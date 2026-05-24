/**
 * EPIC-030: AI Trade Opportunity Scanner
 *
 * Runs every 12 hours via GitHub Actions. Fetches technical indicators and
 * market insights from the database, generates 2 scenarios per asset (long +
 * short) using DeepSeek, scores them with a 5-component algorithm, ranks them,
 * then atomically replaces the trade_opportunities table.
 *
 * Mentor: Pragmatic Engineer — error handling, retries, graceful failure,
 *         cost-conscious AI calls.
 */

import { createClient } from "@supabase/supabase-js";

// ─── Config ────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;

const ASSETS = ["BTC", "ETH", "SOL"];
const OPPORTUNITY_TTL_HOURS = 14;
const MAX_RETRIES = 3;

// Scoring weights (must sum to 100)
// v2: removed thesis_quality (gamed by AI verbosity), redistributed to technical + risk_reward
const WEIGHTS = {
  technical_confluence: 35,
  sentiment_alignment: 20,
  risk_reward_quality: 30,
  entry_quality: 15,
};

const SCORING_VERSION = "v2";
const MIN_RRR = 2.0;

// ─── Utilities ──────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Exponential backoff retry wrapper.
 * Retries up to MAX_RETRIES times: delays 1s, 2s, 4s.
 */
async function withRetry(fn, context = "") {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === MAX_RETRIES) {
        console.error(`[retry] ${context} failed after ${MAX_RETRIES} attempts:`, err.message);
        throw err;
      }
      const delay = Math.pow(2, attempt - 1) * 1000;
      console.warn(`[retry] ${context} attempt ${attempt} failed, retrying in ${delay}ms...`);
      await sleep(delay);
    }
  }
}

// ─── Data Fetching ──────────────────────────────────────────────────────────

async function fetchTechnicalIndicators(supabase, asset) {
  const { data, error } = await supabase
    .from("asset_daily_summary")
    .select(
      "rsi_14, macd, bollinger_bands, ema_20, ema_50, sma_200, atr_14, volume, change_percent_24h, fear_greed_index"
    )
    .eq("symbol", asset)
    .order("date", { ascending: false })
    .limit(1)
    .single();

  if (error) throw new Error(`Failed to fetch indicators for ${asset}: ${error.message}`);

  // Flatten JSONB sub-fields for scoring convenience
  return {
    rsi:              data.rsi_14,
    macd_line:        data.macd?.line ?? null,
    macd_signal:      data.macd?.signal ?? null,
    macd_histogram:   data.macd?.histogram ?? null,
    bb_upper:         data.bollinger_bands?.upper ?? null,
    bb_lower:         data.bollinger_bands?.lower ?? null,
    bb_middle:        data.bollinger_bands?.middle ?? null,
    ema_20:           data.ema_20,
    ema_50:           data.ema_50,
    sma_200:          data.sma_200,
    atr:              data.atr_14,
    volume:           data.volume,
    change_percent:   data.change_percent_24h,
    fear_greed_index: data.fear_greed_index,
  };
}

async function fetchMarketInsights(supabase, asset) {
  const { data, error } = await supabase
    .from("comprehensive_insights")
    .select("analysis")
    .eq("symbol", asset)
    .order("date", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) console.warn(`No insights for ${asset}:`, error.message);
  if (!data?.analysis) return null;

  // Extract sentiment fields from the JSONB analysis object
  const a = data.analysis;
  return {
    signal:      a?.technical_analysis?.overall_signal ?? null,
    momentum:    a?.enriched_metrics?.momentum ?? null,
    news_impact: a?.fundamental_sentiment?.news_impact ?? null,
    trend:       a?.price_action?.trend ?? null,
  };
}

async function fetchCurrentPrice(asset) {
  const symbol = `${asset}USDT`;
  const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
  if (!res.ok) throw new Error(`Binance price fetch failed for ${symbol}: ${res.status}`);
  const json = await res.json();
  return parseFloat(json.price);
}

// ─── Scoring ────────────────────────────────────────────────────────────────

/**
 * Coerce AI-returned confidence_level to a valid enum string.
 * DeepSeek sometimes returns floats (0.75) instead of 'low'/'medium'/'high'.
 */
