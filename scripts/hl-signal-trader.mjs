/**
 * hl-signal-trader.mjs
 *
 * Reads new Aligned + Quality≥70 signals from opportunity_performance,
 * opens positions on Hyperliquid with SL and TP, and records executions
 * in the hyperliquid_trades table for comparison with paper trading.
 *
 * Filter: source=live, scoring_version=v2, method_alignment=true, quality_score>=70, final_status=pending
 *
 * Position conflict logic:
 *   - Same asset, same direction → skip (already in trade)
 *   - Same asset, opposite direction → evaluate based on quality + P&L before closing
 *
 * Usage:
 *   node scripts/hl-signal-trader.mjs            # process new signals
 *   node scripts/hl-signal-trader.mjs --dry-run  # log signals without opening trades
 */

import "dotenv/config";
import ccxt from "ccxt";
import { createClient } from "@supabase/supabase-js";

// ── Config ────────────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const WALLET_ADDRESS = process.env.HL_WALLET_ADDRESS;
const PRIVATE_KEY = process.env.HL_PRIVATE_KEY;
const TESTNET = process.env.HL_TESTNET !== "false";
const RISK_USD = parseFloat(process.env.HL_RISK_PER_TRADE_USD ?? "15");
const MIN_QUALITY = 70;
const DRY_RUN = process.argv.includes("--dry-run");

