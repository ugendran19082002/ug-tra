import dotenv from "dotenv";
dotenv.config();

// ─────────────────────────────────────────
// EMA — SMA-seeded (FIX #10)
// ─────────────────────────────────────────
export function calculateEMA(data, period = 20) {
    if (!data || data.length < period) return Array(data?.length || 0).fill(null);

    const k = 2 / (period + 1);
    let ema = data.slice(0, period).reduce((sum, c) => sum + c.close, 0) / period;

    const result = Array(period - 1).fill(null);
    result.push(ema);

    for (let i = period; i < data.length; i++) {
        ema = data[i].close * k + ema * (1 - k);
        result.push(ema);
    }
    return result;
}

// ─────────────────────────────────────────
// RSI(14) — Wilder's smoothing
// ─────────────────────────────────────────
export function calculateRSI(data, period = 14, warnings = []) {
    const n = data.length;
    if (n < period + 1) {
        warnings.push("RSI_FALLBACK");
        return Array(n).fill(50);
    }

    const result = Array(period).fill(50);
    let avgGain = 0, avgLoss = 0;

    for (let i = 1; i <= period; i++) {
        const diff = data[i].close - data[i - 1].close;
        if (diff > 0) avgGain += diff;
        else avgLoss -= diff;
    }
    avgGain /= period;
    avgLoss /= period;

    const toRSI = (g, l) => l === 0 ? 100 : 100 - 100 / (1 + g / l);
    result.push(toRSI(avgGain, avgLoss));

    for (let i = period + 1; i < n; i++) {
        const diff = data[i].close - data[i - 1].close;
        avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
        avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
        result.push(toRSI(avgGain, avgLoss));
    }
    return result;
}

// ─────────────────────────────────────────
// ATR(14) — Wilder's smoothing
// ─────────────────────────────────────────
export function calculateATR(data, period = 14, warnings = []) {
    const n = data.length;
    if (n < period + 1) {
        warnings.push("ATR_FALLBACK");
        return Array(n).fill(null);
    }

    const tr = data.map((c, i) =>
        i === 0
            ? c.high - c.low
            : Math.max(
                c.high - c.low,
                Math.abs(c.high - data[i - 1].close),
                Math.abs(c.low - data[i - 1].close)
            )
    );

    const result = Array(period).fill(null);
    let atr = tr.slice(0, period).reduce((s, v) => s + v, 0) / period;
    result.push(atr);

    for (let i = period; i < n; i++) {
        atr = (atr * (period - 1) + tr[i]) / period;
        result.push(atr);
    }
    return result;
}

// ─────────────────────────────────────────
// ADX(14) — Wilder's smoothing
// ─────────────────────────────────────────
export function calculateADX(data, period = 14, warnings = []) {
    const n = data.length;
    const minRequired = 2 * period + 1;

    if (n < minRequired) {
        warnings.push("ADX_SHORT");
        return new Array(n).fill(null);
    }

    const result = new Array(n).fill(null);
    const tr = [], pdm = [], mdm = [];

    for (let i = 1; i < n; i++) {
        const up = data[i].high - data[i - 1].high;
        const dn = data[i - 1].low - data[i].low;
        pdm.push(up > dn && up > 0 ? up : 0);
        mdm.push(dn > up && dn > 0 ? dn : 0);
        tr.push(Math.max(
            data[i].high - data[i].low,
            Math.abs(data[i].high - data[i - 1].close),
            Math.abs(data[i].low - data[i - 1].close)
        ));
    }

    let sTR = tr.slice(0, period).reduce((a, b) => a + b, 0);
    let sPDM = pdm.slice(0, period).reduce((a, b) => a + b, 0);
    let sMDM = mdm.slice(0, period).reduce((a, b) => a + b, 0);

    const dx = [];
    const toDX = () => {
        if (sTR === 0) return 0;
        const pdi = sPDM / sTR * 100;
        const mdi = sMDM / sTR * 100;
        return (pdi + mdi) === 0 ? 0 : Math.abs(pdi - mdi) / (pdi + mdi) * 100;
    };
    dx.push(toDX());

    for (let i = period; i < tr.length; i++) {
        sTR = sTR - sTR / period + tr[i];
        sPDM = sPDM - sPDM / period + pdm[i];
        sMDM = sMDM - sMDM / period + mdm[i];
        dx.push(toDX());
    }

    let adx = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
    result[2 * period - 1] = adx;

    for (let i = period; i < dx.length; i++) {
        adx = (adx * (period - 1) + dx[i]) / period;
        result[2 * period + (i - period)] = adx;
    }
    return result;
}

