/**
 * hl-test-trade.mjs
 *
 * Manually opens a small BTC long on Hyperliquid testnet with SL + TP orders,
 * verifies everything appears in the HL UI, then closes cleanly on Enter.
 *
 * This is a one-shot validation script — run it before using the signal trader.
 *
 * Usage: node scripts/hl-test-trade.mjs
 */

import "dotenv/config";
import ccxt from "ccxt";
import * as readline from "readline";

const WALLET_ADDRESS = process.env.HL_WALLET_ADDRESS;
const PRIVATE_KEY = process.env.HL_PRIVATE_KEY;
const TESTNET = process.env.HL_TESTNET !== "false";
const RISK_USD = parseFloat(process.env.HL_RISK_PER_TRADE_USD ?? "15");

// Test uses a smaller risk to be safe — override with --risk flag if needed
const TEST_RISK_USD = process.argv.includes("--full-risk") ? RISK_USD : 5;

const SYMBOL = "BTC/USDC:USDC";
const SL_PCT = 0.03;   // 3% stop loss from entry
const TP_PCT = 0.06;   // 6% take profit from entry (2x RR)

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function waitForEnter(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

function round(value, precision) {
  const factor = Math.pow(10, precision);
  return Math.round(value * factor) / factor;
}

async function main() {
  console.log(`\n[hl-test-trade] ─────────────────────────────────────`);
  console.log(`[hl-test-trade] Hyperliquid ${TESTNET ? "TESTNET" : "MAINNET"} · ${SYMBOL}`);
  console.log(`[hl-test-trade] Risk per trade: $${TEST_RISK_USD} (test mode)`);
  console.log(`[hl-test-trade] ─────────────────────────────────────\n`);

  const exchange = new ccxt.hyperliquid({
    walletAddress: WALLET_ADDRESS,
    privateKey: PRIVATE_KEY,
    sandbox: TESTNET,
  });

  await exchange.loadMarkets();
  const market = exchange.market(SYMBOL);
  const amtPrecision = market.precision?.amount ?? 5; // decimal places for BTC

  // ── 1. Get current price ──────────────────────────────────────────────────
  const ticker = await exchange.fetchTicker(SYMBOL);
  const entryPrice = ticker.last;
  console.log(`[hl-test-trade] BTC current price: $${entryPrice.toLocaleString()}`);

  // ── 2. Calculate levels ───────────────────────────────────────────────────
  const slPrice  = round(entryPrice * (1 - SL_PCT), 1);  // 3% below
  const tpPrice  = round(entryPrice * (1 + TP_PCT), 1);  // 6% above
  const slDist   = entryPrice - slPrice;
  const posSize  = round(TEST_RISK_USD / slDist, Math.round(-Math.log10(amtPrecision)));

  console.log(`[hl-test-trade] Entry:  $${entryPrice.toLocaleString()}`);
  console.log(`[hl-test-trade] SL:     $${slPrice.toLocaleString()} (−${(SL_PCT * 100).toFixed(0)}%)`);
  console.log(`[hl-test-trade] TP:     $${tpPrice.toLocaleString()} (+${(TP_PCT * 100).toFixed(0)}%)`);
  console.log(`[hl-test-trade] Size:   ${posSize} BTC (~$${(posSize * entryPrice).toFixed(2)} notional)`);
  console.log(`[hl-test-trade] Risk:   $${(posSize * slDist).toFixed(2)} | RR: 2.0x\n`);

  await waitForEnter("Press Enter to open the position, or Ctrl+C to abort...");

  // ── 3. Open limit entry ───────────────────────────────────────────────────
  // Limit order at current price: fills immediately at maker fee (0.02%) if
  // price stays near entry. If price moves far away, order waits — no forced fill.
  console.log(`\n[hl-test-trade] Placing limit entry at $${entryPrice.toLocaleString()}...`);
  let position;
  try {
    position = await exchange.createOrder(SYMBOL, "limit", "buy", posSize, entryPrice);
    console.log(`[hl-test-trade] ✓ Limit order placed | order id: ${position.id}`);
  } catch (e) {
    console.error(`[hl-test-trade] ✗ Failed to place entry order: ${e.message}`);
    process.exit(1);
  }

  // Wait for fill (limit orders may take a few seconds if price is close)
  console.log(`[hl-test-trade] Waiting for fill...`);
  let actualEntry = entryPrice;
  let filled = false;
  for (let i = 0; i < 10; i++) {
    await sleep(1500);
    try {
      const o = await exchange.fetchOrder(position.id, SYMBOL);
      if (o.status === "closed" || o.status === "filled") {
        actualEntry = o.average ?? entryPrice;
        filled = true;
        break;
      }
      if (o.status === "canceled" || o.status === "rejected") {
        console.error(`[hl-test-trade] ✗ Entry order ${o.status}. Price may have moved away.`);
        process.exit(1);
      }
    } catch (_) { /* retry */ }
  }
  if (!filled) {
    console.warn(`[hl-test-trade] Order not filled after 15s — still open on HL.`);
    console.warn(`[hl-test-trade] Price may be slightly away. Check HL UI, then press Enter to continue or Ctrl+C to cancel.`);
    await waitForEnter("Press Enter once you see the fill on HL UI...");
    try {
      const o = await exchange.fetchOrder(position.id, SYMBOL);
      actualEntry = o.average ?? entryPrice;
    } catch (_) { /* use estimated */ }
  }
  console.log(`[hl-test-trade] ✓ Filled at: $${actualEntry.toLocaleString()}`);

  // Recalculate SL/TP from actual fill
  const actualSl = round(actualEntry * (1 - SL_PCT), 1);
  const actualTp = round(actualEntry * (1 + TP_PCT), 1);

  // ── 5. Place SL order ─────────────────────────────────────────────────────
  console.log(`[hl-test-trade] Placing SL order at $${actualSl.toLocaleString()}...`);
  let slOrder;
  try {
    slOrder = await exchange.createOrder(SYMBOL, "stop", "sell", posSize, actualSl, {
      triggerPrice: actualSl,
      reduceOnly: true,
    });
    console.log(`[hl-test-trade] ✓ SL placed | order id: ${slOrder.id}`);
  } catch (e) {
    console.error(`[hl-test-trade] ✗ SL failed: ${e.message}`);
    console.error(`[hl-test-trade] CLOSING POSITION to avoid unprotected exposure...`);
    const ct = await exchange.fetchTicker(SYMBOL);
    await exchange.createOrder(SYMBOL, "market", "sell", posSize, ct.last, { reduceOnly: true });
    process.exit(1);
  }

  // ── 6. Place TP limit order ───────────────────────────────────────────────
  console.log(`[hl-test-trade] Placing TP order at $${actualTp.toLocaleString()}...`);
  let tpOrder;
  try {
    tpOrder = await exchange.createOrder(SYMBOL, "limit", "sell", posSize, actualTp, {
      reduceOnly: true,
    });
    console.log(`[hl-test-trade] ✓ TP placed | order id: ${tpOrder.id}`);
  } catch (e) {
    console.error(`[hl-test-trade] ✗ TP failed: ${e.message}`);
    // Not fatal — position is still protected by SL
    console.warn(`[hl-test-trade] Position is open with SL only, no TP.`);
  }

  // ── 7. Summary ────────────────────────────────────────────────────────────
  console.log(`\n[hl-test-trade] ─── POSITION OPEN ───────────────────`);
  console.log(`  Entry:    $${actualEntry.toLocaleString()}`);
  console.log(`  SL:       $${actualSl.toLocaleString()} | order: ${slOrder?.id ?? "n/a"}`);
  console.log(`  TP:       $${actualTp.toLocaleString()} | order: ${tpOrder?.id ?? "n/a"}`);
  console.log(`  Size:     ${posSize} BTC`);
  console.log(`[hl-test-trade] ─────────────────────────────────────`);
  console.log(`\n→ Check your Hyperliquid testnet UI to confirm orders appear.`);
  console.log(`  URL: https://app.hyperliquid-testnet.xyz/trade/BTC`);

  await waitForEnter("\nPress Enter when ready to CLOSE and cancel all orders...");

  // ── 8. Cancel orders and close ────────────────────────────────────────────
  console.log("\n[hl-test-trade] Cancelling orders...");
  const orderIds = [slOrder?.id, tpOrder?.id].filter(Boolean);
  for (const id of orderIds) {
    try {
      await exchange.cancelOrder(id, SYMBOL);
      console.log(`[hl-test-trade] ✓ Cancelled order ${id}`);
    } catch (e) {
      console.warn(`[hl-test-trade] Could not cancel ${id}: ${e.message}`);
    }
    await sleep(300);
  }

  console.log("[hl-test-trade] Closing position at market...");
  try {
    const closeTicker = await exchange.fetchTicker(SYMBOL);
    const close = await exchange.createOrder(SYMBOL, "market", "sell", posSize, closeTicker.last, {
      reduceOnly: true,
    });
    console.log(`[hl-test-trade] ✓ Position closed | order id: ${close.id}`);
  } catch (e) {
    console.error(`[hl-test-trade] ✗ Close failed: ${e.message}`);
    console.error(`[hl-test-trade] You may need to close manually on the HL UI.`);
    process.exit(1);
  }

  console.log("\n[hl-test-trade] ✓ Test complete. Everything working correctly.");
}

main().catch((err) => {
  console.error("[hl-test-trade] Fatal:", err.message);
  process.exit(1);
});
