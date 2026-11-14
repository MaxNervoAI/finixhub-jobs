/**
 * Daily bars from Binance klines.
 *
 * The summary row for a day used to be built from the rolling 24h ticker (a window that ends when
 * the job runs, mid-morning UTC) while its taker volume came from the UTC-day candle, and the row was
 * never corrected once the day closed. A finalized bar here comes from the single UTC-day candle, so
 * open, high, low, close, volume, trade count and taker flow all describe the same day.
 */

/** Binance kline: [openTime, o, h, l, c, vol, closeTime, quoteVol, trades, takerBuyBase, takerBuyQuote, ignore] */
export type Kline = Array<string | number>;

export interface DailyBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quote_volume: number;
  trade_count: number;
  taker_buy_volume: number;
  taker_sell_volume: number;
  /** Change over the bar's own UTC day (close vs open). */
  change_percent_24h: number;
  is_complete: true;
}

const n = (v: string | number) => (typeof v === 'number' ? v : parseFloat(v));

export function finalizedBar(k: Kline): DailyBar {
  const open = n(k[1]);
  const volume = n(k[5]);
  const takerBuy = n(k[9]);
  return {
    date: new Date(n(k[0])).toISOString().slice(0, 10),
    open,
    high: n(k[2]),
    low: n(k[3]),
    close: n(k[4]),
    volume,
    quote_volume: n(k[7]),
    trade_count: n(k[8]),
    taker_buy_volume: takerBuy,
    taker_sell_volume: volume - takerBuy,
    change_percent_24h: open > 0 ? ((n(k[4]) - open) / open) * 100 : 0,
    is_complete: true,
  };
}

/** Klines whose day has fully closed. The candle still open at `nowMs` is dropped. */
export function completedDays(klines: Kline[], nowMs: number): Kline[] {
  return klines.filter((k) => n(k[6]) < nowMs);
}

/** Taker flow over a run of hourly candles (the rolling window behind the live, not-yet-complete row). */
export function rollingTaker(hourly: Kline[]): { taker_buy_volume: number; taker_sell_volume: number } {
  let volume = 0;
  let takerBuy = 0;
  for (const k of hourly) {
    volume += n(k[5]);
    takerBuy += n(k[9]);
  }
  return { taker_buy_volume: takerBuy, taker_sell_volume: volume - takerBuy };
}