// ── Flip thresholds ───────────────────────────────────────────────────────────
// Minimum quality for new signal to even consider closing an existing position
const FLIP_MIN_QUALITY = 85;
// Minimum quality to close a losing position (P&L < -5%)
const FLIP_LOSING_MIN_QUALITY = 80;
// Minimum quality to close at breakeven (-5% to +5%)
const FLIP_BREAKEVEN_MIN_QUALITY = 85;
// Minimum quality to close a small winner (+5% to +10%)
const FLIP_WINNING_MIN_QUALITY = 90;
// % of SL distance remaining — below this, close regardless if new quality ≥ 80
const FLIP_NEAR_SL_THRESHOLD = 30;
// % of TP distance remaining — below this, hold (let it finish)
const HOLD_NEAR_TP_THRESHOLD = 15;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("[hl-trader] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
if (!WALLET_ADDRESS || !PRIVATE_KEY) {
  console.error("[hl-trader] Missing HL_WALLET_ADDRESS or HL_PRIVATE_KEY");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Symbol mapping ────────────────────────────────────────────────────────────
const HL_SYMBOL = { BTC: "BTC/USDC:USDC", ETH: "ETH/USDC:USDC", SOL: "SOL/USDC:USDC" };
const SYMBOL_TO_ASSET = Object.fromEntries(Object.entries(HL_SYMBOL).map(([k, v]) => [v, k]));

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function round(value, decimals) {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

// ── Position sizing ───────────────────────────────────────────────────────────
function calcPositionSize(riskUsd, entryPrice, slPrice, amtPrecision) {
  const slDistance = Math.abs(entryPrice - slPrice);
  if (slDistance <= 0) throw new Error("SL distance is zero");
  const rawSize = riskUsd / slDistance;
  const decimals = Math.max(0, Math.round(-Math.log10(amtPrecision)));
  return round(rawSize, decimals);
}

// ── Fetch open positions from Hyperliquid (for live P&L only) ────────────────
// Returns empty object on failure — DB records are the source of truth for
// conflict detection. HL data is only used to enrich P&L for flip evaluation.
async function fetchOpenHLPositions(exchange) {
  try {
    const positions = await exchange.fetchPositions();
    const open = {};
    for (const pos of positions) {
      if (!pos.contracts || Math.abs(pos.contracts) === 0) continue;
      const asset = SYMBOL_TO_ASSET[pos.symbol];
      if (!asset) continue;
      open[asset] = {
        symbol: pos.symbol,
        side: pos.side,
        size: Math.abs(pos.contracts),
        entryPrice: pos.entryPrice,
        markPrice: pos.markPrice,
        unrealizedPnl: pos.unrealizedPnl,
        percentage: pos.percentage,
      };
    }
    const count = Object.keys(open).length;
    console.log(`[hl-trader] HL positions fetched: ${count > 0 ? Object.keys(open).join(", ") : "none"}`);
    return open;
  } catch (e) {
    console.warn(`[hl-trader] Could not fetch HL positions (${e.message}) — using DB records only`);
    return {};
  }
}

// ── Fetch our open DB records — PRIMARY source of truth for conflict detection ─
async function fetchOpenDBRecords() {
  const { data } = await supabase
    .from("hyperliquid_trades")
    .select("id, asset_symbol, bias, signal_quality_score, signal_sl, signal_tp1, actual_entry_price, position_size_contracts, hl_sl_order_id, hl_tp_order_id")
    .eq("outcome", "open")
    .eq("environment", TESTNET ? "testnet" : "mainnet");

  // Group by asset: use highest quality record as reference, sum all sizes
  const byAsset = {};
  for (const rec of (data ?? [])) {
    const size = parseFloat(rec.position_size_contracts ?? 0);
    if (!byAsset[rec.asset_symbol]) {
      byAsset[rec.asset_symbol] = { ...rec, totalSize: size };
    } else {
      byAsset[rec.asset_symbol].totalSize += size;
      if (rec.signal_quality_score > byAsset[rec.asset_symbol].signal_quality_score) {
        byAsset[rec.asset_symbol] = { ...rec, totalSize: byAsset[rec.asset_symbol].totalSize };
      }
    }
  }
  return byAsset;
}

// ── Decide whether to close an existing opposite-direction position ────────────
// Returns { close: bool, reason: string }
function evaluateFlip(existingPos, dbRecord, newSignal, currentPrice) {
  const newQuality = newSignal.quality_score;

  // Gate: new signal must clear the minimum flip quality
  if (newQuality < FLIP_MIN_QUALITY) {
    return { close: false, reason: `new quality ${newQuality} < ${FLIP_MIN_QUALITY} flip threshold` };
  }

  const entry = existingPos.entryPrice ?? parseFloat(dbRecord?.actual_entry_price ?? 0);
  const isLong = existingPos.side === "long";

  // P&L % from the perspective of the existing position direction
  const pnlPct = entry > 0
    ? ((currentPrice - entry) / entry * 100 * (isLong ? 1 : -1))
    : (existingPos.percentage ?? 0);

  // Check proximity to TP — if close, don't interrupt
  const tpPrice = dbRecord?.signal_tp1 ? parseFloat(dbRecord.signal_tp1) : null;
  if (tpPrice && entry > 0) {
    const totalTpDist = Math.abs(tpPrice - entry);
    const remainingTpDist = Math.abs(tpPrice - currentPrice);
    const tpRemainingPct = totalTpDist > 0 ? (remainingTpDist / totalTpDist) * 100 : 100;
    if (tpRemainingPct < HOLD_NEAR_TP_THRESHOLD) {
      return { close: false, reason: `within ${HOLD_NEAR_TP_THRESHOLD}% of TP (${tpRemainingPct.toFixed(1)}% left) — letting it finish` };
    }
  }

  // Check proximity to SL — too close, cut and take better setup
  const slPrice = dbRecord?.signal_sl ? parseFloat(dbRecord.signal_sl) : null;
  if (slPrice && entry > 0) {
    const totalSlDist = Math.abs(entry - slPrice);
    const remainingSlDist = Math.abs(currentPrice - slPrice);
    const slRemainingPct = totalSlDist > 0 ? (remainingSlDist / totalSlDist) * 100 : 100;
    if (slRemainingPct < FLIP_NEAR_SL_THRESHOLD && newQuality >= FLIP_LOSING_MIN_QUALITY) {
      return { close: true, reason: `within ${FLIP_NEAR_SL_THRESHOLD}% of SL (${slRemainingPct.toFixed(1)}% left), new quality ${newQuality}` };
    }
  }

  // Losing — cut and take better signal
  if (pnlPct < -5 && newQuality >= FLIP_LOSING_MIN_QUALITY) {
    return { close: true, reason: `losing ${pnlPct.toFixed(1)}%, new quality ${newQuality}` };
  }

  // Breakeven — upgrade to higher quality setup
  if (pnlPct >= -5 && pnlPct < 5 && newQuality >= FLIP_BREAKEVEN_MIN_QUALITY) {
    return { close: true, reason: `breakeven ${pnlPct.toFixed(1)}%, upgrading to quality ${newQuality}` };
  }

  // Winning but not big — only for exceptional signal
  if (pnlPct >= 5 && pnlPct < 10 && newQuality >= FLIP_WINNING_MIN_QUALITY) {
    return { close: true, reason: `small winner ${pnlPct.toFixed(1)}%, exceptional quality ${newQuality}` };
  }

  // Well in profit — never flip
  if (pnlPct >= 10) {
    return { close: false, reason: `well in profit ${pnlPct.toFixed(1)}% — holding` };
  }

  return { close: false, reason: `no flip criteria met (pnl:${pnlPct.toFixed(1)}%, quality:${newQuality})` };
}

// ── Close an existing position and cancel its SL/TP orders ───────────────────
async function closeExistingPosition(exchange, asset, existingPos, dbRecords) {
  const symbol = HL_SYMBOL[asset];
  const closeSide = existingPos.side === "long" ? "sell" : "buy";
  const currentPrice = existingPos.markPrice ?? existingPos.entryPrice;

  console.log(`[hl-trader] Closing existing ${asset} ${existingPos.side.toUpperCase()} position (size:${existingPos.size})`);

  if (DRY_RUN) {
    console.log(`[hl-trader] DRY RUN — skipping position close`);
    return;
  }

  // Cancel all SL/TP orders for this asset from DB records
  const allOpenRecords = await supabase
    .from("hyperliquid_trades")
    .select("id, hl_sl_order_id, hl_tp_order_id")
    .eq("asset_symbol", asset)
    .eq("outcome", "open")
    .eq("environment", TESTNET ? "testnet" : "mainnet");

  for (const rec of (allOpenRecords.data ?? [])) {
    for (const orderId of [rec.hl_sl_order_id, rec.hl_tp_order_id]) {
      if (!orderId) continue;
      try {
        await exchange.cancelOrder(orderId, symbol);
        console.log(`[hl-trader] ✓ Cancelled order ${orderId}`);
      } catch (e) {
        // Order may already be filled or cancelled — not fatal
        console.warn(`[hl-trader] Could not cancel order ${orderId}: ${e.message}`);
      }
    }
  }

  // Market close the full position
  await exchange.createOrder(symbol, "market", closeSide, existingPos.size, currentPrice, {
    reduceOnly: true,
    slippagePercentage: 5,
  });
  console.log(`[hl-trader] ✓ Position closed`);

  // Mark all open DB records for this asset as closed_for_upgrade
  await supabase
    .from("hyperliquid_trades")
    .update({ outcome: "closed_for_upgrade" })
    .eq("asset_symbol", asset)
    .eq("outcome", "open")
    .eq("environment", TESTNET ? "testnet" : "mainnet");

  console.log(`[hl-trader] ✓ DB records updated to closed_for_upgrade`);
}

// ── Fetch signals not yet traded on HL ───────────────────────────────────────
async function fetchNewSignals() {
  const { data: signals, error } = await supabase
    .from("opportunity_performance")
    .select("id, asset_symbol, bias, entry_price, invalidation_level, take_profit_levels, quality_score, risk_reward_ratio, method_alignment, simulation_date")
    .eq("source", "live")
    .eq("scoring_version", "v2")
    .eq("final_status", "pending")
    .eq("method_alignment", true)
    .gte("quality_score", MIN_QUALITY)
    .order("quality_score", { ascending: false });

  if (error) throw new Error(`Supabase fetch error: ${error.message}`);
  if (!signals?.length) return [];

  // Filter out signals already attempted (any outcome except cancelled)
  const signalIds = signals.map((s) => s.id);
  const { data: existing } = await supabase
    .from("hyperliquid_trades")
    .select("opportunity_id")
    .in("opportunity_id", signalIds)
    .neq("outcome", "cancelled");

  const tradedIds = new Set((existing ?? []).map((e) => e.opportunity_id));
  return signals.filter((s) => !tradedIds.has(s.id));
}

// ── Open a trade on Hyperliquid ───────────────────────────────────────────────
async function openTrade(exchange, signal, riskUsd) {
  const symbol = HL_SYMBOL[signal.asset_symbol];
  if (!symbol) throw new Error(`Unsupported asset: ${signal.asset_symbol}`);

  const isLong = signal.bias === "long";
  const side = isLong ? "buy" : "sell";
  const slSide = isLong ? "sell" : "buy";

  const market = exchange.market(symbol);
  const amtPrecision = market.precision?.amount ?? 0.00001;

  const entryPrice = parseFloat(signal.entry_price);
  const slPrice = parseFloat(signal.invalidation_level);
  const tp1 = signal.take_profit_levels?.[0]?.level;
  if (!tp1) throw new Error("No TP1 level in signal");
  const tpPrice = parseFloat(tp1);

  const posSize = calcPositionSize(riskUsd, entryPrice, slPrice, amtPrecision);

  console.log(`[hl-trader] ${signal.asset_symbol} ${signal.bias.toUpperCase()} | quality:${signal.quality_score} | entry:$${entryPrice} | SL:$${slPrice} | TP:$${tpPrice} | size:${posSize}`);

  if (DRY_RUN) {
    console.log(`[hl-trader] DRY RUN — skipping order placement`);
    return null;
  }

  // ── 1. Market entry ────────────────────────────────────────────────────────
  const mainOrder = await exchange.createOrder(symbol, "market", side, posSize, entryPrice, {
    slippagePercentage: 5,
  });
  console.log(`[hl-trader] ✓ Market entry | id:${mainOrder.id}`);

  const actualEntry = mainOrder.average ?? mainOrder.info?.average ?? entryPrice;
  console.log(`[hl-trader] ✓ Filled at $${actualEntry}`);

  // Adjust SL/TP proportionally if actual fill differs from signal entry
  const slAdjusted = round(slPrice * (actualEntry / entryPrice), 2);
  const tpAdjusted = round(tpPrice * (actualEntry / entryPrice), 2);

  // ── 2. Place SL ───────────────────────────────────────────────────────────
  let slOrderId = null;
  try {
    const slOrder = await exchange.createOrder(symbol, "stop", slSide, posSize, slAdjusted, {
      triggerPrice: slAdjusted,
      reduceOnly: true,
    });
    slOrderId = slOrder.id;
    console.log(`[hl-trader] ✓ SL at $${slAdjusted} | id:${slOrderId}`);
  } catch (e) {
    // SL failed — close position immediately rather than leave it unprotected
    console.error(`[hl-trader] ✗ SL failed: ${e.message} — closing position for safety`);
    const ct = await exchange.fetchTicker(symbol);
    await exchange.createOrder(symbol, "market", slSide, posSize, ct.last, { reduceOnly: true });
    throw new Error(`SL placement failed, position closed. Original: ${e.message}`);
  }

  await sleep(500);

  // ── 3. Place TP ───────────────────────────────────────────────────────────
  let tpOrderId = null;
  try {
    const tpOrder = await exchange.createOrder(symbol, "limit", slSide, posSize, tpAdjusted, {
      postOnly: true,
      reduceOnly: true,
    });
    tpOrderId = tpOrder.id;
    console.log(`[hl-trader] ✓ TP at $${tpAdjusted} | id:${tpOrderId}`);
  } catch (e) {
    console.warn(`[hl-trader] TP failed (SL protects): ${e.message}`);
  }

  return {
    hl_order_id: mainOrder.id,
    hl_sl_order_id: slOrderId,
    hl_tp_order_id: tpOrderId,
    actual_entry_price: actualEntry,
    position_size_contracts: posSize,
  };
}

// ── Record trade in Supabase ──────────────────────────────────────────────────
async function recordTrade(signal, execution, riskUsd) {
  const tp1Level = signal.take_profit_levels?.[0]?.level;

  const row = {
    opportunity_id: signal.id,
    signal_date: signal.simulation_date,
    asset_symbol: signal.asset_symbol,
    bias: signal.bias,
    signal_entry_price: signal.entry_price,
    signal_sl: signal.invalidation_level,
    signal_tp1: tp1Level,
    signal_quality_score: signal.quality_score,
    signal_rr: signal.risk_reward_ratio,
    signal_method_alignment: signal.method_alignment,
    risk_usd: riskUsd,
    environment: TESTNET ? "testnet" : "mainnet",
    outcome: execution ? "open" : "pending_entry",
    ...(execution
      ? {
          hl_order_id: execution.hl_order_id,
          hl_sl_order_id: execution.hl_sl_order_id,
          hl_tp_order_id: execution.hl_tp_order_id,
          actual_entry_price: execution.actual_entry_price,
          position_size_contracts: execution.position_size_contracts,
        }
      : {}),
  };

  const { error } = await supabase.from("hyperliquid_trades").insert(row);
  if (error) throw new Error(`DB insert failed: ${error.message}`);
  console.log(`[hl-trader] ✓ Recorded in hyperliquid_trades`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n[hl-trader] ══════════════════════════════════════`);
  console.log(`[hl-trader] Hyperliquid Signal Trader ${DRY_RUN ? "(DRY RUN)" : ""}`);
  console.log(`[hl-trader] Filter: aligned=true, quality>=${MIN_QUALITY}, status=pending`);
  console.log(`[hl-trader] Risk per trade: $${RISK_USD} | ${TESTNET ? "TESTNET" : "MAINNET"}`);
  console.log(`[hl-trader] ══════════════════════════════════════\n`);

  const exchange = new ccxt.hyperliquid({
    walletAddress: WALLET_ADDRESS,
    privateKey: PRIVATE_KEY,
    sandbox: TESTNET,
  });
  await exchange.loadMarkets();

  // Fetch current state upfront
  // DB records are the PRIMARY source of truth for conflict detection.
  // HL positions are fetched for live P&L enrichment only (may be empty on testnet).
  const [signals, openHLPositions, openDBRecords] = await Promise.all([
    fetchNewSignals(),
    fetchOpenHLPositions(exchange),
    fetchOpenDBRecords(),
  ]);

  const dbOpenAssets = Object.keys(openDBRecords);
  console.log(`[hl-trader] Found ${signals.length} new signal(s) to process.`);
  console.log(`[hl-trader] Open positions (DB): ${dbOpenAssets.length > 0 ? dbOpenAssets.join(", ") : "none"}\n`);

  if (signals.length === 0) {
    console.log("[hl-trader] Nothing to do. Run again after the next scanner cycle.");
    return;
  }

  // Deduplicate: only take the highest-quality signal per asset
  const bestByAsset = {};
  for (const signal of signals) {
    const existing = bestByAsset[signal.asset_symbol];
    if (!existing || signal.quality_score > existing.quality_score) {
      bestByAsset[signal.asset_symbol] = signal;
    }
  }
  const dedupedSignals = Object.values(bestByAsset);

  if (dedupedSignals.length < signals.length) {
    console.log(`[hl-trader] Deduplicated to ${dedupedSignals.length} signal(s) (one per asset, highest quality wins)\n`);
  }

  let opened = 0;
  let skipped = 0;

  for (const signal of dedupedSignals) {
    console.log(`[hl-trader] ── Processing ${signal.asset_symbol} ${signal.bias.toUpperCase()} (quality:${signal.quality_score}) ──`);

    // DB record is the authoritative check — does not depend on HL API reliability
    const dbRecord = openDBRecords[signal.asset_symbol];

    // No open position for this asset — open freely
    if (!dbRecord) {
      try {
        const execution = await openTrade(exchange, signal, RISK_USD);
        await recordTrade(signal, execution, RISK_USD);
        // Track in memory so subsequent signals in same run don't double-open
        openDBRecords[signal.asset_symbol] = { bias: signal.bias };
        opened++;
      } catch (e) {
        console.error(`[hl-trader] ✗ Skipped ${signal.asset_symbol}: ${e.message}`);
        skipped++;
      }
      await sleep(1000);
      continue;
    }

    // Same direction — already in this trade
    if (dbRecord.bias === signal.bias) {
      console.log(`[hl-trader] ⊘ Skipping — already have ${signal.asset_symbol} ${dbRecord.bias.toUpperCase()} position open`);
      skipped++;
      continue;
    }

    // Opposite direction — evaluate whether to flip
    // Use HL live data for P&L if available, otherwise fetch ticker for current price
    const hlPos = openHLPositions[signal.asset_symbol];
    let currentPrice;
    let existingPos;
    if (hlPos) {
      existingPos = hlPos;
      currentPrice = hlPos.markPrice ?? hlPos.entryPrice;
    } else {
      // HL position fetch failed — get current price from ticker
      try {
        const ticker = await exchange.fetchTicker(HL_SYMBOL[signal.asset_symbol]);
        currentPrice = ticker.last;
      } catch (_) {
        currentPrice = parseFloat(dbRecord.actual_entry_price ?? 0);
      }
      existingPos = {
        side: dbRecord.bias,
        entryPrice: parseFloat(dbRecord.actual_entry_price ?? 0),
        markPrice: currentPrice,
        percentage: null,
        size: dbRecord.totalSize,
      };
    }
    const { close, reason } = evaluateFlip(existingPos, dbRecord, signal, currentPrice);

    console.log(`[hl-trader] ↔ Conflict: open ${existingPos.side.toUpperCase()} vs new ${signal.bias.toUpperCase()} | ${reason}`);

    if (!close) {
      console.log(`[hl-trader] ⊘ Holding existing position — skipping new signal`);
      skipped++;
      continue;
    }

    // Close existing and open new
    try {
      await closeExistingPosition(exchange, signal.asset_symbol, existingPos, openDBRecords);
      await sleep(1000);
      const execution = await openTrade(exchange, signal, RISK_USD);
      await recordTrade(signal, execution, RISK_USD);
      openDBRecords[signal.asset_symbol] = { bias: signal.bias };
      opened++;
    } catch (e) {
      console.error(`[hl-trader] ✗ Flip failed for ${signal.asset_symbol}: ${e.message}`);
      skipped++;
    }

    await sleep(1000);
  }

  console.log(`\n[hl-trader] Done. Opened: ${opened} | Skipped: ${skipped}`);
}

main().catch((err) => {
  console.error("[hl-trader] Fatal:", err.message);
  process.exit(1);
});
