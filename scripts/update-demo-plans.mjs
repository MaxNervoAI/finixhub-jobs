import { createClient } from '@supabase/supabase-js';

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
    const urls = [
        `https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`,
        `https://api.binance.us/api/v3/ticker/24hr?symbol=${symbol}`,
    ];
    for (const url of urls) {
        try {
            const res = await fetch(url, { headers: { Accept: 'application/json' } });
            if (!res.ok) { console.warn(`  ${url} → HTTP ${res.status}`); continue; }
            const data = await res.json();
            if (!data || typeof data.lastPrice !== 'string') { console.warn(`  ${url} → invalid body`); continue; }
            return { price: parseFloat(data.lastPrice), changePercent: parseFloat(data.priceChangePercent || '0') };
        } catch (err) {
            console.warn(`  ${url} → ${err.message}`);
        }
    }
    return null;
}

async function fetchBinanceHistoricalPrice(symbol) {
    // limit=3 → data[0] = 2 days ago close, data[1] = yesterday close, data[2] = today (may be open)
    const urls = [
        `https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=1d&limit=3`,
        `https://api.binance.us/api/v3/klines?symbol=${symbol}USDT&interval=1d&limit=3`,
    ];
    for (const url of urls) {
        try {
            const res = await fetch(url, { headers: { Accept: 'application/json' } });
            if (!res.ok) { console.warn(`  ${url} → HTTP ${res.status}`); continue; }
            const data = await res.json();
            if (!Array.isArray(data) || data.length < 3) { console.warn(`  ${url} → invalid body`); continue; }
            return parseFloat(data[0][4]); // close from 2 days ago
        } catch (err) {
            console.warn(`  ${url} → ${err.message}`);
        }
    }
    return null;
}

