import { createClient } from '@supabase/supabase-js';

async function getAssetsData() {
    const assets = ['BTC', 'ETH', 'SOL'];
    const plans = [];
    const now = new Date();

    for (const asset of assets) {
        const symbol = `${asset}USDT`;
        try {
            console.log(`Fetching ${symbol}...`);
            const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&limit=4`);
            const data = await res.json();

            const currentPrice = parseFloat(data[data.length - 1][4]);

            // Look at previous 3 days (excluding current incomplete day)
            const previousDays = data.slice(0, 3);
            const lows = previousDays.map(d => parseFloat(d[3]));
            const highs = previousDays.map(d => parseFloat(d[2]));

            const minLow = Math.min(...lows);
            const maxHigh = Math.max(...highs);

            const longProfit = currentPrice - minLow;
            const shortProfit = maxHigh - currentPrice;

            let bias = 'bullish';
            let entry = minLow;

            if (asset === 'SOL') {
                // Force negative transition for SOL to show a losing trade
                if (longProfit > shortProfit) {
                    bias = 'bullish';
                    entry = currentPrice * 1.012; // Entry is 1.2% above market -> -1.2% PnL
                } else {
                    bias = 'bearish';
                    entry = currentPrice * 0.988; // Entry is 1.2% below market -> -1.2% PnL
                }
            } else {
                if (longProfit > shortProfit) {
                    bias = 'bullish';
                    entry = minLow + (minLow * 0.005);
                } else {
                    bias = 'bearish';
                    entry = maxHigh - (maxHigh * 0.005);
                }
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
                peak_price: bias === 'bullish' ? Math.max(currentPrice, maxHigh) : Math.min(currentPrice, minLow),
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
        } catch (e) {
            console.error(`Error fetching for ${asset}`, e);
        }
    }

    const supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const { error } = await supabase.storage
        .from('demo-plans')
        .upload('active.json', JSON.stringify(plans), {
            contentType: 'application/json',
            upsert: true
        });

    if (error) {
        console.error('Failed to upload demo plans to Supabase Storage:', error);
        process.exit(1);
    }

    console.log(`Generated ${plans.length} demo active plans and uploaded to Supabase Storage.`);
    process.exit(0);
}

getAssetsData();
