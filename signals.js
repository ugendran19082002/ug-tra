import { buildTimeframe } from "./helpers.js";
import {
    calculateEMA,
    calculateRSI,
    calculateATR,
    calculateADX,
    findSupportResistance,
    getRoundLevels,
    cleanLevels,
    volumeSpike,
    classifyOI,
    calculateVWAP
} from "./indicators.js";

import { logger } from "./logger.js";

// ─────────────────────────────────────────
// BASE DIAGNOSTIC OBJECT
// FIX #7 — Added `warnings: []` field for surfacing fallback conditions
// ─────────────────────────────────────────
const getBaseDiag = (indexLTP = "0.00", futureLTP = "0.00") => ({
    indexLTP,
    futureLTP,
    spread: "0.00",
    dailyBias: "N/A",
    emaAbove: false,
    bullCandle: false,
    bearCandle: false,
    gapUp: false,
    gapDown: false,
    gapLabel: "N/A",
    gapPoints: 0,
    higherHigh: false,
    higherLow: false,
    lowerHigh: false,
    lowerLow: false,
    bullishStructure: false,
    bearishStructure: false,
    currentADX: "0.0",
    currentRSI: "50.0",
    currentATR: "0.00",
    currentEMA: "0.00",
    trendStrong: false,
    rsiBullish: false,
    rsiBearish: false,
    trendUp: false,
    trendDown: false,
    dynamicSL: 0,
    dynamicTGT: 0,
    slPrice: 0,   // ✅ FIX #6 — absolute SL price level
    tgtPrice: 0,   // ✅ FIX #6 — absolute target price level
    bigCandle: false,
    strongBody: false,
    closeNearHigh: false,
    closeNearLow: false,
    breakUp: false,
    breakDown: false,
    volConfirm: false,
    equalHigh: false,
    sweepHigh: false,
    equalLow: false,
    sweepLow: false,
    bullishRejection: false,
    bearishRejection: false,
    exhaustedBull: false,
    exhaustedBear: false,
    volume: 0,
    oi: 0,
    finalSupports: [],
    finalResistances: [],
    warnings: [],   // ✅ FIX #7 — degraded signal visibility
    // ── PRO FILTERS ─────────────────────────
    vwap: null,
    aboveVWAP: false,
    belowVWAP: false,
    trendAligned: false,
    breakoutStrong: false,
    timeAllowed: false
});

