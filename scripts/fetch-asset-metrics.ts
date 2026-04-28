/**
 * fetch-asset-metrics.ts
 *
 * Fetches 24h ticker data from Binance for all active assets
 * and updates asset_daily_summary with current prices.
 *
 * Usage: npx tsx scripts/fetch-asset-metrics.ts
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

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

    // 2. Fetch 24h tickers from Binance (try .com then .us)
    console.log(`  Fetching 24h tickers for ${assets.length} assets...`);
    let allTickers: BinanceTicker24h[] = [];

    try {
        const tickerRes = await fetch('https://api.binance.com/api/v3/ticker/24hr');
        if (!tickerRes.ok) throw new Error(String(tickerRes.status));
        allTickers = await tickerRes.json();
    } catch (err: any) {
        console.warn(`  ⚠️ api.binance.com failed (${err.message}), trying api.binance.us...`);
        try {
            const tickerRes = await fetch('https://api.binance.us/api/v3/ticker/24hr');
            if (!tickerRes.ok) throw new Error(String(tickerRes.status));
            allTickers = await tickerRes.json();
        } catch (err2: any) {
            throw new Error(`Both Binance APIs failed. .com:${err.message}, .us:${err2.message}`);
        }
    }

    // 3. Filter to our assets
    const relevantTickers = allTickers.filter(t => symbolMap.has(t.symbol));
    console.log(`  Found ${relevantTickers.length} matching tickers\n`);

    // 4. Upsert to asset_daily_summary
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
        };
    });

    // Upsert in batches
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

    const duration = Date.now() - startTime;
    console.log(`✅ Upserted ${upsertedCount}/${records.length} ticker metrics in ${duration}ms`);

    // 5. Fetch Taker Buy Volume from Binance klines (1d)
    // The /ticker/24hr endpoint doesn't include taker data.
    // Kline response index 9 = "Taker buy base asset volume"
    console.log(`\n  Fetching taker buy/sell volume for ${relevantTickers.length} assets...`);
    let takerUpdated = 0;

    // Process in sequential batches to avoid rate limiting
    for (const ticker of relevantTickers) {
        const ourSymbol = symbolMap.get(ticker.symbol)!;
        try {
            let klineData: any[];
            try {
                const klineRes = await fetch(
                    `https://api.binance.com/api/v3/klines?symbol=${ticker.symbol}&interval=1d&limit=1`
                );
                if (!klineRes.ok) throw new Error(String(klineRes.status));
                klineData = await klineRes.json();
            } catch {
                const klineRes = await fetch(
                    `https://api.binance.us/api/v3/klines?symbol=${ticker.symbol}&interval=1d&limit=1`
                );
                if (!klineRes.ok) continue;
                klineData = await klineRes.json();
            }

            if (klineData && klineData.length > 0) {
                const kline = klineData[0];
                // Kline format: [openTime, open, high, low, close, volume, closeTime,
                //                quoteVolume, trades, takerBuyBaseVol, takerBuyQuoteVol, ignore]
                const totalVol = parseFloat(kline[5]);
                const takerBuyVol = parseFloat(kline[9]);
                const takerSellVol = totalVol - takerBuyVol;

                const { error: takerError } = await supabase
                    .from('asset_daily_summary')
                    .update({
                        taker_buy_volume: takerBuyVol,
                        taker_sell_volume: takerSellVol,
                    })
                    .eq('symbol', ourSymbol)
                    .eq('date', today);

                if (!takerError) takerUpdated++;
            }
        } catch (err: any) {
            // Skip silently — taker data is supplementary
        }

        // Small delay to respect rate limits (1200 req/min)
        await new Promise(r => setTimeout(r, 50));
    }

    const totalDuration = Date.now() - startTime;
    console.log(`✅ Done! Taker volume updated for ${takerUpdated}/${relevantTickers.length} assets. Total: ${totalDuration}ms\n`);
}

main().then(() => process.exit(0)).catch(err => { console.error('💥 Fatal:', err); process.exit(1); });
