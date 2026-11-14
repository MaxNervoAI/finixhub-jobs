// Run: node --test scripts/lib/opportunity-eval.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateOpportunity, FILL_WINDOW_MS } from './opportunity-eval.mjs';

const MIN = 60_000;
const T0 = Date.parse('2026-11-14T00:05:23Z'); // signal generated
const startMs = Math.ceil(T0 / MIN) * MIN;

/** One closed 1m candle per entry; `i` is minutes after the first evaluated minute. */
function candle(i, low, high, close = (low + high) / 2) {
  const openTime = startMs + i * MIN;
  return { openTime, closeTime: openTime + MIN - 1, low, high, close };
}
function row(over = {}) {
  return {
    bias: 'short', entry_price: 71063, invalidation_level: 73114,
    take_profit_levels: [{ label: 'TP1', level: 68348 }, { label: 'TP2', level: 65800 }],
    created_at: new Date(T0).toISOString(), simulation_date: '2026-11-14',
    entry_filled: null, entry_filled_at: null, scanned_through: null, final_status: 'pending',
    ...over,
  };
}
const NOW = startMs + 3 * 24 * 60 * MIN;

test('BTC 2026-11-14: a short whose entry price never traded is not a winner', () => {
  // The day's real range was 66,469.59 to 68,442.97, so 71,063 was never reached.
  const candles = [];
  for (let i = 0; i <= 24 * 60; i++) candles.push(candle(i, 66469.59, 68442.97, 67353.77));
  const { patch } = evaluateOpportunity(row(), candles, NOW);
  assert.notEqual(patch.final_status, 'winner');
  assert.equal(patch.final_status, 'expired');
  assert.equal(patch.entry_filled, false);
  assert.equal(patch.tp_hit, false);
});

test('short: fill, then take-profit on a later candle is a winner', () => {
  const r = row({ entry_price: 100, invalidation_level: 105, take_profit_levels: [{ level: 95 }, { level: 90 }] });
  const { patch } = evaluateOpportunity(r, [
    candle(0, 97, 99),      // below entry, no fill
    candle(1, 99.5, 101),   // trades through 100: fill
    candle(2, 94.5, 99),    // TP1 touched
  ], NOW);
  assert.equal(patch.entry_filled, true);
  assert.equal(patch.final_status, 'winner');
  assert.equal(patch.tp_level_hit, 1);
});

test('a take-profit touched inside the fill candle does not count (order within a candle is unknown)', () => {
  const r = row({ entry_price: 100, invalidation_level: 105, take_profit_levels: [{ level: 95 }] });
  const { patch } = evaluateOpportunity(r, [candle(0, 94, 101)], NOW);
  assert.equal(patch.entry_filled, true);
  assert.equal(patch.final_status, 'pending');
});

test('a stop touched inside the fill candle is a loser (pessimistic)', () => {
  const r = row({ entry_price: 100, invalidation_level: 105, take_profit_levels: [{ level: 95 }] });
  const { patch } = evaluateOpportunity(r, [candle(0, 99, 106)], NOW);
  assert.equal(patch.final_status, 'loser');
  assert.equal(patch.sl_hit, true);
});

test('long pullback and long breakout entries both fill when price trades through them', () => {
  const base = { bias: 'long', invalidation_level: 95, take_profit_levels: [{ level: 110 }] };
  const pullback = evaluateOpportunity(row({ ...base, entry_price: 98 }), [candle(0, 97.5, 99.5)], NOW).patch;
  const breakout = evaluateOpportunity(row({ ...base, entry_price: 102 }), [candle(0, 100, 103)], NOW).patch;
  assert.equal(pullback.entry_filled, true);
  assert.equal(breakout.entry_filled, true);
});

test('stop and take-profit in the same candle after the fill is a whipsaw', () => {
  const r = row({ entry_price: 100, invalidation_level: 105, take_profit_levels: [{ level: 95 }] });
  const { patch } = evaluateOpportunity(r, [candle(0, 99, 101), candle(1, 94, 106)], NOW);
  assert.equal(patch.final_status, 'whipsaw');
  assert.equal(patch.whipsaw, true);
});

test('the highest take-profit level touched in the winning candle is recorded', () => {
  const r = row({ entry_price: 100, invalidation_level: 105, take_profit_levels: [{ level: 95 }, { level: 90 }] });
  const { patch } = evaluateOpportunity(r, [candle(0, 99, 101), candle(1, 89, 99)], NOW);
  assert.equal(patch.tp_level_hit, 2);
});

test('scanned_through advances to the end of the last evaluated candle and resumes from there', () => {
  const r = row({ entry_price: 100, invalidation_level: 105, take_profit_levels: [{ level: 95 }] });
  const first = evaluateOpportunity(r, [candle(0, 97, 99), candle(1, 97, 99)], NOW).patch;
  assert.equal(Date.parse(first.scanned_through), startMs + 2 * MIN);
  // second run resumes with the stored state and sees the fill and the win
  const resumed = { ...r, ...first };
  const second = evaluateOpportunity(resumed, [candle(2, 99.5, 101), candle(3, 94, 99)], NOW).patch;
  assert.equal(second.final_status, 'winner');
  assert.equal(second.entry_filled_at, new Date(startMs + 2 * MIN).toISOString());
});

test('no new candles leaves the row untouched', () => {
  const { patch, changed } = evaluateOpportunity(row(), [], NOW);
  assert.equal(changed, false);
  assert.equal(patch.final_status, undefined);
});

test('a filled position that never resolves expires after 30 days', () => {
  const r = row({ entry_price: 100, invalidation_level: 105, take_profit_levels: [{ level: 95 }], simulation_date: '2026-10-01' });
  const late = Date.parse('2026-11-14T00:00:00Z');
  const { patch } = evaluateOpportunity(r, [candle(0, 99, 101)], late);
  assert.equal(patch.entry_filled, true);
  assert.equal(patch.final_status, 'expired');
});

test('fill window is 24 hours', () => {
  assert.equal(FILL_WINDOW_MS, 24 * 60 * 60 * 1000);
});
