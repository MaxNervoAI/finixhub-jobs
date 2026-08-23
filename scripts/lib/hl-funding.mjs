/**
 * hl-funding.mjs
 *
 * Shared helpers for reading Hyperliquid funding-rate and premium data
 * straight from the public /info endpoint — not routed through ccxt, so this
 * doesn't depend on ccxt's funding-rate field mapping for a value that's
 * safety-critical (used to block entries and to force-close positions).
 *
 * Added 2026-08-23 after a live testnet ETH long paid $14.36 in funding
 * (vs +$2.94 of price PnL) while a mark/oracle premium of ~3.6% drove an
 * hourly funding rate of ~0.4% — neither hl-signal-trader.mjs nor
 * hl-sync-results.mjs had any awareness of funding cost before this.
 */

const MAINNET_API_URL = "https://api.hyperliquid.xyz";
const TESTNET_API_URL = "https://api.hyperliquid-testnet.xyz";

async function postInfo(testnet, body) {
  const res = await fetch(`${testnet ? TESTNET_API_URL : MAINNET_API_URL}/info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`HL /info ${body.type} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// ── Current funding rate + mark/oracle premium for one coin ──────────────────
// `fundingHourlyPct` is Hyperliquid's current hourly rate as a percentage
// (positive = longs pay shorts, negative = shorts pay longs; a typical
// baseline is around ±0.01%/hr). `premiumPct` is the |markPx - oraclePx| /
// oraclePx gap that drives funding — a thin/illiquid book shows up here
// first, often before funding itself has caught up, so it's checked as an
// independent, direction-agnostic signal.
export async function fetchFundingContext(testnet, coin) {
  const [meta, ctxs] = await postInfo(testnet, { type: "metaAndAssetCtxs" });
  const idx = meta.universe.findIndex((u) => u.name === coin);
  if (idx === -1) throw new Error(`Unknown HL coin: ${coin}`);
  const ctx = ctxs[idx];
  const fundingHourlyPct = parseFloat(ctx.funding) * 100;
  const markPx = parseFloat(ctx.markPx);
  const oraclePx = parseFloat(ctx.oraclePx);
  const premiumPct = oraclePx ? (Math.abs(markPx - oraclePx) / oraclePx) * 100 : 0;
  return { fundingHourlyPct, premiumPct, markPx, oraclePx };
}

// ── Cumulative funding paid since a position was opened ──────────────────────
// Positive = net paid out (a cost), negative = net received. Returns null if
// there's currently no live open position for that coin on this wallet.
export async function fetchCumFundingSinceOpen(testnet, walletAddress, coin) {
  const state = await postInfo(testnet, { type: "clearinghouseState", user: walletAddress });
  const entry = (state.assetPositions ?? []).find((p) => p.position?.coin === coin);
  if (!entry) return null;
  return parseFloat(entry.position.cumFunding?.sinceOpen ?? "0");
}
