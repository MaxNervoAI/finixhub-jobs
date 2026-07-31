/**
 * hl-sync-results.mjs
 *
 * Checks all open hyperliquid_trades against Hyperliquid order state.
 * When a position closes (TP or SL hit), updates the trade record with
 * actual P&L and compares against the paper trading outcome.
 *
 * Position-health rules enforced on every run (added 2026-07-31 after a
 * real incident: two overlapping trader runs opened duplicate positions,
 * one duplicate pair's TP filled without anyone noticing for ~5.5h since
 * this job only ran daily, and the filled side's sibling SL order was
 * never cancelled and sat orphaned on the book):
 *
 *   1. On any confirmed fill, cancel the sibling bracket order — a filled
 *      TP leaves no reason for its SL to keep resting, and vice versa.
 *   2. Sweep all real open orders for tracked assets and cancel any that
 *      don't belong to a currently-open DB row — catches orphans left by
 *      anything that predates rule 1, or any other edge case.
 *   3. Flag (log only, never auto-act) if two 'open' rows share the same
 *      opportunity_id — that's a duplicate-open, not a legitimate stack,
 *      and needs a human look since one side may already be mid-resolution.
 *   4. Flag (log only) if more same-direction positions are open for an
 *      asset than the trader's cap allows — should be structurally
 *      impossible after the hl-signal-trader.yml concurrency fix; seeing
 *      it means something else broke.
 *   5. Flag (log only) partial fills (filled > 0 and remaining > 0) — this
 *      system has no partial-position accounting, so a partial fill is
 *      surfaced for visibility rather than silently mishandled.
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
const MAX_SAME_DIRECTION = 2; // must match hl-signal-trader.mjs

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── Determine if an HL order is filled or cancelled ──────────────────────────
function orderStatus(order) {
  if (!order) return "unknown";
  if (order.status === "closed" || order.status === "filled") return "filled";
  if (order.status === "canceled" || order.status === "cancelled" || order.status === "rejected") return "cancelled";
  return "open";
}

function isPartialFill(order) {
  return !!order && (order.filled ?? 0) > 0 && (order.remaining ?? 0) > 0;
}

// ── Cancel an order, tolerating "already gone" (filled/cancelled/unknownOid) ──
async function safeCancelOrder(exchange, orderId, symbol, label) {
  if (!orderId) return;
  try {
    await exchange.cancelOrder(orderId, symbol);
    console.log(`[hl-sync] ✓ Cancelled orphaned ${label} order ${orderId}`);
  } catch (e) {
    // Already filled, already cancelled, or purged — not an error worth failing over.
    console.log(`[hl-sync] ${label} order ${orderId} not cancelled (likely already gone): ${e.message}`);
  }
  await sleep(200);
}

// ── Reconstruct the real closing fill from account trade history ─────────────
// Used when the SL/TP order objects are gone (unknownOid) so we can't read
// their fill price directly. Returns null if no matching closing fill is found
// — callers must NOT fabricate a P&L number in that case.
async function reconstructExitFromTrades(exchange, trade, symbol) {
  const since = trade.created_at ? new Date(trade.created_at).getTime() : undefined;
  const closingSide = trade.bias === "long" ? "sell" : "buy";

  try {
    // Fetch without `since` — Hyperliquid's time-bounded fills endpoint
    // (userFillsByTime, used when `since` is passed) has proven unreliable;
    // the default fills endpoint (userFills, last ~2000 fills) is the
    // battle-tested path. Filter by time/side ourselves instead.
    const myTrades = await exchange.fetchMyTrades(symbol);
    console.log(
      `[hl-sync] ${trade.asset_symbol} ${trade.bias}: fetched ${myTrades?.length ?? 0} raw fill(s) for symbol, ` +
      `sides seen: ${[...new Set((myTrades ?? []).map((t) => t.side))].join(",") || "none"}`
    );
    const closingFills = (myTrades ?? []).filter(
      (t) => t.side === closingSide && (since == null || t.timestamp >= since)
    );
    if (!closingFills.length) return null;

    const totalQty = closingFills.reduce((s, t) => s + t.amount, 0);
    const notional = closingFills.reduce((s, t) => s + t.amount * t.price, 0);
    if (totalQty <= 0) return null;

    const lastTs = Math.max(...closingFills.map((t) => t.timestamp));
    return { exitPrice: notional / totalQty, closedAt: new Date(lastTs).toISOString() };
  } catch (e) {
    console.warn(`[hl-sync] Could not reconstruct exit via trade history: ${e.message}`);
    return null;
  }
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

  // Rule 5: surface partial fills — no attempt to resolve them, just visibility.
  if (isPartialFill(tpOrder)) {
    console.warn(`[hl-sync] ⚠ PARTIAL FILL: ${trade.asset_symbol} ${trade.bias} TP order ${trade.hl_tp_order_id} — filled ${tpOrder.filled}/${(tpOrder.filled ?? 0) + (tpOrder.remaining ?? 0)}. Leaving as open; no partial-position accounting exists yet.`);
  }
  if (isPartialFill(slOrder)) {
    console.warn(`[hl-sync] ⚠ PARTIAL FILL: ${trade.asset_symbol} ${trade.bias} SL order ${trade.hl_sl_order_id} — filled ${slOrder.filled}/${(slOrder.filled ?? 0) + (slOrder.remaining ?? 0)}. Leaving as open; no partial-position accounting exists yet.`);
  }

  const tpFilled = orderStatus(tpOrder) === "filled";
  const slFilled = orderStatus(slOrder) === "filled";

  // If neither order explicitly shows filled, only a REAL matched closing
  // fill (from account trade history) can prove the trade is closed.
  // `fetchPositions` returning empty is NOT used as evidence here — it gave
  // a false negative once already (reported a genuinely still-open testnet
  // position as gone), which caused hl-signal-trader.mjs to open a duplicate
  // position on top of a live one. Absence of proof must default to "still
  // open", never to "closed".
  if (!tpFilled && !slFilled) {
    const reconstructed = await reconstructExitFromTrades(exchange, trade, symbol);

    if (reconstructed && trade.actual_entry_price && trade.position_size_contracts) {
      console.log(`[hl-sync] ${trade.asset_symbol} ${trade.bias}: found closing fill in trade history — reconciling`);
      const { exitPrice, closedAt } = reconstructed;
      const priceDiff = isLong
        ? exitPrice - trade.actual_entry_price
        : trade.actual_entry_price - exitPrice;
      const actualPnlUsd = priceDiff * trade.position_size_contracts;
      const actualR = trade.risk_usd ? actualPnlUsd / trade.risk_usd : null;
      const daysHeld = trade.created_at
        ? (new Date(closedAt).getTime() - new Date(trade.created_at).getTime()) / (1000 * 60 * 60 * 24)
        : null;

      // Rule 1: whatever closed this, cancel any bracket orders that are
      // still resting — neither should still make sense once the position
      // is gone by some other means.
      await safeCancelOrder(exchange, trade.hl_tp_order_id, symbol, "TP");
      await safeCancelOrder(exchange, trade.hl_sl_order_id, symbol, "SL");

      return {
        outcome: actualPnlUsd >= 0 ? "winner" : "loser",
        actual_exit_price: exitPrice,
        actual_pnl_usd: parseFloat(actualPnlUsd.toFixed(2)),
        actual_r: actualR != null ? parseFloat(actualR.toFixed(3)) : null,
        closed_at: closedAt,
        days_held: daysHeld != null ? parseFloat(daysHeld.toFixed(2)) : null,
        // Can't tell from trade history alone whether this was the SL, the
        // TP, or a manual/flip close that hl-signal-trader.mjs didn't record
        // itself — 'manual' just means "closed by something other than a
        // bracket order filling, cause unknown".
        close_reason: "manual",
      };
    }

    // No positive proof of closure. It's fine to also note what
    // fetchPositions thinks, purely for visibility — but it must NOT change
    // the outcome. Still open until proven otherwise.
    try {
      const positions = await exchange.fetchPositions([symbol]);
      const positionExists = positions.some((p) => p.symbol === symbol && Math.abs(p.contracts ?? 0) > 0);
      if (!positionExists) {
        console.warn(`[hl-sync] ${trade.asset_symbol} ${trade.bias}: fetchPositions reports no position, but no closing fill found in trade history either — leaving as OPEN and flagging for manual review (do not trust fetchPositions alone)`);
      }
    } catch (_) { /* purely informational, ignore failures */ }

    return null; // still open
  }

  // Determine winner/loser
  const outcome = tpFilled ? "winner" : "loser";
  const exitOrder = tpFilled ? tpOrder : slOrder;
  const actualExit = exitOrder?.average ?? exitOrder?.price ?? null;

  // Rule 1: cancel the sibling order — it filled, its counterpart no longer protects anything real.
  if (tpFilled) {
    await safeCancelOrder(exchange, trade.hl_sl_order_id, symbol, "SL");
  } else {
    await safeCancelOrder(exchange, trade.hl_tp_order_id, symbol, "TP");
  }

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
    close_reason: tpFilled ? "take_profit" : "stop_loss",
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

