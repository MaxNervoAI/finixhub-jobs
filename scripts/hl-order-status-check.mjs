import "dotenv/config";
import ccxt from "ccxt";

const WALLET_ADDRESS = process.env.HL_WALLET_ADDRESS;
const PRIVATE_KEY = process.env.HL_PRIVATE_KEY;
const TESTNET = process.env.HL_TESTNET !== "false";

const exchange = new ccxt.hyperliquid({ walletAddress: WALLET_ADDRESS, privateKey: PRIVATE_KEY, sandbox: TESTNET });
await exchange.loadMarkets();

const checks = [
  { asset: "BTC", symbol: "BTC/USDC:USDC", label: "trade1 SL", id: "57129896380" },
  { asset: "BTC", symbol: "BTC/USDC:USDC", label: "trade1 TP", id: "57129897797" },
  { asset: "BTC", symbol: "BTC/USDC:USDC", label: "trade2 SL", id: "57129906378" },
  { asset: "BTC", symbol: "BTC/USDC:USDC", label: "trade2 TP", id: "57129906966" },
  { asset: "ETH", symbol: "ETH/USDC:USDC", label: "dup1 SL", id: "57129908383" },
  { asset: "ETH", symbol: "ETH/USDC:USDC", label: "dup1 TP", id: "57129908865" },
  { asset: "ETH", symbol: "ETH/USDC:USDC", label: "dup2 SL", id: "57129918415" },
  { asset: "ETH", symbol: "ETH/USDC:USDC", label: "dup2 TP", id: "57129919181" },
];

for (const c of checks) {
  try {
    const order = await exchange.fetchOrder(c.id, c.symbol);
    console.log(`${c.asset} ${c.label} (${c.id}): status=${order.status} filled=${order.filled} remaining=${order.remaining} average=${order.average}`);
  } catch (e) {
    console.log(`${c.asset} ${c.label} (${c.id}): ERROR ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, 300));
}

console.log("\n=== fetchMyTrades for ETH (recent, to find actual closing fills) ===");
const ethTrades = await exchange.fetchMyTrades("ETH/USDC:USDC");
const recentEth = ethTrades.filter(t => new Date(t.datetime) > new Date("2026-07-29T00:00:00Z"));
for (const t of recentEth) {
  console.log(`  ${t.datetime} side=${t.side} amount=${t.amount} price=${t.price} order=${t.order}`);
}

console.log("\n=== fetchMyTrades for BTC (recent) ===");
const btcTrades = await exchange.fetchMyTrades("BTC/USDC:USDC");
const recentBtc = btcTrades.filter(t => new Date(t.datetime) > new Date("2026-07-29T00:00:00Z"));
for (const t of recentBtc) {
  console.log(`  ${t.datetime} side=${t.side} amount=${t.amount} price=${t.price} order=${t.order}`);
}
