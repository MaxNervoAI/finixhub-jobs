/**
 * generate-price-movement-summary.ts
 *
 * Generates AI-powered price movement summaries for all active assets
 * using Perplexity (with OpenAI fallback).
 *
 * Usage:
 *   npx tsx scripts/generate-price-movement-summary.ts [--snapshot morning|afternoon]
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

async function callAI(
    model: string, messages: any[], apiKey: string, isPerplexity: boolean,
    maxTokens = 15000,
) {
    let url = isPerplexity
        ? 'https://api.perplexity.ai/chat/completions'
        : 'https://api.openai.com/v1/chat/completions';

    if (model.includes('deepseek')) {
        url = 'https://api.deepseek.com/chat/completions';
        if (maxTokens > 8000) maxTokens = 8000;
    }

    const body: any = { model, messages, temperature: 0.1, max_tokens: maxTokens };
    if (isPerplexity) {
        body.response_format = { type: 'json_schema' };
    } else {
        body.response_format = { type: 'json_object' };
    }

    const res = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'User-Agent': 'FinixHub/1.0',
        },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`AI Error (${model}): ${res.status} - ${errText.substring(0, 200)}`);
    }

    const data = await res.json();
    let content: string = data.choices[0].message.content;
    if (content.includes('<think>')) content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    content = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    return { content, citations: data.citations || [], usage: data.usage };
}

async function processBatch(
    supabase: any,
    apiKey: string,
    isPerplexity: boolean,
    model: string,
    symbolBatch: string[],
    targetDate: string,
    snapshotTime: string,
    batchIdx: number,
    totalBatches: number,
) {
    try {
        console.log(`  Batch ${batchIdx + 1}/${totalBatches} (${symbolBatch.length} symbols)...`);

        const { data: marketData } = await supabase
            .from('asset_daily_summary')
            .select('symbol, close, change_percent_24h')
            .eq('date', targetDate)
            .in('symbol', symbolBatch);

        const inputArr = symbolBatch.map(symbol => {
            const d = marketData?.find((m: any) => m.symbol === symbol);
            return { symbol, price: d?.close || 0, change: d?.change_percent_24h || 0 };
        });

        const prompt = `For these ${inputArr.length} symbols ${JSON.stringify(inputArr)}, generate a 2-sentence summary per symbol explaining the price movement.
Rules:
- Process ALL ${inputArr.length} exactly once, in order.
- Focus: Key driver (news/macro/technicals); style: Professional ticker.
- Format: Use **Markdown** to bold the symbol and key percentages.
- Output ONLY JSON: {"summaries": [{"symbol":"BTC","summary":"**BTC** (+4%): Driven by...", "citations":[]}, ...]}—exactly ${inputArr.length} objects.`;

        const result = await callAI(
            model,
            [
                { role: 'system', content: 'You are a financial news analyst. Return ONLY valid JSON with market summaries.' },
                { role: 'user', content: prompt },
            ],
            apiKey,
            isPerplexity,
        );

        // Audit log
        await supabase.from('ai_audit_log').insert({
            user_id: null,
            model_used: model,
            input_tokens: result.usage?.prompt_tokens || 0,
            output_tokens: result.usage?.completion_tokens || 0,
            cost_usd: 0,
            request_type: 'price_movement_batch',
            metadata: { batch_index: batchIdx, symbols: symbolBatch, date: targetDate },
        });

        let parsed: any;
        try {
            parsed = JSON.parse(result.content);
        } catch {
            console.error(`  ❌ JSON parse error batch ${batchIdx + 1}`);
            return 0;
        }

        const summaries: any[] = Array.isArray(parsed) ? parsed : parsed.summaries || [];

        const upsertData = summaries.map((item: any) => {
            const md = marketData?.find((m: any) => m.symbol === item.symbol);
            return {
                symbol: item.symbol,
                date: targetDate,
                snapshot_time: snapshotTime,
                price: md?.close || 0,
                change_percent: md?.change_percent_24h || 0,
                summary: item.summary,
                citations: JSON.stringify(item.citations || result.citations),
                ai_model: model,
                confidence_score: 0.95,
                is_public_cache: ['BTC', 'ETH', 'SOL'].includes(item.symbol),
            };
        });

        const { error } = await supabase
            .from('asset_daily_commentary')
            .upsert(upsertData, { onConflict: 'symbol, date' });

        if (error) { console.error(`  ❌ DB error batch ${batchIdx + 1}:`, error.message); return 0; }
        console.log(`  ✅ Batch ${batchIdx + 1} — ${summaries.length} summaries`);
        return summaries.length;
    } catch (err: any) {
        console.error(`  ❌ Batch ${batchIdx + 1} failed:`, err?.message);
        return 0;
    }
}

async function main() {
    const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL!;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const OPENAI_KEY = process.env.OPENAI_API_KEY;
    const PERPLEXITY_KEY = process.env.PERPLEXITY_API_KEY;
    const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY;

    if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    if (!OPENAI_KEY && !PERPLEXITY_KEY && !DEEPSEEK_KEY) throw new Error('Need at least OPENAI_API_KEY, PERPLEXITY_API_KEY, or DEEPSEEK_API_KEY');

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    // Parse --snapshot flag
    const snapIdx = process.argv.indexOf('--snapshot');
    const snapshotTime = snapIdx !== -1 && process.argv[snapIdx + 1] ? process.argv[snapIdx + 1] : 'morning';
    const targetDate = new Date().toISOString().split('T')[0];
    const batchSize = 25;

    console.log(`\n🚀 Generating price movement summaries for ${targetDate} (${snapshotTime})\n`);

    const { data: assets, error } = await supabase
        .from('assets').select('symbol').eq('is_active', true).order('symbol');
    if (error) throw new Error(`Failed to fetch assets: ${error.message}`);

    const symbols = assets?.map((a: any) => a.symbol) || [];
    console.log(`  ${symbols.length} active symbols\n`);

    // Split into batches
    const batches: string[][] = [];
    for (let i = 0; i < symbols.length; i += batchSize) batches.push(symbols.slice(i, i + batchSize));

    // Determine model - Use DeepSeek as primary (cheapest), fallback to OpenAI
    let model = 'gpt-4o-mini';
    let apiKey = OPENAI_KEY!;
    let isPerplexity = false;

    if (DEEPSEEK_KEY) {
        model = 'deepseek-chat';
        apiKey = DEEPSEEK_KEY;
        console.log('  Using DeepSeek V3 (cheapest)\n');
    } else if (OPENAI_KEY) {
        model = 'gpt-4o-mini';
        apiKey = OPENAI_KEY;
        console.log('  Using OpenAI gpt-4o-mini (fallback)\n');
    } else {
        throw new Error('Need DEEPSEEK_API_KEY or OPENAI_API_KEY');
    }

    let totalProcessed = 0;
    for (let i = 0; i < batches.length; i++) {
        const count = await processBatch(supabase, apiKey, isPerplexity, model, batches[i], targetDate, snapshotTime, i, batches.length);
        totalProcessed += count;
        if (i < batches.length - 1) await new Promise(r => setTimeout(r, 1000));
    }

    console.log(`\n🏁 Done! ${totalProcessed} summaries generated for ${snapshotTime}\n`);
}

main().then(() => process.exit(0)).catch(err => { console.error('💥 Fatal:', err); process.exit(1); });