export function generateSignal(index1m, index5m, index15m, future1m, data1D) {

    // ─────────────────────────────────────────
    // GUARD — Insufficient data
    // ─────────────────────────────────────────
    if (
        !index1m?.length ||
        !index5m?.length ||
        !index15m?.length ||
        !future1m?.length || index5m.length < 8
    ) {
        const ltp = index1m?.[index1m.length - 1]?.close?.toFixed(2) || "0.00";
        const fltp = future1m?.[future1m.length - 1]?.close?.toFixed(2) || "0.00";
        return {
            signal: "NO_TRADE",
            reason: "insufficient_timeframe_data",
            ...getBaseDiag(ltp, fltp)
        };
    }

    const last1m = index1m[index1m.length - 1];
    const prev1m = index1m[index1m.length - 2];
    const last5m = index5m[index5m.length - 1];
    const prev5m = index5m[index5m.length - 2];
    const lastFuture = future1m[future1m.length - 1];

    if (!last1m || !prev1m || !last5m || !prev5m || !lastFuture) {
        return {
            signal: "NO_TRADE",
            reason: "invalid_candle_structure",
            ...getBaseDiag(
                last1m?.close?.toFixed(2),
                lastFuture?.close?.toFixed(2)
            )
        };
    }

    // ─────────────────────────────────────────
    // PRO FILTER #1 — TIME FILTER (IST 9:20–14:45)
    // Avoid opening chaos + closing traps
    // ─────────────────────────────────────────
    const istStr = new Date(last1m.time).toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
    const istDate = new Date(istStr);
    const minuteOfDay = istDate.getHours() * 60 + istDate.getMinutes();
    // 9:20 = 560 mins | 14:45 = 885 mins
    const TIME_START = 558; // 9:18 IST
    const TIME_END = 900; // 15:00 IST

    // ─────────────────────────────────────────
    // INITIAL DIAGNOSTIC
    // ─────────────────────────────────────────
    const diag = getBaseDiag(last1m.close.toFixed(2), lastFuture.close.toFixed(2));
    diag.spread = (lastFuture.close - last1m.close).toFixed(2);
    diag.warnings = [];

    diag.timeAllowed = minuteOfDay >= TIME_START && minuteOfDay <= TIME_END;
    if (!diag.timeAllowed) {
        return { signal: "NO_TRADE", reason: "time_filter", ...diag };
    }

    // ─────────────────────────────────────────
    // DAILY BIAS
    // FIX #1 — Enforce minimum 20 daily candles for reliable EMA
    // ─────────────────────────────────────────
    const DAILY_EMA_PERIOD = 20;
    const dailyData = data1D?.length >= DAILY_EMA_PERIOD ? data1D : [];

    if (dailyData.length < DAILY_EMA_PERIOD) {
        diag.warnings.push("DAILY_EMA_INSUFFICIENT");
        return {
            signal: "NO_TRADE",
            reason: "insufficient_daily_ema_data",
            ...diag
        };
    }

    const dailyEMA = calculateEMA(dailyData, DAILY_EMA_PERIOD); // ✅ SMA-seeded
    const dailyLast = dailyData[dailyData.length - 1];
    const prevDay = dailyData[dailyData.length - 2];

    const lastDailyEMA = dailyEMA[dailyEMA.length - 1];

    // Guard: EMA could be null if data < period (shouldn't happen given check above)
    if (lastDailyEMA === null) {
        diag.warnings.push("DAILY_EMA_NULL");
        return {
            signal: "NO_TRADE",
            reason: "daily_ema_null",
            ...diag
        };
    }

    diag.emaAbove = dailyLast.close > lastDailyEMA;
    diag.bullCandle = dailyLast.close > dailyLast.open;
    diag.bearCandle = dailyLast.close < dailyLast.open;

    diag.dailyBias =
        (diag.emaAbove && diag.bullCandle) ? "BULLISH" :
            (!diag.emaAbove && diag.bearCandle) ? "BEARISH" :
                "NEUTRAL";

    const dailyBreakUp = dailyLast.close > prevDay.high;
    const dailyBreakDown = dailyLast.close < prevDay.low;

    if (dailyBreakUp && diag.emaAbove) diag.dailyBias = "BULLISH";
    if (dailyBreakDown && !diag.emaAbove) diag.dailyBias = "BEARISH";

    // ─────────────────────────────────────────
    // GAP ANALYSIS
    // ─────────────────────────────────────────
    const GAP_THRESHOLD = 300;
    diag.gapPoints = dailyLast.open - prevDay.close;
    diag.gapUp = diag.gapPoints > GAP_THRESHOLD;
    diag.gapDown = diag.gapPoints < -GAP_THRESHOLD;

    diag.gapLabel =
        diag.gapUp ? `🔼 Gap Up (+${diag.gapPoints.toFixed(0)} pts)` :
            diag.gapDown ? `🔽 Gap Down (${diag.gapPoints.toFixed(0)} pts)` :
                `◾ Normal Day (${diag.gapPoints.toFixed(0)} pts)`;

    // ─────────────────────────────────────────
    // FIX #9 — NEUTRAL daily bias checked EARLY (Priority 2)
    //           Prevents sweep setups evaluating on structureless days
    // ─────────────────────────────────────────
    if (diag.dailyBias === "NEUTRAL") {
        return { signal: "NO_TRADE", reason: "daily_bias_neutral", ...diag };
    }

    // ─────────────────────────────────────────
    // 15M STRUCTURE
    // ─────────────────────────────────────────
    const last3 = index15m.slice(-3);
    const hasStructure = last3.length === 3;

    diag.higherHigh = hasStructure && last3[2].high > last3[1].high;
    diag.higherLow = hasStructure && last3[2].low > last3[1].low;
    diag.lowerHigh = hasStructure && last3[2].high < last3[1].high;
    diag.lowerLow = hasStructure && last3[2].low < last3[1].low;

    diag.bullishStructure = diag.higherHigh && diag.higherLow;
    diag.bearishStructure = diag.lowerHigh && diag.lowerLow;


    // ─────────────────────────────────────────
    // PRO FILTER #2 — VWAP (Institutional Bias)
    // CE → price > VWAP | PE → price < VWAP
    // ─────────────────────────────────────────
    const vwapArr = calculateVWAP(future1m);
    const currentVWAP = vwapArr[vwapArr.length - 1];
    diag.vwap = currentVWAP !== null ? parseFloat(currentVWAP.toFixed(2)) : null;
    diag.aboveVWAP = currentVWAP !== null && lastFuture.close > currentVWAP;
    diag.belowVWAP = currentVWAP !== null && lastFuture.close < currentVWAP;

    // ─────────────────────────────────────────
    // 5M TREND + INDICATORS
    // FIX #3, #4, #5 — Pass shared warnings[] into all indicator functions
    // ─────────────────────────────────────────
    const ema5m = calculateEMA(index5m);
    diag.currentEMA = ema5m[ema5m.length - 1]?.toFixed(2) || "0.00";
    diag.trendUp = last5m.close > (ema5m[ema5m.length - 1] ?? -Infinity);
    diag.trendDown = last5m.close < (ema5m[ema5m.length - 1] ?? Infinity);

    const atrArr = calculateATR(index5m, 14, diag.warnings);
    const rawATR = atrArr[atrArr.length - 1];

    // ✅ FIX #3 — No hardcoded fallback; return NO_TRADE if ATR unavailable
    if (rawATR === null) {
        return {
            signal: "NO_TRADE",
            reason: "atr_unavailable",
            ...diag
        };
    }

    diag.currentATR = rawATR.toFixed(2);
    const currentATR = rawATR;

    diag.dynamicSL = parseFloat(Math.min(90, currentATR * 0.85).toFixed(2));
    diag.dynamicTGT = parseFloat(Math.min(300, currentATR * 2.5).toFixed(2));

    const adxArr = calculateADX(index5m, 14, diag.warnings);
    const rawADX = adxArr[adxArr.length - 1];

    // ✅ FIX #5 — null ADX means insufficient data → NO_TRADE
    if (rawADX === null) {
        return {
            signal: "NO_TRADE",
            reason: "insufficient_adx_data",
            ...diag
        };
    }

    diag.currentADX = rawADX.toFixed(1);
    const currentADX = rawADX;
    diag.trendStrong = currentADX >= 20;

    const rsiArr = calculateRSI(index5m, 14, diag.warnings);  // ✅ FIX #4
    const currentRSI = rsiArr[rsiArr.length - 1];
    diag.currentRSI = currentRSI.toFixed(1);
    diag.rsiBullish = currentRSI > 55;
    diag.rsiBearish = currentRSI < 45;

    // ─────────────────────────────────────────
    // PRO FILTER #3 — ATR DEAD MARKET GUARD
    // Skip trades when volatility is too low
    // ─────────────────────────────────────────
    const ATR_MIN_THRESHOLD = 40;
    if (currentATR < ATR_MIN_THRESHOLD) {
        return { signal: "NO_TRADE", reason: "low_volatility_atr", ...diag };
    }

    // ─────────────────────────────────────────
    // 1M BREAK STRUCTURE
    // ─────────────────────────────────────────
    const last5 = index1m.slice(-2, -1);
    const max5High = Math.max(...last5.map(c => c.high));
    const min5Low = Math.min(...last5.map(c => c.low));

    diag.breakUp = last1m.close > max5High;
    diag.breakDown = last1m.close < min5Low;

    // ─────────────────────────────────────────
    // VOLUME + CANDLE
    // ─────────────────────────────────────────
    diag.volConfirm = volumeSpike(future1m, future1m.length - 1); // ✅ 1.5× threshold

    const body = Math.abs(last1m.close - last1m.open);
    const range = last1m.high - last1m.low;

    diag.strongBody = range > 0 && (body / range) > 0.6;
    diag.bigCandle =
        prev1m &&
        (range > (prev1m.high - prev1m.low) * 1.5) &&
        diag.strongBody;

    diag.closeNearHigh = range > 0 && (last1m.high - last1m.close) / range < 0.2;
    diag.closeNearLow = range > 0 && (last1m.close - last1m.low) / range < 0.2;

    // ─────────────────────────────────────────
    // LIQUIDITY SWEEP
    // ─────────────────────────────────────────
    let LIQ_THRESHOLD;

    if (currentADX > 30) {
        LIQ_THRESHOLD = currentATR * 0.25;
    } else if (currentADX > 20) {
        LIQ_THRESHOLD = currentATR * 0.2;
    } else {
        LIQ_THRESHOLD = Math.max(currentATR * 0.15, 18);
    }

    LIQ_THRESHOLD = Math.min(LIQ_THRESHOLD, 150); // cap

    const recent = index5m.slice(-6, -2);
    const recentHighs = recent.map(c => c.high);
    const recentLows = recent.map(c => c.low);

    const recentMaxHigh = Math.max(...recentHighs);
    const recentMinLow = Math.min(...recentLows);

    diag.equalHigh =
        recentHighs.filter(h => h >= recentMaxHigh - LIQ_THRESHOLD).length >= 2;

    diag.equalLow =
        recentLows.filter(l => l <= recentMinLow + LIQ_THRESHOLD).length >= 2;

    diag.sweepLow =
        diag.equalLow &&
        prev5m.low < recentMinLow &&
        prev5m.close > recentMinLow;

    diag.sweepHigh =
        diag.equalHigh &&
        prev5m.high > recentMaxHigh &&
        prev5m.close < recentMaxHigh;

    const body5m = Math.abs(last5m.close - last5m.open);
    const range5m = last5m.high - last5m.low;

    const strongBody5m = range5m > 0 && (body5m / range5m) > 0.45;
    const closeNearHigh5m = range5m > 0 && (last5m.high - last5m.close) / range5m < 0.35;
    const closeNearLow5m = range5m > 0 && (last5m.close - last5m.low) / range5m < 0.35;

    diag.bullishRejection =
        diag.sweepLow &&
        last5m.close > last5m.open &&
        closeNearHigh5m &&
        strongBody5m &&
        diag.volConfirm;

    diag.bearishRejection =
        diag.sweepHigh &&
        last5m.close < last5m.open &&
        closeNearLow5m &&
        strongBody5m &&
        diag.volConfirm;

    // ─────────────────────────────────────────
    // FIX #6 — Compute absolute SL and Target price levels per side
    // ─────────────────────────────────────────
    const entryPrice = last1m.close;
    const ceSLPrice = parseFloat((entryPrice - diag.dynamicSL).toFixed(2));
    const ceTGTPrice = parseFloat((entryPrice + diag.dynamicTGT).toFixed(2));
    const peSLPrice = parseFloat((entryPrice + diag.dynamicSL).toFixed(2));
    const peTGTPrice = parseFloat((entryPrice - diag.dynamicTGT).toFixed(2));

    // ─────────────────────────────────────────
    // FUTURE 5M + OI
    // ─────────────────────────────────────────
    const future5m = buildTimeframe(future1m, 5);
    const lastFuture5m = (future5m && future5m.length > 0) ? future5m[future5m.length - 1] : { volume: 0, oi: 0 };
    const prevFuture5m = (future5m && future5m.length > 1) ? future5m[future5m.length - 2] : null;

    if (!future5m || future5m.length < 2) {
        diag.warnings.push("OI_INSUFFICIENT");
        return {
            signal: "NO_TRADE",
            reason: "insufficient_oi_data",
            ...diag
        };
    }

    diag.volume = lastFuture5m.volume;
    diag.oi = lastFuture5m.oi;


    // ─────────────────────────────────────────
    // ENTRY CONDITIONS (PRIORITY STRUCTURE)
    // ─────────────────────────────────────────

    // ── Priority 1: CHOP FILTER ──────────────
    // ADX < 18 AND RSI near midline → dead/ranging market
    if (currentADX < 18 && currentRSI > 45 && currentRSI < 55) {
        return { signal: "NO_TRADE", reason: "choppy_market", ...diag };
    }

    // ── PRO FILTER #4 — MULTI-TF ALIGNMENT ──
    // 5m trend direction + 15m structure must align with daily bias
    // Without this → false breakouts on wrong side
    diag.trendAligned =
        (diag.dailyBias === "BULLISH" && diag.trendUp && diag.bullishStructure) ||
        (diag.dailyBias === "BEARISH" && diag.trendDown && diag.bearishStructure);

    if (!diag.trendAligned) {
        return { signal: "NO_TRADE", reason: "multi_tf_misaligned", ...diag };
    }

    // ── PRO FILTER #5 — BREAKOUT STRENGTH ───
    // Real breakout must have big candle + strong body + volume
    diag.breakoutStrong =
        diag.bigCandle &&
        diag.strongBody &&
        diag.volConfirm;

    // ── Priority 3: TREND CONTINUATION ──────
    // FIX #8 — Gap guard extended: if gap fills intraday, allow trend
    const gapDownFilled = diag.gapDown && last5m.close < prevDay.close;
    const gapUpFilled = diag.gapUp && last5m.close > prevDay.close;

    const bearishTrendSetup =
        diag.dailyBias === "BEARISH" &&
        diag.trendStrong &&
        diag.rsiBearish &&
        (diag.trendDown || diag.bigCandle) &&
        !(diag.gapDown && !diag.breakDown && !gapDownFilled) && // ✅ FIX #8
        diag.volConfirm &&
        diag.belowVWAP   // ✅ PRO — institutional bias confirmation


    const bullishTrendSetup =
        diag.dailyBias === "BULLISH" &&
        diag.trendStrong &&
        diag.rsiBullish &&
        (diag.trendUp || diag.bigCandle) &&
        !(diag.gapUp && !diag.breakUp && !gapUpFilled) &&       // ✅ FIX #8
        diag.volConfirm &&
        diag.aboveVWAP   // ✅ PRO — institutional bias confirmation


    if (bearishTrendSetup) {

        console.log("BEARISH", diag.breakDown);

        return {
            signal: "PE",
            reason: "trend_continuation_down",
            slPrice: peSLPrice,   // ✅ FIX #6
            tgtPrice: peTGTPrice,  // ✅ FIX #6
            ...diag
        };
    }

    if (bullishTrendSetup) {
        console.log("BULLISH", diag.breakUp);
        return {
            signal: "CE",
            reason: "trend_continuation_up",
            slPrice: ceSLPrice,   // ✅ FIX #6
            tgtPrice: ceTGTPrice,  // ✅ FIX #6
            ...diag
        };
    }

    // ── Priority 4: DEFAULT ──────────────────
    return { signal: "NO_TRADE", reason: "no_conditions_met", ...diag };
}