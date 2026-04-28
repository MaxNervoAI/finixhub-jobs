/**
 * validate-market-data.ts
 *
 * Sanity checks for market data pipeline output.
 * Runs as the final step in the daily GitHub Actions pipeline.
 * Exits with code 1 (fails the pipeline) if any check fails.
 *
 * Checks:
 *   1. Today's row exists in asset_daily_summary for BTC, ETH, SOL
 *   2. BTC close > $1,000 (catches ~$51k seed-price regression)
 *   3. BTC close < $10,000,000 (catches obvious data corruption)
 *   4. data_source = 'binance' for today's BTC row
 *   5. BTC change_percent_24h is between -50% and +50%
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE!;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('💥 Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const REQUIRED_SYMBOLS = ['BTC', 'ETH', 'SOL'];
const BTC_MIN_PRICE = 1_000;
const BTC_MAX_PRICE = 10_000_000;
const MAX_CHANGE_PCT = 50;

interface DailySummaryRow {
    symbol: string;
    date: string;
    close: number;
    data_source: string;
    change_percent_24h: number;
}

async function main() {
    const today = new Date().toISOString().split('T')[0];
    console.log(`\n🔍 Validating market data for ${today}...\n`);

    const { data, error } = await supabase
        .from('asset_daily_summary')
        .select('symbol, date, close, data_source, change_percent_24h')
        .in('symbol', REQUIRED_SYMBOLS)
        .eq('date', today);

    if (error) {
        console.error(`💥 DB query failed: ${error.message}`);
        process.exit(1);
    }

    const failures: string[] = [];
    const rows = (data || []) as DailySummaryRow[];

    // Check 1: All required symbols have a row for today
    for (const sym of REQUIRED_SYMBOLS) {
        const row = rows.find(r => r.symbol === sym);
        if (!row) {
            failures.push(`❌ [${sym}] No row in asset_daily_summary for today (${today})`);
        }
    }

    const btc = rows.find(r => r.symbol === 'BTC');
    if (btc) {
        const close = Number(btc.close);
        const changePct = Number(btc.change_percent_24h);

        // Check 2: BTC price above minimum
        if (close < BTC_MIN_PRICE) {
            failures.push(`❌ [BTC] close = $${close} is below minimum $${BTC_MIN_PRICE} — possible seed/fake data`);
        }

        // Check 3: BTC price below maximum
        if (close > BTC_MAX_PRICE) {
            failures.push(`❌ [BTC] close = $${close} is above maximum $${BTC_MAX_PRICE} — possible data corruption`);
        }

        // Check 4: data_source must be 'binance'
        if (btc.data_source !== 'binance') {
            failures.push(`❌ [BTC] data_source = '${btc.data_source}' — expected 'binance' for today's row`);
        }

        // Check 5: 24h change within plausible range
        if (Math.abs(changePct) > MAX_CHANGE_PCT) {
            failures.push(`❌ [BTC] change_percent_24h = ${changePct}% — exceeds ±${MAX_CHANGE_PCT}% threshold`);
        }

        if (failures.length === 0) {
            console.log(`  ✅ BTC close = $${close.toLocaleString()} (${changePct > 0 ? '+' : ''}${changePct.toFixed(2)}%)`);
            console.log(`  ✅ data_source = '${btc.data_source}'`);
        }
    }

    for (const sym of REQUIRED_SYMBOLS.filter(s => s !== 'BTC')) {
        const row = rows.find(r => r.symbol === sym);
        if (row) {
            console.log(`  ✅ ${sym} close = $${Number(row.close).toLocaleString()}`);
        }
    }

    if (failures.length > 0) {
        console.error('\n🚨 Validation FAILED:\n');
        failures.forEach(f => console.error(`  ${f}`));
        console.error('\n  → Run: npx tsx scripts/fetch-asset-metrics.ts to fix today\'s data');
        console.error('  → Or:  npx tsx scripts/backfill.ts --from <date> --to <date> --skip-insights\n');
        process.exit(1);
    }

    console.log(`\n✅ All market data checks passed for ${today}\n`);
    process.exit(0);
}

main().then(() => process.exit(0)).catch(err => {
    console.error('💥 Fatal:', err);
    process.exit(1);
});
