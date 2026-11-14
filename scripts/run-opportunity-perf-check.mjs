/**
 * Opportunity Performance Checker
 *
 * Dispatched about every 20 minutes by pg_cron (see performance-check.yml).
 * Checks ALL pending opportunity_performance rows:
 *  - 'live' rows (from the scanner) are replayed against closed 1-minute candles, in order, and a
 *    take-profit or stop only counts once the entry price has traded (scripts/lib/opportunity-eval.mjs).
 *  - 'backtest' near-present rows keep the original spot-price check against current Binance prices.
 *
 * Unlike run-performance-check.mjs (which is plan-scoped), this checker
 * is not tied to user-created plans — it tracks every AI-generated opportunity.
 *
 * Expiry: rows open >= MAX_LOOKFORWARD_DAYS with no hit are marked 'expired'.
 * Display TTL (14h on trade_opportunities) is irrelevant here — we track
 * outcomes regardless of whether the opportunity was still shown in the UI.
 */

import { createClient } from "@supabase/supabase-js";
import { evaluateOpportunity } from "./lib/opportunity-eval.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const MAX_LOOKFORWARD_DAYS = 30;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const COINGECKO_IDS = { BTC: "bitcoin", ETH: "ethereum", SOL: "solana" };

async function fetchCurrentPrice(asset) {
  const symbol = `${asset}USDT`;
  try {
    const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
    if (res.status === 451) throw new Error("geo-blocked");
    if (!res.ok) throw new Error(`Binance price fetch failed for ${symbol}: ${res.status}`);
    const json = await res.json();
    return parseFloat(json.price);
  } catch {
    const id = COINGECKO_IDS[asset];
    if (!id) throw new Error(`No CoinGecko ID for ${asset}`);
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`);
    if (!res.ok) throw new Error(`CoinGecko price fetch failed for ${asset}: ${res.status}`);
    const json = await res.json();
    return json[id].usd;
  }
}

/**
 * Check all TP levels hit by current price (returns highest TP level hit).
 * Returns 0 if none hit.
 */
function checkTpLevels(tpLevels, currentPrice, isLong) {
  let highestHit = 0;
  for (let i = 0; i < tpLevels.length; i++) {
    const level = tpLevels[i]?.level;
    if (level == null) continue;
    const hit = isLong ? currentPrice >= level : currentPrice <= level;
    if (hit) highestHit = i + 1; // 1-indexed
  }
  return highestHit;
}


// ── Live rows: candle replay ────────────────────────────────────────────────

const KLINE_PAGE = 1000;
const MAX_KLINE_PAGES = 60; // ~41 days of 1m candles per asset per run; the rest resumes next run
const MINUTE_MS = 60_000;

async function fetchKlinePage(symbol, startMs) {
  const path = `/api/v3/klines?symbol=${symbol}&interval=1m&startTime=${startMs}&limit=${KLINE_PAGE}`;
  let lastError;
  for (const host of ["https://api.binance.com", "https://api.binance.us"]) {
    try {
      const res = await fetch(`${host}${path}`);
      if (!res.ok) throw new Error(`${host} klines ${res.status}`);
      return await res.json();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

/**
 * Closed 1m candles from startMs up to (not including) endMs. If a later page fails the candles
 * fetched so far are returned: they are contiguous, so scanned_through simply stops earlier and the
 * next run resumes there. A failure on the first page throws, and the asset is skipped this run.
 */
async function fetchCandles(asset, startMs, endMs) {
  const symbol = `${asset}USDT`;
  const candles = [];
  let cursor = startMs;
  for (let page = 0; page < MAX_KLINE_PAGES; page++) {
    let rows;
    try {
      rows = await fetchKlinePage(symbol, cursor);
    } catch (err) {
      if (page === 0) throw err;
      console.warn(`[opp-perf] ${asset}: kline page ${page + 1} failed (${err.message}); resuming next run`);
      break;
    }
    if (!rows.length) break;
    for (const k of rows) {
      if (k[6] >= endMs) return candles; // still-open candle
      candles.push({ openTime: k[0], closeTime: k[6], high: parseFloat(k[2]), low: parseFloat(k[3]) });
    }
    cursor = rows[rows.length - 1][6] + 1;
    if (rows.length < KLINE_PAGE) break;
  }
  return candles;
}

function rowStartMs(row) {
  return row.scanned_through
    ? Date.parse(row.scanned_through)
    : Math.ceil(Date.parse(row.created_at) / MINUTE_MS) * MINUTE_MS;
}

async function checkLiveRows(supabase, rows) {
  const nowMs = Date.now();
  const byAsset = new Map();
  for (const r of rows) byAsset.set(r.asset_symbol, [...(byAsset.get(r.asset_symbol) ?? []), r]);

  let updated = 0;
  for (const [asset, assetRows] of byAsset) {
    let candles;
    try {
      const startMs = Math.min(...assetRows.map(rowStartMs));
      candles = await fetchCandles(asset, startMs, nowMs);
    } catch (err) {
      console.warn(`[opp-perf] ${asset}: could not fetch candles (${err.message}); skipping, nothing is lost`);
      continue;
    }

    for (const record of assetRows) {
      const from = rowStartMs(record);
      const { patch, changed } = evaluateOpportunity(record, candles.filter((c) => c.openTime >= from), nowMs);
      const stamp = new Date().toISOString();
      const { error } = await supabase
        .from("opportunity_performance")
        .update(changed ? { ...patch, last_checked_at: stamp, updated_at: stamp } : { last_checked_at: stamp })
        .eq("id", record.id);
      if (error) {
        console.warn(`[opp-perf] Failed to update ${record.id}:`, error.message);
        continue;
      }
      if (changed && patch.final_status !== "pending") {
        updated++;
        console.log(`[opp-perf] ${record.asset_symbol} ${record.bias.toUpperCase()} (live) → ${patch.final_status}${patch.entry_filled === false ? " (never filled)" : ""}`);
      }
      await sleep(50);
    }
  }
  console.log(`[opp-perf] Live check done. Resolved ${updated}/${rows.length} records.`);
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  console.log("[opp-perf] Starting opportunity performance check...");

  const { data: pending, error: fetchError } = await supabase
    .from("opportunity_performance")
    .select("*")
    .eq("final_status", "pending");

  if (fetchError) {
    console.error("[opp-perf] Failed to fetch pending records:", fetchError.message);
    process.exit(1);
  }

  if (!pending || pending.length === 0) {
    console.log("[opp-perf] No pending records. Nothing to do.");
    return;
  }

  const liveRows = pending.filter((r) => r.source === "live");
  const spotRows = pending.filter((r) => r.source !== "live");
  console.log(`[opp-perf] Checking ${pending.length} pending records (${liveRows.length} live, ${spotRows.length} spot-checked)...`);

  if (liveRows.length > 0) await checkLiveRows(supabase, liveRows);
  if (spotRows.length > 0) await checkSpotRows(supabase, spotRows);
  console.log("[opp-perf] Done.");
}

/** Original spot-price check, kept for backtest rows. */
async function checkSpotRows(supabase, pending) {
  // Fetch current price once per unique asset
  const assets = [...new Set(pending.map((r) => r.asset_symbol))];
  const prices = {};
  for (const asset of assets) {
    try {
      prices[asset] = await fetchCurrentPrice(asset);
      console.log(`[opp-perf] ${asset}: $${prices[asset]}`);
    } catch (err) {
      console.warn(`[opp-perf] Could not fetch price for ${asset}:`, err.message);
    }
    await sleep(200);
  }

  const today = new Date().toISOString().split("T")[0];
  const todayDate = new Date(today);
  let updated = 0;

  for (const record of pending) {
    const currentPrice = prices[record.asset_symbol];

    // Calculate days open regardless of price availability (for expiry check)
    const simulationDate = new Date(record.simulation_date);
    const daysOpen = Math.floor((todayDate - simulationDate) / (1000 * 60 * 60 * 24));

    // Expire if we've waited long enough with no price data either
    if (currentPrice == null) {
      if (daysOpen >= MAX_LOOKFORWARD_DAYS) {
        await supabase
          .from("opportunity_performance")
          .update({ final_status: "expired", last_checked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq("id", record.id);
        updated++;
      }
      continue;
    }

    const tpLevels = record.take_profit_levels ?? [];
    const sl = record.invalidation_level;
    const isLong = record.bias === "long";

    const slHit = isLong ? currentPrice <= sl : currentPrice >= sl;
    const tpLevelHit = checkTpLevels(tpLevels, currentPrice, isLong);
    const tpHit = tpLevelHit > 0;

    // Carry forward previously recorded hits (incremental: once hit, always hit)
    const wasSlHit = record.sl_hit || slHit;
    const wasTpHit = record.tp_hit || tpHit;
    const finalTpLevel = tpHit ? Math.max(tpLevelHit, record.tp_level_hit ?? 0) : (record.tp_level_hit ?? null);

    const slHitDate = wasSlHit ? (record.sl_hit_date ?? today) : null;
    const tpHitDate = wasTpHit ? (record.tp_hit_date ?? today) : null;

    const timeToSlDays = wasSlHit && slHitDate
      ? Math.floor((new Date(slHitDate) - simulationDate) / (1000 * 60 * 60 * 24))
      : null;
    const timeToTpDays = wasTpHit && tpHitDate
      ? Math.floor((new Date(tpHitDate) - simulationDate) / (1000 * 60 * 60 * 24))
      : null;

    // Whipsaw: both hit on the same day
    const whipsaw = wasTpHit && wasSlHit && tpHitDate === slHitDate;

    let finalStatus = "pending";
    if (whipsaw) {
      finalStatus = "whipsaw";
    } else if (wasTpHit) {
      finalStatus = "winner";
    } else if (wasSlHit) {
      finalStatus = "loser";
    } else if (daysOpen >= MAX_LOOKFORWARD_DAYS) {
      finalStatus = "expired";
    }

    const changed =
      finalStatus !== "pending" ||
      wasSlHit !== record.sl_hit ||
      wasTpHit !== record.tp_hit;

    if (changed) {
      const { error: updateError } = await supabase
        .from("opportunity_performance")
        .update({
          sl_hit: wasSlHit,
          sl_hit_date: slHitDate,
          time_to_sl_days: timeToSlDays,
          tp_hit: wasTpHit,
          tp_hit_date: tpHitDate,
          tp_level_hit: finalTpLevel,
          time_to_tp_days: timeToTpDays,
          whipsaw,
          final_status: finalStatus,
          last_checked_at: new Date().toISOString(),
        })
        .eq("id", record.id);

      if (updateError) {
        console.warn(`[opp-perf] Failed to update ${record.id}:`, updateError.message);
      } else {
        console.log(`[opp-perf] ${record.asset_symbol} ${record.bias.toUpperCase()} (${record.source}) → ${finalStatus}`);
        updated++;
      }
    } else {
      // Still pending — just update last_checked_at
      await supabase
        .from("opportunity_performance")
        .update({ last_checked_at: new Date().toISOString() })
        .eq("id", record.id);
    }

    await sleep(50); // gentle rate limiting on DB writes
  }

  console.log(`[opp-perf] Spot check done. Updated ${updated}/${pending.length} records.`);
}

main().catch((err) => {
  console.error("[opp-perf] Fatal error:", err.message);
  process.exit(1);
});
