/**
 * Sentiment inputs and score for the trade scanner.
 *
 * comprehensive_insights has two writers that disagree on vocabulary: the edge function writes
 * bullish/bearish, the daily job writes strong_buy/buy/sell/strong_sell. The scanner used to test
 * only for "buy"/"sell", so for rows written by the edge function the signal never counted, and it
 * read momentum from a key that does not exist. Both are fixed here.
 */

const SIGNAL = {
  strong_buy: "bullish", buy: "bullish", bullish: "bullish", strong_bullish: "bullish",
  strong_sell: "bearish", sell: "bearish", bearish: "bearish", strong_bearish: "bearish",
  neutral: "neutral",
};

/** @returns {{signal: 'bullish'|'bearish'|'neutral'|null, momentum: string|null, news_impact: string|null, trend: string|null}} */
export function normalizeInsights(analysis) {
  const raw = analysis?.technical_analysis?.overall_signal;
  return {
    signal:      typeof raw === "string" ? (SIGNAL[raw.toLowerCase()] ?? null) : null,
    momentum:    analysis?.technical_analysis?.momentum ?? analysis?.enriched_metrics?.momentum ?? null,
    news_impact: analysis?.fundamental_sentiment?.news_impact ?? null,
    trend:       analysis?.price_action?.trend ?? null,
  };
}

/**
 * Sentiment alignment score (0-100) from the normalized insights plus Fear & Greed.
 *   - signal with the trade +25, against it -20
 *   - accelerating momentum +10 only when the trade goes with the signal (it describes the move in
 *     the signal's direction, so it cannot support the opposite trade); stalling -5 either way
 *   - news impact with the trade +10, against it -10
 *   - Fear & Greed is contrarian: extreme fear (<=25) helps a long, extreme greed (>=75) a short
 */
export function calculateSentimentScore(insights, fearGreed, bias) {
  let score = 50;

  if (insights) {
    const withSignal = (insights.signal === "bullish" && bias === "long") || (insights.signal === "bearish" && bias === "short");
    const againstSignal = (insights.signal === "bullish" && bias === "short") || (insights.signal === "bearish" && bias === "long");

    if (withSignal) score += 25;
    else if (againstSignal) score -= 20;

    if (insights.momentum === "accelerating" && withSignal) score += 10;
    else if (insights.momentum === "stalling") score -= 5;

    if (insights.news_impact === "positive" && bias === "long") score += 10;
    else if (insights.news_impact === "negative" && bias === "short") score += 10;
    else if (insights.news_impact === "negative" && bias === "long") score -= 10;
    else if (insights.news_impact === "positive" && bias === "short") score -= 10;
  }

  if (fearGreed != null) {
    if (fearGreed <= 25 && bias === "long") score += 10;
    else if (fearGreed >= 75 && bias === "short") score += 10;
  }

  return Math.min(100, Math.max(0, score));
}
