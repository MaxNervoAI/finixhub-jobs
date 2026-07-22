/**
 * hl-signal-trader.mjs
 *
 * Reads new Aligned + Quality≥70 signals from opportunity_performance,
 * opens positions on Hyperliquid with SL and TP, and records executions
 * in the hyperliquid_trades table for comparison with paper trading.
 *
 * Filter: source=live, scoring_version=v2, method_alignment=true, quality_score>=70, final_status=pending
 * Assets: BTC, ETH only. SOL is intentionally excluded — backtesting
 * (2026-05-23 to 2026-07-18) showed SOL needing up to 9x concurrent capital
 * to capture meaningfully more R than BTC/ETH ever needed at 2x, i.e. much
 * worse capital efficiency. Revisit if SOL's behavior changes.
 *
 * Position policy, backtested against the same window before adopting:
 *   - No open position for the asset+direction → open freely, up to
 *     MAX_SAME_DIRECTION concurrent tranches per asset+direction.
 *   - MAX_SAME_DIRECTION reached for that asset+direction → skip.
 *   - An open position exists in the OPPOSITE direction → flip: cancel its
 *     resting SL/TP orders, close it at market, record the realized result
 *     (close_reason='flip'), then open the new signal. Backtest: of 10 flip
 *     events, 7 rescued what would've been a full -1R stop-out, 3 cut a
 *     winner short — net positive every time relative to doing nothing.
 *   - hl-sync-results.mjs remains the source of truth for trades that close
 *     via their own SL/TP order filling (this script never touches those).
 *
 * Runs via workflow_run right after the scanner finishes (plus a 30-min
 * schedule as a safety net) rather than a fixed cron offset — a signal that
 * resolves fast (paper trading checks every 15 min) can otherwise disappear
 * before a twice-daily trader ever sees it. Every entry (including the
 * first attempt, not just retries) is checked against current price before
 * firing a market order — see ENTRY_MAX_DEVIATION_PCT.
 *
 * Usage:
 *   node scripts/hl-signal-trader.mjs            # process new signals
 *   node scripts/hl-signal-trader.mjs --dry-run  # log signals without opening trades
 */

import "dotenv/config";
import ccxt from "ccxt";
import { createClient } from "@supabase/supabase-js";

