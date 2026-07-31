/**
 * hl-close-duplicate.mjs — one-off cleanup.
 * Closes the untouched side of a known accidental duplicate-open
 * (opportunity_id 4b9ac271-ba7e-4689-96a2-403a97bc8152, BTC short), leaving
 * the partially-filled side alone since we have no partial-position
 * accounting to safely force-close it.
 */
import "dotenv/config";
import ccxt from "ccxt";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const WALLET_ADDRESS = process.env.HL_WALLET_ADDRESS;
const PRIVATE_KEY = process.env.HL_PRIVATE_KEY;
const TESTNET = process.env.HL_TESTNET !== "false";

const TRADE_ID = "2c91859f-2bc6-46db-aff9-2647e815260e";
const SYMBOL = "BTC/USDC:USDC";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const { data: trade, error } = await supabase
  .from("hyperliquid_trades")
  .select("*")
  .eq("id", TRADE_ID)
  .single();

if (error || !trade) {
  console.error(`[close-dup] Could not fetch trade ${TRADE_ID}: ${error?.message}`);
  process.exit(1);
}

if (trade.outcome !== "open") {
  console.log(`[close-dup] Trade ${TRADE_ID} is already outcome='${trade.outcome}' — nothing to do.`);
  process.exit(0);
}

console.log(`[close-dup] Closing ${trade.asset_symbol} ${trade.bias}, entry=${trade.actual_entry_price}, size=${trade.position_size_contracts}, risk=$${trade.risk_usd}`);

const exchange = new ccxt.hyperliquid({
  walletAddress: WALLET_ADDRESS,
  privateKey: PRIVATE_KEY,
  sandbox: TESTNET,
});
await exchange.loadMarkets();

// Cancel resting TP/SL first
for (const [label, id] of [["TP", trade.hl_tp_order_id], ["SL", trade.hl_sl_order_id]]) {
  if (!id) continue;
  try {
    await exchange.cancelOrder(id, SYMBOL);
    console.log(`[close-dup] ✓ Cancelled ${label} order ${id}`);
  } catch (e) {
    console.log(`[close-dup] ${label} order ${id} not cancelled (likely already gone): ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, 300));
}

// Close at market — this is a short, so closing side is buy
const isLong = trade.bias === "long";
const closeSide = isLong ? "sell" : "buy";
const referencePrice = (await exchange.fetchTicker(SYMBOL)).last;

const closeOrder = await exchange.createOrder(SYMBOL, "market", closeSide, trade.position_size_contracts, referencePrice, {
  reduceOnly: true,
  slippagePercentage: 5,
});

const exitPrice = closeOrder.average ?? referencePrice;
console.log(`[close-dup] ✓ Closed at $${exitPrice}`);

const entry = parseFloat(trade.actual_entry_price);
const size = parseFloat(trade.position_size_contracts);
const priceDiff = isLong ? exitPrice - entry : entry - exitPrice;
const actualPnlUsd = priceDiff * size;
const actualR = trade.risk_usd ? actualPnlUsd / trade.risk_usd : null;
const closedAt = new Date().toISOString();
const daysHeld = trade.created_at
  ? (Date.now() - new Date(trade.created_at).getTime()) / (1000 * 60 * 60 * 24)
  : null;

const { error: updateErr } = await supabase
  .from("hyperliquid_trades")
  .update({
    outcome: actualPnlUsd >= 0 ? "winner" : "loser",
    actual_exit_price: exitPrice,
    actual_pnl_usd: parseFloat(actualPnlUsd.toFixed(2)),
    actual_r: actualR != null ? parseFloat(actualR.toFixed(3)) : null,
    closed_at: closedAt,
    days_held: daysHeld != null ? parseFloat(daysHeld.toFixed(2)) : null,
    close_reason: "duplicate_cleanup",
    updated_at: closedAt,
  })
  .eq("id", TRADE_ID);

if (updateErr) {
  console.error(`[close-dup] Closed on exchange but failed to update DB: ${updateErr.message}`);
  process.exit(1);
}

console.log(`[close-dup] ✓ Recorded. PnL: $${actualPnlUsd.toFixed(2)} (${actualR?.toFixed(3)}R)`);