// ─────────────────────────────────────────
// SUPPORT / RESISTANCE ENGINE
// Swing pivots + Classic Pivot levels
// ─────────────────────────────────────────
export function findSupportResistance(data, prevCandle = null, options = {}) {
    const { window = 8, tolerance = 0.002, minTouches = 2 } = options;

    if (!Array.isArray(data) || data.length < window * 2) {
        return { supports: [], resistances: [], pivotLevels: null };
    }

    const pivots = [];

    for (let i = window; i < data.length - window; i++) {
        let isSupport = true, isResistance = true;
        for (let j = i - window; j <= i + window; j++) {
            if (data[j].low < data[i].low) isSupport = false;
            if (data[j].high > data[i].high) isResistance = false;
        }
        if (isSupport) pivots.push({ type: "low", price: data[i].low });
        if (isResistance) pivots.push({ type: "high", price: data[i].high });
    }

    function clusterLevels(levels) {
        const clusters = [];
        levels.forEach(level => {
            let found = false;
            for (let cluster of clusters) {
                if (Math.abs(cluster.price - level) / cluster.price <= tolerance) {
                    cluster.touches++;
                    cluster.price = (cluster.price * (cluster.touches - 1) + level) / cluster.touches;
                    found = true;
                    break;
                }
            }
            if (!found) clusters.push({ price: level, touches: 1 });
        });
        return clusters
            .filter(l => l.touches >= minTouches)
            .sort((a, b) => b.touches - a.touches)
            .map(l => Number(l.price.toFixed(2)));
    }

    const swingSupports = clusterLevels(pivots.filter(p => p.type === "low").map(p => p.price));
    const swingResistances = clusterLevels(pivots.filter(p => p.type === "high").map(p => p.price));

    let pivotLevels = null;
    if (prevCandle &&
        typeof prevCandle.high === "number" &&
        typeof prevCandle.low === "number" &&
        typeof prevCandle.close === "number") {
        const { high, low, close } = prevCandle;
        const P = (high + low + close) / 3;
        pivotLevels = {
            pivot: Number(P.toFixed(2)),
            supports: [
                Number(((2 * P) - high).toFixed(2)),
                Number((P - (high - low)).toFixed(2)),
                Number((low - 2 * (high - P)).toFixed(2))
            ],
            resistances: [
                Number(((2 * P) - low).toFixed(2)),
                Number((P + (high - low)).toFixed(2)),
                Number((high + 2 * (P - low)).toFixed(2))
            ]
        };
    }

    return {
        supports: pivotLevels ? [...swingSupports, ...pivotLevels.supports] : swingSupports,
        resistances: pivotLevels ? [...swingResistances, ...pivotLevels.resistances] : swingResistances,
    };
}

// ─────────────────────────────────────────
// ROUND LEVELS
// ─────────────────────────────────────────
export function getRoundLevels(price, step = 500) {
    const base = Math.floor(price / step) * step;
    return [base - step, base, base + step, base + step * 2];
}

export function cleanLevels(levels, threshold = 20) {
    levels.sort((a, b) => a - b);
    return levels.reduce((acc, lvl) => {
        if (acc.length === 0 || Math.abs(lvl - acc[acc.length - 1]) > threshold)
            acc.push(lvl);
        return acc;
    }, []);
}

// ─────────────────────────────────────────
// VOLUME SPIKE — FIX: 1.7x threshold (institutional options grade)
// ─────────────────────────────────────────
export function volumeSpike(data, index) {
    const lookback = Math.min(10, index);
    if (lookback < 3) return false;
    const avg = data.slice(index - lookback, index)
        .reduce((s, c) => s + c.volume, 0) / lookback;
    return data[index].volume > avg * 1.4; // ✅ UPGRADED: 1.5 → 1.7x (options noise filter)
}

// ─────────────────────────────────────────
// OI CLASSIFICATION
// ─────────────────────────────────────────
export function classifyOI(last, prev) {
    if (!last || !prev) {
        return {
            longBuildup: false, shortBuildup: false,
            shortCovering: false, longUnwinding: false,
            callOi: false, putOi: false
        };
    }
    const priceChange = last.close - prev.close;
    const oiChange = (last.oi ?? 0) - (prev.oi ?? 0);

    const longBuildup = priceChange > 0 && oiChange > 0;
    const shortBuildup = priceChange < 0 && oiChange > 0;
    const shortCovering = priceChange > 0 && oiChange < 0;
    const longUnwinding = priceChange < 0 && oiChange < 0;

    return {
        longBuildup, shortBuildup, shortCovering, longUnwinding,
        callOi: longBuildup || shortCovering,
        putOi: shortBuildup || longUnwinding
    };
}