// ── Config ────────────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const WALLET_ADDRESS = process.env.HL_WALLET_ADDRESS;
const PRIVATE_KEY = process.env.HL_PRIVATE_KEY;
const TESTNET = process.env.HL_TESTNET !== "false";
const RISK_USD = parseFloat(process.env.HL_RISK_PER_TRADE_USD ?? "15");
const MIN_QUALITY = 70;
const MAX_SAME_DIRECTION = 2;
const DRY_RUN = process.argv.includes("--dry-run");

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("[hl-trader] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
if (!WALLET_ADDRESS || !PRIVATE_KEY) {
  console.error("[hl-trader] Missing HL_WALLET_ADDRESS or HL_PRIVATE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Symbol mapping — BTC/ETH only, SOL excluded (see header) ─────────────────
const HL_SYMBOL = { BTC: "BTC/USDC:USDC", ETH: "ETH/USDC:USDC" };
const TRADED_ASSETS = Object.keys(HL_SYMBOL);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function round(value, decimals) {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

// ── Position sizing ───────────────────────────────────────────────────────────
function calcPositionSize(riskUsd, entryPrice, slPrice, amtPrecision) {
  const slDistance = Math.abs(entryPrice - slPrice);
  if (slDistance <= 0) throw new Error("SL distance is zero");
  const rawSize = riskUsd / slDistance;
  const decimals = Math.max(0, Math.round(-Math.log10(amtPrecision)));
  return round(rawSize, decimals);
}

// ── Market entry with one retry ───────────────────────────────────────────────
// A market entry can be rejected outright with zero fill if there's no
// resting liquidity to match against at that instant (seen on testnet). One
// retry, re-pricing off a fresh ticker rather than the stale signal price,
// is usually enough to catch a momentary liquidity gap.
const ENTRY_ATTEMPTS = 2;
const ENTRY_RETRY_DELAY_MS = 3000;
// If current price has moved more than this from the signal's entry_price,
// the setup the quality score was computed for no longer holds — better to
// miss the trade than chase it at a level the signal never justified. This
// is checked on EVERY attempt, including the first: a market order fires
// immediately regardless of how long the signal has been pending, so a
// slow-moving pipeline (or just a fast-moving market) can mean the "current
// price" is already far from what was scored, even within minutes. (Seen
// live: an 18-minute-old ETH signal filled 2.23% away from its entry_price
// because the order chased whatever the market was doing right then.)
// This deviation check is deliberately NOT loosened for fast reactions —
// a large move is a bad entry whether it happened in 18 minutes or 18
// seconds, and reacting fast to a genuine volatility spike is exactly when
// chasing is most dangerous, not least. Skips are logged with the signal's
// age so this can be tuned later from real data instead of a guess now.
const ENTRY_MAX_DEVIATION_PCT = 1.5;

async function placeMarketEntry(exchange, symbol, side, posSize, referencePrice, signalAgeMin) {
  let lastErr;
  for (let attempt = 1; attempt <= ENTRY_ATTEMPTS; attempt++) {
    const price = (await exchange.fetchTicker(symbol)).last;
    const deviationPct = Math.abs(price - referencePrice) / referencePrice * 100;
    if (deviationPct > ENTRY_MAX_DEVIATION_PCT) {
      // Not retryable — the price won't un-move by waiting a few seconds.
      throw new Error(
        `Price moved ${deviationPct.toFixed(2)}% from signal ($${referencePrice} → $${price}), ` +
        `exceeding ${ENTRY_MAX_DEVIATION_PCT}% max deviation — signal is stale, not chasing ` +
        `(signal age: ${signalAgeMin != null ? signalAgeMin.toFixed(1) + "min" : "unknown"})`
      );
    }
    try {
      const order = await exchange.createOrder(symbol, "market", side, posSize, price, {
        slippagePercentage: 5,
      });
      if (attempt > 1) console.log(`[hl-trader] ✓ Entry filled on retry ${attempt}/${ENTRY_ATTEMPTS}`);
      return order;
    } catch (e) {
      lastErr = e;
      console.warn(`[hl-trader] Entry attempt ${attempt}/${ENTRY_ATTEMPTS} failed: ${e.message}`);
      if (attempt < ENTRY_ATTEMPTS) await sleep(ENTRY_RETRY_DELAY_MS);
    }
  }
  throw lastErr;
}

// ── Fetch this run's open positions, grouped by asset ─────────────────────────
// The DB is the single source of truth here on purpose: it's what the rest of
// the app reads, and it's guaranteed consistent as long as hl-sync-results.mjs
// keeps it that way. No live HL position lookup is needed to make this decision.
async function fetchOpenPositionsByAsset() {
  const { data } = await supabase
    .from("hyperliquid_trades")
    .select("id, asset_symbol, bias, hl_tp_order_id, hl_sl_order_id, actual_entry_price, position_size_contracts, risk_usd, created_at, opportunity_id")
    .eq("outcome", "open")
    .eq("environment", TESTNET ? "testnet" : "mainnet");

  const byAsset = {};
  for (const row of data ?? []) {
    (byAsset[row.asset_symbol] ??= []).push(row);
  }
  return byAsset;
}

// ── Fetch paper trading result for comparison (mirrors hl-sync-results.mjs) ──
async function fetchPaperResult(opportunityId) {
  if (!opportunityId) return {};
  const { data } = await supabase
    .from("opportunity_performance")
    .select("final_status, risk_reward_ratio")
    .eq("id", opportunityId)
    .single();
  if (!data) return {};
  const paperR = data.final_status === "winner"
    ? parseFloat(data.risk_reward_ratio ?? 0)
    : data.final_status === "loser" ? -1 : null;
  return { paper_outcome: data.final_status, paper_r: paperR };
}

// ── Close an existing position at market because a new opposite-direction ────
// signal arrived. Cancels its resting SL/TP first so they can't fill against
// the market close (or the newly-opened opposite position) as an orphaned
// order, then records the realized result with close_reason='flip'.
async function flipClosePosition(exchange, position) {
  const symbol = HL_SYMBOL[position.asset_symbol];
  const isLong = position.bias === "long";
  const closeSide = isLong ? "sell" : "buy";

  console.log(`[hl-trader] ⇄ Flip: closing existing ${position.asset_symbol} ${position.bias.toUpperCase()} (opened ${position.created_at})`);

  if (DRY_RUN) {
    console.log(`[hl-trader] DRY RUN — would cancel SL/TP and close at market`);
    return;
  }

  for (const orderId of [position.hl_tp_order_id, position.hl_sl_order_id]) {
    if (!orderId) continue;
    try {
      await exchange.cancelOrder(orderId, symbol);
      await sleep(200);
    } catch (e) {
      console.warn(`[hl-trader] Could not cancel order ${orderId} (may already be filled/gone): ${e.message}`);
    }
  }

  const referencePrice = (await exchange.fetchTicker(symbol)).last;
  const closeOrder = await exchange.createOrder(symbol, "market", closeSide, position.position_size_contracts, referencePrice, {
    reduceOnly: true,
    slippagePercentage: 5,
  });
  const exitPrice = closeOrder.average ?? referencePrice;
  console.log(`[hl-trader] ✓ Flip-closed at $${exitPrice}`);

  const entry = parseFloat(position.actual_entry_price);
  const priceDiff = isLong ? exitPrice - entry : entry - exitPrice;
  const actualPnlUsd = priceDiff * position.position_size_contracts;
  const actualR = position.risk_usd ? actualPnlUsd / position.risk_usd : null;
  const daysHeld = position.created_at
    ? (Date.now() - new Date(position.created_at).getTime()) / (1000 * 60 * 60 * 24)
    : null;

  const paper = await fetchPaperResult(position.opportunity_id);

  const { error } = await supabase
    .from("hyperliquid_trades")
    .update({
      outcome: actualPnlUsd >= 0 ? "winner" : "loser",
      actual_exit_price: exitPrice,
      actual_pnl_usd: parseFloat(actualPnlUsd.toFixed(2)),
      actual_r: actualR != null ? parseFloat(actualR.toFixed(3)) : null,
      closed_at: new Date().toISOString(),
      days_held: daysHeld != null ? parseFloat(daysHeld.toFixed(2)) : null,
      close_reason: "flip",
      ...paper,
      updated_at: new Date().toISOString(),
    })
    .eq("id", position.id);

  if (error) console.error(`[hl-trader] Failed to record flip-close for ${position.id}: ${error.message}`);
  else console.log(`[hl-trader] ✓ Recorded flip-close | R:${actualR != null ? actualR.toFixed(2) : "n/a"}`);
}

// ── Fetch signals not yet traded on HL ───────────────────────────────────────
async function fetchNewSignals() {
  const { data: signals, error } = await supabase
    .from("opportunity_performance")
    .select("id, asset_symbol, bias, entry_price, invalidation_level, take_profit_levels, quality_score, risk_reward_ratio, method_alignment, simulation_date, created_at")
    .eq("source", "live")
    .eq("scoring_version", "v2")
    .eq("final_status", "pending")
    .eq("method_alignment", true)
    .in("asset_symbol", TRADED_ASSETS)
    .gte("quality_score", MIN_QUALITY)
    .order("quality_score", { ascending: false });

  if (error) throw new Error(`Supabase fetch error: ${error.message}`);
  if (!signals?.length) return [];

  // Filter out signals already attempted (any outcome except cancelled)
  const signalIds = signals.map((s) => s.id);
  const { data: existing } = await supabase
    .from("hyperliquid_trades")
    .select("opportunity_id")
    .in("opportunity_id", signalIds)
    .neq("outcome", "cancelled");

  const tradedIds = new Set((existing ?? []).map((e) => e.opportunity_id));
  return signals.filter((s) => !tradedIds.has(s.id));
}

// ── Open a trade on Hyperliquid ───────────────────────────────────────────────
async function openTrade(exchange, signal, riskUsd) {
  const symbol = HL_SYMBOL[signal.asset_symbol];
  if (!symbol) throw new Error(`Unsupported asset: ${signal.asset_symbol}`);

  const isLong = signal.bias === "long";
  const side = isLong ? "buy" : "sell";
  const slSide = isLong ? "sell" : "buy";

  const market = exchange.market(symbol);
  const amtPrecision = market.precision?.amount ?? 0.00001;

  const entryPrice = parseFloat(signal.entry_price);
  const slPrice = parseFloat(signal.invalidation_level);
  const tp1 = signal.take_profit_levels?.[0]?.level;
  if (!tp1) throw new Error("No TP1 level in signal");
  const tpPrice = parseFloat(tp1);

  const posSize = calcPositionSize(riskUsd, entryPrice, slPrice, amtPrecision);

  console.log(`[hl-trader] ${signal.asset_symbol} ${signal.bias.toUpperCase()} | quality:${signal.quality_score} | entry:$${entryPrice} | SL:$${slPrice} | TP:$${tpPrice} | size:${posSize}`);

  if (DRY_RUN) {
    console.log(`[hl-trader] DRY RUN — skipping order placement`);
    return null;
  }

  // ── 1. Market entry ────────────────────────────────────────────────────────
  const signalAgeMin = signal.created_at
    ? (Date.now() - new Date(signal.created_at).getTime()) / (1000 * 60)
    : null;
  const mainOrder = await placeMarketEntry(exchange, symbol, side, posSize, entryPrice, signalAgeMin);
  console.log(`[hl-trader] ✓ Market entry | id:${mainOrder.id}`);

  const actualEntry = mainOrder.average ?? mainOrder.info?.average ?? entryPrice;
  console.log(`[hl-trader] ✓ Filled at $${actualEntry}`);

  // Adjust SL/TP proportionally if actual fill differs from signal entry
  const slAdjusted = round(slPrice * (actualEntry / entryPrice), 2);
  const tpAdjusted = round(tpPrice * (actualEntry / entryPrice), 2);

  // ── 2. Place SL ───────────────────────────────────────────────────────────
  let slOrderId = null;
  try {
    const slOrder = await exchange.createOrder(symbol, "stop", slSide, posSize, slAdjusted, {
      triggerPrice: slAdjusted,
      reduceOnly: true,
    });
    slOrderId = slOrder.id;
    console.log(`[hl-trader] ✓ SL at $${slAdjusted} | id:${slOrderId}`);
  } catch (e) {
    // SL failed — close position immediately rather than leave it unprotected
    console.error(`[hl-trader] ✗ SL failed: ${e.message} — closing position for safety`);
    const ct = await exchange.fetchTicker(symbol);
    await exchange.createOrder(symbol, "market", slSide, posSize, ct.last, { reduceOnly: true });
    throw new Error(`SL placement failed, position closed. Original: ${e.message}`);
  }

  await sleep(500);

  // ── 3. Place TP ───────────────────────────────────────────────────────────
  let tpOrderId = null;
  try {
    const tpOrder = await exchange.createOrder(symbol, "limit", slSide, posSize, tpAdjusted, {
      postOnly: true,
      reduceOnly: true,
    });
    tpOrderId = tpOrder.id;
    console.log(`[hl-trader] ✓ TP at $${tpAdjusted} | id:${tpOrderId}`);
  } catch (e) {
    console.warn(`[hl-trader] TP failed (SL protects): ${e.message}`);
  }

  return {
    hl_order_id: mainOrder.id,
    hl_sl_order_id: slOrderId,
    hl_tp_order_id: tpOrderId,
    actual_entry_price: actualEntry,
    position_size_contracts: posSize,
  };
}

// ── Record trade in Supabase ──────────────────────────────────────────────────
async function recordTrade(signal, execution, riskUsd) {
  const tp1Level = signal.take_profit_levels?.[0]?.level;

  const row = {
    opportunity_id: signal.id,
    signal_date: signal.simulation_date,
    asset_symbol: signal.asset_symbol,
    bias: signal.bias,
    signal_entry_price: signal.entry_price,
    signal_sl: signal.invalidation_level,
    signal_tp1: tp1Level,
    signal_quality_score: signal.quality_score,
    signal_rr: signal.risk_reward_ratio,
    signal_method_alignment: signal.method_alignment,
    risk_usd: riskUsd,
    environment: TESTNET ? "testnet" : "mainnet",
    outcome: execution ? "open" : "pending_entry",
    ...(execution
      ? {
          hl_order_id: execution.hl_order_id,
          hl_sl_order_id: execution.hl_sl_order_id,
          hl_tp_order_id: execution.hl_tp_order_id,
          actual_entry_price: execution.actual_entry_price,
          position_size_contracts: execution.position_size_contracts,
        }
      : {}),
  };

  const { error } = await supabase.from("hyperliquid_trades").insert(row);
  if (error) throw new Error(`DB insert failed: ${error.message}`);
  console.log(`[hl-trader] ✓ Recorded in hyperliquid_trades`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n[hl-trader] ══════════════════════════════════════`);
  console.log(`[hl-trader] Hyperliquid Signal Trader ${DRY_RUN ? "(DRY RUN)" : ""}`);
  console.log(`[hl-trader] Filter: aligned=true, quality>=${MIN_QUALITY}, status=pending, assets=${TRADED_ASSETS.join("/")}`);
  console.log(`[hl-trader] Policy: max ${MAX_SAME_DIRECTION} same-direction tranches/asset, flip on opposite-direction signal`);
  console.log(`[hl-trader] Risk per trade: $${RISK_USD} | ${TESTNET ? "TESTNET" : "MAINNET"}`);
  console.log(`[hl-trader] ══════════════════════════════════════\n`);

  const exchange = new ccxt.hyperliquid({
    walletAddress: WALLET_ADDRESS,
    privateKey: PRIVATE_KEY,
    sandbox: TESTNET,
  });
  await exchange.loadMarkets();

  const [signals, openByAsset] = await Promise.all([
    fetchNewSignals(),
    fetchOpenPositionsByAsset(),
  ]);

  console.log(`[hl-trader] Found ${signals.length} new signal(s) to process.`);
  for (const asset of TRADED_ASSETS) {
    const open = openByAsset[asset] ?? [];
    if (open.length) {
      console.log(`[hl-trader] ${asset} currently open: ${open.map((p) => p.bias).join(", ")}`);
    }
  }
  console.log("");

  if (signals.length === 0) {
    console.log("[hl-trader] Nothing to do. Run again after the next scanner cycle.");
    return;
  }

  // Deduplicate: only take the highest-quality signal per asset this run
  const bestByAsset = {};
  for (const signal of signals) {
    const existing = bestByAsset[signal.asset_symbol];
    if (!existing || signal.quality_score > existing.quality_score) {
      bestByAsset[signal.asset_symbol] = signal;
    }
  }
  const dedupedSignals = Object.values(bestByAsset);

  if (dedupedSignals.length < signals.length) {
    console.log(`[hl-trader] Deduplicated to ${dedupedSignals.length} signal(s) (one per asset, highest quality wins)\n`);
  }

  let opened = 0;
  let flipped = 0;
  let skipped = 0;

  for (const signal of dedupedSignals) {
    console.log(`[hl-trader] ── Processing ${signal.asset_symbol} ${signal.bias.toUpperCase()} (quality:${signal.quality_score}) ──`);

    const openPositions = openByAsset[signal.asset_symbol] ?? [];
    const sameDirection = openPositions.filter((p) => p.bias === signal.bias);
    const oppositeDirection = openPositions.filter((p) => p.bias !== signal.bias);

    try {
      if (oppositeDirection.length > 0) {
        for (const pos of oppositeDirection) {
          await flipClosePosition(exchange, pos);
          flipped++;
          await sleep(500);
        }
      } else if (sameDirection.length >= MAX_SAME_DIRECTION) {
        console.log(`[hl-trader] ⊘ Skipping — ${signal.asset_symbol} already has ${sameDirection.length}/${MAX_SAME_DIRECTION} ${signal.bias} tranches open.`);
        skipped++;
        continue;
      }

      const execution = await openTrade(exchange, signal, RISK_USD);
      await recordTrade(signal, execution, RISK_USD);
      // Keep in-memory state consistent in case another signal this run targets the same asset
      (openByAsset[signal.asset_symbol] ??= []).push({
        asset_symbol: signal.asset_symbol,
        bias: signal.bias,
      });
      opened++;
    } catch (e) {
      console.error(`[hl-trader] ✗ Skipped ${signal.asset_symbol}: ${e.message}`);
      skipped++;
    }
    await sleep(1000);
  }

  console.log(`\n[hl-trader] Done. Opened: ${opened} | Flipped: ${flipped} | Skipped: ${skipped}`);
}

main().catch((err) => {
  console.error("[hl-trader] Fatal:", err.message);
  process.exit(1);
});
