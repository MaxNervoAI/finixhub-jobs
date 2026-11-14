/**
 * Entry-fill aware outcome evaluation for live trade opportunities.
 *
 * A signal only becomes a trade once price trades through its entry price after the signal was
 * generated. Until then it cannot win or lose. Outcomes are decided by replaying closed 1-minute
 * candles in order, so wicks are never missed and the order of events is known.
 *
 * Rules, in order, for each candle after `scanned_through`:
 *  1. Not filled yet: the candle fills the entry if entry_price lies inside its low-high range.
 *     This is "touch" semantics (a touch does not guarantee a real fill), and it covers both
 *     pullback entries and breakout entries. In the fill candle only the stop is checked, because
 *     the order of events inside one candle is unknown and the stop is the pessimistic reading.
 *     If the fill window closes with no fill, the row is stored as 'expired' with entry_filled=false.
 *  2. Filled: a candle that touches the stop and a take-profit is a 'whipsaw'; stop only is a
 *     'loser'; a take-profit only is a 'winner' (highest level touched). The first terminal event wins.
 *  3. Filled and still open after MAX_LOOKFORWARD_DAYS: 'expired' with entry_filled=true.
 *
 * Pure: no I/O, no clock. The caller supplies candles (ascending, closed, none before
 * `scanned_through`) and `nowMs`.
 */

export const FILL_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MAX_LOOKFORWARD_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const iso = (ms) => new Date(ms).toISOString();
const isoDate = (ms) => iso(ms).slice(0, 10);

/**
 * @param {object} row opportunity_performance row (live, pending)
 * @param {{openTime:number, closeTime:number, low:number, high:number}[]} candles
 * @param {number} nowMs
 * @returns {{patch: object, changed: boolean}} columns to write; `changed` is false when nothing was evaluated
 */
export function evaluateOpportunity(row, candles, nowMs) {
  if (!candles.length) return { patch: {}, changed: false };

  const isLong = row.bias === 'long';
  const entry = Number(row.entry_price);
  const stop = Number(row.invalidation_level);
  const targets = (row.take_profit_levels ?? []).map((t) => Number(t?.level));
  const generatedMs = Date.parse(row.created_at);

  let filled = row.entry_filled === true;
  let filledAtMs = row.entry_filled_at ? Date.parse(row.entry_filled_at) : null;
  let scannedThroughMs = row.scanned_through ? Date.parse(row.scanned_through) : null;

  const stopTouched = (c) => (isLong ? c.low <= stop : c.high >= stop);
  const targetLevelTouched = (c) => {
    let level = 0;
    targets.forEach((t, i) => {
      if (Number.isFinite(t) && (isLong ? c.high >= t : c.low <= t)) level = i + 1;
    });
    return level;
  };

  let status = 'pending';
  let slHitMs = null;
  let tpHitMs = null;
  let tpLevel = 0;
  let whipsaw = false;

  for (const c of candles) {
    scannedThroughMs = c.closeTime + 1;

    if (!filled) {
      if (c.low <= entry && entry <= c.high) {
        filled = true;
        filledAtMs = c.openTime;
        if (stopTouched(c)) {
          status = 'loser';
          slHitMs = c.openTime;
          break;
        }
        continue;
      }
      if (scannedThroughMs - generatedMs >= FILL_WINDOW_MS) {
        status = 'expired';
        break;
      }
      continue;
    }

    const stopHit = stopTouched(c);
    const level = targetLevelTouched(c);
    if (stopHit && level > 0) {
      status = 'whipsaw';
      whipsaw = true;
      slHitMs = tpHitMs = c.openTime;
      tpLevel = level;
      break;
    }
    if (stopHit) {
      status = 'loser';
      slHitMs = c.openTime;
      break;
    }
    if (level > 0) {
      status = 'winner';
      tpHitMs = c.openTime;
      tpLevel = level;
      break;
    }
  }

  if (status === 'pending' && filled) {
    const daysOpen = Math.floor((nowMs - Date.parse(row.simulation_date)) / DAY_MS);
    if (daysOpen >= MAX_LOOKFORWARD_DAYS) status = 'expired';
  }

  const daysFromFill = (hitMs) => (hitMs !== null && filledAtMs !== null ? Math.floor((hitMs - filledAtMs) / DAY_MS) : null);

  return {
    changed: true,
    patch: {
      entry_filled: filled ? true : status === 'expired' ? false : null,
      entry_filled_at: filledAtMs !== null ? iso(filledAtMs) : null,
      scanned_through: iso(scannedThroughMs),
      fill_method: '1m',
      final_status: status,
      sl_hit: slHitMs !== null,
      sl_hit_date: slHitMs !== null ? isoDate(slHitMs) : null,
      time_to_sl_days: daysFromFill(slHitMs),
      tp_hit: tpHitMs !== null,
      tp_hit_date: tpHitMs !== null ? isoDate(tpHitMs) : null,
      tp_level_hit: tpLevel || null,
      time_to_tp_days: daysFromFill(tpHitMs),
      whipsaw,
    },
  };
}