// ── Rule 3 + 4: structural health checks over whatever is open AFTER syncing ──
async function runHealthChecks() {
  const { data: openTrades } = await supabase
    .from("hyperliquid_trades")
    .select("id, asset_symbol, bias, opportunity_id, created_at")
    .eq("outcome", "open")
    .eq("environment", TESTNET ? "testnet" : "mainnet");

  if (!openTrades?.length) return;

  // Rule 3: duplicate opportunity_id among currently-open rows.
  const byOpportunity = new Map();
  for (const t of openTrades) {
    if (!t.opportunity_id) continue;
    if (!byOpportunity.has(t.opportunity_id)) byOpportunity.set(t.opportunity_id, []);
    byOpportunity.get(t.opportunity_id).push(t);
  }
  for (const [oppId, rows] of byOpportunity) {
    if (rows.length > 1) {
      console.error(
        `[hl-sync] 🚨 CRITICAL: ${rows.length} open trades share the same opportunity_id (${oppId}) — ` +
        `this is a duplicate-open, not a legitimate stack. IDs: ${rows.map((r) => r.id).join(", ")}. ` +
        `Not auto-closing (one side may already be mid-resolution) — needs manual review.`
      );
    }
  }

  // Rule 4: same-direction cap violation.
  const byAssetBias = new Map();
  for (const t of openTrades) {
    const key = `${t.asset_symbol}:${t.bias}`;
    if (!byAssetBias.has(key)) byAssetBias.set(key, []);
    byAssetBias.get(key).push(t);
  }
  for (const [key, rows] of byAssetBias) {
    if (rows.length > MAX_SAME_DIRECTION) {
      console.error(
        `[hl-sync] 🚨 CRITICAL: ${key} has ${rows.length} concurrent open positions, exceeding the cap of ${MAX_SAME_DIRECTION}. ` +
        `IDs: ${rows.map((r) => r.id).join(", ")}. This should be structurally impossible — investigate immediately.`
      );
    }
  }
}

