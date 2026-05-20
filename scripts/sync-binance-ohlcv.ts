/**
 * sync-binance-ohlcv.ts
 *
 * Fetches daily (1d) OHLCV candles from Binance for all active assets.
 *
 * Usage: npx tsx scripts/sync-binance-ohlcv.ts
 */

import { createClient } from '@supabase/supabase-js';

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

async function main() {
    const SUPABASE_URL = process.env.SUPABASE_URL!;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    const startTime = Date.now();

    console.log('🚀 Starting Binance 1d OHLCV sync...\n');

    const { data: assets, error } = await supabase
        .from('assets')
        .select('symbol, binance_symbol')
        .eq('is_active', true)
        .not('binance_symbol', 'is', null)
        .order('rank_by_market_cap', { ascending: true, nullsFirst: false })
        .limit(500);

    if (error) throw new Error(`Failed to fetch assets: ${error.message}`);
    if (!assets || assets.length === 0) { console.log('No assets found.'); return; }

    console.log(`  Processing ${assets.length} assets sequentially...\n`);

    let success = 0;
    let failed = 0;
    let totalCandles = 0;
    let consecutveErrors = 0;

    for (let i = 0; i < assets.length; i++) {
        const { symbol, binance_symbol } = assets[i];
        try {
            const path = `/api/v3/klines?symbol=${binance_symbol}&interval=1d&limit=30`;
            const response = await fetchBinance(path);

            if (!response.ok) {
                if (consecutveErrors < 3) console.error(`    ⚠️ Binance ${response.status} for ${binance_symbol}`);
                if (response.status === 418 || response.status === 429) {
                    console.error('    🛑 Rate limited! Waiting 30s...');
                    await new Promise(r => setTimeout(r, 30000));
                }
                failed++;
                consecutveErrors++;
                continue;
            }

            const klines: any[] = await response.json();
            if (!klines || klines.length === 0) {
                consecutveErrors = 0;
                continue;
            }

            const candles = klines.map(k => ({
                symbol,
                timeframe: '1d',
                timestamp: new Date(k[0]).toISOString(),
                open: parseFloat(k[1]),
                high: parseFloat(k[2]),
                low: parseFloat(k[3]),
                close: parseFloat(k[4]),
                volume: parseFloat(k[5]),
                quote_volume: parseFloat(k[7]),
                trade_count: parseInt(k[8], 10),
            }));

            const { error: upsertError } = await supabase
                .from('market_data_ohlcv')
                .upsert(candles, { onConflict: 'symbol,timeframe,timestamp', ignoreDuplicates: false });

            if (upsertError) {
                console.error(`    ❌ DB error for ${symbol}: ${upsertError.message}`);
                failed++;
            } else {
                success++;
                totalCandles += candles.length;
                consecutveErrors = 0;
            }

        } catch (err: any) {
            if (consecutveErrors < 3) console.error(`    ❌ ${symbol}: ${err?.message}`);
            failed++;
            consecutveErrors++;
        }

        // Rate limit delay
        if (i % 10 === 9) await new Promise(r => setTimeout(r, 500));
        else if (i % 3 === 2) await new Promise(r => setTimeout(r, 100));
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n✅ Done! ${success}/${assets.length} assets, ${totalCandles} candles, ${duration}s`);
    if (failed > 0) console.log(`  ❌ ${failed} failed`);
}

main().then(() => process.exit(0)).catch((err) => { console.error('💥 Fatal:', err); process.exit(1); });
