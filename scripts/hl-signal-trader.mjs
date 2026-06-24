/**
 * hl-signal-trader.mjs
 *
 * Reads new Aligned + Quality≥70 signals from opportunity_performance,
 * opens positions on Hyperliquid with SL and TP, and records executions
 * in the hyperliquid_trades table for comparison with paper trading.
 *
 * Filter: source=live, scoring_version=v2, method_alignment=true, quality_score>=70, final_status=pending
 *
 * Position conflict logic:
 *   - Same asset, same direction → skip (already in trade)
 *   - Same asset, opposite direction → evaluate based on quality + P&L before closing
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


// ── Fetch our open DB records — PRIMARY source of truth for conflict detection ─
async function fetchOpenDBRecords() {
  const { data } = await supabase
    .from("hyperliquid_trades")
    .select("id, asset_symbol, bias, signal_quality_score, signal_sl, signal_tp1, actual_entry_price, position_size_contracts, hl_sl_order_id, hl_tp_order_id")
    .eq("outcome", "open")
    .eq("environment", TESTNET ? "testnet" : "mainnet");

  // Group by asset: use highest quality record as reference, sum all sizes
  const byAsset = {};
  for (const rec of (data ?? [])) {
    const size = parseFloat(rec.position_size_contracts ?? 0);
    if (!byAsset[rec.asset_symbol]) {
      byAsset[rec.asset_symbol] = { ...rec, totalSize: size };
    } else {
      byAsset[rec.asset_symbol].totalSize += size;
      if (rec.signal_quality_score > byAsset[rec.asset_symbol].signal_quality_score) {
        byAsset[rec.asset_symbol] = { ...rec, totalSize: byAsset[rec.asset_symbol].totalSize };
      }
    }
  }
  return byAsset;
}


// ── Fetch signals not yet traded on HL ───────────────────────────────────────
async function fetchNewSignals() {
  // Only act on signals from the current scanner cycle (last 24h).
  // Older pending signals may have stale setups — paper holds them passively
  // but we should not actively enter them now.
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split("T")[0];

  const { data: signals, error } = await supabase
    .from("opportunity_performance")
    .select("id, asset_symbol, bias, entry_price, invalidation_level, take_profit_levels, quality_score, risk_reward_ratio, method_alignment, simulation_date")
    .eq("source", "live")
    .eq("scoring_version", "v2")
    .eq("final_status", "pending")
    .eq("method_alignment", true)
    .gte("quality_score", MIN_QUALITY)
    .gte("simulation_date", yesterday)
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

  // Pre-entry size estimate based on signal entry (used for the market order itself)
  const estimatedSize = calcPositionSize(riskUsd, entryPrice, slPrice, amtPrecision);

  console.log(`[hl-trader] ${signal.asset_symbol} ${signal.bias.toUpperCase()} | quality:${signal.quality_score} | entry:$${entryPrice} | SL:$${slPrice} | TP:$${tpPrice} | size:${estimatedSize}`);

  if (DRY_RUN) {
    console.log(`[hl-trader] DRY RUN — skipping order placement`);
    return null;
  }

  // ── 1. Market entry ────────────────────────────────────────────────────────
  const mainOrder = await exchange.createOrder(symbol, "market", side, estimatedSize, entryPrice, {
    slippagePercentage: 5,
  });
  console.log(`[hl-trader] ✓ Market entry | id:${mainOrder.id}`);

  const actualEntry = mainOrder.average ?? mainOrder.info?.average ?? entryPrice;
  const fillDevPct = Math.abs((actualEntry - entryPrice) / entryPrice * 100);
  if (fillDevPct > 2) {
    console.warn(`[hl-trader] ⚠ Fill deviation ${fillDevPct.toFixed(1)}% (signal $${entryPrice} → actual $${actualEntry})`);
  }
  console.log(`[hl-trader] ✓ Filled at $${actualEntry}`);

  // SL/TP are absolute technical levels set by the scanner (invalidation zone / target).
  // Do NOT adjust them proportionally to fill price — that tightens the SL when entry
  // deviates from signal, causing HL to stop out where paper trading would not.
  const slAdjusted = slPrice;
  const tpAdjusted = tpPrice;

  // SL/TP orders must match the filled size exactly.
  const posSize = estimatedSize;
  // Log actual risk so we can audit fill-price divergence impact.
  const actualRiskUsd = round(Math.abs(actualEntry - slPrice) * posSize, 2);
  if (fillDevPct > 1) {
    console.log(`[hl-trader] ℹ Actual risk ~$${actualRiskUsd} (target $${riskUsd}) due to $${round(Math.abs(actualEntry - entryPrice), 2)} fill deviation`);
  }

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

  const [signals, openDBRecords] = await Promise.all([
    fetchNewSignals(),
    fetchOpenDBRecords(),
  ]);

  const dbOpenAssets = Object.keys(openDBRecords);
  console.log(`[hl-trader] Found ${signals.length} new signal(s) to process.`);
  console.log(`[hl-trader] Open positions (DB): ${dbOpenAssets.length > 0 ? dbOpenAssets.join(", ") : "none"}\n`);

  if (signals.length === 0) {
    console.log("[hl-trader] Nothing to do. Run again after the next scanner cycle.");
    return;
  }

  // Deduplicate: only take the highest-quality signal per asset
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

    // DB record is the authoritative check — does not depend on HL API reliability
    const dbRecord = openDBRecords[signal.asset_symbol];

    // No open position for this asset — open freely
    if (!dbRecord) {
      try {
        const execution = await openTrade(exchange, signal, RISK_USD);
        await recordTrade(signal, execution, RISK_USD);
        // Track in memory so subsequent signals in same run don't double-open
        openDBRecords[signal.asset_symbol] = { bias: signal.bias };
        opened++;
      } catch (e) {
        console.error(`[hl-trader] ✗ Skipped ${signal.asset_symbol}: ${e.message}`);
        skipped++;
      }
      await sleep(1000);
      continue;
    }

    // Position already open for this asset (any direction) — let it run to SL/TP
    const direction = dbRecord.bias === signal.bias ? "same direction" : `opposite direction (open:${dbRecord.bias})`;
    console.log(`[hl-trader] ⊘ Skipping ${signal.asset_symbol} — ${direction} already open`);
    skipped++;
  }

  console.log(`\n[hl-trader] Done. Opened: ${opened} | Skipped: ${skipped}`);
}

main().catch((err) => {
  console.error("[hl-trader] Fatal:", err.message);
  process.exit(1);
});
