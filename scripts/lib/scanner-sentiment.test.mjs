// Run: node --test scripts/lib/scanner-sentiment.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateSentimentScore, normalizeInsights } from './scanner-sentiment.mjs';

// comprehensive_insights.analysis as written by the edge function (bullish/bearish vocabulary,
// momentum under technical_analysis), BTC 2026-11-14.
const BEARISH_BTC = {
  technical_analysis: { overall_signal: 'bearish', momentum: 'accelerating' },
  fundamental_sentiment: { news_impact: 'neutral' },
  price_action: { trend: 'bearish' },
};

test('normalizeInsights reads the signal and momentum from where the writers put them', () => {
  const i = normalizeInsights(BEARISH_BTC);
  assert.equal(i.signal, 'bearish');
  assert.equal(i.momentum, 'accelerating');
  assert.equal(i.news_impact, 'neutral');
});

test('normalizeInsights maps every signal vocabulary to bullish / bearish / neutral', () => {
  const sig = (overall_signal) => normalizeInsights({ technical_analysis: { overall_signal } }).signal;
  for (const v of ['strong_buy', 'buy', 'bullish', 'strong_bullish']) assert.equal(sig(v), 'bullish', v);
  for (const v of ['strong_sell', 'sell', 'bearish', 'strong_bearish']) assert.equal(sig(v), 'bearish', v);
  assert.equal(sig('neutral'), 'neutral');
  assert.equal(sig(undefined), null);
});

test('a bearish signal now favours the short and penalises the long (it scored a flat 50 before)', () => {
  const i = normalizeInsights(BEARISH_BTC);
  assert.equal(calculateSentimentScore(i, null, 'short'), 85); // 50 + 25 aligned + 10 accelerating with it
  assert.equal(calculateSentimentScore(i, null, 'long'), 30);  // 50 - 20 against the signal, no momentum bonus
});

test('accelerating momentum only helps a trade that goes with the signal', () => {
  const bull = normalizeInsights({ technical_analysis: { overall_signal: 'bullish', momentum: 'accelerating' } });
  assert.equal(calculateSentimentScore(bull, null, 'long'), 85);
  assert.equal(calculateSentimentScore(bull, null, 'short'), 30);
});

test('stalling momentum still costs 5 whichever way the trade goes', () => {
  const i = normalizeInsights({ technical_analysis: { overall_signal: 'neutral', momentum: 'stalling' } });
  assert.equal(calculateSentimentScore(i, null, 'long'), 45);
  assert.equal(calculateSentimentScore(i, null, 'short'), 45);
});

test('news impact and the Fear & Greed contrarian bonus are unchanged', () => {
  const neg = normalizeInsights({ fundamental_sentiment: { news_impact: 'negative' } });
  assert.equal(calculateSentimentScore(neg, null, 'short'), 60);
  assert.equal(calculateSentimentScore(neg, null, 'long'), 40);
  assert.equal(calculateSentimentScore(null, 13, 'long'), 60);
  assert.equal(calculateSentimentScore(null, 80, 'short'), 60);
});

test('score stays within 0..100', () => {
  const i = normalizeInsights({ technical_analysis: { overall_signal: 'sell', momentum: 'stalling' }, fundamental_sentiment: { news_impact: 'negative' } });
  assert.ok(calculateSentimentScore(i, 10, 'long') >= 0);
});