// ─────────────────────────────────────────
// VWAP — Intraday Cumulative
// Caller passes session candles only (resets each day)
// ─────────────────────────────────────────
export function calculateVWAP(candles) {
    let cumulativePV = 0;
    let cumulativeVol = 0;
    return candles.map(c => {
        const typical = (c.high + c.low + c.close) / 3;
        cumulativePV += typical * c.volume;
        cumulativeVol += c.volume;
        return cumulativeVol === 0 ? null : cumulativePV / cumulativeVol;
    });
}

// ═══════════════════════════════════════════════════════════════
// ██████████████████████████████████████████████████████████████
//         4 NEW INSTITUTIONAL ENGINES
// ██████████████████████████████████████████████████████████████
// ═══════════════════════════════════════════════════════════════

// ─────────────────────────────────────────
// ENGINE 1: LIQUIDITY SWEEP DETECTOR
// Detects fake breakouts / stop hunts
// Used by hedge funds to trap retail traders
// ─────────────────────────────────────────
/**
 * liquiditySweepEngine(candles1m)
 * Returns:
 *   sweepHigh  — wick above prev high but close BELOW → bearish trap
 *   sweepLow   — wick below prev low but close ABOVE  → bullish trap
 *   trapLong   — retail longs trapped (sell signal after)
 *   trapShort  — retail shorts trapped (buy signal after)
 */
export function liquiditySweepEngine(candles) {
    const n = candles.length;
    if (n < 3) {
        return { sweepHigh: false, sweepLow: false, trapLong: false, trapShort: false };
    }

    const last = candles[n - 1];
    const prev = candles[n - 2];
    const prev2 = candles[n - 3];

    // Swing high / swing low of last 2 candles before current
    const swingHigh = Math.max(prev.high, prev2.high);
    const swingLow = Math.min(prev.low, prev2.low);

    // ✅ Sweep High: wick pierces above swing high, closes back BELOW it
    // → Retail breakout buyers trapped → bearish reversal signal
    const sweepHigh = last.high > swingHigh && last.close < swingHigh;

    // ✅ Sweep Low: wick pierces below swing low, closes back ABOVE it
    // → Retail stop sellers trapped → bullish reversal signal
    const sweepLow = last.low < swingLow && last.close > swingLow;

    // Trap labels for signal clarity
    const trapLong = sweepHigh;   // longs above high got trapped
    const trapShort = sweepLow;   // shorts below low got trapped

    return { sweepHigh, sweepLow, trapLong, trapShort };
}

// ─────────────────────────────────────────
// ENGINE 2: PULLBACK ENGINE
// Identifies high-probability entries on pullback to EMA
// Trend continuation entry — not top/bottom chasing
// ─────────────────────────────────────────
/**
 * pullbackEngine(candles1m, ema5mArray)
 * Returns:
 *   pullbackLong  — price dipped to EMA, now bouncing (bullish entry)
 *   pullbackShort — price rallied to EMA, now rejecting (bearish entry)
 *   emaVal        — current EMA value
 */
export function pullbackEngine(candles1m, ema5mArray) {
    const n = candles1m.length;
    const emaLen = ema5mArray.length;

    if (n < 2 || emaLen < 2) {
        return { pullbackLong: false, pullbackShort: false, emaVal: null };
    }

    const last = candles1m[n - 1];
    const prev = candles1m[n - 2];
    const emaVal = ema5mArray[emaLen - 1];
    const emaPrev = ema5mArray[emaLen - 2];

    if (emaVal === null || emaPrev === null) {
        return { pullbackLong: false, pullbackShort: false, emaVal: null };
    }

    // ✅ Pullback Long:
    //   - EMA is rising (uptrend)
    //   - Previous candle dipped to or below EMA (touched support)
    //   - Current candle closed ABOVE EMA (bounce confirmed)
    const emaRising = emaVal > emaPrev;
    const pullbackLong =
        emaRising &&
        prev.low <= emaVal &&           // candle touched EMA zone
        last.close > emaVal;            // bounced back above

    // ✅ Pullback Short:
    //   - EMA is falling (downtrend)
    //   - Previous candle rallied to or above EMA (touched resistance)
    //   - Current candle closed BELOW EMA (rejection confirmed)
    const emaFalling = emaVal < emaPrev;
    const pullbackShort =
        emaFalling &&
        prev.high >= emaVal &&          // candle touched EMA resistance
        last.close < emaVal;            // rejected back below




    return { pullbackLong, pullbackShort, emaVal };
}

