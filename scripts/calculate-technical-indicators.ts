/**
 * calculate-technical-indicators.ts
 *
 * Calculates RSI, MACD, Bollinger Bands, EMA, SMA, ATR, Stochastic RSI,
 * VWAP, ADX, and volume trend for all active assets.
 *
 * Uses a 250-day rolling window from the database to ensure SMA-200
 * and other long-period indicators are calculated accurately.
 *
 * Usage:
 *   npx tsx scripts/calculate-technical-indicators.ts [--date 2026-02-10]
 */

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

import {
    OHLCVData,
    calculateRSI,
    calculateEMA,
    calculateSMA,
    calculateMACD,
    calculateBollingerBands,
    calculateATR,
    calculateStochasticRSI,
    calculateVWAP,
    analyzeVolumeTrend,
    calculateADX,
    calculateTradingViewRatings
} from './lib/indicators';

// ---- Main ----

const ROLLING_WINDOW_DAYS = 250; // Enough for SMA-200 + buffer

async function calculateForSymbol(supabase: any, symbol: string, date: string) {
    // 1. Pull the last 250 days of daily data from the summary table to use as context
    const { data: ohlcvData, error: ohlcvError } = await supabase
        .from('asset_daily_summary')
        .select('date, open, high, low, close, volume')
        .eq('symbol', symbol)
        .lt('date', date)
        .order('date', { ascending: false })
        .limit(ROLLING_WINDOW_DAYS);

    if (ohlcvError) {
        console.error(`  ❌ History fetch error for ${symbol}:`, ohlcvError.message);
        return null;
    }

    // 2. Also get the "current" day's data (the one we are calculating for)
    // This reads 1d candles for "today"
    const { data: currentDay, error: currentError } = await supabase.rpc('get_daily_candles', {
        p_symbol: symbol,
        p_start_date: date,
        p_end_date: date,
    });

    if (currentError) {
        console.error(`  ❌ Current day fetch error for ${symbol}:`, currentError.message);
        return null;
    }

    // 3. Combine history and current day
    const combinedData = [...(ohlcvData || []).reverse(), ...(currentDay || [])];

    if (!combinedData || combinedData.length < 30) {
        return null; // Not enough data for meaningful indicators
    }

    const prices = combinedData.map((d: any) => Number(d.close));
    const typed: OHLCVData[] = combinedData.map((d: any) => ({
        timestamp: d.date || d.timestamp,
        open: Number(d.open),
        high: Number(d.high),
        low: Number(d.low),
        close: Number(d.close),
        volume: Number(d.volume),
    }));

    const latestCandle = typed[typed.length - 1];
    if (!latestCandle || latestCandle.open === null || latestCandle.high === null || latestCandle.low === null || latestCandle.close === null || isNaN(latestCandle.open) || isNaN(latestCandle.high) || isNaN(latestCandle.low) || isNaN(latestCandle.close)) {
        console.warn(`  ⚠️  Skipping ${symbol}: Missing current OHLCV data.`);
        return null;
    }

    // 4. Calculate Indicators
    const rsi14 = calculateRSI(prices, 14);
    const macd = calculateMACD(prices);
    const bb = calculateBollingerBands(prices, 20, 2);
    const ema20 = calculateEMA(prices, 20);
    const ema50 = calculateEMA(prices, 50);
    const atr14 = calculateATR(typed, 14);
    const stochRsi = calculateStochasticRSI(prices, 14);
    const vwap = calculateVWAP(typed.slice(-30));
    const volTrend = analyzeVolumeTrend(typed);

    // SMA: Accurate thanks to 250-day context
    const sma50 = prices.length >= 50 ? calculateSMA(prices, 50) : null;
    const sma200 = prices.length >= 200 ? calculateSMA(prices, 200) : null;

    const adxResult = calculateADX(typed, 14);

    // TradingView Deterministic Ratings
    const tvRatings = calculateTradingViewRatings(prices, typed);

    // 5. Check if a record already exists with high-fidelity Binance data
    //    If so, only update technical indicator columns — do NOT overwrite OHLCV or change_24h
    const { data: existingRecord } = await supabase
        .from('asset_daily_summary')
        .select('id, volume, change_24h, data_source')
        .eq('symbol', symbol)
        .eq('date', date)
        .maybeSingle();

    const hasBinanceData = existingRecord && (
        existingRecord.data_source === 'binance' ||
        (existingRecord.volume && existingRecord.volume > latestCandle.volume * 10) ||
        existingRecord.change_24h !== null
    );

    const upsertData: Record<string, any> = {
        symbol, date,
        rsi_14: rsi14, macd, bollinger_bands: bb,
        ema_20: ema20, ema_50: ema50,
        sma_50: sma50, sma_200: sma200,
        atr_14: atr14, stochastic_rsi: stochRsi, vwap,
        volume_trend: volTrend,
        ...tvRatings,
        updated_at: new Date().toISOString(),
    };

    // Only include OHLCV if there's no existing high-fidelity data
    if (!hasBinanceData) {
        upsertData.open = latestCandle.open;
        upsertData.high = latestCandle.high;
        upsertData.low = latestCandle.low;
        upsertData.close = latestCandle.close;
        upsertData.volume = latestCandle.volume;
    }

    if (adxResult) {
        upsertData.adx_14 = adxResult.adx;
        upsertData.di_plus_14 = adxResult.plusDI;
        upsertData.di_minus_14 = adxResult.minusDI;
    }

    // 6. Update DB
    let updateError;
    if (existingRecord) {
        // Use .update() to only modify the technical indicator columns
        const { error } = await supabase
            .from('asset_daily_summary')
            .update(upsertData)
            .eq('symbol', symbol)
            .eq('date', date);
        updateError = error;
    } else {
        // Record doesn't exist, use .upsert() with full OHLCV data
        const fullUpsertData = {
            ...upsertData,
            open: latestCandle.open,
            high: latestCandle.high,
            low: latestCandle.low,
            close: latestCandle.close,
            volume: latestCandle.volume,
            data_source: 'aggregated'
        };
        const { error } = await supabase
            .from('asset_daily_summary')
            .upsert(fullUpsertData, { onConflict: 'symbol,date' });
        updateError = error;
    }

    if (updateError) {
        console.error(`  ❌ Update error for ${symbol}:`, updateError.message);
        return null;
    }

    console.log(`Successfully calculated indicators for ${symbol}${hasBinanceData ? ' (preserved Binance OHLCV)' : ''}`);
    return symbol;
}

