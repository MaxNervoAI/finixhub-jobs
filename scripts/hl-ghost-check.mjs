/**
 * hl-ghost-check.mjs — temporary diagnostic.
 * Compares real Hyperliquid state (open positions, open orders) against
 * what hyperliquid_trades in the DB currently tracks as "open", to find
 * ghost positions/orders — anything live on the exchange with no matching
 * DB row, most likely orphaned SL/TP orders left over from a flip whose
 * cancelOrder() call failed silently.
 */
import "dotenv/config";
import ccxt from "ccxt";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const WALLET_ADDRESS = process.env.HL_WALLET_ADDRESS;
const PRIVATE_KEY = process.env.HL_PRIVATE_KEY;
const TESTNET = process.env.HL_TESTNET !== "false";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const HL_SYMBOL = { BTC: "BTC/USDC:USDC", ETH: "ETH/USDC:USDC", SOL: "SOL/USDC:USDC" };

const exchange = new ccxt.hyperliquid({
  walletAddress: WALLET_ADDRESS,
  privateKey: PRIVATE_KEY,
  sandbox: TESTNET,
});
await exchange.loadMarkets();

console.log(`\n[ghost-check] ${TESTNET ? "TESTNET" : "MAINNET"}\n`);

// 1. Real open positions on the exchange
console.log("=== Real open positions (fetchPositions) ===");
const positions = await exchange.fetchPositions();
const realOpenPositions = positions.filter((p) => Math.abs(p.contracts ?? 0) > 0);
if (!realOpenPositions.length) {
  console.log("  None.");
} else {
  for (const p of realOpenPositions) {
    console.log(`  ${p.symbol}: side=${p.side} contracts=${p.contracts} entryPrice=${p.entryPrice} unrealizedPnl=${p.unrealizedPnl}`);
  }
}

// 2. Real open orders on the exchange, per traded symbol
console.log("\n=== Real open orders (fetchOpenOrders) ===");
let allOpenOrders = [];
for (const [asset, symbol] of Object.entries(HL_SYMBOL)) {
  try {
    const orders = await exchange.fetchOpenOrders(symbol);
    for (const o of orders) {
      console.log(`  ${asset} ${symbol}: id=${o.id} type=${o.type} side=${o.side} price=${o.price ?? o.triggerPrice} amount=${o.amount} reduceOnly=${o.reduceOnly}`);
      allOpenOrders.push({ asset, ...o });
    }
    if (!orders.length) console.log(`  ${asset}: none`);
  } catch (e) {
    console.log(`  ${asset}: error fetching open orders: ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, 300));
}

// 3. What the DB thinks is open
console.log("\n=== DB state (hyperliquid_trades outcome='open') ===");
const { data: dbOpen } = await supabase
  .from("hyperliquid_trades")
  .select("id, asset_symbol, bias, hl_tp_order_id, hl_sl_order_id, created_at")
  .eq("outcome", "open")
  .eq("environment", TESTNET ? "testnet" : "mainnet");

if (!dbOpen?.length) {
  console.log("  None — DB thinks everything is closed.");
} else {
  for (const row of dbOpen) {
    console.log(`  ${row.asset_symbol} ${row.bias} (id ${row.id}, opened ${row.created_at}) — tracked TP:${row.hl_tp_order_id} SL:${row.hl_sl_order_id}`);
  }
}

// 4. Cross-reference: any real position with no matching DB row?
console.log("\n=== Ghost check: positions ===");
const dbOpenAssets = new Set((dbOpen ?? []).map((r) => r.asset_symbol));
const ghostPositions = realOpenPositions.filter((p) => {
  const asset = Object.keys(HL_SYMBOL).find((a) => HL_SYMBOL[a] === p.symbol);
  return !dbOpenAssets.has(asset);
});
if (!ghostPositions.length) {
  console.log("  None found — every real open position has a matching DB row.");
} else {
  for (const p of ghostPositions) {
    console.log(`  GHOST POSITION: ${p.symbol} side=${p.side} contracts=${p.contracts} — no matching open DB row!`);
  }
}

// 5. Cross-reference: any real open order not tracked as this asset's current TP/SL in DB?
console.log("\n=== Ghost check: orders ===");
const trackedOrderIds = new Set();
for (const row of dbOpen ?? []) {
  if (row.hl_tp_order_id) trackedOrderIds.add(String(row.hl_tp_order_id));
  if (row.hl_sl_order_id) trackedOrderIds.add(String(row.hl_sl_order_id));
}
const ghostOrders = allOpenOrders.filter((o) => !trackedOrderIds.has(String(o.id)));
if (!ghostOrders.length) {
  console.log("  None found — every real open order matches a currently-tracked TP/SL.");
} else {
  for (const o of ghostOrders) {
    console.log(`  GHOST ORDER: ${o.asset} id=${o.id} type=${o.type} side=${o.side} price=${o.price ?? o.triggerPrice} reduceOnly=${o.reduceOnly} — not tracked by any open DB row!`);
  }
}

console.log("\n[ghost-check] Done.");
