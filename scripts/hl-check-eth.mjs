import "dotenv/config";
import ccxt from "ccxt";

const exchange = new ccxt.hyperliquid({
  walletAddress: process.env.HL_WALLET_ADDRESS,
  privateKey: process.env.HL_PRIVATE_KEY,
  sandbox: process.env.HL_TESTNET !== "false",
});
await exchange.loadMarkets();

console.log("=== Real positions (all) ===");
const positions = await exchange.fetchPositions();
const real = positions.filter((p) => Math.abs(p.contracts ?? 0) > 0);
for (const p of real) console.log(`  ${p.symbol} side=${p.side} contracts=${p.contracts} entryPrice=${p.entryPrice}`);
console.log(`  Total real positions: ${real.length}`);

console.log("\n=== Real open orders (all tracked symbols) ===");
let total = 0;
for (const symbol of ["BTC/USDC:USDC", "ETH/USDC:USDC"]) {
  const orders = await exchange.fetchOpenOrders(symbol);
  total += orders.length;
  for (const o of orders) {
    console.log(`  ${symbol}: id=${o.id} type=${o.type} side=${o.side} price=${o.price ?? o.triggerPrice} amount=${o.amount} reduceOnly=${o.reduceOnly}`);
  }
  await new Promise((r) => setTimeout(r, 300));
}
console.log(`  Total real open orders: ${total}`);

// specifically check the ETH TP order we placed during the emergency reprotect
console.log("\n=== ETH TP order status (id 57269850954, placed during reprotect) ===");
try {
  const o = await exchange.fetchOrder("57269850954", "ETH/USDC:USDC");
  console.log(`  status=${o.status} filled=${o.filled} remaining=${o.remaining} price=${o.price}`);
} catch (e) {
  console.log(`  ERROR fetching: ${e.message}`);
}
