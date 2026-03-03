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
    classifyOI
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
    higherHigh: false,
    higherLow: false,
    lowerHigh: false,
    lowerLow: false,
    bullishStructure: false,
    bearishStructure: false,
    currentADX: "0.0",
    currentRSI: "50.0",
    currentATR: "0.00",
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
    finalSupports: [],
    finalResistances: [],
    warnings: []   // ✅ FIX #7 — degraded signal visibility
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
    // FIX #7 — Shared warnings array passed into indicator functions
    // ─────────────────────────────────────────
    const warnings = [];

    // ─────────────────────────────────────────
    // DAILY BIAS
    // FIX #1 — Enforce minimum 20 daily candles for reliable EMA
    // ─────────────────────────────────────────
    const DAILY_EMA_PERIOD = 20;
    const dailyData = data1D?.length >= DAILY_EMA_PERIOD ? data1D : [];

    if (dailyData.length < DAILY_EMA_PERIOD) {
        const d = getBaseDiag(last1m.close.toFixed(2), lastFuture.close.toFixed(2));
        return {
            signal: "NO_TRADE",
            reason: "insufficient_daily_ema_data",
            ...d,
            spread: (lastFuture.close - last1m.close).toFixed(2),
            warnings: ["DAILY_EMA_INSUFFICIENT"]
        };
    }

    const dailyEMA = calculateEMA(dailyData, DAILY_EMA_PERIOD); // ✅ SMA-seeded
    const dailyLast = dailyData[dailyData.length - 1];
    const prevDay = dailyData[dailyData.length - 2];

    const lastDailyEMA = dailyEMA[dailyEMA.length - 1];

    // Guard: EMA could be null if data < period (shouldn't happen given check above)
    if (lastDailyEMA === null) {
        return {
            signal: "NO_TRADE",
            reason: "daily_ema_null",
            warnings: ["DAILY_EMA_NULL"],
            ...getBaseDiag(last1m.close.toFixed(2), lastFuture.close.toFixed(2))
        };
    }

    const emaAbove = dailyLast.close > lastDailyEMA;
    const bullCandle = dailyLast.close > dailyLast.open;
    const bearCandle = dailyLast.close < dailyLast.open;

    let dailyBias =
        (emaAbove && bullCandle) ? "BULLISH" :
            (!emaAbove && bearCandle) ? "BEARISH" :
                "NEUTRAL";

    const dailyBreakUp = dailyLast.close > prevDay.high;
    const dailyBreakDown = dailyLast.close < prevDay.low;

    if (dailyBreakUp && emaAbove) dailyBias = "BULLISH";
    if (dailyBreakDown && !emaAbove) dailyBias = "BEARISH";

    // ─────────────────────────────────────────
    // GAP ANALYSIS
    // ─────────────────────────────────────────
    const GAP_THRESHOLD = 300;
    const gapPoints = dailyLast.open - prevDay.close;
    const gapUp = gapPoints > GAP_THRESHOLD;
    const gapDown = gapPoints < -GAP_THRESHOLD;

    const gapLabel =
        gapUp ? `🔼 Gap Up (+${gapPoints.toFixed(0)} pts)` :
            gapDown ? `🔽 Gap Down (${gapPoints.toFixed(0)} pts)` :
                `◾ Normal Day (${gapPoints.toFixed(0)} pts)`;

    // ─────────────────────────────────────────
    // FIX #9 — NEUTRAL daily bias checked EARLY (Priority 2)
    //           Prevents sweep setups evaluating on structureless days
    // ─────────────────────────────────────────
    if (dailyBias === "NEUTRAL") {
        // Build minimal diag for early return
        const earlyDiag = {
            ...getBaseDiag(last1m.close.toFixed(2), lastFuture.close.toFixed(2)),
            spread: (lastFuture.close - last1m.close).toFixed(2),
            dailyBias,
            emaAbove,
            bullCandle,
            bearCandle,
            gapUp,
            gapDown,
            gapLabel,
            warnings
        };
        return { signal: "NO_TRADE", reason: "daily_bias_neutral", ...earlyDiag };
    }

    // ─────────────────────────────────────────
    // 15M STRUCTURE
    // ─────────────────────────────────────────
    const last3 = index15m.slice(-3);
    const hasStructure = last3.length === 3;

    const higherHigh = hasStructure && last3[2].high > last3[1].high;
    const higherLow = hasStructure && last3[2].low > last3[1].low;
    const lowerHigh = hasStructure && last3[2].high < last3[1].high;
    const lowerLow = hasStructure && last3[2].low < last3[1].low;

    const bullishStructure = higherHigh && higherLow;
    const bearishStructure = lowerHigh && lowerLow;

    // ─────────────────────────────────────────
    // SUPPORT / RESISTANCE
    // ─────────────────────────────────────────
    const { supports, resistances } = findSupportResistance(index15m);
    const currentPrice = last5m.close;
    const roundLevels = getRoundLevels(currentPrice);

    const finalSupports = cleanLevels([
        ...supports,
        prevDay.low,
        ...roundLevels.filter(r => r < currentPrice)
    ]);

    const finalResistances = cleanLevels([
        ...resistances,
        prevDay.high,
        ...roundLevels.filter(r => r > currentPrice)
    ]);

    // ─────────────────────────────────────────
    // 5M TREND + INDICATORS
    // FIX #3, #4, #5 — Pass shared warnings[] into all indicator functions
    // ─────────────────────────────────────────
    const ema5m = calculateEMA(index5m);
    const trendUp = last5m.close > (ema5m[ema5m.length - 1] ?? -Infinity);
    const trendDown = last5m.close < (ema5m[ema5m.length - 1] ?? Infinity);

    const atrArr = calculateATR(index5m, 14, warnings);
    const rawATR = atrArr[atrArr.length - 1];

    // ✅ FIX #3 — No hardcoded fallback; return NO_TRADE if ATR unavailable
    if (rawATR === null) {
        return {
            signal: "NO_TRADE",
            reason: "atr_unavailable",
            warnings: [...warnings],
            ...getBaseDiag(last1m.close.toFixed(2), lastFuture.close.toFixed(2))
        };
    }

    const currentATR = rawATR;
    const dynamicSL = parseFloat(Math.max(20, currentATR * 0.85).toFixed(2));
    const dynamicTGT = parseFloat(Math.max(100, currentATR * 2.99).toFixed(2));

    const adxArr = calculateADX(index5m, 14, warnings);
    const rawADX = adxArr[adxArr.length - 1];

    // ✅ FIX #5 — null ADX means insufficient data → NO_TRADE
    if (rawADX === null) {
        return {
            signal: "NO_TRADE",
            reason: "insufficient_adx_data",
            warnings: [...warnings],
            ...getBaseDiag(last1m.close.toFixed(2), lastFuture.close.toFixed(2))
        };
    }

    const currentADX = rawADX;
    const trendStrong = currentADX >= 20;

    const rsiArr = calculateRSI(index5m, 14, warnings);  // ✅ FIX #4
    const currentRSI = rsiArr[rsiArr.length - 1];
    const rsiBullish = currentRSI > 55;
    const rsiBearish = currentRSI < 45;

    // ─────────────────────────────────────────
    // 1M BREAK STRUCTURE
    // ─────────────────────────────────────────
    const last5 = index1m.slice(-6, -1);
    const max5High = Math.max(...last5.map(c => c.high));
    const min5Low = Math.min(...last5.map(c => c.low));

    const breakUp = last1m.close > max5High;
    const breakDown = last1m.close < min5Low;

    // ─────────────────────────────────────────
    // VOLUME + CANDLE
    // ─────────────────────────────────────────
    const volConfirm = volumeSpike(future1m, future1m.length - 1); // ✅ 1.5× threshold

    const body = Math.abs(last1m.close - last1m.open);
    const range = last1m.high - last1m.low;

    const strongBody = range > 0 && (body / range) > 0.6;
    const bigCandle =
        prev1m &&
        (range > (prev1m.high - prev1m.low) * 1.5) &&
        strongBody;

    const closeNearHigh = range > 0 && (last1m.high - last1m.close) / range < 0.2;
    const closeNearLow = range > 0 && (last1m.close - last1m.low) / range < 0.2;

    const spread = lastFuture.close - last1m.close;

    // ─────────────────────────────────────────
    // LIQUIDITY SWEEP
    // ─────────────────────────────────────────
    const LIQ_THRESHOLD = Math.max(currentATR * 0.2, 15);

    const recent = index5m.slice(-6, -2);
    const recentHighs = recent.map(c => c.high);
    const recentLows = recent.map(c => c.low);

    const recentMaxHigh = Math.max(...recentHighs);
    const recentMinLow = Math.min(...recentLows);

    const equalHigh =
        recentHighs.filter(h => h >= recentMaxHigh - LIQ_THRESHOLD).length >= 2;

    const equalLow =
        recentLows.filter(l => l <= recentMinLow + LIQ_THRESHOLD).length >= 2;

    const sweepLow =
        equalLow &&
        prev5m.low < recentMinLow &&
        prev5m.close > recentMinLow;

    const sweepHigh =
        equalHigh &&
        prev5m.high > recentMaxHigh &&
        prev5m.close < recentMaxHigh;

    const body5m = Math.abs(last5m.close - last5m.open);
    const range5m = last5m.high - last5m.low;

    const strongBody5m = range5m > 0 && (body5m / range5m) > 0.45;
    const closeNearHigh5m = range5m > 0 && (last5m.high - last5m.close) / range5m < 0.35;
    const closeNearLow5m = range5m > 0 && (last5m.close - last5m.low) / range5m < 0.35;

    const bullishRejection =
        sweepLow &&
        last5m.close > last5m.open &&
        closeNearHigh5m &&
        strongBody5m &&
        volConfirm;

    const bearishRejection =
        sweepHigh &&
        last5m.close < last5m.open &&
        closeNearLow5m &&
        strongBody5m &&
        volConfirm;

    const exhaustedBull = (last5m.close - recentMinLow) > currentATR * 2;
    const exhaustedBear = (recentMaxHigh - last5m.close) > currentATR * 2;

    // ─────────────────────────────────────────
    // FIX #6 — Compute absolute SL and Target price levels per side
    //          CE = buy call → SL below entry, TGT above entry
    //          PE = buy put  → SL above entry, TGT below entry
    // ─────────────────────────────────────────
    const entryPrice = last1m.close;
    const ceSLPrice = parseFloat((entryPrice - dynamicSL).toFixed(2));
    const ceTGTPrice = parseFloat((entryPrice + dynamicTGT).toFixed(2));
    const peSLPrice = parseFloat((entryPrice + dynamicSL).toFixed(2));
    const peTGTPrice = parseFloat((entryPrice - dynamicTGT).toFixed(2));

    // ─────────────────────────────────────────
    // DIAGNOSTICS
    // ─────────────────────────────────────────
    const diag = {
        indexLTP: last1m.close.toFixed(2),
        futureLTP: lastFuture.close.toFixed(2),
        spread: spread.toFixed(2),
        dailyBias,
        emaAbove,
        bullCandle,
        bearCandle,
        gapUp,
        gapDown,
        gapLabel,
        higherHigh,
        higherLow,
        lowerHigh,
        lowerLow,
        bullishStructure,
        bearishStructure,
        currentADX: currentADX?.toFixed(1),
        currentRSI: currentRSI?.toFixed(1),
        currentATR: currentATR?.toFixed(2),
        currentEMA: ema5m[ema5m.length - 1]?.toFixed(2),
        trendStrong,
        rsiBullish,
        rsiBearish,
        trendUp,
        trendDown,
        dynamicSL,
        dynamicTGT,
        bigCandle,
        strongBody,
        closeNearHigh,
        closeNearLow,
        breakUp,
        breakDown,
        volConfirm,
        equalHigh,
        sweepHigh,
        equalLow,
        sweepLow,
        bullishRejection,
        bearishRejection,
        exhaustedBull,
        exhaustedBear,
        finalSupports,
        finalResistances,
        warnings          // ✅ FIX #7 — exposes RSI_FALLBACK, ATR_FALLBACK etc.
    };

    // ─────────────────────────────────────────
    // FUTURE 5M + OI
    // ─────────────────────────────────────────
    const future5m = buildTimeframe(future1m, 5);

    if (!future5m || future5m.length < 2) {
        return { signal: "NO_TRADE", reason: "insufficient_oi_data", ...diag };
    }

    const lastFuture5m = future5m[future5m.length - 1];
    const prevFuture5m = future5m[future5m.length - 2];

    const oiData = classifyOI(lastFuture5m, prevFuture5m);
    const { callOi, putOi } = oiData;

    // ─────────────────────────────────────────
    // ENTRY CONDITIONS (PRIORITY STRUCTURE)
    // ─────────────────────────────────────────

    // ── Priority 1: CHOP FILTER ──────────────
    if (currentADX < 18 && currentRSI > 45 && currentRSI < 55) {
        return { signal: "NO_TRADE", reason: "choppy_market", ...diag };
    }

    // ── Priority 2: LIQUIDITY SWEEP REVERSALS ──
    const bullishLiqSetup =
        dailyBias !== "BEARISH" &&
        bullishRejection &&
        trendStrong &&
        trendUp &&
        !exhaustedBull;

    const bearishLiqSetup =
        dailyBias !== "BULLISH" &&
        bearishRejection &&
        trendStrong &&
        trendDown &&
        !exhaustedBear;

    if (bullishLiqSetup) {
        return {
            signal: "CE",
            reason: "liq_sweep_low",
            slPrice: ceSLPrice,   // ✅ FIX #6
            tgtPrice: ceTGTPrice,  // ✅ FIX #6
            ...diag
        };
    }

    if (bearishLiqSetup) {
        return {
            signal: "PE",
            reason: "liq_sweep_high",
            slPrice: peSLPrice,   // ✅ FIX #6
            tgtPrice: peTGTPrice,  // ✅ FIX #6
            ...diag
        };
    }

    // ── Priority 3: TREND CONTINUATION ──────
    // FIX #8 — Gap guard extended: if gap fills intraday, allow trend
    const gapDownFilled = gapDown && last5m.close < prevDay.close;
    const gapUpFilled = gapUp && last5m.close > prevDay.close;

    const bearishTrendSetup =
        dailyBias === "BEARISH" &&
        trendStrong &&
        rsiBearish &&
        (trendDown || bigCandle) &&
        !(gapDown && !breakDown && !gapDownFilled) && // ✅ FIX #8
        volConfirm &&
        putOi &&
        !exhaustedBear;

    const bullishTrendSetup =
        dailyBias === "BULLISH" &&
        trendStrong &&
        rsiBullish &&
        (trendUp || bigCandle) &&
        !(gapUp && !breakUp && !gapUpFilled) &&       // ✅ FIX #8
        volConfirm &&
        callOi &&
        !exhaustedBull;

    if (bearishTrendSetup) {
        return {
            signal: "PE",
            reason: "trend_continuation_down",
            slPrice: peSLPrice,   // ✅ FIX #6
            tgtPrice: peTGTPrice,  // ✅ FIX #6
            ...diag
        };
    }

    if (bullishTrendSetup) {
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