/**
 * hl-emergency-reprotect.mjs — urgent one-off.
 * Two real positions were found naked (no SL/TP resting) after a bug in
 * the trade-history reconstruction fallback wrongly marked them as closed
 * and cancelled their still-valid protective orders. Re-places SL/TP at
 * their original (adjusted) levels immediately.
 */
import "dotenv/config";
import ccxt from "ccxt";

const exchange = new ccxt.hyperliquid({
  walletAddress: process.env.HL_WALLET_ADDRESS,
  privateKey: process.env.HL_PRIVATE_KEY,
  sandbox: process.env.HL_TESTNET !== "false",
});
await exchange.loadMarkets();

const jobs = [
  {
    label: "ETH short (f63f41c5, full 0.0604, untouched)",
    symbol: "ETH/USDC:USDC",
    size: 0.0604,
    sl: 1958.39,
    tp: 1786.82,
  },
  {
    label: "BTC short (72918188, remaining 0.00121 after partial TP)",
    symbol: "BTC/USDC:USDC",
    size: 0.00121,
    sl: 65502.2,
    tp: 61453.3,
  },
];

for (const job of jobs) {
  console.log(`\n[reprotect] ${job.label}`);
  try {
    const slOrder = await exchange.createOrder(job.symbol, "stop", "buy", job.size, job.sl, {
      triggerPrice: job.sl,
      reduceOnly: true,
    });
    console.log(`[reprotect] ✓ SL placed at $${job.sl} | id:${slOrder.id}`);
  } catch (e) {
    console.error(`[reprotect] ✗ SL FAILED: ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, 500));

  try {
    const tpOrder = await exchange.createOrder(job.symbol, "limit", "buy", job.size, job.tp, {
      postOnly: true,
      reduceOnly: true,
    });
    console.log(`[reprotect] ✓ TP placed at $${job.tp} | id:${tpOrder.id}`);
  } catch (e) {
    console.error(`[reprotect] TP failed (non-fatal, SL still protects): ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, 500));
}

console.log("\n[reprotect] Done.");
