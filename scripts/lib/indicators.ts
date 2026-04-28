export interface OHLCVData {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// Technical Indicator Calculation Functions
export function calculateRSI(prices: number[], period: number = 14): number {
  if (prices.length < period + 1) return 50;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = prices[i] - prices[i - 1];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

export function calculateEMA(prices: number[], period: number): number {
  if (prices.length < period) return prices[prices.length - 1];

  const multiplier = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < prices.length; i++) {
    ema = (prices[i] - ema) * multiplier + ema;
  }

  return ema;
}

export function calculateSMA(prices: number[], period: number): number {
  if (prices.length < period) return prices[prices.length - 1];

  const slice = prices.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function calculateMACD(prices: number[]) {
  const ema12 = calculateEMA(prices, 12);
  const ema26 = calculateEMA(prices, 26);
  const macdLine = ema12 - ema26;

  // Calculate signal line (9-period EMA of MACD)
  const macdValues: number[] = [];
  for (let i = 26; i < prices.length; i++) {
    const slice = prices.slice(0, i + 1);
    const e12 = calculateEMA(slice, 12);
    const e26 = calculateEMA(slice, 26);
    macdValues.push(e12 - e26);
  }

  const signalLine = calculateEMA(macdValues, 9);
  const histogram = macdLine - signalLine;

  return {
    macd: parseFloat(macdLine.toFixed(4)),
    signal: parseFloat(signalLine.toFixed(4)),
    histogram: parseFloat(histogram.toFixed(4))
  };
}

export function calculateBollingerBands(prices: number[], period: number = 20, stdDev: number = 2) {
  const sma = calculateSMA(prices, period);
  const slice = prices.slice(-period);

  const variance = slice.reduce((sum, price) => sum + Math.pow(price - sma, 2), 0) / period;
  const standardDeviation = Math.sqrt(variance);

  return {
    upper: parseFloat((sma + (standardDeviation * stdDev)).toFixed(2)),
    middle: parseFloat(sma.toFixed(2)),
    lower: parseFloat((sma - (standardDeviation * stdDev)).toFixed(2))
  };
}

export function calculateATR(data: OHLCVData[], period: number = 14): number {
  if (data.length < period + 1) return 0;

  const trueRanges: number[] = [];
  for (let i = 1; i < data.length; i++) {
    const high = data[i].high;
    const low = data[i].low;
    const prevClose = data[i - 1].close;

    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trueRanges.push(tr);
  }

  const atr = trueRanges.slice(-period).reduce((a, b) => a + b, 0) / period;
  return parseFloat(atr.toFixed(2));
}

// === NEW TRADINGVIEW TECHNICAL RATINGS MATH FUNCTIONS ===

export function calculateWMA(prices: number[], period: number): number {
  if (prices.length < period) return prices[prices.length - 1];
  let wma = 0;
  let norm = 0;
  for (let i = 0; i < period; i++) {
    const weight = (period - i);
    norm += weight;
    wma += prices[prices.length - 1 - i] * weight;
  }
  return wma / norm;
}

export function calculateHMA(prices: number[], period: number): number {
  if (prices.length < period) return prices[prices.length - 1];

  const halfLength = Math.floor(period / 2);
  const sqrtLength = Math.floor(Math.sqrt(period));

  const wmaHalfValues: number[] = [];
  const wmaFullValues: number[] = [];

  // Calculate WMA for half period and full period over the needed window
  for (let i = sqrtLength; i >= 0; i--) {
    const slice = prices.slice(0, prices.length - i);
    wmaHalfValues.push(calculateWMA(slice, halfLength));
    wmaFullValues.push(calculateWMA(slice, period));
  }

  // Raw HMA values = 2 * WMA(period/2) - WMA(period)
  const rawHmaValues = wmaHalfValues.map((half, idx) => (2 * half) - wmaFullValues[idx]);

  // Final HMA is WMA(sqrt(period)) of the raw values
  return calculateWMA(rawHmaValues, sqrtLength);
}

export function calculateVWMA(data: OHLCVData[], period: number): number {
  if (data.length < period) return data[data.length - 1].close;

  const slice = data.slice(-period);
  let priceVolumeSum = 0;
  let volumeSum = 0;

  for (const candle of slice) {
    priceVolumeSum += (candle.close * candle.volume);
    volumeSum += candle.volume;
  }

  return volumeSum === 0 ? slice[slice.length - 1].close : priceVolumeSum / volumeSum;
}

export function calculateIchimoku(data: OHLCVData[], conversionPeriod = 9, basePeriod = 26, lagSpan = 52) {
  if (data.length < lagSpan) return null;

  const getHighLowAvg = (slice: OHLCVData[]) => {
    const highs = slice.map(d => d.high);
    const lows = slice.map(d => d.low);
    return (Math.max(...highs) + Math.min(...lows)) / 2;
  };

  const conversionLine = getHighLowAvg(data.slice(-conversionPeriod));
  const baseLine = getHighLowAvg(data.slice(-basePeriod));
  const leadSpanA = (conversionLine + baseLine) / 2;
  const leadSpanB = getHighLowAvg(data.slice(-lagSpan));

  // Return the latest computed values
  return {
    conversionLine,
    baseLine,
    leadSpanA,
    leadSpanB
  };
}

export function calculateStochastic(data: OHLCVData[], kPeriod = 14, dPeriod = 3, smoothPeriod = 3) {
  if (data.length < kPeriod + dPeriod + smoothPeriod) return null;

  const rawKValues: number[] = [];

  // Calculate raw %K for the window needed to compute smooth %K and %D
  const neededLength = smoothPeriod + dPeriod - 1;
  for (let i = neededLength; i >= 0; i--) {
    const slice = data.slice(data.length - kPeriod - i, data.length - i);
    const currentClose = slice[slice.length - 1].close;
    const highestHigh = Math.max(...slice.map(d => d.high));
    const lowestLow = Math.min(...slice.map(d => d.low));

    const rawK = highestHigh === lowestLow ? 100 : ((currentClose - lowestLow) / (highestHigh - lowestLow)) * 100;
    rawKValues.push(rawK);
  }

  // Smooth %K (SMA of raw %K)
  const smoothKValues: number[] = [];
  for (let i = dPeriod - 1; i >= 0; i--) {
    const slice = rawKValues.slice(rawKValues.length - smoothPeriod - i, rawKValues.length - i);
    smoothKValues.push(slice.reduce((a, b) => a + b, 0) / smoothPeriod);
  }

  const k = smoothKValues[smoothKValues.length - 1];
  const d = smoothKValues.reduce((a, b) => a + b, 0) / dPeriod;

  return { k, d };
}

export function calculateCCI(data: OHLCVData[], period = 20) {
  if (data.length < period) return null;

  const slice = data.slice(-period);
  const typicalPrices = slice.map(d => (d.high + d.low + d.close) / 3);
  const currentTp = typicalPrices[typicalPrices.length - 1];

  const sma = typicalPrices.reduce((a, b) => a + b, 0) / period;
  const meanDeviation = typicalPrices.reduce((sum, tp) => sum + Math.abs(tp - sma), 0) / period;

  if (meanDeviation === 0) return 0;
  return (currentTp - sma) / (0.015 * meanDeviation);
}

export function calculateADX(data: OHLCVData[], period = 14) {
  if (data.length < period * 2) return null;

  // Calculate True Range, +DM, -DM
  const tr: number[] = [];
  const plusDM: number[] = [];
  const minusDM: number[] = [];

  for (let i = 1; i < data.length; i++) {
    const highDiff = data[i].high - data[i - 1].high;
    const lowDiff = data[i - 1].low - data[i].low;

    tr.push(Math.max(
      data[i].high - data[i].low,
      Math.abs(data[i].high - data[i - 1].close),
      Math.abs(data[i].low - data[i - 1].close)
    ));

    plusDM.push((highDiff > lowDiff && highDiff > 0) ? highDiff : 0);
    minusDM.push((lowDiff > highDiff && lowDiff > 0) ? lowDiff : 0);
  }

  // Wilder's Smoothing Function
  const smooth = (values: number[], period: number) => {
    const smoothed: number[] = [values.slice(0, period).reduce((a, b) => a + b, 0)];
    for (let i = period; i < values.length; i++) {
      smoothed.push(smoothed[smoothed.length - 1] - (smoothed[smoothed.length - 1] / period) + values[i]);
    }
    return smoothed;
  };

  const smoothedTR = smooth(tr, period);
  const smoothedPlusDM = smooth(plusDM, period);
  const smoothedMinusDM = smooth(minusDM, period);

  const dxValues: number[] = [];
  for (let i = 0; i < smoothedTR.length; i++) {
    const plusDI = (smoothedPlusDM[i] / smoothedTR[i]) * 100;
    const minusDI = (smoothedMinusDM[i] / smoothedTR[i]) * 100;
    const dx = plusDI + minusDI === 0 ? 0 : Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100;
    dxValues.push(dx);
  }

  // ADX is SMMA of DX
  const adx = dxValues.slice(-period).reduce((a, b) => a + b, 0) / period;

  const latestPlusDI = (smoothedPlusDM[smoothedPlusDM.length - 1] / smoothedTR[smoothedTR.length - 1]) * 100;
  const latestMinusDI = (smoothedMinusDM[smoothedMinusDM.length - 1] / smoothedTR[smoothedTR.length - 1]) * 100;

  return { adx, plusDI: latestPlusDI, minusDI: latestMinusDI };
}

export function calculateAwesomeOscillator(data: OHLCVData[]) {
  if (data.length < 34) return null;
  // AO = SMA(High+Low)/2, 5 Periods) - SMA(High+Low)/2, 34 Periods)
  const medianPrices = data.map(d => (d.high + d.low) / 2);
  const sma5 = calculateSMA(medianPrices, 5);
  const sma34 = calculateSMA(medianPrices, 34);
  return sma5 - sma34;
}

export function calculateMomentum(prices: number[], period = 10) {
  if (prices.length < period + 1) return null;
  return prices[prices.length - 1] - prices[prices.length - 1 - period];
}

export function calculateWilliamsR(data: OHLCVData[], period = 14) {
  if (data.length < period) return null;
  const slice = data.slice(-period);
  const highestHigh = Math.max(...slice.map(d => d.high));
  const lowestLow = Math.min(...slice.map(d => d.low));
  const currentClose = slice[slice.length - 1].close;

  if (highestHigh === lowestLow) return -50;
  return ((highestHigh - currentClose) / (highestHigh - lowestLow)) * -100;
}

export function calculateBullBearPower(data: OHLCVData[], period = 13) {
  if (data.length < period) return null;
  const prices = data.map(d => d.close);
  const ema = calculateEMA(prices, period);
  const currentCandle = data[data.length - 1];

  return {
    bull: currentCandle.high - ema,
    bear: currentCandle.low - ema
  };
}

export function calculateUltimateOscillator(data: OHLCVData[], p1 = 7, p2 = 14, p3 = 28) {
  if (data.length < p3 + 1) return null;

  const bp: number[] = [];
  const tr: number[] = [];

  for (let i = 1; i < data.length; i++) {
    const current = data[i];
    const previous = data[i - 1];
    const trueLow = Math.min(current.low, previous.close);
    const trueHigh = Math.max(current.high, previous.close);

    bp.push(current.close - trueLow);
    tr.push(trueHigh - trueLow);
  }

  const calcAverage = (period: number) => {
    const bpSum = bp.slice(-period).reduce((a, b) => a + b, 0);
    const trSum = tr.slice(-period).reduce((a, b) => a + b, 0);
    return trSum === 0 ? 0 : bpSum / trSum;
  };

  const avg1 = calcAverage(p1);
  const avg2 = calcAverage(p2);
  const avg3 = calcAverage(p3);

  // Guard against divide by zero (trSum === 0 returned 0 for avgs, but formula divisor is static 7)
  return 100 * ((4 * avg1) + (2 * avg2) + avg3) / 7;
}

// === END NEW MATH ===

export function calculateStochasticRSI(prices: number[], period: number = 14): { k: number; d: number } {
  const rsiValues: number[] = [];

  for (let i = period; i <= prices.length; i++) {
    const slice = prices.slice(i - period - 1, i);
    rsiValues.push(calculateRSI(slice, period));
  }

  if (rsiValues.length < 14) {
    return { k: 50, d: 50 };
  }

  const recentRsi = rsiValues.slice(-14);
  const minRsi = Math.min(...recentRsi);
  const maxRsi = Math.max(...recentRsi);
  const currentRsi = rsiValues[rsiValues.length - 1];

  const k = maxRsi - minRsi === 0 ? 50 : ((currentRsi - minRsi) / (maxRsi - minRsi)) * 100;

  // Calculate D (3-period SMA of K)
  const kValues: number[] = [];
  for (let i = 0; i < rsiValues.length - 13; i++) {
    const slice = rsiValues.slice(i, i + 14);
    const min = Math.min(...slice);
    const max = Math.max(...slice);
    const curr = slice[slice.length - 1];
    kValues.push(max - min === 0 ? 50 : ((curr - min) / (max - min)) * 100);
  }

  const d = kValues.length >= 3
    ? kValues.slice(-3).reduce((a, b) => a + b, 0) / 3
    : k;

  return {
    k: parseFloat(k.toFixed(1)),
    d: parseFloat(d.toFixed(1))
  };
}

export function calculateVWAP(data: OHLCVData[]): number {
  if (data.length === 0) return 0;

  let cumulativeTPV = 0;
  let cumulativeVolume = 0;

  for (const candle of data) {
    const typicalPrice = (candle.high + candle.low + candle.close) / 3;
    cumulativeTPV += typicalPrice * candle.volume;
    cumulativeVolume += candle.volume;
  }

  return cumulativeVolume === 0 ? 0 : parseFloat((cumulativeTPV / cumulativeVolume).toFixed(2));
}

export function analyzeVolumeTrend(data: OHLCVData[]): string {
  if (data.length < 20) return 'neutral';

  const recentVolumes = data.slice(-10).map(d => d.volume);
  const olderVolumes = data.slice(-20, -10).map(d => d.volume);

  const recentAvg = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;
  const olderAvg = olderVolumes.reduce((a, b) => a + b, 0) / olderVolumes.length;

  const overallAvg = data.slice(-50).map(d => d.volume).reduce((a, b) => a + b, 0) / Math.min(50, data.length);

  if (recentAvg > olderAvg * 1.2 && recentAvg > overallAvg) return 'increasing_high';
  if (recentAvg > olderAvg * 1.1) return 'increasing';
  if (recentAvg < olderAvg * 0.8 && recentAvg < overallAvg) return 'decreasing_low';
  if (recentAvg < olderAvg * 0.9) return 'decreasing';

  return 'neutral';
}

// === TRADINGVIEW RATINGS EVALUATION ENGINE ===

export function evaluateMAs(prices: number[], currentPrice: number, hlocData: OHLCVData[]) {
  const ratings: Record<string, number> = {};
  const rawValues: Record<string, number | null> = {};

  const evaluateAndStore = (key: string, val: number | null) => {
    rawValues[key] = val;
    if (val === null) {
      ratings[key] = 0;
      return;
    }
    if (val < currentPrice) ratings[key] = 1; // Buy
    else if (val > currentPrice) ratings[key] = -1; // Sell
    else ratings[key] = 0; // Neutral
  };

  evaluateAndStore('sma10', calculateSMA(prices, 10));
  evaluateAndStore('sma20', calculateSMA(prices, 20));
  evaluateAndStore('sma30', calculateSMA(prices, 30));
  evaluateAndStore('sma50', calculateSMA(prices, 50));
  evaluateAndStore('sma100', calculateSMA(prices, 100));
  evaluateAndStore('sma200', calculateSMA(prices, 200));
  evaluateAndStore('ema10', calculateEMA(prices, 10));
  evaluateAndStore('ema20', calculateEMA(prices, 20));
  evaluateAndStore('ema30', calculateEMA(prices, 30));
  evaluateAndStore('ema50', calculateEMA(prices, 50));
  evaluateAndStore('ema100', calculateEMA(prices, 100));
  evaluateAndStore('ema200', calculateEMA(prices, 200));
  evaluateAndStore('hma9', calculateHMA(prices, 9));
  evaluateAndStore('vwma20', calculateVWMA(hlocData, 20));

  // Ichimoku Cloud (9, 26, 52)
  const ichi = calculateIchimoku(hlocData);
  ratings.ichimoku = 0;
  rawValues.ichimoku = null;
  if (ichi) {
    rawValues.ichimoku = ichi.conversionLine; // Using conversionLine as representative value
    if (ichi.leadSpanA > ichi.leadSpanB && ichi.baseLine > ichi.leadSpanA && ichi.conversionLine > ichi.baseLine && currentPrice > ichi.conversionLine) {
      ratings.ichimoku = 1;
    } else if (ichi.leadSpanA < ichi.leadSpanB && ichi.baseLine < ichi.leadSpanA && ichi.conversionLine < ichi.baseLine && currentPrice < ichi.conversionLine) {
      ratings.ichimoku = -1;
    }
  }

  const values = Object.values(ratings);
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    rating: sum / values.length,
    components: ratings,
    raw_values: rawValues
  };
}

export function evaluateOscillators(prices: number[], hlocData: OHLCVData[]) {
  const ratings: Record<string, number> = {};
  const rawValues: Record<string, number | null> = {};

  const prevPrices = prices.slice(0, -1);
  const prevHloc = hlocData.slice(0, -1);

  // 1. RSI (14)
  const rsi = calculateRSI(prices, 14);
  const prevRsi = calculateRSI(prevPrices, 14);
  rawValues.rsi = rsi;
  if (rsi < 30 && rsi > prevRsi) ratings.rsi = 1;
  else if (rsi > 70 && rsi < prevRsi) ratings.rsi = -1;
  else ratings.rsi = 0;

  // 2. Stochastic (14, 3, 3)
  const stoch = calculateStochastic(hlocData);
  rawValues.stoch = stoch ? stoch.k : null;
  if (stoch && stoch.k < 20 && stoch.d < 20 && stoch.k > stoch.d) ratings.stoch = 1;
  else if (stoch && stoch.k > 80 && stoch.d > 80 && stoch.k < stoch.d) ratings.stoch = -1;
  else ratings.stoch = 0;

  // 3. CCI (20)
  const cci = calculateCCI(hlocData, 20);
  const prevCci = calculateCCI(prevHloc, 20);
  rawValues.cci = cci;
  if (cci !== null && prevCci !== null) {
    if (cci < -100 && cci > prevCci) ratings.cci = 1;
    else if (cci > 100 && cci < prevCci) ratings.cci = -1;
    else ratings.cci = 0;
  } else ratings.cci = 0;

  // 4. ADX (14)
  const adxData = calculateADX(hlocData, 14);
  const prevAdxData = calculateADX(prevHloc, 14);
  rawValues.adx = adxData ? adxData.adx : null;
  if (adxData && prevAdxData) {
    if (adxData.plusDI > adxData.minusDI && adxData.adx > 20 && adxData.adx > prevAdxData.adx) ratings.adx = 1;
    else if (adxData.plusDI < adxData.minusDI && adxData.adx > 20 && adxData.adx < prevAdxData.adx) ratings.adx = -1;
    else ratings.adx = 0;
  } else ratings.adx = 0;

  // 5. Awesome Oscillator (AO)
  const ao = calculateAwesomeOscillator(hlocData);
  const prevAo = hlocData.length > 1 ? calculateAwesomeOscillator(prevHloc) : null;
  const prev2Ao = hlocData.length > 2 ? calculateAwesomeOscillator(hlocData.slice(0, -2)) : null;
  rawValues.ao = ao;
  if (ao !== null && prevAo !== null && prev2Ao !== null) {
    const crossover = prevAo <= 0 && ao > 0;
    const saucerBuy = ao > 0 && prevAo > 0 && prev2Ao > 0 && ao > prevAo && prevAo < prev2Ao;
    const crossunder = prevAo >= 0 && ao < 0;
    const saucerSell = ao < 0 && prevAo < 0 && prev2Ao < 0 && ao < prevAo && prevAo > prev2Ao;

    if (crossover || saucerBuy) ratings.ao = 1;
    else if (crossunder || saucerSell) ratings.ao = -1;
    else ratings.ao = 0;
  } else ratings.ao = 0;

  // 6. Momentum (10)
  const mom = calculateMomentum(prices, 10);
  const prevMom = calculateMomentum(prevPrices, 10);
  rawValues.mom = mom;
  if (mom !== null && prevMom !== null) {
    if (mom > prevMom) ratings.mom = 1;
    else if (mom < prevMom) ratings.mom = -1;
    else ratings.mom = 0;
  } else ratings.mom = 0;

  // 7. MACD (12, 26, 9)
  const macd = calculateMACD(prices);
  rawValues.macd = macd.macd;
  if (macd.macd > macd.signal) ratings.macd = 1;
  else if (macd.macd < macd.signal) ratings.macd = -1;
  else ratings.macd = 0;

  // 8. Stochastic RSI (3, 3, 14, 14) 
  const stochRsi = calculateStochasticRSI(prices);
  rawValues.stoch_rsi = stochRsi.k;
  if (stochRsi.k < 20 && stochRsi.d < 20 && stochRsi.k > stochRsi.d) ratings.stoch_rsi = 1;
  else if (stochRsi.k > 80 && stochRsi.d > 80 && stochRsi.k < stochRsi.d) ratings.stoch_rsi = -1;
  else ratings.stoch_rsi = 0;

  // 9. Williams %R (14)
  const wR = calculateWilliamsR(hlocData, 14);
  const prevWr = calculateWilliamsR(prevHloc, 14);
  rawValues.williams_r = wR;
  if (wR !== null && prevWr !== null) {
    if (wR < -80 && wR > prevWr) ratings.williams_r = 1;
    else if (wR > -20 && wR < prevWr) ratings.williams_r = -1;
    else ratings.williams_r = 0;
  } else ratings.williams_r = 0;

  // 10. Bull Bear Power (13)
  const bbp = calculateBullBearPower(hlocData, 13);
  const prevBbp = calculateBullBearPower(prevHloc, 13);
  rawValues.bbp = bbp ? bbp.bull : null; // Representing as Bull Power
  if (bbp !== null && prevBbp !== null) {
    const ema13 = calculateEMA(prices, 13);
    const prevEma13 = calculateEMA(prevPrices, 13);
    const uptrend = ema13 > prevEma13;
    const downtrend = ema13 < prevEma13;

    if (uptrend && bbp.bear < 0 && bbp.bear > prevBbp.bear) ratings.bbp = 1;
    else if (downtrend && bbp.bull > 0 && bbp.bull < prevBbp.bull) ratings.bbp = -1;
    else ratings.bbp = 0;
  } else ratings.bbp = 0;

  // 11. Ultimate Oscillator (7, 14, 28)
  const uo = calculateUltimateOscillator(hlocData);
  rawValues.uo = uo;
  if (uo !== null) {
    if (uo > 70) ratings.uo = 1;
    else if (uo < 30) ratings.uo = -1;
    else ratings.uo = 0;
  } else ratings.uo = 0;

  const values = Object.values(ratings);
  const sum = values.reduce((a, b) => a + b, 0);
  return {
    rating: sum / values.length,
    components: ratings,
    raw_values: rawValues
  };
}

export function calculateTradingViewRatings(prices: number[], hlocData: OHLCVData[]) {
  const currentPrice = prices[prices.length - 1];
  const maEvaluation = evaluateMAs(prices, currentPrice, hlocData);
  const oscEvaluation = evaluateOscillators(prices, hlocData);

  const overall = (maEvaluation.rating + oscEvaluation.rating) / 2;

  return {
    ma_rating: parseFloat(maEvaluation.rating.toFixed(4)),
    oscillator_rating: parseFloat(oscEvaluation.rating.toFixed(4)),
    overall_rating: parseFloat(overall.toFixed(4)),
    extended_indicators: {
      ma_components: maEvaluation.components,
      osc_components: oscEvaluation.components,
      ma_raw_values: maEvaluation.raw_values,
      osc_raw_values: oscEvaluation.raw_values
    }
  };
}

async function calculateIndicatorsForSymbol(supabase: any, symbol: string, date: string) {
  console.log(`Calculating indicators for ${symbol} on ${date}`);

  // Calculate date range for 200 days lookback
  const endDate = new Date(date);
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - 200);

  // Use the new helper function to get daily candles aggregated from 1m data
  const { data: ohlcvData, error: ohlcvError } = await supabase
    .rpc('get_daily_candles_from_1m', {
      p_symbol: symbol,
      p_start_date: startDate.toISOString().split('T')[0],
      p_end_date: date
    });

  if (ohlcvError) {
    console.error(`Error fetching OHLCV data for ${symbol}:`, ohlcvError);
    return null;
  }

  if (!ohlcvData || ohlcvData.length < 50) {
    console.log(`Insufficient data for ${symbol}: ${ohlcvData?.length || 0} candles`);
    return null;
  }

  const prices = ohlcvData.map((d: OHLCVData) => d.close);
  const typedData: OHLCVData[] = ohlcvData.map((d: any) => ({
    timestamp: d.timestamp,
    open: Number(d.open),
    high: Number(d.high),
    low: Number(d.low),
    close: Number(d.close),
    volume: Number(d.volume)
  }));

  // Calculate all indicators
  const rsi14 = calculateRSI(prices, 14);
  const macd = calculateMACD(prices);
  const bollingerBands = calculateBollingerBands(prices, 20, 2);
  const ema20 = calculateEMA(prices, 20);
  const ema50 = calculateEMA(prices, 50);
  const sma50 = calculateSMA(prices, 50);
  const sma200 = calculateSMA(prices, 200);
  const atr14 = calculateATR(typedData, 14);
  const stochasticRsi = calculateStochasticRSI(prices, 14);
  const vwap = calculateVWAP(typedData.slice(-30)); // Last 30 days for VWAP
  const volumeTrend = analyzeVolumeTrend(typedData);

  // === NEW TRADINGVIEW DETERMISITIC RATINGS ===
  const tvRatings = calculateTradingViewRatings(prices, typedData);

  // Extract latest candle for base OHLCV fields
  const latestCandle = typedData[typedData.length - 1];

  if (!latestCandle) {
    console.error(`No candle data available for ${symbol} on ${date}`);
    return null;
  }

  // Upsert to asset_daily_summary with all required fields
  const { error: updateError } = await supabase
    .from('asset_daily_summary')
    .upsert({
      // Required base OHLCV fields
      symbol: symbol,
      date: date,
      open: latestCandle.open,
      high: latestCandle.high,
      low: latestCandle.low,
      close: latestCandle.close,
      volume: latestCandle.volume,

      // Calculated technical indicators
      rsi_14: rsi14,
      macd: macd,
      bollinger_bands: bollingerBands,
      ema_20: ema20,
      ema_50: ema50,
      sma_50: sma50,
      sma_200: sma200,
      atr_14: atr14,
      stochastic_rsi: stochasticRsi,
      vwap: vwap,
      volume_trend: volumeTrend,
      ...tvRatings, // Spread ma_rating, oscillator_rating, overall_rating, and extended_indicators
      updated_at: new Date().toISOString()
    }, {
      onConflict: 'symbol,date'
    });

  if (updateError) {
    console.error(`Error updating indicators for ${symbol}:`, updateError);
    return null;
  }

  console.log(`Successfully calculated indicators for ${symbol}`);
  return {
    symbol,
    date,
    rsi_14: rsi14,
    macd,
    bollinger_bands: bollingerBands,
    ema_20: ema20,
    ema_50: ema50,
    sma_50: sma50,
    sma_200: sma200,
    atr_14: atr14,
    stochastic_rsi: stochasticRsi,
    vwap: vwap,
    volume_trend: volumeTrend,
    ...tvRatings
  };
}



