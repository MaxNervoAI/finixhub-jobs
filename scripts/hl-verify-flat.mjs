import "dotenv/config";
import ccxt from "ccxt";

const exchange = new ccxt.hyperliquid({
  walletAddress: process.env.HL_WALLET_ADDRESS,
  privateKey: process.env.HL_PRIVATE_KEY,
  sandbox: process.env.HL_TESTNET !== "false",
});
await exchange.loadMarkets();

const positions = await exchange.fetchPositions();
const real = positions.filter((p) => Math.abs(p.contracts ?? 0) > 0);
console.log(`[verify] Real open positions: ${real.length}`);
for (const p of real) console.log(`  ${p.symbol} side=${p.side} contracts=${p.contracts}`);

for (const symbol of ["BTC/USDC:USDC", "ETH/USDC:USDC"]) {
  const orders = await exchange.fetchOpenOrders(symbol);
  console.log(`[verify] ${symbol} open orders: ${orders.length}`);
  await new Promise((r) => setTimeout(r, 300));
}
