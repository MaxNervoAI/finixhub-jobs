/**
 * hl-signal-trader.mjs
 *
 * Reads new Aligned + Quality≥70 signals from opportunity_performance,
 * opens positions on Hyperliquid with SL and TP, and records executions
 * in the hyperliquid_trades table for comparison with paper trading.
 *
 * Filter: source=live, scoring_version=v2, method_alignment=true, quality_score>=70, final_status=pending
 *
 * Position policy (kept intentionally simple for reliability):
 *   - No open DB record for the asset → open freely.
 *   - An open DB record already exists for the asset → skip entirely. Never
 *     modify, upgrade, flip, or cancel anything on an existing position. The
 *     only thing that closes a position is its own SL/TP order filling, or
 *     hl-sync-results.mjs reconciling it after the fact.
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

// ── Symbol mapping ────────────────────────────────────────────────────────────
const HL_SYMBOL = { BTC: "BTC/USDC:USDC", ETH: "ETH/USDC:USDC", SOL: "SOL/USDC:USDC" };

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
// is usually enough to catch a momentary liquidity gap without adding
// meaningful staleness risk to the entry.
const ENTRY_ATTEMPTS = 2;
const ENTRY_RETRY_DELAY_MS = 3000;
// If price has moved more than this from the original signal price by the
// time of the retry, the setup the quality score was computed for no longer
// holds — better to miss the trade than chase it at a level the signal never
// justified. (Seen live: a retry chased ETH 6.6% away from signal price.)
const ENTRY_MAX_DEVIATION_PCT = 1.5;

async function placeMarketEntry(exchange, symbol, side, posSize, referencePrice) {
  let lastErr;
  for (let attempt = 1; attempt <= ENTRY_ATTEMPTS; attempt++) {
    try {
      let price = referencePrice;
      if (attempt > 1) {
        price = (await exchange.fetchTicker(symbol)).last;
        const deviationPct = Math.abs(price - referencePrice) / referencePrice * 100;
        if (deviationPct > ENTRY_MAX_DEVIATION_PCT) {
          throw new Error(
            `Price moved ${deviationPct.toFixed(2)}% from signal ($${referencePrice} → $${price}), ` +
            `exceeding ${ENTRY_MAX_DEVIATION_PCT}% max deviation — signal is stale, not chasing`
          );
        }
      }
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

// ── Assets with an already-open DB record — the ONLY conflict check ──────────
// The DB is the single source of truth here on purpose: it's what the rest of
// the app reads, and it's guaranteed consistent as long as hl-sync-results.mjs
// keeps it that way. No live HL position lookup is needed to make this decision.
async function fetchBusyAssets() {
  const { data } = await supabase
    .from("hyperliquid_trades")
    .select("asset_symbol")
    .eq("outcome", "open")
    .eq("environment", TESTNET ? "testnet" : "mainnet");
  return new Set((data ?? []).map((r) => r.asset_symbol));
}

// ── Fetch signals not yet traded on HL ───────────────────────────────────────
async function fetchNewSignals() {
  const { data: signals, error } = await supabase
    .from("opportunity_performance")
    .select("id, asset_symbol, bias, entry_price, invalidation_level, take_profit_levels, quality_score, risk_reward_ratio, method_alignment, simulation_date")
    .eq("source", "live")
    .eq("scoring_version", "v2")
    .eq("final_status", "pending")
    .eq("method_alignment", true)
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
  const mainOrder = await placeMarketEntry(exchange, symbol, side, posSize, entryPrice);
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
  console.log(`[hl-trader] Filter: aligned=true, quality>=${MIN_QUALITY}, status=pending`);
  console.log(`[hl-trader] Risk per trade: $${RISK_USD} | ${TESTNET ? "TESTNET" : "MAINNET"}`);
  console.log(`[hl-trader] ══════════════════════════════════════\n`);

  const exchange = new ccxt.hyperliquid({
    walletAddress: WALLET_ADDRESS,
    privateKey: PRIVATE_KEY,
    sandbox: TESTNET,
  });
  await exchange.loadMarkets();

  const [signals, busyAssets] = await Promise.all([
    fetchNewSignals(),
    fetchBusyAssets(),
  ]);

  console.log(`[hl-trader] Found ${signals.length} new signal(s) to process.`);
  console.log(`[hl-trader] Assets already open (untouched): ${busyAssets.size > 0 ? [...busyAssets].join(", ") : "none"}\n`);

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
  let skipped = 0;

  for (const signal of dedupedSignals) {
    console.log(`[hl-trader] ── Processing ${signal.asset_symbol} ${signal.bias.toUpperCase()} (quality:${signal.quality_score}) ──`);

    if (busyAssets.has(signal.asset_symbol)) {
      console.log(`[hl-trader] ⊘ Skipping — ${signal.asset_symbol} already has an open position. Not touching it.`);
      skipped++;
      continue;
    }

    try {
      const execution = await openTrade(exchange, signal, RISK_USD);
      await recordTrade(signal, execution, RISK_USD);
      busyAssets.add(signal.asset_symbol); // don't double-open within the same run
      opened++;
    } catch (e) {
      console.error(`[hl-trader] ✗ Skipped ${signal.asset_symbol}: ${e.message}`);
      skipped++;
    }
    await sleep(1000);
  }

  console.log(`\n[hl-trader] Done. Opened: ${opened} | Skipped: ${skipped}`);
}

main().catch((err) => {
  console.error("[hl-trader] Fatal:", err.message);
  process.exit(1);
});
