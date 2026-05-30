/**
 * sync-active-assets.ts
 *
 * Discovers active crypto assets from Binance + CoinGecko.
 * Upserts them into the Supabase `assets` table.
 *
 * Usage: npx tsx scripts/sync-active-assets.ts
 */

import { createClient } from '@supabase/supabase-js';

interface CoinGeckoMarket {
    id: string;
    symbol: string;
    name: string;
    image: string;
    market_cap: number;
    market_cap_rank: number;
    current_price: number;
    total_volume: number;
    circulating_supply: number;
    total_supply: number;
    max_supply: number;
}

const MIN_MARKET_CAP = 100000;

async function main() {
    const SUPABASE_URL = process.env.SUPABASE_URL!;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    const startTime = Date.now();

    console.log('🚀 Starting asset discovery...\n');

    // 1. Fetch Binance exchange info (try .com then .us)
    console.log('  Fetching Binance exchange info...');
    let exchangeInfo: any;
    try {
        const exchangeInfoRes = await fetch('https://api.binance.com/api/v3/exchangeInfo');
        if (!exchangeInfoRes.ok) throw new Error(String(exchangeInfoRes.status));
        exchangeInfo = await exchangeInfoRes.json();
    } catch (err: any) {
        console.warn(`  ⚠️ api.binance.com failed (${err.message}), trying api.binance.us...`);
        try {
            const exchangeInfoRes = await fetch('https://api.binance.us/api/v3/exchangeInfo');
            if (!exchangeInfoRes.ok) throw new Error(String(exchangeInfoRes.status));
            exchangeInfo = await exchangeInfoRes.json();
        } catch (err2: any) {
            throw new Error(`Both Binance APIs failed. .com:${err.message}, .us:${err2.message}`);
        }
    }

    const usdtPairs = exchangeInfo.symbols.filter((s: any) =>
        s.status === 'TRADING' &&
        s.quoteAsset === 'USDT' &&
        !s.baseAsset.includes('UP') &&
        !s.baseAsset.includes('DOWN') &&
        !s.baseAsset.includes('BEAR') &&
        !s.baseAsset.includes('BULL') &&
        !s.baseAsset.endsWith('3L') &&
        !s.baseAsset.endsWith('3S') &&
        !s.baseAsset.endsWith('2L') &&
        !s.baseAsset.endsWith('2S'),
    );
    console.log(`  Found ${usdtPairs.length} active USDT pairs on Binance`);

    const binanceSymbolMap = new Map<string, string>();
    for (const pair of usdtPairs) {
        binanceSymbolMap.set(pair.baseAsset.toUpperCase(), pair.symbol);
    }

    // 2. Fetch CoinGecko market data
    console.log('  Fetching CoinGecko market data...');
    const allCoins: CoinGeckoMarket[] = [];
    const maxAssets = 500;
    const pages = Math.ceil(maxAssets / 250);

    for (let page = 1; page <= pages; page++) {
        const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${page}&sparkline=false`;
        try {
            const cgHeaders: Record<string, string> = {};
            if (process.env.COINGECKO_API_KEY) {
                cgHeaders['x-cg-demo-api-key'] = process.env.COINGECKO_API_KEY;
            }
            const res = await fetch(url, { headers: cgHeaders });
            if (!res.ok) { console.warn(`  CoinGecko page ${page} failed: ${res.status}`); break; }
            const coins: CoinGeckoMarket[] = await res.json();
            if (coins.length === 0) break;
            allCoins.push(...coins);
            console.log(`  Page ${page}: ${coins.length} coins (total: ${allCoins.length})`);
            if (page < pages) await new Promise(r => setTimeout(r, 2500));
        } catch (e: any) {
            console.error(`  Error page ${page}:`, e?.message);
            break;
        }
    }

    // 3. Filter eligible coins
    const eligibleCoins = allCoins.filter(coin => {
        const symbol = coin.symbol.toUpperCase();
        return binanceSymbolMap.has(symbol) && coin.market_cap >= MIN_MARKET_CAP;
    });
    console.log(`\n  ${eligibleCoins.length} coins meet criteria\n`);

    // 4. Prepare & deduplicate
    const seenSymbols = new Set<string>();
    const assetsToUpsert = [];

    for (const coin of eligibleCoins) {
        const symbol = coin.symbol.toUpperCase();
        if (seenSymbols.has(symbol)) continue;
        seenSymbols.add(symbol);
        assetsToUpsert.push({
            symbol,
            name: coin.name,
            category: 'cryptocurrency',
            logo_url: coin.image,
            binance_symbol: binanceSymbolMap.get(symbol),
            coingecko_id: coin.id,
            market_cap: coin.market_cap,
            circulating_supply: coin.circulating_supply,
            total_supply: coin.total_supply,
            max_supply: coin.max_supply,
            rank_by_market_cap: coin.market_cap_rank,
            is_active: true,
            updated_at: new Date().toISOString(),
        });
    }

    // 5. Upsert in batches
    console.log(`  Upserting ${assetsToUpsert.length} assets...`);
    const batchSize = 50;
    let upsertedCount = 0;

    for (let i = 0; i < assetsToUpsert.length; i += batchSize) {
        const batch = assetsToUpsert.slice(i, i + batchSize);
        const { error } = await supabase.from('assets').upsert(batch, { onConflict: 'symbol', ignoreDuplicates: false });
        if (error) console.error(`  Upsert error:`, error.message);
        else upsertedCount += batch.length;
    }

    // 6. Deactivate stale assets
    const activeSymbols = new Set(assetsToUpsert.map(a => a.symbol));
    const { data: existingAssets } = await supabase.from('assets').select('symbol').eq('is_active', true);
    const stablecoins = ['USDT', 'USDC', 'DAI', 'BUSD', 'TUSD', 'USDP', 'GUSD'];
    const toDeactivate = (existingAssets || [])
        .filter(a => !activeSymbols.has(a.symbol) && !stablecoins.includes(a.symbol))
        .map(a => a.symbol);

    if (toDeactivate.length > 0) {
        await supabase.from('assets').update({ is_active: false }).in('symbol', toDeactivate);
        console.log(`  Deactivated ${toDeactivate.length} stale assets`);
    }

    const duration = Date.now() - startTime;
    console.log(`\n✅ Done! Upserted ${upsertedCount} assets in ${duration}ms\n`);
}

main().then(() => process.exit(0)).catch(err => { console.error('💥 Fatal:', err); process.exit(1); });