function toConfidenceLabel(val) {
  if (typeof val === "string" && ["low", "medium", "high"].includes(val)) return val;
  const n = parseFloat(val);
  if (isNaN(n)) return "medium";
  return n >= 0.75 ? "high" : n >= 0.5 ? "medium" : "low";
}

/**
 * Calculate sentiment alignment score (0–100) from comprehensive_insights + fear/greed.
 *
 * Sources:
 *   - insights.signal: 'buy'/'sell' from technical_analysis.overall_signal
 *   - insights.momentum: 'accelerating'/'stalling' from enriched_metrics
 *   - insights.news_impact: 'positive'/'neutral'/'negative' from fundamental_sentiment
 *   - fearGreed: integer from asset_daily_summary.fear_greed_index (0-100)
 *     Contrarian: extreme fear (≤25) = long opportunity; extreme greed (≥75) = short opportunity
 */
function calculateSentimentScore(insights, fearGreed, bias) {
  let score = 50;

  if (insights) {
    // Signal alignment with bias
    if (insights.signal === "buy" && bias === "long") score += 25;
    else if (insights.signal === "sell" && bias === "short") score += 25;
    else if (insights.signal === "buy" && bias === "short") score -= 20;
    else if (insights.signal === "sell" && bias === "long") score -= 20;

    // Momentum bonus/penalty
    if (insights.momentum === "accelerating") score += 10;
    else if (insights.momentum === "stalling") score -= 5;

    // News impact alignment
    if (insights.news_impact === "positive" && bias === "long") score += 10;
    else if (insights.news_impact === "negative" && bias === "short") score += 10;
    else if (insights.news_impact === "negative" && bias === "long") score -= 10;
    else if (insights.news_impact === "positive" && bias === "short") score -= 10;
  }

  // Fear & Greed contrarian signal
  if (fearGreed != null) {
    if (fearGreed <= 25 && bias === "long") score += 10;   // extreme fear = buy opportunity
    else if (fearGreed >= 75 && bias === "short") score += 10; // extreme greed = short opportunity
  }

  return Math.min(100, Math.max(0, score));
}

/**
 * 5-component quality scoring algorithm.
 * Each component returns 0-100; weighted average gives quality_score.
 */
function calculateScenarioScore(indicators, insights, scenario) {
  // 1. Technical confluence (RSI, MACD alignment with bias)
  let technical = 50;
  if (indicators) {
    const rsi = indicators.rsi ?? 50;
    if (scenario.bias === "long") {
      technical = rsi < 30 ? 90 : rsi < 45 ? 70 : rsi < 60 ? 50 : 30;
    } else {
      technical = rsi > 70 ? 90 : rsi > 55 ? 70 : rsi > 40 ? 50 : 30;
    }
    // MACD alignment bonus
    if (indicators.macd_histogram != null) {
      if (scenario.bias === "long" && indicators.macd_histogram > 0) technical = Math.min(100, technical + 10);
      if (scenario.bias === "short" && indicators.macd_histogram < 0) technical = Math.min(100, technical + 10);
    }
  }

  // 2. Sentiment alignment — from comprehensive_insights + fear/greed index
  const sentiment = calculateSentimentScore(insights, indicators?.fear_greed_index, scenario.bias);

  // 3. Risk/reward quality
  const rrr = scenario.risk_reward_ratio ?? 0;
  const riskReward = rrr >= 3 ? 90 : rrr >= 2 ? 75 : rrr >= 1.5 ? 60 : rrr >= 1 ? 40 : 20;

  // 4. Entry quality (distance from current price to entry)
  const entryDeviation = scenario.entry_price && scenario.current_price
    ? Math.abs(scenario.entry_price - scenario.current_price) / scenario.current_price
    : 0.05;
  const entryQuality = entryDeviation < 0.01 ? 90 : entryDeviation < 0.03 ? 70 : entryDeviation < 0.05 ? 50 : 30;

  const quality_score = Math.round(
    technical   * (WEIGHTS.technical_confluence / 100) +
    sentiment   * (WEIGHTS.sentiment_alignment / 100) +
    riskReward  * (WEIGHTS.risk_reward_quality / 100) +
    entryQuality * (WEIGHTS.entry_quality / 100)
  );

  return {
    quality_score: Math.min(100, Math.max(0, quality_score)),
    technical_confluence_score: technical,
    sentiment_alignment_score: sentiment,
    risk_reward_quality_score: riskReward,
    entry_quality_score: entryQuality,
    thesis_quality_score: 0, // deprecated in v2 — kept for schema compatibility
  };
}

