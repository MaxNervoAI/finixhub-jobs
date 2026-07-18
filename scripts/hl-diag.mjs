/**
 * hl-diag.mjs — temporary diagnostic script.
 * Investigates why fetchMyTrades() returns 0 fills even for a position
 * that filled minutes earlier. Prints raw, unfiltered data at every layer
 * so we can tell apart: wrong address, wrong symbol filter, or a genuinely
 * empty API response.
 */
import "dotenv/config";
import ccxt from "ccxt";

const WALLET_ADDRESS = process.env.HL_WALLET_ADDRESS;
const PRIVATE_KEY = process.env.HL_PRIVATE_KEY;
const TESTNET = process.env.HL_TESTNET !== "false";

console.log(`[diag] wallet address: ${WALLET_ADDRESS?.slice(0, 6)}...${WALLET_ADDRESS?.slice(-4)}`);
console.log(`[diag] testnet: ${TESTNET}`);

const exchange = new ccxt.hyperliquid({
  walletAddress: WALLET_ADDRESS,
  privateKey: PRIVATE_KEY,
  sandbox: TESTNET,
});
await exchange.loadMarkets();
console.log(`[diag] exchange.walletAddress resolved to: ${exchange.walletAddress?.slice(0, 6)}...${exchange.walletAddress?.slice(-4)}`);

// 1. Raw info API call, bypassing ccxt parsing entirely
console.log("\n[diag] === Raw userFills API call ===");
try {
  const raw = await exchange.publicPostInfo({ type: "userFills", user: WALLET_ADDRESS });
  console.log(`[diag] raw response type: ${Array.isArray(raw) ? "array" : typeof raw}, length: ${raw?.length ?? "n/a"}`);
  if (Array.isArray(raw) && raw.length) {
    console.log("[diag] first 3 raw fills:", JSON.stringify(raw.slice(0, 3), null, 2));
  } else {
    console.log("[diag] raw response:", JSON.stringify(raw).slice(0, 500));
  }
} catch (e) {
  console.log(`[diag] raw userFills call threw: ${e.message}`);
}

// 2. Same, but via ccxt's fetchMyTrades with no symbol filter
console.log("\n[diag] === fetchMyTrades(undefined, undefined) — no symbol, no since ===");
try {
  const trades = await exchange.fetchMyTrades();
  console.log(`[diag] parsed trade count: ${trades?.length ?? 0}`);
  if (trades?.length) {
    console.log("[diag] symbols seen:", [...new Set(trades.map((t) => t.symbol))]);
    console.log("[diag] first 3:", trades.slice(0, 3).map((t) => ({ symbol: t.symbol, side: t.side, amount: t.amount, price: t.price, timestamp: t.datetime })));
  }
} catch (e) {
  console.log(`[diag] fetchMyTrades() threw: ${e.message}`);
}

// 3. fetchPositions raw
console.log("\n[diag] === fetchPositions() ===");
try {
  const positions = await exchange.fetchPositions();
  console.log(`[diag] position count: ${positions?.length ?? 0}`);
  for (const p of positions ?? []) {
    console.log(`[diag]   ${p.symbol}: contracts=${p.contracts} side=${p.side}`);
  }
} catch (e) {
  console.log(`[diag] fetchPositions() threw: ${e.message}`);
}

// 4. fetchBalance — confirms which account this key actually controls
console.log("\n[diag] === fetchBalance() ===");
try {
  const balance = await exchange.fetchBalance();
  console.log(`[diag] USDC total: ${balance?.USDC?.total ?? "n/a"}, free: ${balance?.USDC?.free ?? "n/a"}`);
} catch (e) {
  console.log(`[diag] fetchBalance() threw: ${e.message}`);
}

console.log("\n[diag] Done.");
