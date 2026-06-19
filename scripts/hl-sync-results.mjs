/**
 * hl-sync-results.mjs
 *
 * Checks all open hyperliquid_trades against Hyperliquid order state.
 * When a position closes (TP or SL hit), updates the trade record with
 * actual P&L and compares against the paper trading outcome.
 *
 * Usage: node scripts/hl-sync-results.mjs
 */

import "dotenv/config";
import ccxt from "ccxt";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const WALLET_ADDRESS = process.env.HL_WALLET_ADDRESS;
const PRIVATE_KEY = process.env.HL_PRIVATE_KEY;
const TESTNET = process.env.HL_TESTNET !== "false";

if (!SUPABASE_URL || !SUPABASE_KEY || !WALLET_ADDRESS || !PRIVATE_KEY) {
  console.error("[hl-sync] Missing required env vars");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const HL_SYMBOL = { BTC: "BTC/USDC:USDC", ETH: "ETH/USDC:USDC", SOL: "SOL/USDC:USDC" };

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── Determine if an HL order is filled or cancelled ──────────────────────────
function orderStatus(order) {
  if (!order) return "unknown";
  if (order.status === "closed" || order.status === "filled") return "filled";
  if (order.status === "canceled" || order.status === "cancelled" || order.status === "rejected") return "cancelled";
  return "open";
}

// ── Check one open trade ──────────────────────────────────────────────────────
async function checkTrade(exchange, trade) {
  const symbol = HL_SYMBOL[trade.asset_symbol];
  if (!symbol) {
    console.warn(`[hl-sync] Unknown asset ${trade.asset_symbol} for trade ${trade.id}`);
    return null;
  }

  const isLong = trade.bias === "long";

  // Fetch TP and SL order statuses
  let tpOrder = null;
  let slOrder = null;

  try {
    if (trade.hl_tp_order_id) {
      tpOrder = await exchange.fetchOrder(trade.hl_tp_order_id, symbol);
      await sleep(200);
    }
  } catch (e) {
    console.warn(`[hl-sync] Could not fetch TP order ${trade.hl_tp_order_id}: ${e.message}`);
  }

  try {
    if (trade.hl_sl_order_id) {
      slOrder = await exchange.fetchOrder(trade.hl_sl_order_id, symbol);
      await sleep(200);
    }
  } catch (e) {
    console.warn(`[hl-sync] Could not fetch SL order ${trade.hl_sl_order_id}: ${e.message}`);
  }

  const tpFilled = orderStatus(tpOrder) === "filled";
  const slFilled = orderStatus(slOrder) === "filled";

  // If neither order filled yet, check if position is still open
  if (!tpFilled && !slFilled) {
    // Double-check via open positions
    try {
      const positions = await exchange.fetchPositions([symbol]);
      const pos = positions.find(
        (p) => p.symbol === symbol && p.contracts > 0
      );
      if (!pos) {
        // Position closed but no order marked filled — probably closed manually
        console.log(`[hl-sync] ${trade.asset_symbol} ${trade.bias}: position not found, may be manually closed`);
      }
    } catch (_) { /* ignore */ }
    return null; // Still open
  }

  // Determine winner/loser
  const outcome = tpFilled ? "winner" : "loser";
  const exitOrder = tpFilled ? tpOrder : slOrder;
  const actualExit = exitOrder?.average ?? exitOrder?.price ?? null;

  // Calculate P&L
  let actualPnlUsd = null;
  let actualR = null;
  if (actualExit && trade.actual_entry_price && trade.position_size_contracts) {
    const priceDiff = isLong
      ? actualExit - trade.actual_entry_price
      : trade.actual_entry_price - actualExit;
    actualPnlUsd = priceDiff * trade.position_size_contracts;
    actualR = trade.risk_usd ? actualPnlUsd / trade.risk_usd : null;
  }

  const closedAt = exitOrder?.lastTradeTimestamp
    ? new Date(exitOrder.lastTradeTimestamp).toISOString()
    : new Date().toISOString();

  const daysHeld = trade.created_at
    ? (Date.now() - new Date(trade.created_at).getTime()) / (1000 * 60 * 60 * 24)
    : null;

  return {
    outcome,
    actual_exit_price: actualExit,
    actual_pnl_usd: actualPnlUsd ? parseFloat(actualPnlUsd.toFixed(2)) : null,
    actual_r: actualR ? parseFloat(actualR.toFixed(3)) : null,
    closed_at: closedAt,
    days_held: daysHeld ? parseFloat(daysHeld.toFixed(2)) : null,
  };
}

// ── Fetch paper trading result for comparison ─────────────────────────────────
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

// ── Log comparison ────────────────────────────────────────────────────────────
function logComparison(trade, result, paper) {
  const hlStr = `HL: ${result.outcome} ${result.actual_r != null ? (result.actual_r > 0 ? "+" : "") + result.actual_r + "R" : ""}`;
  const paperStr = paper.paper_outcome
    ? `Paper: ${paper.paper_outcome} ${paper.paper_r != null ? (paper.paper_r > 0 ? "+" : "") + paper.paper_r + "R" : ""}`
    : "Paper: pending";
  const match = paper.paper_outcome === result.outcome ? "✓ match" : "✗ diverged";
  console.log(`[hl-sync] ${trade.asset_symbol} ${trade.bias.toUpperCase()} CLOSED | ${hlStr} | ${paperStr} | ${match}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n[hl-sync] ══════════════════════════════════════`);
  console.log(`[hl-sync] Hyperliquid Results Sync`);
  console.log(`[hl-sync] ${TESTNET ? "TESTNET" : "MAINNET"}`);
  console.log(`[hl-sync] ══════════════════════════════════════\n`);

  const exchange = new ccxt.hyperliquid({
    walletAddress: WALLET_ADDRESS,
    privateKey: PRIVATE_KEY,
    sandbox: TESTNET,
  });
  await exchange.loadMarkets();

  // Fetch all open HL trades
  const { data: openTrades, error } = await supabase
    .from("hyperliquid_trades")
    .select("*")
    .eq("outcome", "open");

  if (error) throw new Error(`Supabase fetch error: ${error.message}`);
  console.log(`[hl-sync] Checking ${openTrades?.length ?? 0} open trade(s)...\n`);

  if (!openTrades?.length) {
    console.log("[hl-sync] No open trades to sync.");
    return;
  }

  let synced = 0;
  let stillOpen = 0;

  for (const trade of openTrades) {
    console.log(`[hl-sync] Checking ${trade.asset_symbol} ${trade.bias} (opened ${trade.signal_date})...`);
    try {
      const result = await checkTrade(exchange, trade);

      if (!result) {
        console.log(`[hl-sync] → Still open`);
        stillOpen++;
        await sleep(500);
        continue;
      }

      const paper = await fetchPaperResult(trade.opportunity_id);
      logComparison(trade, result, paper);

      const { error: updateErr } = await supabase
        .from("hyperliquid_trades")
        .update({
          ...result,
          ...paper,
          updated_at: new Date().toISOString(),
        })
        .eq("id", trade.id);

      if (updateErr) {
        console.error(`[hl-sync] Failed to update trade ${trade.id}: ${updateErr.message}`);
      } else {
        synced++;
      }
    } catch (e) {
      console.error(`[hl-sync] Error checking trade ${trade.id}: ${e.message}`);
    }
    await sleep(800);
  }

  console.log(`\n[hl-sync] Done. Synced: ${synced} | Still open: ${stillOpen}`);
  if (synced > 0) {
    console.log(`\n[hl-sync] Run this query in Supabase to compare paper vs real:`);
    console.log(`SELECT signal_date, asset_symbol, bias, signal_quality_score, actual_r, outcome as hl_outcome, paper_outcome, paper_r, actual_r - paper_r as r_delta FROM hyperliquid_trades ORDER BY signal_date DESC;`);
  }
}

main().catch((err) => {
  console.error("[hl-sync] Fatal:", err.message);
  process.exit(1);
});
