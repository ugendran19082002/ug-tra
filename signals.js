import {
    calculateEMA,
    calculateRSI,
    calculateATR,
    calculateADX,
    findSupportResistance,
    getRoundLevels,
    cleanLevels,
    volumeSpike
} from "./indicators.js";

import { logger } from "./logger.js";

// ═══════════════════════════════════════════════════════════════
// generateSignal()
// ═══════════════════════════════════════════════════════════════
export function generateSignal(index1m, index5m, index15m, future1m, data1D) {

    // ─────────────────────────────────────────
    // BASIC DATA VALIDATION
    // ─────────────────────────────────────────
    if (
        !index1m?.length ||
        !index5m?.length ||
        !index15m?.length ||
        !future1m?.length || index5m.length < 8
    ) {
        return { signal: "NO_TRADE", reason: "insufficient timeframe data" };
    }
    if (!future1m?.length) {
        return { signal: "NO_TRADE", reason: "insufficient futures data" };
    }

    // Require minimum 5m candles for liquidity logic
    if (index5m.length < 8) {
        return { signal: "NO_TRADE", reason: "not enough 5m candles" };
    }

    const last1m = index1m[index1m.length - 1];
    const prev1m = index1m[index1m.length - 2];
    const last5m = index5m[index5m.length - 1];
    const prev5m = index5m[index5m.length - 2];
    const lastFuture = future1m[future1m.length - 1];

    if (!last1m || !prev1m || !last5m || !prev5m || !lastFuture) {
        return { signal: "NO_TRADE", reason: "invalid candle structure" };
    }

    // ─────────────────────────────────────────
    // DAILY BIAS
    // ─────────────────────────────────────────
    const dailyData = (data1D?.length >= 2) ? data1D : [];

    if (dailyData.length < 2) {
        return {
            signal: "NO_TRADE",
            reason: "insufficient daily data",
            dailyBias: "N/A",
            indexLTP: last1m.close.toFixed(2),
            futureLTP: lastFuture.close.toFixed(2)
        };
    }

    const dailyEMA = calculateEMA(dailyData);
    const dailyLast = dailyData[dailyData.length - 1];
    const prevDay = dailyData[dailyData.length - 2];

    const emaAbove = dailyLast.close > dailyEMA[dailyEMA.length - 1];
    const bullCandle = dailyLast.close > dailyLast.open;
    const bearCandle = dailyLast.close < dailyLast.open;

    const dailyBias =
        (emaAbove && bullCandle) ? "BULLISH" :
            (!emaAbove && bearCandle) ? "BEARISH" :
                "NEUTRAL";

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
    // ─────────────────────────────────────────
    const ema5m = calculateEMA(index5m);
    const trendUp = last5m.close > ema5m[ema5m.length - 1];
    const trendDown = last5m.close < ema5m[ema5m.length - 1];

    const atrArr = calculateATR(index5m, 14);
    const rawATR = atrArr[atrArr.length - 1];
    const currentATR = rawATR > 0 ? rawATR : 80;

    const dynamicSL = parseFloat(Math.min(100, currentATR).toFixed(2));
    const dynamicTGT = parseFloat(Math.max(100, currentATR * 2.5).toFixed(2));

    const adxArr = calculateADX(index5m, 14);
    const currentADX = adxArr[adxArr.length - 1];
    const trendStrong = currentADX >= 20;

    const rsiArr = calculateRSI(index5m, 14);
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
    const volConfirm = volumeSpike(future1m, future1m.length - 1);

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
    const closeNearHigh5m =
        range5m > 0 && (last5m.high - last5m.close) / range5m < 0.35;
    const closeNearLow5m =
        range5m > 0 && (last5m.close - last5m.low) / range5m < 0.35;

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

    const exhaustedBull =
        (last5m.close - recentMinLow) > currentATR * 2;

    const exhaustedBear =
        (recentMaxHigh - last5m.close) > currentATR * 2;

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
        finalResistances
    };

    // ─────────────────────────────────────────
    // ENTRY CONDITIONS
    // ─────────────────────────────────────────
    if (
        bullishRejection &&
        trendStrong &&
        trendUp
    ) {
        return { signal: "CE", reason: "liq_sweep_low", ...diag };
    }

    if (
        bearishRejection &&
        trendStrong &&
        trendDown
    ) {
        return { signal: "PE", reason: "liq_sweep_high", ...diag };
    }

    if (dailyBias === "NEUTRAL") {
        return { signal: "NO_TRADE", reason: "daily bias neutral", ...diag };
    }

    if (
        dailyBias === "BEARISH" &&
        trendStrong &&
        rsiBearish &&
        (trendDown || bigCandle) &&
        breakDown &&
        volConfirm &&
        !gapUp
    ) {
        return { signal: "PE", reason: "trend_continuation_down", ...diag };
    }

    if (
        dailyBias === "BULLISH" &&
        trendStrong &&
        rsiBullish &&
        (trendUp || bigCandle) &&
        breakUp &&
        volConfirm &&
        !gapDown
    ) {
        return { signal: "CE", reason: "trend_continuation_up", ...diag };
    }

    return { signal: "NO_TRADE", reason: "no conditions met", ...diag };
}