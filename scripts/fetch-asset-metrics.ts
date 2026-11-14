/**
 * fetch-asset-metrics.ts
 *
 * Keeps asset_daily_summary current from Binance's global venue.
 *
 *  1. Today's row is a live snapshot: open/high/low/close/volume/trade count from the rolling 24h
 *     ticker, taker flow from the last 24 hourly candles, flagged is_complete = false.
 *  2. Every completed UTC day in the last FINALIZE_DAYS is rewritten from its final daily candle
 *     (is_complete = true), so a past row always describes its own UTC day.
 *
 * All requests go through lib/binance.mjs: global venue only, no Binance.US fallback. An asset that
 * is not listed on the global venue is skipped and reported rather than filled with another venue's
 * numbers.
 *
 * Usage: npx tsx scripts/fetch-asset-metrics.ts
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { fetchBinanceGlobal } from './lib/binance.mjs';
import { completedDays, finalizedBar, rollingTaker, type Kline } from './lib/daily-bars';

dotenv.config();

const FINALIZE_DAYS = 31;

interface BinanceTicker24h {
    symbol: string;
    priceChange: string;
    priceChangePercent: string;
    lastPrice: string;
    highPrice: string;
    lowPrice: string;
    volume: string;
    quoteVolume: string;
    openPrice: string;
    count: number;
}

function safePercent(val: number | null | undefined): number | null {
    if (val === null || val === undefined || !isFinite(val)) return null;
    if (val > 10000) return 10000;
    if (val < -10000) return -10000;
    return val;
}

async function klines(symbol: string, interval: '1h' | '1d', limit: number): Promise<Kline[]> {
    const { res } = await fetchBinanceGlobal(`/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
    return res.json();
}

async function main() {
    const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL!;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE!;
    if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    const startTime = Date.now();
    const today = new Date().toISOString().split('T')[0];

    console.log(`🚀 Fetching asset metrics for ${today}...\n`);

    // 1. Get active assets with binance symbols
    const { data: assets, error: assetsError } = await supabase
        .from('assets')
        .select('symbol, binance_symbol')
        .eq('is_active', true)
        .not('binance_symbol', 'is', null);

    if (assetsError) throw new Error(`Failed to fetch assets: ${assetsError.message}`);
    if (!assets || assets.length === 0) { console.log('No assets found.'); return; }

    // Build symbol map: BTCUSDT -> BTC
    const symbolMap = new Map<string, string>();
    for (const a of assets) {
        if (a.binance_symbol) symbolMap.set(a.binance_symbol, a.symbol);
    }

    // 2. Fetch 24h tickers from the global venue (throws if it is unreachable: no other venue is used)
    console.log(`  Fetching 24h tickers for ${assets.length} assets...`);
    const { res: tickerRes, host } = await fetchBinanceGlobal('/api/v3/ticker/24hr');
    const allTickers: BinanceTicker24h[] = await tickerRes.json();
    console.log(`  Tickers from ${host}`);

    // 3. Filter to our assets; report the ones the global venue does not list
    const relevantTickers = allTickers.filter(t => symbolMap.has(t.symbol));
    const listed = new Set(relevantTickers.map(t => t.symbol));
    const unlisted = [...symbolMap.entries()].filter(([binance]) => !listed.has(binance)).map(([, ours]) => ours);
    console.log(`  Found ${relevantTickers.length} matching tickers`);
    if (unlisted.length) console.warn(`  ⚠️ Not listed on the global venue, skipped: ${unlisted.join(', ')}`);
    console.log('');

    // 4. Upsert today's live snapshot (is_complete = false until the day closes)
    const records = relevantTickers.map(t => {
        const symbol = symbolMap.get(t.symbol)!;
        return {
            symbol,
            date: today,
            open: parseFloat(t.openPrice),
            high: parseFloat(t.highPrice),
            low: parseFloat(t.lowPrice),
            close: parseFloat(t.lastPrice),
            volume: parseFloat(t.volume),
            quote_volume: parseFloat(t.quoteVolume),
            change_percent_24h: safePercent(parseFloat(t.priceChangePercent)),
            trade_count: t.count,
            data_source: 'binance',
            is_complete: false,
        };
    });

    const batchSize = 50;
    let upsertedCount = 0;
    for (let i = 0; i < records.length; i += batchSize) {
        const batch = records.slice(i, i + batchSize);
        const { error } = await supabase
            .from('asset_daily_summary')
            .upsert(batch, { onConflict: 'symbol,date', ignoreDuplicates: false });

        if (error) console.error(`  Upsert error batch ${Math.floor(i / batchSize) + 1}:`, error.message);
        else upsertedCount += batch.length;
    }
    console.log(`✅ Upserted ${upsertedCount}/${records.length} live snapshots`);

    // 5. Taker flow for today's snapshot: the last 24 hourly candles, the window closest to the
    //    rolling 24h ticker above (the ticker has no taker data).
    console.log(`\n  Fetching taker flow for ${relevantTickers.length} assets...`);
    let takerUpdated = 0;
    for (const ticker of relevantTickers) {
        const ourSymbol = symbolMap.get(ticker.symbol)!;
        try {
            const taker = rollingTaker(await klines(ticker.symbol, '1h', 24));
            const { error: takerError } = await supabase
                .from('asset_daily_summary')
                .update(taker)
                .eq('symbol', ourSymbol)
                .eq('date', today);
            if (!takerError) takerUpdated++;
        } catch {
            // Taker data is supplementary; the next run retries
        }
        await new Promise(r => setTimeout(r, 50)); // 1200 req/min limit
    }
    console.log(`✅ Taker flow updated for ${takerUpdated}/${relevantTickers.length} assets`);

    // 6. Finalize completed days from their final daily candle (also fills days that have no row yet)
    console.log(`\n  Finalizing the last ${FINALIZE_DAYS} completed days...`);
    let finalizedRows = 0;
    let finalizeFailed = 0;
    const now = Date.now();
    for (const ticker of relevantTickers) {
        const ourSymbol = symbolMap.get(ticker.symbol)!;
        try {
            const bars = completedDays(await klines(ticker.symbol, '1d', FINALIZE_DAYS + 1), now).map(finalizedBar);
            if (bars.length === 0) continue;
            const { error } = await supabase
                .from('asset_daily_summary')
                .upsert(bars.map(b => ({ symbol: ourSymbol, ...b, data_source: 'binance' })), { onConflict: 'symbol,date', ignoreDuplicates: false });
            if (error) { finalizeFailed++; console.error(`  Finalize error ${ourSymbol}: ${error.message}`); }
            else finalizedRows += bars.length;
        } catch (err: any) {
            finalizeFailed++;
            if (finalizeFailed <= 3) console.error(`  Finalize failed ${ourSymbol}: ${err?.message}`);
        }
        await new Promise(r => setTimeout(r, 50));
    }
    console.log(`✅ Finalized ${finalizedRows} rows (${finalizeFailed} assets failed)`);

    console.log(`\nDone in ${Date.now() - startTime}ms\n`);
}

main().then(() => process.exit(0)).catch(err => { console.error('💥 Fatal:', err); process.exit(1); });
