/**
 * generate-daily-insights.ts
 *
 * Standalone script that generates daily AI market insights for all active
 * assets and writes them to Supabase. Designed to run via GitHub Actions cron
 * (no Edge Function timeout constraints).
 *
 * Usage:
 *   npx tsx scripts/generate-daily-insights.ts [--date 2026-02-10]
 *
 * Required env vars:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY
 * Optional:
 *   PERPLEXITY_API_KEY  (falls back to OpenAI if missing or blocked)
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();
import { calculateSupportResistance, calculateVolumeRatio, OHLCVData } from './lib/indicators';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchGlobalContext(supabase: any) {
    const { data: top50 } = await supabase
        .from('asset_daily_summary')
        .select('symbol, close, sma_50, change_percent_24h, market_cap')
        .order('market_cap', { ascending: false })
        .limit(50);

    if (!top50) return null;

    const momentumCount = top50.filter((a: any) => a.sma_50 && a.close > a.sma_50).length;
    const validSmaCount = top50.filter((a: any) => a.sma_50).length;
    const momentumPercent = validSmaCount > 0 ? (momentumCount / validSmaCount) * 100 : 0;

    const totalMarketCap = top50.reduce((acc: number, a: any) => acc + (a.market_cap || 0), 0);
    const marketCapChange = top50.reduce(
        (acc: number, a: any) => acc + ((a.market_cap || 0) * (a.change_percent_24h || 0)) / 100,
        0,
    );
    const marketCapChangePercent = (marketCapChange / totalMarketCap) * 100;

    const { data: news } = await supabase
        .from('news_articles')
        .select('title, excerpt, source')
        .order('published_at', { ascending: false })
        .limit(5);

    // Fetch latest Fear & Greed Index
    const { data: fngData } = await supabase
        .from('asset_daily_summary')
        .select('fear_greed_index')
        .not('fear_greed_index', 'is', null)
        .order('date', { ascending: false })
        .limit(1)
        .maybeSingle();

    return {
        top50,
        momentumPercent,
        marketCapChangePercent,
        news,
        fearGreedIndex: fngData?.fear_greed_index || null
    };
}

async function callAI(
    model: string,
    messages: any[],
    apiKey: string,
    isPerplexity: boolean,
) {
    const isDeepSeek = model.includes('deepseek');
    let url = isPerplexity
        ? 'https://api.perplexity.ai/chat/completions'
        : 'https://api.openai.com/v1/chat/completions';

    if (isDeepSeek) {
        url = 'https://api.deepseek.com/chat/completions';
    }

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'User-Agent': 'FinixHub/1.0',
        },
        body: JSON.stringify({
            model,
            messages,
            temperature: 0.6, // CREATIVE_TEMP: For insightful market analysis
            response_format: { type: isPerplexity ? 'json_schema' : 'json_object' },
            stream: false
        }),
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`AI API Error (${model}): ${response.status} - ${errText.substring(0, 200)}`);
    }

    const data = await response.json();
    let content: string = data.choices[0].message.content;

    // Strip Perplexity <think> tags
    if (content.includes('<think>')) {
        content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    }

    return {
        content: JSON.parse(content),
        citations: data.citations || [],
        usage: data.usage,
    };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    // Parse optional --date flag
    const dateArgIdx = process.argv.indexOf('--date');
    const targetDate =
        dateArgIdx !== -1 && process.argv[dateArgIdx + 1]
            ? process.argv[dateArgIdx + 1]
            : new Date().toISOString().split('T')[0];

    // Validate env
    const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
    const OPENAI_KEY = process.env.OPENAI_API_KEY;
    const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;
    const PERPLEXITY_KEY = process.env.PERPLEXITY_API_KEY;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
        throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    }

    // Check for either OpenAI or DeepSeek key
    if (!OPENAI_KEY && !DEEPSEEK_KEY) {
        throw new Error('Missing AI API Key (OPENAI_API_KEY or DEEPSEEK_API_KEY)');
    }

    const aiKey = DEEPSEEK_KEY || OPENAI_KEY || '';
    const aiModel = DEEPSEEK_KEY ? 'deepseek-chat' : 'gpt-4o-mini';

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    console.log(`\n🚀 Generating daily insights for ${targetDate}\n`);

    // -----------------------------------------------------------------------
    // 1. Fetch global context
    // -----------------------------------------------------------------------
    const context = await fetchGlobalContext(supabase);
    if (!context) throw new Error('Could not fetch market context');

    // -----------------------------------------------------------------------
    // 2. Generate Asset Insights
    // -----------------------------------------------------------------------
    const { data: activeAssets } = await supabase
        .from('assets')
        .select('symbol, market_cap')
        .eq('is_active', true)
        .order('market_cap', { ascending: false, nullsFirst: false });

    const symbols: string[] = activeAssets?.map((a: any) => a.symbol) || [];
    const FREE_TIER_ASSETS = ['BTC', 'ETH', 'SOL'];
    const allSymbols = [...new Set([...FREE_TIER_ASSETS, ...symbols])];
    const top10 = [
        ...FREE_TIER_ASSETS,
        ...symbols.filter((s: string) => !FREE_TIER_ASSETS.includes(s)),
    ].slice(0, 10);

    console.log(`\n📊 Processing ${allSymbols.length} assets (top 10: ${top10.join(', ')})\n`);

    let successCount = 0;
    let errorCount = 0;

    for (const symbol of allSymbols) {
        try {
            const { data: summary } = await supabase
                .from('asset_daily_summary')
                .select('*')
                .eq('symbol', symbol)
                .eq('date', targetDate)
                .maybeSingle();

            if (!summary) {
                continue; // No summary data for this date
            }

            // Fetch 1d candles from market_data_ohlcv for key levels calculation
            // (sync-binance-ohlcv now writes 1d candles directly from Binance)
            const { data: candles } = await supabase
                .from('market_data_ohlcv')
                .select('high, low, close, volume')
                .eq('symbol', symbol)
                .eq('timeframe', '1d')
                .order('timestamp', { ascending: false })
                .limit(30);

            // Calculate 7d change
            let change7d = 'N/A';
            if (candles && candles.length >= 8) {
                const current = candles[0].close;
                const prev7d = candles[7].close;
                const pct = ((current - prev7d) / prev7d) * 100;
                change7d = `${pct.toFixed(2)}%`;
            }

            const levels = calculateSupportResistance(candles || []);
            const isTop10 = top10.includes(symbol);

            // Build taker ratio string
            const takerRatio = summary.taker_buy_volume && summary.taker_sell_volume
                ? `Buy: ${((summary.taker_buy_volume / (summary.taker_buy_volume + summary.taker_sell_volume)) * 100).toFixed(1)}% / Sell: ${((summary.taker_sell_volume / (summary.taker_buy_volume + summary.taker_sell_volume)) * 100).toFixed(1)}%`
                : 'N/A';

            // Build ADX string
            const adxStr = summary.adx_14
                ? `ADX: ${summary.adx_14} (${summary.adx_14 < 20 ? 'No Trend' : summary.adx_14 < 40 ? 'Developing' : 'Strong Trend'}), +DI: ${summary.di_plus_14 || 'N/A'}, -DI: ${summary.di_minus_14 || 'N/A'}`
                : 'N/A';

            const analysisPrompt = isTop10
                ? `You are a senior crypto educator and analyst for FinixHub. Your goal is to explain WHY the asset is moving (${symbol}) on ${targetDate}.
Tone: Educational, clear, analytical, but accessible. Avoid generic "price went up" statements. Explain the *drivers*.

DATA CONTEXT:
- Price: $${summary.close} (24h: ${summary.change_percent_24h}%, 7d: ${change7d})
- RSI (14): ${summary.rsi_14 || 'N/A'}
- SMA (50): ${summary.sma_50 || 'N/A'}
- SMA (200): ${summary.sma_200 || 'N/A'}
- MACD: ${summary.macd ? JSON.stringify(summary.macd) : 'N/A'}
- Bollinger Bands: ${summary.bollinger_bands ? `Upper: ${summary.bollinger_bands.upper}, Lower: ${summary.bollinger_bands.lower}` : 'N/A'}
- ATR (14): ${summary.atr_14 || 'N/A'}
- Stochastic RSI: ${summary.stochastic_rsi ? `K: ${summary.stochastic_rsi.k}, D: ${summary.stochastic_rsi.d}` : 'N/A'}
- VWAP: ${summary.vwap || 'N/A'}
- Taker Volume (Buyer/Seller Pressure): ${takerRatio}
- Trend Strength: ${adxStr}
- Volume Trend: ${summary.volume_trend || 'N/A'}
- Levels: ${JSON.stringify(levels)}
- Global Market News: ${JSON.stringify(context.news.slice(0, 3).map((n: any) => n.title))}

IMPORTANT CONSTRAINTS:
- ONLY use the data provided above. Do NOT fabricate or invent exchange netflow numbers, wallet inflow/outflow data, or on-chain metrics.
- Use the Taker Volume ratio to discuss buyer/seller pressure instead of inventing netflow figures.
- If a metric shows "N/A", state that data is unavailable rather than guessing.

TASK: Provide comprehensive analysis in JSON format corresponding to this schema:
{
  "price_action": {
    "trend": "bullish|bearish|neutral|volatile",
    "drivers": ["list of 2-3 key drivers"],
    "short_term_outlook": "Maximum 7 sentences, super condensed, focusing on the most relevant technical and fundamental drivers. Use **Markdown** formatting: **Bold** key levels and technical terms. Educational tone."
  },
  "technical_analysis": {
    "overall_signal": "strong_buy|buy|neutral|sell|strong_sell",
    "key_levels": {
      "support": [],
      "resistance": []
    },
    "momentum": "accelerating|stalling|reversing"
  },
  "fundamental_sentiment": {
    "news_impact": "positive|negative|neutral",
    "key_catalysts": ["general market sentiment"],
    "risk_factors": ["volatility", "macro"]
  },
  "market_positioning": {
    "relative_strength": "outperforming|underperforming|neutral",
    "institutional_signals": "neutral",
    "retail_interest": "moderate"
  },
  "forward_look": {
    "catalysts_to_watch": ["price action at key levels"],
    "time_horizon": "short",
    "confidence_level": 0.85
  }
}
Focus on actionable insights based on the technicals provided.`
                : `Analyze ${symbol} for ${targetDate}: Price $${summary.close} (${summary.change_percent_24h}%), RSI ${summary.rsi_14}, SMA50 ${summary.sma_50 || 'N/A'}, MACD ${summary.macd ? JSON.stringify(summary.macd) : 'N/A'}, Volume Trend: ${summary.volume_trend || 'N/A'}.
Return JSON: { "why_moving": "Maximum 7 sentences, super condensed, focusing on the most relevant technical and fundamental drivers.", "vital_signs": { "rsi": { "status": "Overbought|Normal|Oversold", "value": ${summary.rsi_14} }, "volume": { "status": "High|Normal|Low", "value": ${summary.volume} }, "trend": { "status": "Strong|Weak|Sideways", "label": "Analysis" } } }`;

            // Use DeepSeek as primary model (cheapest), fallback to OpenAI
            let assetAIResult: any;
            let modelUsed = 'deepseek-chat';

            if (DEEPSEEK_KEY) {
                assetAIResult = await callAI(
                    'deepseek-chat',
                    [
                        { role: 'system', content: 'You are a senior crypto market analyst. ONLY reference data explicitly provided in the prompt. Do NOT fabricate exchange netflow numbers, wallet data, or on-chain metrics.' },
                        { role: 'user', content: analysisPrompt },
                    ],
                    DEEPSEEK_KEY,
                    false,
                );
                modelUsed = 'deepseek-chat';
            } else if (OPENAI_KEY) {
                assetAIResult = await callAI(
                    'gpt-4o-mini',
                    [
                        { role: 'system', content: 'You are a senior crypto market analyst. ONLY reference data explicitly provided in the prompt. Do NOT fabricate exchange netflow numbers, wallet data, or on-chain metrics.' },
                        { role: 'user', content: analysisPrompt },
                    ],
                    OPENAI_KEY,
                    false,
                );
                modelUsed = 'gpt-4o-mini';
            }

            // Audit log
            await supabase.from('ai_audit_log').insert({
                user_id: null,
                model_used: modelUsed,
                input_tokens: assetAIResult.usage?.prompt_tokens,
                output_tokens: assetAIResult.usage?.completion_tokens,
                asset_context: symbol,
                request_type: 'daily_insights_asset',
                metadata: { date: targetDate, symbol },
            });

            // Save results
            if (isTop10 && assetAIResult.content.price_action) {

                // We inject 'enriched_metrics' for the UI
                const volRatio = calculateVolumeRatio(summary.volume, (candles || []) as any);
                const volatility = summary.atr_14 ? (summary.atr_14 / summary.close) * 100 : 0.0;
                const totalTop50MarketCap = context.top50?.reduce((acc: number, a: any) => acc + (a.market_cap || 0), 0) || 1;
                const mktShare = summary.market_cap ? (summary.market_cap / totalTop50MarketCap) * 100 : 0;

                const enrichedMetrics = {
                    signal: assetAIResult.content.technical_analysis.overall_signal,
                    momentum: assetAIResult.content.technical_analysis.momentum,
                    daily_volatility: parseFloat(volatility.toFixed(2)),
                    volume_ratio: volRatio,
                    price_change_7d: typeof change7d === 'number' ? change7d : parseFloat(String(change7d).replace('%', '')) || 0,
                    market_share: parseFloat(mktShare.toFixed(2)),
                    vital_signs: {
                        signal: assetAIResult.content.technical_analysis.overall_signal,
                        momentum: assetAIResult.content.technical_analysis.momentum,
                        volatility: volatility.toFixed(1) + '%'
                    }
                };

                const finalContent = {
                    ...assetAIResult.content,
                    technical_analysis: {
                        ...assetAIResult.content.technical_analysis,
                        key_levels: levels // Force calculated levels (database source)
                    },
                    enriched_metrics: enrichedMetrics
                };

                // Save to comprehensive_insights for Top 10
                const { error: saveError } = await supabase.from('comprehensive_insights').upsert({
                    symbol,
                    date: targetDate,
                    analysis: finalContent,
                    created_at: new Date().toISOString(),
                }, { onConflict: 'symbol,date' });

                if (saveError) console.error(`  ❌ DB error comprehensive ${symbol}: ${saveError.message}`);

                // Map to basic structure for backward compatibility
                const basicContent = {
                    why_moving: assetAIResult.content.price_action?.drivers?.[0] || "Market movement based on technicals.",
                    vital_signs: {
                        rsi: { status: summary.rsi_14 > 70 ? 'Overbought' : summary.rsi_14 < 30 ? 'Oversold' : 'Normal', value: summary.rsi_14 },
                        volume: { status: 'Normal', value: 0 },
                        trend: { status: assetAIResult.content.price_action?.trend === 'bullish' ? 'Strong' : 'Weak', label: assetAIResult.content.price_action?.trend }
                    }
                };
                assetAIResult.content = basicContent; // consistency for daily_commentary upsert
            }

            // Upsert to asset_daily_commentary (legacy/basic table)
            const { error: upsertError } = await supabase
                .from('asset_daily_commentary')
                .upsert(
                    {
                        symbol,
                        date: targetDate,
                        price: summary.close,
                        change_percent: summary.change_percent_24h,
                        summary: assetAIResult.content.why_moving,
                        why_moving: assetAIResult.content.why_moving,
                        vital_signs: assetAIResult.content.vital_signs,
                        key_levels: levels,
                        citations: assetAIResult.citations,
                        snapshot_time: 'daily_update',
                        is_public_cache: FREE_TIER_ASSETS.includes(symbol),
                    },
                    { onConflict: 'symbol, date' },
                );

            successCount++;
            const tag = isTop10 ? `[${modelUsed}]` : '[gpt-4o-mini]';
            process.stdout.write(`  ✅ ${symbol} ${tag}  `);
            if (successCount % 5 === 0) console.log(''); // newline every 5

        } catch (err: any) {
            errorCount++;
            console.error(`\n  ❌ ${symbol}: ${err?.message}`);
        }
    }

    if (successCount === 0 && errorCount === 0) {
        console.log(`\n⚠️  No asset summaries found for ${targetDate}. Make sure calculate-technical-indicators has run for this date first.`);
    }
    console.log(`\n🏁 Done! ${successCount} succeeded, ${errorCount} failed out of ${allSymbols.length} assets.\n`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('💥 Fatal error:', err);
        process.exit(1);
    });
