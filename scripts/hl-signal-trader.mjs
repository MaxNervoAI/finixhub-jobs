/**
 * hl-signal-trader.mjs
 *
 * Reads new Aligned + Quality≥70 signals from opportunity_performance,
 * opens positions on Hyperliquid with SL and TP, and records executions
 * in the hyperliquid_trades table for comparison with paper trading.
 *
 * Filter: source=live, scoring_version=v2, method_alignment=true, quality_score>=70, final_status=pending
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
  // Round to the market's lot size
  const decimals = Math.max(0, Math.round(-Math.log10(amtPrecision)));
  return round(rawSize, decimals);
}

// ── Fetch signals not yet traded on HL ───────────────────────────────────────
async function fetchNewSignals() {
  // 1. Get aligned, quality>=70, pending live signals
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

  // 2. Get already-traded opportunity IDs
  const signalIds = signals.map((s) => s.id);
  const { data: existing } = await supabase
    .from("hyperliquid_trades")
    .select("opportunity_id")
    .in("opportunity_id", signalIds)
    .neq("outcome", "cancelled");

  const tradedIds = new Set((existing ?? []).map((e) => e.opportunity_id));

  // 3. Return only untreated signals
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

  // Use signal entry price (= live market price at scan time)
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

  // ── 1. Place market entry (ensure immediate fill at current price) ──────────
  const mainOrder = await exchange.createOrder(symbol, "market", side, posSize);
  console.log(`[hl-trader] ✓ Market entry | id:${mainOrder.id}`);

  // ── 2. Market order fills immediately; get actual fill price ─────────────────
  // For market orders, CCXT fills immediately and returns status 'closed'
  const actualEntry = mainOrder.average ?? mainOrder.info?.average ?? entryPrice;
  console.log(`[hl-trader] ✓ Filled at $${actualEntry}`);

  // ── 3. Place SL immediately after fill ────────────────────────────────────
  // Adjust SL/TP proportionally if actual fill differs from signal entry
  const slAdjusted = round(slPrice * (actualEntry / entryPrice), 2);
  const tpAdjusted = round(tpPrice * (actualEntry / entryPrice), 2);

  let slOrderId = null;
  try {
    const slOrder = await exchange.createOrder(symbol, "stop", slSide, posSize, slAdjusted, {
      triggerPrice: slAdjusted,
      reduceOnly: true,
    });
    slOrderId = slOrder.id;
    console.log(`[hl-trader] ✓ SL at $${slAdjusted} | id:${slOrderId}`);
  } catch (e) {
    // SL failed — close the position immediately rather than leave it unprotected
    console.error(`[hl-trader] ✗ SL failed: ${e.message} — closing position for safety`);
    const ct = await exchange.fetchTicker(symbol);
    await exchange.createOrder(symbol, "market", slSide, posSize, ct.last, { reduceOnly: true });
    throw new Error(`SL placement failed, position closed. Original: ${e.message}`);
  }

  await sleep(500);

  // ── 4. Place TP ────────────────────────────────────────────────────────────
  let tpOrderId = null;
  try {
    const tpOrder = await exchange.createOrder(symbol, "limit", slSide, posSize, tpAdjusted, {
      postOnly: true,
      reduceOnly: true,
    });
    tpOrderId = tpOrder.id;
    console.log(`[hl-trader] ✓ TP at $${tpAdjusted} | id:${tpOrderId}`);
  } catch (e) {
    // Not fatal — SL still protects the position
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

  // Connect to HL
  const exchange = new ccxt.hyperliquid({
    walletAddress: WALLET_ADDRESS,
    privateKey: PRIVATE_KEY,
    sandbox: TESTNET,
  });
  await exchange.loadMarkets();

  // Fetch new signals
  const signals = await fetchNewSignals();
  console.log(`[hl-trader] Found ${signals.length} new signal(s) to process.\n`);

  if (signals.length === 0) {
    console.log("[hl-trader] Nothing to do. Run again after the next scanner cycle.");
    return;
  }

  let opened = 0;
  let skipped = 0;

  for (const signal of signals) {
    console.log(`[hl-trader] ── Processing ${signal.asset_symbol} ${signal.bias.toUpperCase()} (quality:${signal.quality_score}) ──`);
    try {
      const execution = await openTrade(exchange, signal, RISK_USD);
      await recordTrade(signal, execution, RISK_USD);
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