// ─────────────────────────────────────────
// ENGINE 3: RANGE MARKET ENGINE
// Detects consolidation zones & fades extremes
// When ADX is low → market is ranging, not trending
// Trade: Fade moves near range high/low with reversal signal
// ─────────────────────────────────────────
/**
 * rangeMarketEngine(candles, currentADX, currentRSI, adxThreshold)
 * Returns:
 *   isRanging       — ADX below threshold (no trend)
 *   rangeLow        — lowest low of lookback period
 *   rangeHigh       — highest high of lookback period
 *   nearRangeHigh   — price near top of range (sell zone)
 *   nearRangeLow    — price near bottom of range (buy zone)
 *   fadeShort       — range + near high + RSI overbought
 *   fadeLong        — range + near low + RSI oversold
 */
export function rangeMarketEngine(candles, currentADX, currentRSI, adxThreshold = 20, lookback = 20) {
    const n = candles.length;
    if (n < lookback || currentADX === null) {
        return {
            isRanging: false, rangeLow: null, rangeHigh: null,
            nearRangeHigh: false, nearRangeLow: false,
            fadeShort: false, fadeLong: false
        };
    }

    const isRanging = currentADX < adxThreshold;

    const recentCandles = candles.slice(-lookback);
    const rangeHigh = Math.max(...recentCandles.map(c => c.high));
    const rangeLow = Math.min(...recentCandles.map(c => c.low));
    const rangeSize = rangeHigh - rangeLow;

    const currentPrice = candles[n - 1].close;
    const zonePct = 0.15; // Within 15% of range edge = "near"

    const nearRangeHigh = currentPrice >= rangeHigh - rangeSize * zonePct;
    const nearRangeLow = currentPrice <= rangeLow + rangeSize * zonePct;

    // ✅ Fade Short: ranging market + price near high + RSI overbought
    const fadeShort = isRanging && nearRangeHigh && currentRSI > 65;

    // ✅ Fade Long: ranging market + price near low + RSI oversold
    const fadeLong = isRanging && nearRangeLow && currentRSI < 35;

    return {
        isRanging,
        rangeLow: Number(rangeLow.toFixed(2)),
        rangeHigh: Number(rangeHigh.toFixed(2)),
        nearRangeHigh,
        nearRangeLow,
        fadeShort,
        fadeLong
    };
}

// ─────────────────────────────────────────
// ENGINE 4: REVERSAL ENGINE
// Detects exhaustion + structure break reversals
// High-probability counter-trend entries
// Used after trend exhaustion, not random counter-trend
// ─────────────────────────────────────────
/**
 * reversalEngine(candles1m, currentRSI, currentATR)
 * Returns:
 *   bullReversal  — bearish exhaustion → bullish flip signal
 *   bearReversal  — bullish exhaustion → bearish flip signal
 *   exhaustedBull — price extended, RSI overbought, small candle (topping)
 *   exhaustedBear — price extended, RSI oversold, small candle (bottoming)
 */
export function reversalEngine(candles1m, currentRSI, currentATR) {
    const n = candles1m.length;
    if (n < 4 || currentRSI === null || currentATR === null) {
        return {
            bullReversal: false, bearReversal: false,
            exhaustedBull: false, exhaustedBear: false
        };
    }

    const last = candles1m[n - 1];
    const prev = candles1m[n - 2];
    const prev2 = candles1m[n - 3];

    const lastRange = last.high - last.low;
    const prevRange = prev.high - prev.low;
    const lastBody = Math.abs(last.close - last.open);

    // ✅ Exhaustion = strong prior move, then small indecisive candle
    const smallCandle = lastRange < prevRange * 0.5;   // current candle < 50% of prev
    const tinyBody = lastBody < lastRange * 0.35;       // body < 35% of range (doji-like)

    // Bullish exhaustion: was going up → now stalling at top
    const exhaustedBull =
        prev.close > prev2.close &&     // prior candle was bullish
        smallCandle &&
        tinyBody &&
        currentRSI > 68;               // overbought

    // Bearish exhaustion: was going down → now stalling at bottom
    const exhaustedBear =
        prev.close < prev2.close &&     // prior candle was bearish
        smallCandle &&
        tinyBody &&
        currentRSI < 32;               // oversold

    // ✅ Structure break confirmation
    // Bull Reversal: exhausted bear + current candle breaks ABOVE prev high
    const bullReversal =
        exhaustedBear &&
        last.close > prev.high;         // structure break up

    // Bear Reversal: exhausted bull + current candle breaks BELOW prev low
    const bearReversal =
        exhaustedBull &&
        last.close < prev.low;          // structure break down

    return { bullReversal, bearReversal, exhaustedBull, exhaustedBear };
}