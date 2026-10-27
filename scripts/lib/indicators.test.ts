// Run: npx tsx --test scripts/lib/indicators.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateADX, calculateATR, calculateRSI, calculateStochasticRSI, rsiSeries, type OHLCVData } from './indicators';

// Wilder's RSI worked example (StockCharts ChartSchool), closes rounded to cents. RSI_DEF is Wilder's
// definition computed by an independent implementation; the same fixture tests the chat's
// calculate tool in finixhub (supabase/functions/_shared/agent/calc/indicators.test.ts).
const CLOSES = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64, 46.21, 46.25, 45.71, 46.45, 45.78, 45.35, 44.03, 44.18, 44.22, 44.57, 43.42, 42.66, 43.13];
const RSI_DEF = [70.46, 66.25, 66.48, 69.35, 66.29, 57.92, 62.88, 63.21, 56.01, 62.34, 54.67, 50.39, 40.02, 41.49, 41.90, 45.50, 37.32, 33.09, 37.79];

const candles = (closes: number[], spread = 1): OHLCVData[] =>
  closes.map((c, i) => ({ timestamp: `d${i}`, open: c, high: c + spread, low: c - spread, close: c, volume: 1 }));
const near = (a: number, b: number, tol: number) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);

test('RSI is the latest value of Wilder RSI over the whole series', () => {
  RSI_DEF.forEach((ref, i) => near(calculateRSI(CLOSES.slice(0, 15 + i), 14), ref, 0.005));
  const series = rsiSeries(CLOSES, 14);
  near(series.at(-1) as number, 37.79, 0.005);
});

test('RSI reflects the most recent days, not the start of the window (the stored-RSI bug)', () => {
  // 200 days falling, then 30 days rising: today's RSI must be high.
  const prices = [...Array.from({ length: 200 }, (_, i) => 300 - i), ...Array.from({ length: 30 }, (_, i) => 101 + i * 2)];
  assert.ok(calculateRSI(prices, 14) > 90, `got ${calculateRSI(prices, 14)}`);
});

test('ATR is Wilder-smoothed: a constant range gives that range', () => {
  near(calculateATR(candles(Array(60).fill(100), 2), 14), 4, 1e-9);
});

test('ATR follows a change in range gradually (Wilder), not a 14-day plain mean', () => {
  const c = [...candles(Array(60).fill(100), 1), ...candles(Array(5).fill(100), 6)];
  // plain mean of the last 14 TRs would be (9×2 + 5×12)/14 = 5.57; Wilder gives less
  const a = calculateATR(c, 14);
  assert.ok(a > 2 && a < 5.5, `got ${a}`);
});

test('ADX: steady uptrend → 100 with -DI 0; flat → 0', () => {
  const up = calculateADX(candles(Array.from({ length: 80 }, (_, i) => 100 + i * 2), 1), 14)!;
  near(up.adx, 100, 1e-6);
  assert.equal(up.minusDI, 0);
  assert.equal(calculateADX(candles(Array(60).fill(50), 1), 14)!.adx, 0);
});

// A fixed wave with drift (no randomness). WILDER holds the values the chat's calculate tool in finixhub
// computes for it (supabase/functions/_shared/agent/calc/indicators.ts), so both repos agree.
const WAVE: OHLCVData[] = Array.from({ length: 120 }, (_, i) => {
  const close = 100 + i * 0.3 + 8 * Math.sin(i / 5) + 3 * Math.sin(i / 2.3);
  return { timestamp: `d${i}`, open: close, high: close + 1.5 + Math.abs(Math.sin(i)), low: close - 1.5 - Math.abs(Math.cos(i)), close, volume: 1 };
});
const WILDER = { rsi: 52.2984319, atr: 4.33228617, adx: 25.6465431, plus_di: 15.13652511, minus_di: 14.09459514 };

test('RSI, ATR, ADX and DI match the chat tool on the same candles', () => {
  near(calculateRSI(WAVE.map((x) => x.close), 14), WILDER.rsi, 1e-4);
  near(calculateATR(WAVE, 14), WILDER.atr, 1e-4);
  const a = calculateADX(WAVE, 14)!;
  near(a.adx, WILDER.adx, 1e-4);
  near(a.plusDI, WILDER.plus_di, 1e-4);
  near(a.minusDI, WILDER.minus_di, 1e-4);
});

test('Stochastic RSI uses Wilder RSI and stays within 0..100', () => {
  const s = calculateStochasticRSI(CLOSES, 14);
  assert.ok(s.k >= 0 && s.k <= 100 && s.d >= 0 && s.d <= 100);
});