async function main() {
    // Validate env
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const dateArgIdx = process.argv.indexOf('--date');
    const targetDate = dateArgIdx !== -1 && process.argv[dateArgIdx + 1]
        ? process.argv[dateArgIdx + 1]
        : new Date().toISOString().split('T')[0];

    console.log(`\n🚀 Calculating technical indicators for ${targetDate}`);
    console.log(`   Rolling window: ${ROLLING_WINDOW_DAYS} days (History from DB + 1m data)\n`);

    const { data: assets, error } = await supabase
        .from('assets').select('symbol').eq('is_active', true);
    if (error) throw new Error(`Failed to fetch assets: ${error.message}`);
    if (!assets || assets.length === 0) { console.log('No active assets.'); return; }

    console.log(`  Processing ${assets.length} assets...\n`);

    let success = 0, skipped = 0;

    for (const asset of assets) {
        const result = await calculateForSymbol(supabase, asset.symbol, targetDate);
        if (result) {
            success++;
            process.stdout.write(`  ✅ ${result}  `);
            if (success % 5 === 0) console.log('');
        } else {
            skipped++;
        }
    }

    console.log(`\n\n🏁 Done! ${success} calculated, ${skipped} skipped out of ${assets.length}\n`);
}

main()
    .then(() => process.exit(0))
    .catch(err => { console.error('💥 Fatal:', err); process.exit(1); });
