/**
 * backfill.ts
 *
 * Backfills historical data for a date range:
 *  1. Fetch daily OHLCV from Binance klines → asset_daily_summary
 *  2. Calculate technical indicators → asset_daily_summary
 *  3. Generate AI insights → asset_daily_commentary + global_market_insights
 *
 * Usage:
 *   npx tsx scripts/backfill.ts --from 2026-02-01 --to 2026-02-11
 *   npx tsx scripts/backfill.ts --from 2026-02-01 --to 2026-02-11 --skip-insights
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

// ---- Arg parsing ----
function getArg(name: string): string | undefined {
    const idx = process.argv.indexOf(`--${name}`);
    return idx !== -1 ? process.argv[idx + 1] : undefined;
}

function dateRange(from: string, to: string): string[] {
    const dates: string[] = [];
    const d = new Date(from);
    const end = new Date(to);
    while (d <= end) {
        dates.push(d.toISOString().split('T')[0]);
        d.setDate(d.getDate() + 1);
    }
    return dates;
}

// ---- Binance helper ----
async function fetchBinance(path: string) {
    const domains = ['api.binance.com', 'api.binance.us'];
    let lastError: any;

    for (const domain of domains) {
        try {
            const res = await fetch(`https://${domain}${path}`);

            if (res.ok) return res;
            if (res.status === 451 || res.status === 403) {
                // Geo-blocked, try next domain
                continue;
            }
            return res;
        } catch (err) {
            lastError = err;
        }
    }
    throw lastError || new Error('Binance fetch failed');
}

// ---- Binance historical fetch ----
async function fetchHistoricalMetrics(
    supabase: any, assets: { symbol: string; binance_symbol: string }[], date: string,
) {
    const dayStart = new Date(`${date}T00:00:00Z`).getTime();
    const dayEnd = new Date(`${date}T23:59:59Z`).getTime();
    const records: any[] = [];
    let errors = 0;

    // Process sequentially to avoid Binance rate limits
    for (let i = 0; i < assets.length; i++) {
        const { symbol, binance_symbol } = assets[i];
        try {
            // OPTIMIZATION: Check if we already have daily OHLCV for this date in the DB
            const { data: existing } = await supabase
                .from('asset_daily_summary')
                .select('open, high, low, close, volume, taker_buy_volume')
                .eq('symbol', symbol)
                .eq('date', date)
                .single();

            if (existing && existing.close !== null) {
                // We have it! Move to next asset
                records.push({
                    symbol, date,
                    open: existing.open,
                    high: existing.high,
                    low: existing.low,
                    close: existing.close,
                    volume: existing.volume,
                    taker_buy_volume: existing.taker_buy_volume,
                    taker_sell_volume: (existing.volume || 0) - (existing.taker_buy_volume || 0),
                });
                continue;
            }

            const path = `/api/v3/klines?symbol=${binance_symbol}&interval=1d&startTime=${dayStart}&endTime=${dayEnd}&limit=1`;
            const res = await fetchBinance(path);

            if (!res.ok) {
                // 400 usually means symbol not found on the exchange (common with Binance.us)
                if (res.status === 400) continue;

                if (errors < 3) console.error(`    ⚠️ Binance ${res.status} for ${binance_symbol}`);
                errors++;
                // If rate limited, wait longer
                if (res.status === 418 || res.status === 429) {
                    console.error(`    🛑 Rate limited! Waiting 30s...`);
                    await new Promise(r => setTimeout(r, 30000));
                }
                continue;
            }

            const klines: any[] = await res.json();
            if (!klines || klines.length === 0) continue;

            const k = klines[0];
            const open = parseFloat(k[1]);
            const close = parseFloat(k[4]);
            records.push({
                symbol, date,
                open,
                high: parseFloat(k[2]),
                low: parseFloat(k[3]),
                close,
                volume: parseFloat(k[5]),
                quote_volume: parseFloat(k[7]),
                trade_count: parseInt(k[8], 10),
                taker_buy_volume: parseFloat(k[9]),
                taker_sell_volume: parseFloat(k[5]) - parseFloat(k[9]),
                change_percent_24h: open > 0 ? parseFloat((((close - open) / open) * 100).toFixed(2)) : 0,
                data_source: 'binance',
            });
        } catch (err: any) {
            if (errors < 3) console.error(`    ❌ ${symbol}: ${err?.message}`);
            errors++;
        }

        // Rate limit: small delay every request, bigger delay every 10
        if (i % 10 === 9) await new Promise(r => setTimeout(r, 500));
        else if (i % 3 === 2) await new Promise(r => setTimeout(r, 100));
    }

    if (errors > 0) console.log(`    (${errors} fetch errors)`);

    // Upsert all records in batches
    if (records.length > 0) {
        const batchSize = 50;
        let upserted = 0;
        for (let i = 0; i < records.length; i += batchSize) {
            const batch = records.slice(i, i + batchSize);
            const { error } = await supabase
                .from('asset_daily_summary')
                .upsert(batch, { onConflict: 'symbol,date', ignoreDuplicates: false });
            if (error) console.error(`    DB upsert error (summary):`, error.message);
            else upserted += batch.length;
        }
        return upserted;
    }
    return 0;
}

// ---- Technical indicators imported from shared lib ----
import {
    calculateRSI, calculateEMA, calculateSMA, calculateMACD,
    calculateBollingerBands, calculateATR, calculateStochasticRSI,
    calculateVWAP, analyzeVolumeTrend, calculateSupportResistance,
    calculateVolumeRatio, calculateADX
} from './lib/indicators';


async function calculateIndicators(supabase: any, symbol: string, date: string) {
    // Get historical daily data from asset_daily_summary (up to 250 days for 200-SMA warmup)
    const lookbackDate = new Date(date);
    lookbackDate.setDate(lookbackDate.getDate() - 250);

    const { data: dailyData } = await supabase
        .from('asset_daily_summary')
        .select('date, open, high, low, close, volume')
        .eq('symbol', symbol)
        .gte('date', lookbackDate.toISOString().split('T')[0])
        .lte('date', date)
        .order('date', { ascending: true });

    if (!dailyData || dailyData.length < 30) return false;

    // Convert to numbers
    const typed = dailyData.map((d: any) => ({
        ...d,
        open: Number(d.open), high: Number(d.high), low: Number(d.low), close: Number(d.close), volume: Number(d.volume)
    }));
    const prices = typed.map((d: any) => d.close);

    const rsi14 = calculateRSI(prices, 14);
    const ema20 = calculateEMA(prices, 20);
    const ema50 = calculateEMA(prices, 50);
    const macd = calculateMACD(prices);
    const bb = calculateBollingerBands(prices, 20, 2);
    const atr14 = calculateATR(typed, 14);
    const stochRsi = calculateStochasticRSI(prices, 14);
    const vwap = calculateVWAP(typed.slice(-30));
    const volTrend = analyzeVolumeTrend(typed);

    // SMA with null-safety
    const sma50 = prices.length >= 50 ? calculateSMA(prices, 50) : null;
    const sma200 = prices.length >= 200 ? calculateSMA(prices, 200) : null;

    // ADX
    const adxResult = calculateADX(typed, 14);

    const updatePayload: any = {
        rsi_14: parseFloat(rsi14.toFixed(2)),
        ema_20: parseFloat(ema20.toFixed(2)),
        ema_50: parseFloat(ema50.toFixed(2)),
        sma_50: sma50 ? parseFloat(sma50.toFixed(2)) : null,
        sma_200: sma200 ? parseFloat(sma200.toFixed(2)) : null,
        macd,
        bollinger_bands: bb,
        atr_14: atr14,
        stochastic_rsi: stochRsi,
        vwap,
        volume_trend: volTrend,
        updated_at: new Date().toISOString(),
    };

    if (adxResult) {
        updatePayload.adx_14 = adxResult.adx;
        updatePayload.di_plus_14 = adxResult.plusDI;
        updatePayload.di_minus_14 = adxResult.minusDI;
    }

    const { error } = await supabase
        .from('asset_daily_summary')
        .update(updatePayload)
        .eq('symbol', symbol)
        .eq('date', date);

    if (error) console.error(`    ❌ Update error for ${symbol}: ${error.message}`);
    return !error;
}

// ---- AI insights ----
async function callAI(model: string, messages: any[], apiKey: string, isPerplexity: boolean) {
    const isDeepSeek = model.includes('deepseek');
    let url = isPerplexity ? 'https://api.perplexity.ai/chat/completions' : 'https://api.openai.com/v1/chat/completions';
    if (isDeepSeek) url = 'https://api.deepseek.com/chat/completions';

    const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'User-Agent': 'FinixHub/1.0' },
        body: JSON.stringify({
            model,
            messages,
            temperature: 0.6, // CREATIVE_TEMP: For insightful market analysis
            stream: false,
            response_format: { type: isPerplexity ? 'json_schema' : 'json_object' }
        }),
    });
    if (!res.ok) throw new Error(`AI Error (${model}): ${res.status} - ${(await res.text()).substring(0, 200)}`);
    const data = await res.json();
    let content: string = data.choices[0].message.content;
    if (content.includes('</think>')) content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    return { content: JSON.parse(content), citations: data.citations || [], usage: data.usage };
}

async function generateInsightsForDate(supabase: any, date: string, aiKey: string, aiModel: string, targetSymbols?: string[]) {
    if (!aiKey) return 0;
    // ...

    // Global context
    // Global context: Fetch top 50 assets by market_cap from ASSETS table (source of truth)
    let query = supabase
        .from('assets')
        .select('symbol, market_cap')
        .order('market_cap', { ascending: false, nullsFirst: false })
        .limit(50);

    if (targetSymbols && targetSymbols.length > 0) {
        query = query.in('symbol', targetSymbols);
    }

    const { data: topAssets } = await query;

    if (!topAssets || topAssets.length === 0) return 0;
    const topSymbols = topAssets.map((a: any) => a.symbol);

    const { data: summaries } = await supabase
        .from('asset_daily_summary')
        .select(`
            symbol, close, date, volume, market_cap,
            change_percent_24h,
            rsi_14, ema_20, ema_50, sma_50, sma_200,
            macd, bollinger_bands, atr_14, stochastic_rsi,
            vwap, volume_trend
        `)
        .eq('date', date)
        .in('symbol', topSymbols); // Filter by top symbols

    if (!summaries || summaries.length === 0) { console.log(`    No data for ${date}, skipping insights`); return 0; }

    // Merge correct market_cap from assets table
    const top50 = summaries.map((s: any) => ({
        ...s,
        market_cap: topAssets.find((a: any) => a.symbol === s.symbol)?.market_cap || s.market_cap || 0
    })).sort((a: any, b: any) => b.market_cap - a.market_cap); // Re-sort to be safe

    if (!top50 || top50.length === 0) { console.log(`    No data for ${date}, skipping insights`); return 0; }

    const momentumCount = top50.filter((a: any) => a.sma_50 && a.close > a.sma_50).length;
    const momentumPct = top50.length > 0 ? (momentumCount / top50.length) * 100 : 50;

    // Global insight
    const globalPrompt = `Market analysis for ${date}. ${top50.length} assets tracked. Momentum: ${momentumPct.toFixed(1)}% above SMA50. Top movers: ${top50.slice(0, 5).map((a: any) => `${a.symbol} ${a.change_percent_24h}%`).join(', ')}.
Return JSON: {"fear_greed_index":number,"mood_label":"...","mood_text":"...","momentum_label":"...","momentum_text":"...","flow_label":"...","flow_text":"...","top_story":"..."}`;

    try {
        const globalResult = await callAI(aiModel, [
            { role: 'system', content: 'You are a financial analyst.' },
            { role: 'user', content: globalPrompt },
        ], aiKey, false);

        await supabase.from('global_market_insights').upsert({
            date, ...globalResult.content, momentum_percent: momentumPct, citations: globalResult.citations,
        }, { onConflict: 'date' });
    } catch (err: any) {
        console.error(`    Global insight error: ${err?.message}`);
    }

    // Asset insights (top 20 only to manage costs)
    const assetsToProcess = top50.slice(0, 20);
    let count = 0;

    // comprehensive_insights prompt
    for (const asset of assetsToProcess) {
        try {
            // Fetch recent daily candles for support/resistance levels
            const { data: candles } = await supabase
                .from('asset_daily_summary')
                .select('high, low, close')
                .eq('symbol', asset.symbol)
                .lt('date', date) // Candles BEFORE this date
                .order('date', { ascending: false })
                .limit(30);

            const levels = calculateSupportResistance(candles || []);

            // Enriched Metrics Calculation
            const volRatio = asset.volume_trend === 'accumulating' ? 1.2 : asset.volume_trend === 'distributing' ? 0.8 : 1.0;
            const volatility = asset.atr_14 ? (asset.atr_14 / asset.close) * 100 : 0.0;
            const mktShare = asset.market_cap ? (asset.market_cap / (top50.reduce((acc: number, a: any) => acc + (a.market_cap || 0), 0) || 1)) * 100 : 0;

            // Calculate 7d change if possible
            let change7d = 0;
            if (candles && candles.length >= 7) {
                const recent = candles[0].close;
                const past = candles[6].close;
                change7d = ((recent - past) / past) * 100;
            }

            const enrichedMetrics = {
                signal: 'Neutral',
                momentum: asset.close > asset.sma_50 ? "Bullish" : "Bearish",
                daily_volatility: parseFloat(volatility.toFixed(2)),
                volume_ratio: volRatio,
                price_change_7d: parseFloat(change7d.toFixed(2)),
                market_share: parseFloat(mktShare.toFixed(2)),
                vital_signs: {
                    signal: "Neutral",
                    momentum: asset.close > asset.sma_50 ? "Bullish" : "Bearish",
                    volatility: volatility.toFixed(1) + '%'
                }
            };

            const analysisPrompt = `
You are a senior crypto educator and analyst for FinixHub. Your goal is to explain WHY the asset is moving in a way that teaches the user.
Tone: Educational, clear, analytical, but accessible. Avoid generic "price went up" statements. Explain the *drivers*.

DATA CONTEXT:
- Price: $${asset.close} (${asset.change_percent_24h}%)
- RSI (14): ${asset.rsi_14 || 'N/A'}
- SMA (50): ${asset.sma_50 || 'N/A'}
- SMA (200): ${asset.sma_200 || 'N/A'}
- MACD: ${asset.macd ? JSON.stringify(asset.macd) : 'N/A'}
- Bollinger Bands: ${asset.bollinger_bands ? `Upper: ${asset.bollinger_bands.upper}, Lower: ${asset.bollinger_bands.lower}` : 'N/A'}
- ATR (14): ${asset.atr_14 || 'N/A'}
- Stochastic RSI: ${asset.stochastic_rsi ? `K: ${asset.stochastic_rsi.k}, D: ${asset.stochastic_rsi.d}` : 'N/A'}
- VWAP: ${asset.vwap || 'N/A'}
- Volume Trend: ${asset.volume_trend || 'N/A'}
- Levels: ${JSON.stringify(levels)}
- Market Cap: $${(asset.market_cap / 1e9).toFixed(2)}B

TASK: Provide comprehensive analysis in JSON format corresponding to this schema:
{
  "price_action": {
    "trend": "bullish|bearish|neutral|volatile",
    "drivers": ["list of 2-3 key drivers"],
    "short_term_outlook": "A comprehensive summary paragraph (MINIMUM 150 CHARACTERS) explaining WHY the asset moved, the key technical levels triggered, and what to expect next. Educational tone."
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
Focus on actionable insights based on the technicals provided.`;

            const assetResult = await callAI(aiModel, [
                { role: 'system', content: 'You are a senior crypto market analyst.' },
                { role: 'user', content: analysisPrompt },
            ], aiKey, false);

            // Inject calculated values
            const finalContent = {
                ...assetResult.content,
                technical_analysis: {
                    ...assetResult.content.technical_analysis,
                    key_levels: levels
                },
                enriched_metrics: enrichedMetrics
            };

            // Save to comprehensive_insights
            const { error: saveError } = await supabase.from('comprehensive_insights').upsert({
                symbol: asset.symbol,
                date,
                analysis: finalContent,
                created_at: new Date().toISOString(),
            }, { onConflict: 'symbol,date' });

            if (saveError) console.error(`    ❌ DB error comprehensive ${asset.symbol}: ${saveError.message}`);
            else count++;

            // Also save to asset_daily_commentary for backward compatibility if needed?
            // User seems to rely on comprehensive structure now.
            // But let's keep daily commentary as a fallback or if the UI uses it elsewhere.
            // We can map the comprehensive output to the basic structure.
            const basicContent = {
                why_moving: assetResult.content.price_action?.drivers?.[0] || "Market movement based on technicals.",
                vital_signs: {
                    rsi: { status: asset.rsi_14 > 70 ? 'Overbought' : asset.rsi_14 < 30 ? 'Oversold' : 'Normal', value: asset.rsi_14 },
                    volume: { status: 'Normal', value: 0 },
                    trend: { status: assetResult.content.price_action?.trend === 'bullish' ? 'Strong' : 'Weak', label: assetResult.content.price_action?.trend }
                }
            };

            await supabase.from('asset_daily_commentary').upsert({
                symbol: asset.symbol,
                date,
                price: asset.close,
                change_percent: asset.change_percent_24h,
                summary: basicContent.why_moving,
                why_moving: basicContent.why_moving,
                vital_signs: basicContent.vital_signs,
                citations: assetResult.citations,
                snapshot_time: 'daily_update',
                is_public_cache: ['BTC', 'ETH', 'SOL'].includes(asset.symbol),
                updated_at: new Date().toISOString(),
            }, { onConflict: 'symbol,date,snapshot_time' });

        } catch (err: any) {
            console.error(`    ❌ Insight error ${asset.symbol}: ${err?.message}`);
        }
    }
    return count;
}

// ---- Main ----
async function main() {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    const OPENAI_KEY = process.env.OPENAI_API_KEY;
    const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;

    if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error(`Missing Credentials: URL=${!!SUPABASE_URL}, KEY=${!!SUPABASE_KEY}`);

    // Check for either OpenAI or DeepSeek key
    if (!OPENAI_KEY && !DEEPSEEK_KEY) {
        console.log('Skipping AI insights (no API key)');
        // We can still run backfill without insights, just warn
    }

    const aiKey = DEEPSEEK_KEY || OPENAI_KEY || '';
    const aiModel = DEEPSEEK_KEY ? 'deepseek-chat' : 'gpt-4o-mini';

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    const fromDate = getArg('from') || '2026-02-01';
    const toDate = getArg('to') || new Date().toISOString().split('T')[0];
    const symbolsArg = getArg('symbols');
    const targetSymbols = symbolsArg ? symbolsArg.split(',').map(s => s.trim().toUpperCase()) : null;
    const clean = process.argv.includes('--clean');
    const skipInsights = process.argv.includes('--skip-insights');
    const noWarmup = process.argv.includes('--no-warmup');
    const dates = dateRange(fromDate, toDate);

    // Warmup: Start 250 days earlier to ensure indicators (SMA-200, EMA-200) are valid
    // Skip with --no-warmup when only OHLCV prices are needed
    const warmupStart = new Date(fromDate);
    if (!noWarmup) warmupStart.setDate(warmupStart.getDate() - 250);
    const warmupDateStr = warmupStart.toISOString().split('T')[0];
    const fullDateRange = dateRange(warmupDateStr, toDate);

    console.log(`\n🔄 BACKFILL: ${fromDate} → ${toDate} (Target Range)`);
    if (!noWarmup) console.log(`   WARMUP:   ${warmupDateStr} → ${fromDate} (Fetching history for context)`);
    console.log(`   Total Days: ${fullDateRange.length}`);

    if (targetSymbols) console.log(`   Targets: ${targetSymbols.join(', ')}`);
    if (clean) console.log(`   Clean: YES (Deleting existing data first)`);

    // Clean existing data if requested
    if (clean && targetSymbols) {
        console.log(`\n🗑️  Cleaning existing data for target symbols...`);
        const { error: err1 } = await supabase.from('asset_daily_summary')
            .delete().in('symbol', targetSymbols).gte('date', fromDate).lte('date', toDate);
        const { error: err2 } = await supabase.from('asset_daily_commentary')
            .delete().in('symbol', targetSymbols).gte('date', fromDate).lte('date', toDate);
        const { error: err3 } = await supabase.from('comprehensive_insights')
            .delete().in('symbol', targetSymbols).gte('date', fromDate).lte('date', toDate);

        if (err1 || err2 || err3) console.error("    ⚠️ Error cleaning data:", err1 || err2 || err3);
        else console.log("    ✅ Data cleaned.");
    }

    // Get active assets
    let query = supabase
        .from('assets')
        .select('symbol, binance_symbol')
        .eq('is_active', true)
        .not('binance_symbol', 'is', null)
        .order('market_cap', { ascending: false, nullsFirst: false })
        .limit(500);

    if (targetSymbols) {
        query = query.in('symbol', targetSymbols);
    }

    const { data: assets } = await query;

    if (!assets || assets.length === 0) throw new Error('No active assets found');
    console.log(`\n  Processing ${assets.length} assets\n`);

    for (const date of fullDateRange) {
        const isTargetDate = date >= fromDate;
        const mode = isTargetDate ? '🚀 TARGET' : '🔥 WARMUP';

        console.log(`\n📅 ${date} [${mode}]`);
        const dayStart = Date.now();

        // Step 1: Fetch historical OHLCV
        const metricsCount = await fetchHistoricalMetrics(supabase, assets, date);
        console.log(`  📊 Metrics: ${metricsCount} assets`);

        // Step 2: Calculate indicators (using accumulated daily data)
        let indicatorsCount = 0;
        for (const { symbol } of assets) {
            const ok = await calculateIndicators(supabase, symbol, date);
            if (ok) indicatorsCount++;
        }
        console.log(`  📐 Indicators: ${indicatorsCount} assets`);

        // Step 3: Generate AI insights (ONLY FOR TARGET DATES)
        if (isTargetDate && !skipInsights && aiKey) {
            const insightsCount = await generateInsightsForDate(supabase, date, aiKey, aiModel, targetSymbols || undefined);
            console.log(`  🤖 Insights: ${insightsCount} assets (${aiModel})`);
        } else if (!isTargetDate) {
            console.log(`  ⏭️  Skipping AI (Warmup Phase)`);
        }

        console.log(`  ⏱  ${((Date.now() - dayStart) / 1000).toFixed(1)}s`);

        // Delay between days to be gentle on APIs
        if (fullDateRange.indexOf(date) < fullDateRange.length - 1) {
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    console.log(`\n✅ Backfill complete! Processed ${fullDateRange.length} days (Warmup + Target).\n`);
}

main()
    .then(() => process.exit(0))
    .catch(err => { console.error('💥 Fatal:', err); process.exit(1); });