// ---- Support / Resistance (used by insights + backfill) ----

export function calculateSupportResistance(candles: { high: number; low: number; close: number }[]) {
  if (!candles || candles.length === 0) {
    return { support: [], resistance: [] };
  }

  const highs = candles.map(c => c.high).filter(v => v != null && !isNaN(v));
  const lows = candles.map(c => c.low).filter(v => v != null && !isNaN(v));
  const closes = candles.map(c => c.close).filter(v => v != null && !isNaN(v));

  if (highs.length === 0 || lows.length === 0 || closes.length === 0) {
    return { support: [], resistance: [] };
  }

  const currentClose = closes[0];
  const maxH = Math.max(...highs);
  const minL = Math.min(...lows);

  // Core levels
  const coreSupport = [minL, currentClose * 0.98, currentClose * 0.95];
  const coreResistance = [maxH, currentClose * 1.02, currentClose * 1.05];

  // Fibonacci-based levels
  const range = maxH - minL;
  if (range > 0) {
    coreSupport.push(maxH - range * 0.618);
    coreResistance.push(minL + range * 0.618);
  }

  // Deduplicate and round to 2 decimal places, filtered by position
  const support = [...new Set(coreSupport.map(v => parseFloat(v.toFixed(2))))]
    .filter(v => v < currentClose && v > 0)
    .sort((a, b) => b - a)
    .slice(0, 3);

  const resistance = [...new Set(coreResistance.map(v => parseFloat(v.toFixed(2))))]
    .filter(v => v > currentClose)
    .sort((a, b) => a - b)
    .slice(0, 3);

  return { support, resistance };
}

// ---- Volume Ratio (real calculation vs. string-based approximation) ----

export function calculateVolumeRatio(todayVolume: number, historicalData: OHLCVData[]): number {
  if (!todayVolume || historicalData.length < 5) return 1.0;
  const avgVolume = historicalData.slice(-20).reduce((sum, d) => sum + d.volume, 0) / Math.min(historicalData.length, 20);
  if (avgVolume === 0) return 1.0;
  return parseFloat((todayVolume / avgVolume).toFixed(2));
}