// ── Rule 2: cancel any resting order that doesn't belong to a currently-open row ──
async function sweepOrphanedOrders(exchange) {
  const { data: openTrades } = await supabase
    .from("hyperliquid_trades")
    .select("hl_tp_order_id, hl_sl_order_id")
    .eq("outcome", "open")
    .eq("environment", TESTNET ? "testnet" : "mainnet");

  const trackedIds = new Set();
  for (const t of openTrades ?? []) {
    if (t.hl_tp_order_id) trackedIds.add(String(t.hl_tp_order_id));
    if (t.hl_sl_order_id) trackedIds.add(String(t.hl_sl_order_id));
  }

  let orphansFound = 0;
  for (const [asset, symbol] of Object.entries(HL_SYMBOL)) {
    let orders;
    try {
      orders = await exchange.fetchOpenOrders(symbol);
    } catch (e) {
      console.warn(`[hl-sync] Could not fetch open orders for ${asset}: ${e.message}`);
      continue;
    }
    for (const o of orders) {
      if (!o.reduceOnly) continue; // only bracket (TP/SL) orders are ours to manage
      if (trackedIds.has(String(o.id))) continue;
      orphansFound++;
      console.warn(`[hl-sync] Found orphaned ${asset} order ${o.id} (${o.side} @ ${o.price ?? o.triggerPrice}) — not tracked by any open trade`);
      await safeCancelOrder(exchange, o.id, symbol, `orphaned ${asset}`);
    }
    await sleep(300);
  }

  if (orphansFound === 0) {
    console.log("[hl-sync] Orphan sweep: none found.");
  } else {
    console.log(`[hl-sync] Orphan sweep: cancelled ${orphansFound} orphaned order(s).`);
  }
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

  let synced = 0;
  let stillOpen = 0;

  for (const trade of openTrades ?? []) {
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

  console.log(`\n[hl-sync] Running orphaned-order sweep...`);
  await sweepOrphanedOrders(exchange);

  console.log(`\n[hl-sync] Running structural health checks...`);
  await runHealthChecks();
}

main().catch((err) => {
  console.error("[hl-sync] Fatal:", err.message);
  process.exit(1);
});
