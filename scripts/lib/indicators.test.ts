// Run: npx tsx --test scripts/lib/indicators.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateADX, calculateATR, calculateBollingerBands, calculateMACD, calculateRSI, calculateStochasticRSI, calculateSupportResistance, calculateVWAP, roundToScale, rsiSeries, type OHLCVData } from './indicators';

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

// ---- Price precision (finixhub: stored bands of 0 / 0 for cheap coins) ----
// The daily summary is read by the app to build plan levels. A flat toFixed(2) stored a $0.0000045
// coin's Bollinger bands as 0 / 0, and 2-decimal bands are meaningless for anything under about $0.5.

const meanSd = (xs: number[]) => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return { m, sd: Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length) };
};
const wave = (base: number, n = 40) => Array.from({ length: n }, (_, i) => base * (1 + 0.04 * Math.sin(i / 2) + 0.0005 * i));

test('roundToScale keeps cents from 1 up and 4 significant digits below 1', () => {
  assert.equal(roundToScale(83834.3217), 83834.32);
  assert.equal(roundToScale(1.10349), 1.1);
  assert.equal(roundToScale(0.52349), 0.5235);
  assert.equal(roundToScale(0.0063521), 0.006352);
  assert.equal(roundToScale(0.0000044749), 0.000004475);
  assert.equal(roundToScale(-0.0000012344), -0.000001234);
  assert.equal(roundToScale(0), 0);
  assert.equal(roundToScale(Number.NaN), 0);
  assert.equal(roundToScale(0.0123456, 6), 0.012346); // a larger minimum is respected
  assert.equal(roundToScale(0.123456, 4), 0.1235);
});

test('Bollinger bands of a $0.0000045 coin are not stored as 0 / 0', () => {
  const prices = wave(0.0000045);
  const bb = calculateBollingerBands(prices);
  const { m, sd } = meanSd(prices.slice(-20));
  assert.ok(bb.upper > 0 && bb.lower > 0 && bb.upper > bb.middle && bb.middle > bb.lower, JSON.stringify(bb));
  assert.ok(Math.abs(bb.upper - (m + 2 * sd)) / (m + 2 * sd) < 1e-3, `upper ${bb.upper}`);
  assert.ok(Math.abs(bb.lower - (m - 2 * sd)) / (m - 2 * sd) < 1e-3, `lower ${bb.lower}`);
});

test('Bollinger bands of a $0.07 coin keep their width (stored as 0.07 / 0.08 before)', () => {
  const prices = wave(0.07);
  const bb = calculateBollingerBands(prices);
  const { m, sd } = meanSd(prices.slice(-20));
  assert.ok(Math.abs(bb.upper - (m + 2 * sd)) / (m + 2 * sd) < 1e-3, `upper ${bb.upper}`);
  assert.ok(Math.abs(bb.lower - (m - 2 * sd)) / (m - 2 * sd) < 1e-3, `lower ${bb.lower}`);
  assert.ok(bb.upper - bb.lower > 0.005, `width ${bb.upper - bb.lower}`);
});

test('Bollinger bands of an expensive asset are unchanged: still rounded to cents', () => {
  const prices = wave(78000);
  const bb = calculateBollingerBands(prices);
  const { m, sd } = meanSd(prices.slice(-20));
  assert.equal(bb.upper, parseFloat((m + 2 * sd).toFixed(2)));
  assert.equal(bb.middle, parseFloat(m.toFixed(2)));
  assert.equal(bb.lower, parseFloat((m - 2 * sd).toFixed(2)));
});

test('MACD of a cheap trending coin is not rounded to 0', () => {
  const prices = Array.from({ length: 80 }, (_, i) => 0.0000045 * (1 + i * 0.01));
  const macd = calculateMACD(prices);
  assert.ok(macd.macd > 0, JSON.stringify(macd));
  assert.ok(macd.signal > 0, JSON.stringify(macd));
});

test('VWAP of a cheap coin is not rounded to 0', () => {
  const candles = candles_(wave(0.0000045, 20));
  assert.ok(calculateVWAP(candles) > 0);
});

test('support and resistance of a cheap coin still produce distinct levels', () => {
  const closes = wave(0.0063, 60);
  const sr = calculateSupportResistance(closes.map((c) => ({ high: c * 1.02, low: c * 0.98, close: c })));
  const last = closes[closes.length - 1];
  assert.ok(sr.support.length + sr.resistance.length > 0, JSON.stringify(sr));
  // every level sits near the price, not on a coarse 2-decimal grid (0.01 for a $0.0063 coin)
  for (const v of [...sr.support, ...sr.resistance]) assert.ok(Math.abs(v - last) / last < 0.25, `level ${v} vs price ${last}`);
  assert.equal(new Set([...sr.support, ...sr.resistance]).size, sr.support.length + sr.resistance.length);
});

function candles_(closes: number[]): OHLCVData[] {
  return closes.map((c, i) => ({ timestamp: String(i), open: c, high: c * 1.01, low: c * 0.99, close: c, volume: 1000 + i }) as OHLCVData);
}
