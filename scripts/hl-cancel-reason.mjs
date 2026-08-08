import "dotenv/config";
import ccxt from "ccxt";

const exchange = new ccxt.hyperliquid({
  walletAddress: process.env.HL_WALLET_ADDRESS,
  privateKey: process.env.HL_PRIVATE_KEY,
  sandbox: process.env.HL_TESTNET !== "false",
});
await exchange.loadMarkets();

const o = await exchange.fetchOrder("57269850954", "ETH/USDC:USDC");
console.log(JSON.stringify(o, null, 2));

// Also check the historical order endpoint directly for more detail
try {
  const raw = await exchange.publicPostInfo({ type: "orderStatus", user: process.env.HL_WALLET_ADDRESS, oid: 57269850954 });
  console.log("\n=== Raw orderStatus ===");
  console.log(JSON.stringify(raw, null, 2));
} catch (e) {
  console.log("Raw orderStatus fetch failed:", e.message);
}
