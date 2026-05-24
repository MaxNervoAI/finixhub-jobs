/**
 * Opportunity Performance Checker
 *
 * Runs daily at midnight UTC via GitHub Actions.
 * Checks ALL pending opportunity_performance rows (both 'live' from the scanner
 * and 'backtest' near-present rows) against current Binance prices.
 *
 * Unlike run-performance-check.mjs (which is plan-scoped), this checker
 * is not tied to user-created plans — it tracks every AI-generated opportunity.
 *
 * Expiry: rows open >= MAX_LOOKFORWARD_DAYS with no hit are marked 'expired'.
 * Display TTL (14h on trade_opportunities) is irrelevant here — we track
 * outcomes regardless of whether the opportunity was still shown in the UI.
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const MAX_LOOKFORWARD_DAYS = 30;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const COINGECKO_IDS = { BTC: "bitcoin", ETH: "ethereum", SOL: "solana" };

async function fetchCurrentPrice(asset) {
  const symbol = `${asset}USDT`;
  try {
    const res = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
    if (res.status === 451) throw new Error("geo-blocked");
    if (!res.ok) throw new Error(`Binance price fetch failed for ${symbol}: ${res.status}`);
    const json = await res.json();
    return parseFloat(json.price);
  } catch {
    const id = COINGECKO_IDS[asset];
    if (!id) throw new Error(`No CoinGecko ID for ${asset}`);
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`);
    if (!res.ok) throw new Error(`CoinGecko price fetch failed for ${asset}: ${res.status}`);
    const json = await res.json();
    return json[id].usd;
  }
}

/**
 * Check all TP levels hit by current price (returns highest TP level hit).
 * Returns 0 if none hit.
 */
function checkTpLevels(tpLevels, currentPrice, isLong) {
  let highestHit = 0;
  for (let i = 0; i < tpLevels.length; i++) {
    const level = tpLevels[i]?.level;
    if (level == null) continue;
    const hit = isLong ? currentPrice >= level : currentPrice <= level;
    if (hit) highestHit = i + 1; // 1-indexed
  }
  return highestHit;
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  console.log("[opp-perf] Starting opportunity performance check...");

  const { data: pending, error: fetchError } = await supabase
    .from("opportunity_performance")
    .select("*")
    .eq("final_status", "pending");

  if (fetchError) {
    console.error("[opp-perf] Failed to fetch pending records:", fetchError.message);
    process.exit(1);
  }

  if (!pending || pending.length === 0) {
    console.log("[opp-perf] No pending records. Nothing to do.");
    return;
  }

  console.log(`[opp-perf] Checking ${pending.length} pending records...`);

  // Fetch current price once per unique asset
  const assets = [...new Set(pending.map((r) => r.asset_symbol))];
  const prices = {};
  for (const asset of assets) {
    try {
      prices[asset] = await fetchCurrentPrice(asset);
      console.log(`[opp-perf] ${asset}: $${prices[asset]}`);
    } catch (err) {
      console.warn(`[opp-perf] Could not fetch price for ${asset}:`, err.message);
    }
    await sleep(200);
  }

  const today = new Date().toISOString().split("T")[0];
  const todayDate = new Date(today);
  let updated = 0;

  for (const record of pending) {
    const currentPrice = prices[record.asset_symbol];

    // Calculate days open regardless of price availability (for expiry check)
    const simulationDate = new Date(record.simulation_date);
    const daysOpen = Math.floor((todayDate - simulationDate) / (1000 * 60 * 60 * 24));

    // Expire if we've waited long enough with no price data either
    if (currentPrice == null) {
      if (daysOpen >= MAX_LOOKFORWARD_DAYS) {
        await supabase
          .from("opportunity_performance")
          .update({ final_status: "expired", last_checked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq("id", record.id);
        updated++;
      }
      continue;
    }

    const tpLevels = record.take_profit_levels ?? [];
    const sl = record.invalidation_level;
    const isLong = record.bias === "long";

    const slHit = isLong ? currentPrice <= sl : currentPrice >= sl;
    const tpLevelHit = checkTpLevels(tpLevels, currentPrice, isLong);
    const tpHit = tpLevelHit > 0;

    // Carry forward previously recorded hits (incremental: once hit, always hit)
    const wasSlHit = record.sl_hit || slHit;
    const wasTpHit = record.tp_hit || tpHit;
    const finalTpLevel = tpHit ? Math.max(tpLevelHit, record.tp_level_hit ?? 0) : (record.tp_level_hit ?? null);

    const slHitDate = wasSlHit ? (record.sl_hit_date ?? today) : null;
    const tpHitDate = wasTpHit ? (record.tp_hit_date ?? today) : null;

    const timeToSlDays = wasSlHit && slHitDate
      ? Math.floor((new Date(slHitDate) - simulationDate) / (1000 * 60 * 60 * 24))
      : null;
    const timeToTpDays = wasTpHit && tpHitDate
      ? Math.floor((new Date(tpHitDate) - simulationDate) / (1000 * 60 * 60 * 24))
      : null;

    // Whipsaw: both hit on the same day
    const whipsaw = wasTpHit && wasSlHit && tpHitDate === slHitDate;

    let finalStatus = "pending";
    if (whipsaw) {
      finalStatus = "whipsaw";
    } else if (wasTpHit) {
      finalStatus = "winner";
    } else if (wasSlHit) {
      finalStatus = "loser";
    } else if (daysOpen >= MAX_LOOKFORWARD_DAYS) {
      finalStatus = "expired";
    }

    const changed =
      finalStatus !== "pending" ||
      wasSlHit !== record.sl_hit ||
      wasTpHit !== record.tp_hit;

    if (changed) {
      const { error: updateError } = await supabase
        .from("opportunity_performance")
        .update({
          sl_hit: wasSlHit,
          sl_hit_date: slHitDate,
          time_to_sl_days: timeToSlDays,
          tp_hit: wasTpHit,
          tp_hit_date: tpHitDate,
          tp_level_hit: finalTpLevel,
          time_to_tp_days: timeToTpDays,
          whipsaw,
          final_status: finalStatus,
          last_checked_at: new Date().toISOString(),
        })
        .eq("id", record.id);

      if (updateError) {
        console.warn(`[opp-perf] Failed to update ${record.id}:`, updateError.message);
      } else {
        console.log(`[opp-perf] ${record.asset_symbol} ${record.bias.toUpperCase()} (${record.source}) → ${finalStatus}`);
        updated++;
      }
    } else {
      // Still pending — just update last_checked_at
      await supabase
        .from("opportunity_performance")
        .update({ last_checked_at: new Date().toISOString() })
        .eq("id", record.id);
    }

    await sleep(50); // gentle rate limiting on DB writes
  }

  console.log(`[opp-perf] Done. Updated ${updated}/${pending.length} records.`);
}

main().catch((err) => {
  console.error("[opp-perf] Fatal error:", err.message);
  process.exit(1);
});