// ─── AI Generation ──────────────────────────────────────────────────────────

async function generateScenariosWithDeepSeek(asset, indicators, insights, currentPrice) {
  const prompt = buildPrompt(asset, indicators, insights, currentPrice);

  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0.3,
    }),
  });

  if (!res.ok) throw new Error(`DeepSeek API error: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return JSON.parse(json.choices[0].message.content);
}

function buildPrompt(asset, indicators, insights, currentPrice) {
  return `You are a professional crypto trading analyst. Analyze ${asset} and generate exactly 2 trade scenarios: one long and one short.

Current price: $${currentPrice}
Technical indicators: ${JSON.stringify(indicators ?? {}, null, 2)}
Market insights: ${JSON.stringify(insights ?? {}, null, 2)}

Return a JSON object with this exact structure:
{
  "long": {
    "entry_price": number,
    "invalidation_level": number,
    "take_profit_levels": [{"level": number, "label": "TP1"}, {"level": number, "label": "TP2"}],
    "thesis": "string (100-300 chars explaining the bull case)",
    "confluence_factors": ["factor1", "factor2", "factor3"],
    "confidence_level": "low" | "medium" | "high",
    "risk_reward_ratio": number
  },
  "short": {
    "entry_price": number,
    "invalidation_level": number,
    "take_profit_levels": [{"level": number, "label": "TP1"}, {"level": number, "label": "TP2"}],
    "thesis": "string (100-300 chars explaining the bear case)",
    "confluence_factors": ["factor1", "factor2", "factor3"],
    "confidence_level": "low" | "medium" | "high",
    "risk_reward_ratio": number
  }
}

Rules:
- Long entry < current price (buy the dip) OR within 2% above (breakout)
- Short entry > current price OR within 2% below (breakdown)
- Long: TP > entry, invalidation < entry
- Short: TP < entry, invalidation > entry
- Minimum RRR: 1.5
- Base levels on technical structure (support/resistance, Bollinger Bands, EMAs)`;
}

async function generateScenarios(asset, indicators, insights, currentPrice) {
  if (!DEEPSEEK_API_KEY) {
    throw new Error("DEEPSEEK_API_KEY is required");
  }
  return await generateScenariosWithDeepSeek(asset, indicators, insights, currentPrice);
}

/**
 * Rule-based (deterministic) scenario generation.
 * Entry = current price, TP1 = ±5%, TP2 = ±10%, SL = ±5%.
 * No API call — always runs alongside AI to compute method alignment.
 */
function generateRuleBased(currentPrice) {
  return {
    long: {
      entry_price: currentPrice,
      invalidation_level: parseFloat((currentPrice * 0.95).toFixed(2)),
      take_profit_levels: [
        { level: parseFloat((currentPrice * 1.05).toFixed(2)), label: "TP1" },
        { level: parseFloat((currentPrice * 1.10).toFixed(2)), label: "TP2" },
      ],
      thesis: "Rule-based long: entry at current price, 5% TP1, 10% TP2, 5% SL.",
      confluence_factors: ["rule-based"],
      confidence_level: "medium",
      risk_reward_ratio: 2.0,
    },
    short: {
      entry_price: currentPrice,
      invalidation_level: parseFloat((currentPrice * 1.05).toFixed(2)),
      take_profit_levels: [
        { level: parseFloat((currentPrice * 0.95).toFixed(2)), label: "TP1" },
        { level: parseFloat((currentPrice * 0.90).toFixed(2)), label: "TP2" },
      ],
      thesis: "Rule-based short: entry at current price, 5% TP1, 10% TP2, 5% SL.",
      confluence_factors: ["rule-based"],
      confidence_level: "medium",
      risk_reward_ratio: 2.0,
    },
  };
}

/**
 * Score both rule-based scenarios and return the top bias + its quality score.
 */
function getRuleBasedTopBias(indicators, insights, currentPrice) {
  const ruleScenarios = generateRuleBased(currentPrice);
  const longScores = calculateScenarioScore(indicators, insights, {
    ...ruleScenarios.long, bias: "long", current_price: currentPrice,
  });
  const shortScores = calculateScenarioScore(indicators, insights, {
    ...ruleScenarios.short, bias: "short", current_price: currentPrice,
  });
  if (longScores.quality_score >= shortScores.quality_score) {
    return { rule_bias: "long", rule_quality_score: longScores.quality_score };
  }
  return { rule_bias: "short", rule_quality_score: shortScores.quality_score };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function processAsset(supabase, asset) {
  console.log(`[${asset}] Processing...`);

  const [indicators, insights, currentPrice] = await Promise.all([
    withRetry(() => fetchTechnicalIndicators(supabase, asset), `${asset} indicators`),
    withRetry(() => fetchMarketInsights(supabase, asset), `${asset} insights`),
    withRetry(() => fetchCurrentPrice(asset), `${asset} price`),
  ]);

  const scenarios = await withRetry(
    () => generateScenarios(asset, indicators, insights, currentPrice),
    `${asset} AI generation`
  );

  // Always compute rule-based top bias for alignment check (no extra API cost)
  const { rule_bias, rule_quality_score } = getRuleBasedTopBias(indicators, insights, currentPrice);

  const results = [];
  for (const bias of ["long", "short"]) {
    const scenario = scenarios[bias];
    if (!scenario) {
      console.warn(`[${asset}] Missing ${bias} scenario from AI response`);
      continue;
    }

    // Geometry guard: ensure TP/SL are not inverted before storing
    if (scenario.entry_price && scenario.take_profit_levels?.[0]?.level && scenario.invalidation_level) {
      const tp = scenario.take_profit_levels[0].level;
      const sl = scenario.invalidation_level;
      const tpCorrect = bias === 'long' ? tp > scenario.entry_price : tp < scenario.entry_price;
      const slCorrect = bias === 'long' ? sl < scenario.entry_price : sl > scenario.entry_price;
      if (!tpCorrect || !slCorrect) {
        console.warn(`[${asset}] Geometry inverted for ${bias} — swapping TP (${tp}) and SL (${sl})`);
        scenario.take_profit_levels[0].level = sl;
        scenario.invalidation_level = tp;
      }
    }

    // RRR gate — skip low-quality setups before scoring
    if ((scenario.risk_reward_ratio ?? 0) < MIN_RRR) {
      console.warn(`[${asset}] ${bias} skipped — RRR ${scenario.risk_reward_ratio} < ${MIN_RRR}`);
      continue;
    }

    const scores = calculateScenarioScore(
      indicators,
      insights,
      { ...scenario, bias, current_price: currentPrice }
    );

    const method_alignment = bias === rule_bias;
    const alignment_score_bonus = method_alignment ? 5 : 0;

    results.push({
      asset_symbol: asset,
      bias,
      entry_price: scenario.entry_price,
      invalidation_level: scenario.invalidation_level,
      take_profit_levels: scenario.take_profit_levels ?? [],
      thesis: scenario.thesis ?? "",
      confluence_factors: scenario.confluence_factors ?? [],
      confidence_level: toConfidenceLabel(scenario.confidence_level),
      risk_reward_ratio: scenario.risk_reward_ratio ?? 0,
      ...scores,
      quality_score: Math.min(100, scores.quality_score + alignment_score_bonus),
      rule_bias,
      rule_quality_score,
      method_alignment,
      alignment_score_bonus,
      rank: 0, // set after sorting all scenarios
      is_current: true,
      generated_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + OPPORTUNITY_TTL_HOURS * 60 * 60 * 1000).toISOString(),
    });
  }

  console.log(`[${asset}] AI top bias to-be-determined | Rule-based top: ${rule_bias} (score: ${rule_quality_score})`);

  return results;
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  console.log(`[scanner] Starting scan for assets: ${ASSETS.join(", ")}`);

  // Fetch all assets in parallel
  const assetResults = await Promise.allSettled(
    ASSETS.map((asset) => processAsset(supabase, asset))
  );

  const allScenarios = [];
  for (let i = 0; i < assetResults.length; i++) {
    const result = assetResults[i];
    if (result.status === "fulfilled") {
      allScenarios.push(...result.value);
    } else {
      console.error(`[${ASSETS[i]}] Failed:`, result.reason?.message);
    }
  }

  if (allScenarios.length === 0) {
    console.error("[scanner] No scenarios generated — aborting database write");
    process.exit(1);
  }

  // Sort by quality_score descending.
  // Best bias per asset gets ranks 1-3, secondary biases get ranks 4-6.
  // This ensures rank is never null (NOT NULL constraint) while the UI's
  // top-3 filter always surfaces one recommendation per asset.
  allScenarios.sort((a, b) => b.quality_score - a.quality_score);

  const seenAssets = new Set();
  const primary = [];
  const secondary = [];
  for (const s of allScenarios) {
    if (!seenAssets.has(s.asset_symbol)) {
      seenAssets.add(s.asset_symbol);
      primary.push(s);
    } else {
      secondary.push(s);
    }
  }
  primary.forEach((s, i)   => { s.rank = i + 1; });           // 1, 2, 3
  secondary.forEach((s, i) => { s.rank = primary.length + i + 1; }); // 4, 5, 6

  // Append: keep previous runs as historical record, just insert the new batch.
  // Use .select() to get back the inserted IDs for performance tracking.
  const { data: insertedOpps, error: insertError } = await supabase
    .from("trade_opportunities")
    .insert(allScenarios)
    .select();

  if (insertError) {
    console.error("[scanner] Failed to insert opportunities:", insertError.message);
    process.exit(1);
  }

  // Mirror into opportunity_performance as 'pending' — tracked until TP/SL hit
  // (independent of the 14h display TTL on trade_opportunities)
  if (insertedOpps && insertedOpps.length > 0) {
    const today = new Date().toISOString().split("T")[0];
    const perfRows = insertedOpps.map((opp) => ({
      source: "live",
      scoring_version: SCORING_VERSION,
      opportunity_id: opp.id,
      simulation_date: today,
      asset_symbol: opp.asset_symbol,
      bias: opp.bias,
      entry_price: opp.entry_price,
      invalidation_level: opp.invalidation_level,
      take_profit_levels: opp.take_profit_levels,
      confidence_level: opp.confidence_level,
      price_at_generation: opp.entry_price,
      quality_score: opp.quality_score,
      risk_reward_ratio: opp.risk_reward_ratio,
      technical_confluence_score: opp.technical_confluence_score,
      sentiment_alignment_score: opp.sentiment_alignment_score,
      risk_reward_quality_score: opp.risk_reward_quality_score,
      entry_quality_score: opp.entry_quality_score,
      thesis_quality_score: opp.thesis_quality_score,
      rank: opp.rank,
      rule_bias: opp.rule_bias,
      rule_quality_score: opp.rule_quality_score,
      method_alignment: opp.method_alignment,
      alignment_score_bonus: opp.alignment_score_bonus,
      final_status: "pending",
    }));

    const { error: perfError } = await supabase
      .from("opportunity_performance")
      .insert(perfRows);

    if (perfError) {
      // Non-fatal: log but don't abort — opportunities are still stored
      console.warn("[scanner] Failed to insert performance records:", perfError.message);
    } else {
      console.log(`[scanner] Inserted ${perfRows.length} performance tracking records.`);
    }
  }

  console.log(`[scanner] Done. Inserted ${allScenarios.length} opportunities (ranked by quality score).`);
  allScenarios.forEach((s) =>
    console.log(`  #${s.rank} ${s.asset_symbol} ${s.bias.toUpperCase()} — quality: ${s.quality_score}${s.alignment_score_bonus ? ` (+${s.alignment_score_bonus} alignment)` : ""}, RR: ${s.risk_reward_ratio}, rule: ${s.rule_bias ?? "n/a"} ${s.method_alignment ? "✓ ALIGNED" : "✗ diverged"}`)
  );
}

main().catch((err) => {
  console.error("[scanner] Fatal error:", err.message);
  process.exit(1);
});