async function generateAIThesis(asset, bias, entry, invalidation, target, currentPrice) {
    try {
        const prompt = `You are Finix AI, a clinical trading mentor. Create a concise 3-bullet trade thesis for:

Asset: ${asset}
Bias: ${bias}
Entry: ${entry}
Target: ${target}
Invalidation: ${invalidation}
Current Price: ${currentPrice}

Write 3 short, professional bullet points explaining WHY this trade works structurally. Be specific with numbers. Use the format:
• Point 1
• Point 2
• Point 3`;

        const res = await fetch(`${supabaseUrl}/functions/v1/chat-router`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${supabaseKey}` },
            body: JSON.stringify({ message: prompt, asset_symbol: asset, use_reasoning: false }),
        });
        if (!res.ok) { console.warn(`  AI thesis failed for ${asset}: HTTP ${res.status}`); return null; }
        const data = await res.json();
        return data.content ?? null;
    } catch (err) {
        console.warn(`  AI thesis error for ${asset}: ${err.message}`);
        return null;
    }
}

/** Fisher-Yates shuffle — returns a new shuffled array */
function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

async function uploadToStorage(plans) {
    try {
        const blob = new Blob([JSON.stringify(plans, null, 2)], { type: 'application/json' });
        const { error } = await supabase.storage
            .from('demo-plans')
            .upload('active.json', blob, { contentType: 'application/json', upsert: true });
        if (error) { console.error('Storage upload failed:', error.message); return false; }
        console.log('Uploaded to Supabase Storage: demo-plans/active.json');
        return true;
    } catch (err) {
        console.error('Storage upload error:', err.message);
        return false;
    }
}

async function run() {
    const now = new Date();
    const ASSETS = ['BTC', 'ETH', 'SOL'];

    // Randomly decide which asset is the loser (1 loser, 2 winners)
    const shuffled = shuffle(ASSETS);
    const loserAsset = shuffled[0];
    console.log(`\nToday's loser: ${loserAsset} | Winners: ${shuffled.slice(1).join(', ')}\n`);

    // Clean up old demo plans in DB (user_id IS NULL)
    const { error: delError } = await supabase
        .from('investment_plans')
        .delete()
        .is('user_id', null);
    if (delError) {
        console.warn('Could not clean up old demo plans:', delError.message);
    } else {
        console.log('Cleaned up old demo plans from database.\n');
    }

    const plans = [];

    for (const asset of ASSETS) {
        const symbol = `${asset}USDT`;
        console.log(`── ${asset} ──────────────────────────`);

        let ticker = await fetchBinanceTicker(symbol);
        if (!ticker) {
            ticker = STATIC_FALLBACK[asset];
            console.warn(`  Using static fallback: $${ticker.price}`);
        } else {
            console.log(`  Current price: $${ticker.price} (${ticker.changePercent >= 0 ? '+' : ''}${ticker.changePercent.toFixed(2)}%)`);
        }

        const currentPrice = ticker.price;

        let historicalPrice = await fetchBinanceHistoricalPrice(asset);
        if (!historicalPrice) {
            // If klines failed, estimate yesterday's close from 24h change
            const changeRatio = 1 + (ticker.changePercent / 100);
            historicalPrice = changeRatio !== 1 ? currentPrice / changeRatio : currentPrice * 0.99;
            console.warn(`  Historical from 24h change: $${historicalPrice.toFixed(2)}`);
        } else {
            console.log(`  Historical (prev day close): $${historicalPrice.toFixed(2)}`);
        }

        const isLoser = asset === loserAsset;
        const entry = parseFloat((historicalPrice * 1.005).toPrecision(5));

        // Winner: bias follows price direction (in profit)
        // Loser: bias is inverted so current price is past the SL
        let bias;
        if (isLoser) {
            bias = currentPrice > entry ? 'bearish' : 'bullish';
        } else {
            bias = currentPrice >= entry ? 'bullish' : 'bearish';
        }

        // Winner TP: always 15% beyond current price so the trade never appears "at target"
        // Loser SL: midpoint of entry and current so current is guaranteed past SL
        let invalidation, takeProfit;
        if (isLoser) {
            const midpoint = parseFloat(((entry + currentPrice) / 2).toPrecision(5));
            invalidation = midpoint;
            takeProfit = parseFloat((bias === 'bullish' ? entry + entry * 0.15 : entry - entry * 0.15).toPrecision(5));
        } else {
            const winnerSlDist = entry * 0.06;
            invalidation = parseFloat((bias === 'bullish' ? entry - winnerSlDist : entry + winnerSlDist).toPrecision(5));
            takeProfit = parseFloat((bias === 'bullish' ? currentPrice * 1.15 : currentPrice * 0.85).toPrecision(5));
        }
        const peakPrice = isLoser
            ? entry
            : bias === 'bullish'
                ? Math.max(currentPrice * 1.01, entry * 1.02)
                : Math.min(currentPrice * 0.99, entry * 0.98);

        console.log(`  Bias: ${bias} | Entry: $${entry} | SL: $${invalidation} | TP: $${takeProfit}`);
        console.log(`  Role: ${isLoser ? 'LOSER (past SL)' : 'WINNER (in profit)'}`);

        console.log(`  Generating AI thesis...`);
        const aiThesis = await generateAIThesis(asset, bias, entry, invalidation, takeProfit, currentPrice);
        const thesis = aiThesis
            || `Market structure acting ${bias} on daily timeframe for ${asset}. Key liquidity level triggered at entry.`;
        if (aiThesis) console.log(`  AI thesis: ok`);
        else console.warn(`  Using fallback thesis`);

        const plan = {
            user_id: null,
            asset_symbol: asset,
            bias,
            time_horizon_months: 1,
            invalidation_level: invalidation,
            risk_percent: 2,
            thesis,
            take_profit_levels: [{ level: takeProfit, percent_to_close: 100 }],
            entry_price: entry,
            peak_price: parseFloat(peakPrice.toPrecision(6)),
            max_allowed_giveback_percent: 50,
            exit_structure_defined: true,
            is_active: true,
            created_at: new Date(now.getTime() - 2 * 86_400_000).toISOString(),
            last_reviewed: new Date(now.getTime() - 3_600_000).toISOString(),
            confluence_factors: ['Daily Orderblock', 'Volume Flow'],
            plan_quality_score: 85,
            invalidation_streak: Math.floor(Math.random() * 3),
            status: 'active',
        };

        plans.push(plan);

        // Insert into DB
        const { error: dbError } = await supabase.from('investment_plans').insert(plan);
        if (dbError) console.error(`  DB insert failed for ${asset}:`, dbError.message);
        else console.log(`  DB insert: ok`);
    }

    // Upload to Supabase Storage for storage-based consumers
    await uploadToStorage(plans);

    console.log(`\nDone. Loser: ${loserAsset} | Winners: ${ASSETS.filter(a => a !== loserAsset).join(', ')}`);
}

run().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
