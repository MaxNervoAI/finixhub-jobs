// Run: npx tsx --test scripts/lib/daily-bars.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completedDays, finalizedBar, rollingTaker, type Kline } from './daily-bars';

const DAY = 24 * 3600 * 1000;
const HOUR = 3600 * 1000;
const t = (iso: string) => Date.parse(iso);

/** Binance kline: [openTime, o, h, l, c, vol, closeTime, quoteVol, trades, takerBuyBase, takerBuyQuote, ignore] */
function kline(openIso: string, o: number, h: number, l: number, c: number, vol: number, quote: number, trades: number, takerBuy: number, span = DAY): Kline {
  const open = t(openIso);
  return [open, String(o), String(h), String(l), String(c), String(vol), open + span - 1, String(quote), trades, String(takerBuy), '0', '0'];
}

// BTCUSDT 2026-11-12 (UTC day), as stored in market_data_ohlcv.
const NOV_12 = kline('2026-11-12T00:00:00Z', 74032, 74217, 71117, 71428, 52.52, 3_800_000, 10492, 20.1);

test('a finalized bar takes every field from the one UTC-day candle', () => {
  const bar = finalizedBar(NOV_12);
  assert.equal(bar.date, '2026-11-12');
  assert.deepEqual([bar.open, bar.high, bar.low, bar.close], [74032, 74217, 71117, 71428]);
  assert.equal(bar.volume, 52.52);
  assert.equal(bar.quote_volume, 3_800_000);
  assert.equal(bar.trade_count, 10492);
  assert.equal(bar.is_complete, true);
});

test('taker buy plus taker sell equals the day volume, so the row is internally consistent', () => {
  const bar = finalizedBar(NOV_12);
  assert.equal(bar.taker_buy_volume, 20.1);
  assert.ok(Math.abs(bar.taker_buy_volume + bar.taker_sell_volume - bar.volume) < 1e-9);
});

test('a finalized bar reports the change over its own UTC day (close vs open)', () => {
  const bar = finalizedBar(NOV_12);
  assert.ok(Math.abs(bar.change_percent_24h - ((71428 - 74032) / 74032) * 100) < 1e-9);
});

test('only completed days are finalized; the candle still open is left alone', () => {
  const nov13 = kline('2026-11-13T00:00:00Z', 71463, 73680, 67600, 68304, 118.2, 8_000_000, 23351, 66.9);
  const nov14 = kline('2026-11-14T00:00:00Z', 68313, 68442, 66469, 67353, 35.2, 2_300_000, 7014, 24.4);
  const now = t('2026-11-14T10:00:00Z');
  const done = completedDays([NOV_12, nov13, nov14], now);
  assert.deepEqual(done.map((k) => finalizedBar(k).date), ['2026-11-12', '2026-11-13']);
});

test('rolling taker flow sums the last 24 hourly candles', () => {
  const hours = Array.from({ length: 24 }, (_, i) =>
    kline(new Date(t('2026-11-13T11:00:00Z') + i * HOUR).toISOString(), 1, 1, 1, 1, 4, 1, 1, 1.5, HOUR));
  const r = rollingTaker(hours);
  assert.equal(r.taker_buy_volume, 36);
  assert.equal(r.taker_sell_volume, 60);
});
