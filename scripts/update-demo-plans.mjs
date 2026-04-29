import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
 
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
 
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
 
if (!supabaseUrl || !supabaseKey) {
    console.error('Missing required env vars: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
}
 
const supabase = createClient(supabaseUrl, supabaseKey);
 
const STATIC_FALLBACK = {
    BTC: { price: 95600, changePercent: 2.4 },
    ETH: { price: 3520, changePercent: -1.2 },
    SOL: { price: 178, changePercent: 4.1 },
};
 
async function fetchBinanceTicker(symbol) {
    const paths = [
        `https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`,
        `https://api.binance.us/api/v3/ticker/24hr?symbol=${symbol}`,
    ];
 
    for (const url of paths) {
        try {
            const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
            if (!res.ok) {
                console.warn(`  ${url} → HTTP ${res.status}`);
                continue;
            }
            const data = await res.json();
            if (!data || typeof data.lastPrice !== 'string') {
                console.warn(`  ${url} → invalid body`);
                continue;
            }
            return {
                price: parseFloat(data.lastPrice),
                changePercent: parseFloat(data.priceChangePercent || '0'),
            };
        } catch (err) {
            console.warn(`  ${url} → ${err.message}`);
        }
    }
    return null;
}
 
async function uploadToStorage(plans) {
    try {
        const jsonContent = JSON.stringify(plans, null, 2);
        const blob = new Blob([jsonContent], { type: 'application/json' });
 
        const { data, error } = await supabase.storage
            .from('demo-plans')
            .upload('active.json', blob, {
                contentType: 'application/json',
                upsert: true,
            });
 
        if (error) {
            console.error('Failed to upload to Supabase Storage:', error);
            return false;
        }
 
        console.log('Uploaded demo plans to Supabase Storage: demo-plans/active.json');
        return true;
    } catch (err) {
        console.error('Error uploading to Supabase Storage:', err);
        return false;
    }
}
 
async function getAssetsData() {
    const assets = ['BTC', 'ETH', 'SOL'];
    const plans = [];
    const now = new Date();
 
    for (const asset of assets) {
        const symbol = `${asset}USDT`;
        console.log(`Fetching ${symbol}...`);
 
        let ticker = await fetchBinanceTicker(symbol);
        if (!ticker) {
            ticker = STATIC_FALLBACK[asset];
            console.warn(`  Falling back to static price for ${asset}: $${ticker.price}`);
        } else {
            console.log(`  ${asset}: $${ticker.price} (${ticker.changePercent >= 0 ? '+' : ''}${ticker.changePercent.toFixed(2)}%)`);
        }
 
        const currentPrice = ticker.price;
        let bias = ticker.changePercent > 0 ? 'bullish' : 'bearish';
        let entry = currentPrice * (1 + (ticker.changePercent > 0 ? -0.005 : 0.005));
 
        if (asset === 'SOL') {
            bias = 'bullish';
            entry = currentPrice * 1.012;
        }
 
        entry = parseFloat(entry.toPrecision(5));
        const slDistance = entry * 0.05;
        const tpDistance = entry * 0.15;
        const invalidation = bias === 'bullish' ? entry - slDistance : entry + slDistance;
        const takeProfit = bias === 'bullish' ? entry + tpDistance : entry - tpDistance;
 
        plans.push({
            id: `demo-active-${asset.toLowerCase()}`,
            user_id: 'mock-user',
            asset_symbol: asset,
            bias: bias,
            time_horizon_months: 1,
            invalidation_level: parseFloat(invalidation.toPrecision(5)),
            risk_percent: 2,
            thesis: `Market structure acting ${bias} on daily timeframe for ${asset}. Key liquidity level triggered at entry.`,
            take_profit_levels: [{ level: parseFloat(takeProfit.toPrecision(5)), percent_to_close: 100 }],
            entry_price: entry,
            peak_price: bias === 'bullish' ? currentPrice * 1.018 : currentPrice * 0.982,
            max_allowed_giveback_percent: 50,
            exit_structure_defined: true,
            is_active: true,
            created_at: new Date(now.getTime() - 2 * 86400000).toISOString(),
            last_reviewed: new Date(now.getTime() - 3600000).toISOString(),
            confluence_factors: ['Daily Orderblock', 'Volume Flow'],
            plan_quality_score: 85,
            invalidation_streak: Math.floor(Math.random() * 3),
            status: 'open'
        });
    }
 
    const uploaded = await uploadToStorage(plans);
    if (!uploaded) {
        console.error('Failed to upload demo plans to Supabase Storage');
        process.exit(1);
    }
 
    console.log(`Generated ${plans.length} demo active plans.`);
    process.exit(0);
}
 
getAssetsData().catch(err => {
    console.error('Unhandled error:', err);
    process.exit(1);
});
