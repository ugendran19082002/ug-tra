import dotenv from "dotenv";
dotenv.config();

import { createRequire } from "module";
const require = createRequire(import.meta.url);

let CFG;
try {
    CFG = require("./strategy.config.json");
} catch (e) {
    CFG = require("./strategy.config.default.json");
}

import { buildTimeframe } from "./helpers.js";
import {
    calculateEMA,
    calculateRSI,
    calculateATR,
    calculateADX,
    volumeSpike,
    calculateVWAP,
    liquiditySweepEngine,
    pullbackEngine,
    rangeMarketEngine,
    reversalEngine
} from "./indicators.js";

import { btLogger } from "./logger.js";

// ═══════════════════════════════════════════════════════════════
// ██  BASE DIAGNOSTIC OBJECT
// ═══════════════════════════════════════════════════════════════
const getBaseDiag = (indexLTP = "0.00", futureLTP = "0.00") => ({
    indexLTP, futureLTP,
    dailyBias: "N/A",
    emaAbove: false, bullCandle: false, bearCandle: false,
    gapUp: false, gapDown: false, gapLabel: "N/A",
    gapPoints: 0, gapPercent: 0,
    higherHigh: false, higherLow: false,
    lowerHigh: false, lowerLow: false,
    bullishStructure: false, bearishStructure: false,
    currentADX: "0.0", currentRSI: "50.0",
    currentATR: "0.00", currentEMA: "0.00",
    trendStrong: false,
    rsiBullish: false, rsiBearish: false,
    trendUp: false, trendDown: false,
    dynamicSL: 0, dynamicTGT: 0,
    slPrice: 0, tgtPrice: 0,
    trailingSlPrice: 0, partialExitPrice: 0,
    bigCandle: false, strongBody: false,
    breakUp: false, breakDown: false,
    confirmBreakUp: false, confirmBreakDown: false,
    volConfirm: false,
    exhaustedBull: false, exhaustedBear: false,
    volume: 0, oi: 0,
    finalSupports: [], finalResistances: [],
    warnings: [],
    vwap: null, vwapUp: false, vwapDown: false,
    aboveVWAP: false, belowVWAP: false,
    trendAligned: false, breakoutStrong: false, timeAllowed: false,
    sweepHigh: false, sweepLow: false, trapLong: false, trapShort: false,
    pullbackLong: false, pullbackShort: false,
    isRanging: false, rangeHigh: null, rangeLow: null,
    fadeShort: false, fadeLong: false,
    bullReversal: false, bearReversal: false,
    regime: "UNKNOWN", subRegime: "UNKNOWN", timeZone: "UNKNOWN",
    signalScore: 0, signalGrade: "C", signalEngine: "NONE",
});

// ═══════════════════════════════════════════════════════════════
// ██  LAYER 1: REGIME DETECTOR
// ═══════════════════════════════════════════════════════════════
function detectMarketRegime(adx, atr, atrPrev, candles5m, minuteOfDay) {
    const timeZone =
        minuteOfDay < 630 ? "MORNING" :
            minuteOfDay < 810 ? "MIDDAY" :
                "AFTERNOON";

    const atrSpike = atrPrev !== null && atr !== null && atr > atrPrev * 1.5;

    let recentBreakout = false;
    if (candles5m?.length >= 10) {
        const n = candles5m.length;
        const lb = candles5m.slice(-10, -1);
        const hi = Math.max(...lb.map(c => c.high));
        const lo = Math.min(...lb.map(c => c.low));
        const last = candles5m[n - 1];
        recentBreakout = last.close > hi || last.close < lo;
    }

    let regime, subRegime;
    if (atrSpike && recentBreakout) {
        regime = "VOLATILE"; subRegime = "ATR_BREAKOUT";
    } else if (adx !== null && adx > 25 && !recentBreakout) {
        regime = "TRENDING";
        subRegime = adx > 35 ? "STRONG_TREND" : (adx > 28 ? "MODERATE_TREND" : "WEAK_TREND");
    } else if (recentBreakout && adx !== null && adx >= 18) {
        regime = "BREAKOUT"; subRegime = timeZone === "MORNING" ? "EARLY_BREAKOUT" : "MID_BREAKOUT";
    } else if (adx !== null && adx < 18) {
        regime = "RANGING"; subRegime = "SIDEWAYS";
    } else {
        regime = timeZone === "AFTERNOON" ? "REVERSAL" : "TRENDING";
        subRegime = "WEAK_TREND";
    }

    if (timeZone === "AFTERNOON" && regime === "RANGING") {
        regime = "REVERSAL"; subRegime = "EOD_REVERSAL";
    }

    const ENGINE_ORDER = {
        TRENDING: ["TREND", "BREAKOUT", "PULLBACK", "SWEEP"],
        BREAKOUT: ["BREAKOUT", "TREND", "PULLBACK"],
        RANGING: ["RANGE"],
        VOLATILE: ["BREAKOUT", "TREND", "SWEEP"],
        REVERSAL: ["REVERSAL", "TREND", "SWEEP", "PULLBACK"]
    };

    return {
        regime, subRegime, timeZone, atrSpike, recentBreakout,
        engineOrder: ENGINE_ORDER[regime] || ["TREND"],
    };
}

// ═══════════════════════════════════════════════════════════════
// ██  LAYER 2: SIGNAL SCORING  (max 10 pts)
//
// VWAP slope bonus = 1 extra pt when slope aligns with trade
// ADX 22+ = score 1 (was 22-29), now properly tiered
// ═══════════════════════════════════════════════════════════════
function scoreSignal(diag, direction, engineName) {
    const isBull = direction === "BULL";
    let score = 0;
    const breakdown = {};

    // EMA alignment (2 pts)
    breakdown.ema = isBull ? (diag.trendUp ? 2 : 0) : (diag.trendDown ? 2 : 0);
    score += breakdown.ema;

    // ADX strength (2 pts) — ADX_MIN check via score, not just hard gate
    const adx = parseFloat(diag.currentADX);
    breakdown.adx = adx >= 30 ? 2 : adx >= 22 ? 1 : 0;
    score += breakdown.adx;

    // RSI momentum (1 pt)
    breakdown.rsi = isBull ? (diag.rsiBullish ? 1 : 0) : (diag.rsiBearish ? 1 : 0);
    score += breakdown.rsi;

    // Volume (1 pt)
    breakdown.vol = diag.volConfirm ? 1 : 0;
    score += breakdown.vol;

    // VWAP side (1 pt)
    breakdown.vwap = isBull ? (diag.aboveVWAP ? 1 : 0) : (diag.belowVWAP ? 1 : 0);
    score += breakdown.vwap;

    // 15m structure (1 pt)
    breakdown.struct = isBull ? (diag.bullishStructure ? 1 : 0) : (diag.bearishStructure ? 1 : 0);
    score += breakdown.struct;

    // Quality bonus — engine-specific (1 pt)
    breakdown.quality = isBull
        ? (diag.pullbackLong || diag.trapShort || diag.bullReversal ? 1 : 0)
        : (diag.pullbackShort || diag.trapLong || diag.bearReversal ? 1 : 0);
    score += breakdown.quality;

    // Daily bias (1 pt)
    breakdown.bias = isBull
        ? (diag.dailyBias === "BULLISH" ? 1 : 0)
        : (diag.dailyBias === "BEARISH" ? 1 : 0);
    score += breakdown.bias;

    // Per-engine thresholds (tuned from backtest)
    const THRESHOLDS = {
        TREND: 5,
        PULLBACK: 5,
        BREAKOUT: 5,
        SWEEP: 4,   // all score<6 sweeps were losses in backtest
        RANGE: 4,
        REVERSAL: 5,
    };

    const threshold = THRESHOLDS[engineName] ?? 5;
    return {
        score, breakdown,
        qualified: score >= threshold,
        threshold,
        grade: score >= 8 ? "A+" : score >= 6 ? "A" : score >= 4 ? "B" : "C",
    };
}

// ═══════════════════════════════════════════════════════════════
// ██  LAYER 3: RISK ENGINE
// ═══════════════════════════════════════════════════════════════
function computeRiskLevels(entryPrice, direction, rawATR, regime, adx) {
    const isBull = direction === "CE";

    const atrTgtMult =
        rawATR > 150 ? CFG.ATR_TGT_MULTIPLIER * 1.4 :
            rawATR > 80 ? CFG.ATR_TGT_MULTIPLIER * 1.2 :
                CFG.ATR_TGT_MULTIPLIER;



    const slFactor = (regime === "RANGING" || regime === "REVERSAL") ? 0.7 : 1.0;
    const tgtFactor = (regime === "RANGING" || regime === "REVERSAL") ? 0.8 : 1.0;
    const trendSlFactor = (adx !== null && adx > 40) ? 1.15 : 1.0;

    const finalSL = parseFloat((Math.min(CFG.ATR_SL_CAP, rawATR * CFG.ATR_SL_MULTIPLIER * slFactor * trendSlFactor)).toFixed(2));
    const finalTGT = parseFloat((Math.min(CFG.ATR_TGT_CAP, rawATR * atrTgtMult) * tgtFactor).toFixed(2));

    const slPrice = isBull ? parseFloat((entryPrice - finalSL).toFixed(2)) : parseFloat((entryPrice + finalSL).toFixed(2));
    const tgtPrice = isBull ? parseFloat((entryPrice + finalTGT).toFixed(2)) : parseFloat((entryPrice - finalTGT).toFixed(2));
    const partialExitPrice = isBull ? parseFloat((entryPrice + finalTGT * 0.5).toFixed(2)) : parseFloat((entryPrice - finalTGT * 0.5).toFixed(2));
    const trailingSlPrice = isBull ? parseFloat((entryPrice + finalTGT * 0.3).toFixed(2)) : parseFloat((entryPrice - finalTGT * 0.3).toFixed(2));

    return { dynamicSL: finalSL, dynamicTGT: finalTGT, slPrice, tgtPrice, partialExitPrice, trailingSlPrice };
}

// ═══════════════════════════════════════════════════════════════
// ██  LAYER 5: ENGINE EVALUATORS
// ═══════════════════════════════════════════════════════════════

// ─────────────────────────────────────────
// TREND ENGINE — trendAligned + VWAP side required
// 15m structure & VWAP slope contribute to SCORE (not hard gate)
// Reason: ADX 23-25 range has both wins and losses at same level
// ─────────────────────────────────────────
function runTrendEngine(diag, gapDownFilled, gapUpFilled) {
    if (
        diag.dailyBias === "BULLISH" && diag.trendAligned &&
        diag.trendStrong && diag.rsiBullish &&
        (diag.trendUp || diag.breakoutStrong) &&
        !(diag.gapUp && !diag.breakUp && !gapUpFilled) &&
        diag.volConfirm && diag.aboveVWAP
    ) return { signal: "CE", reason: "trend_continuation_up" };

    if (
        diag.dailyBias === "BEARISH" && diag.trendAligned &&
        diag.trendStrong && diag.rsiBearish &&
        (diag.trendDown || diag.breakoutStrong) &&
        !(diag.gapDown && !diag.breakDown && !gapDownFilled) &&
        diag.volConfirm && diag.belowVWAP
    ) return { signal: "PE", reason: "trend_continuation_down" };

    return null;
}

// ─────────────────────────────────────────
// BREAKOUT ENGINE
//
// ✅ FILTER 1 (Entry Delay) applied HERE only
// Uses confirmBreakUp/Down — 2-candle confirmation
// Reason: BREAKOUT engine fires on structure breaks
//         False breakouts cause 1-bar SL hits (trades 34,35,49)
//         Confirmation candle required: close beyond break level
//
// NOT applied to TREND engine:
//   TREND uses EMA/VWAP alignment, not 1-candle breakouts
//   Delay would cause missed entries on trend continuation
// ─────────────────────────────────────────
function runBreakoutEngine(diag) {
    // ✅ FILTER 1: Use confirmed breakout, not raw breakup
    if (
        diag.confirmBreakUp && diag.breakoutStrong &&
        diag.dailyBias !== "BEARISH" &&
        diag.aboveVWAP && diag.volConfirm
    ) return { signal: "CE", reason: "breakout_up" };

    if (
        diag.confirmBreakDown && diag.breakoutStrong &&
        diag.dailyBias !== "BULLISH" &&
        diag.belowVWAP && diag.volConfirm
    ) return { signal: "PE", reason: "breakout_down" };

    return null;
}

// ─────────────────────────────────────────
// PULLBACK ENGINE — trendAligned + EMA bounce
// ─────────────────────────────────────────
function runPullbackEngine(diag) {
    if (
        diag.dailyBias === "BULLISH" && diag.trendAligned &&
        diag.pullbackLong && diag.aboveVWAP && diag.volConfirm
    ) return { signal: "CE", reason: "pullback_long" };

    if (
        diag.dailyBias === "BEARISH" && diag.trendAligned &&
        diag.pullbackShort && diag.belowVWAP && diag.volConfirm
    ) return { signal: "PE", reason: "pullback_short" };

    return null;
}

// ─────────────────────────────────────────
// SWEEP ENGINE
// ADX > 35 = blocked (continuation wicks, not reversal)
// ADX 25-35 = MODERATE trend = sweep valid (v2 winners confirm)
// Score >= 6 blocks all B-grade sweep losers
// ─────────────────────────────────────────
function runSweepEngine(diag) {
    const adx = parseFloat(diag.currentADX);
    const rsi = parseFloat(diag.currentRSI);
    if (adx > 60) return null;

    if (
        diag.trapShort && diag.dailyBias !== "BEARISH" &&
        diag.aboveVWAP && rsi < 62
    ) return { signal: "CE", reason: "liquidity_sweep_reversal_up" };

    if (
        diag.trapLong && diag.dailyBias !== "BULLISH" &&
        diag.belowVWAP && rsi > 38
    ) return { signal: "PE", reason: "liquidity_sweep_reversal_down" };

    return null;
}

// ─────────────────────────────────────────
// RANGE ENGINE
// ─────────────────────────────────────────
function runRangeEngine(diag) {
    if (!diag.isRanging) return null;
    if (diag.fadeLong && diag.dailyBias !== "BEARISH")
        return { signal: "CE", reason: "range_fade_long" };
    if (diag.fadeShort && diag.dailyBias !== "BULLISH")
        return { signal: "PE", reason: "range_fade_short" };
    return null;
}

// ─────────────────────────────────────────
// REVERSAL ENGINE
// ─────────────────────────────────────────
function runReversalEngine(diag) {
    if (diag.bullReversal && diag.dailyBias === "BULLISH" && diag.aboveVWAP)
        return { signal: "CE", reason: "exhaustion_reversal_up" };
    if (diag.bearReversal && diag.dailyBias === "BEARISH" && diag.belowVWAP)
        return { signal: "PE", reason: "exhaustion_reversal_down" };
    return null;
}

// ═══════════════════════════════════════════════════════════════
// ██  MAIN: generateSignal()
// ═══════════════════════════════════════════════════════════════
export function generateSignal(
    index1m, index5m, index15m, future1m, data1D,
    sessionState = {}
) {
    // ── Guard ─────────────────────────────────────────────────
    if (!index1m?.length || !index5m?.length || !index15m?.length ||
        !future1m?.length || index5m.length < 8) {
        const ltp = index1m?.[index1m.length - 1]?.close?.toFixed(2) || "0.00";
        const fltp = future1m?.[future1m.length - 1]?.close?.toFixed(2) || "0.00";
        return { signal: "NO_TRADE", reason: "insufficient_timeframe_data", ...getBaseDiag(ltp, fltp) };
    }

    const last1m = index1m[index1m.length - 1];
    const prev1m = index1m[index1m.length - 2];
    const prev2m = index1m[index1m.length - 3];   // needed for confirmation
    const last5m = index5m[index5m.length - 1];
    const prev5m = index5m[index5m.length - 2];
    const lastFuture = future1m[future1m.length - 1];

    if (!last1m || !prev1m || !last5m || !prev5m || !lastFuture) {
        return {
            signal: "NO_TRADE", reason: "invalid_candle_structure",
            ...getBaseDiag(last1m?.close?.toFixed(2), lastFuture?.close?.toFixed(2))
        };
    }

    // ── Time ──────────────────────────────────────────────────
    const istStr = new Date(last1m.time).toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
    const istDate = new Date(istStr);
    const minuteOfDay = istDate.getHours() * 60 + istDate.getMinutes();

    const diag = getBaseDiag(last1m.close.toFixed(2), lastFuture.close.toFixed(2));
    diag.warnings = [];
    diag.timeAllowed = minuteOfDay >= CFG.TIME_START_MIN && minuteOfDay <= CFG.TIME_END_MIN;
    if (!diag.timeAllowed) return { signal: "NO_TRADE", reason: "time_filter", ...diag };

    // ─────────────────────────────────────────
    // FILTER: DAILY CONSECUTIVE LOSS LIMIT
    // 3 consecutive SL hits = stop trading for today
    // Reset happens externally (new day or TGT hit resets counter)
    // ─────────────────────────────────────────
    const maxConsecLoss = CFG.MAX_CONSECUTIVE_LOSS ?? 3;
    if ((sessionState.consecutiveLosses ?? 0) >= maxConsecLoss) {
        diag.warnings.push("DAILY_LOSS_LIMIT_REACHED");
        return {
            signal: "NO_TRADE",
            reason: `max_consecutive_losses_${sessionState.consecutiveLosses}`,
            ...diag
        };
    }

    // ── Daily bias ────────────────────────────────────────────
    const dailyData = data1D?.length >= CFG.DAILY_EMA_PERIOD ? data1D : [];
    if (dailyData.length < CFG.DAILY_EMA_PERIOD)
        return { signal: "NO_TRADE", reason: "insufficient_daily_ema_data", ...diag };

    const dailyEMA = calculateEMA(dailyData, CFG.DAILY_EMA_PERIOD);
    const dailyLast = dailyData[dailyData.length - 1];
    const prevDay = dailyData[dailyData.length - 2];
    const lastDailyEMA = dailyEMA[dailyEMA.length - 1];
    if (lastDailyEMA === null) return { signal: "NO_TRADE", reason: "daily_ema_null", ...diag };

    diag.emaAbove = dailyLast.close > lastDailyEMA;
    diag.bullCandle = dailyLast.close > dailyLast.open;
    diag.bearCandle = dailyLast.close < dailyLast.open;
    diag.dailyBias =
        (diag.emaAbove && diag.bullCandle) ? "BULLISH" :
            (!diag.emaAbove && diag.bearCandle) ? "BEARISH" : "NEUTRAL";
    if (dailyLast.close > prevDay.high && diag.emaAbove) diag.dailyBias = "BULLISH";
    if (dailyLast.close < prevDay.low && !diag.emaAbove) diag.dailyBias = "BEARISH";
    if (diag.dailyBias === "NEUTRAL") diag.warnings.push("DAILY_BIAS_NEUTRAL");

    // ── VWAP ──────────────────────────────────────────────────
    const vwapArr = calculateVWAP(future1m);
    const currentVWAP = vwapArr[vwapArr.length - 1];
    const prevVWAP = vwapArr[vwapArr.length - 2];

    diag.vwap = currentVWAP !== null ? parseFloat(currentVWAP.toFixed(2)) : null;
    diag.aboveVWAP = currentVWAP !== null && lastFuture.close > currentVWAP;
    diag.belowVWAP = currentVWAP !== null && lastFuture.close < currentVWAP;
    diag.vwapUp = currentVWAP !== null && prevVWAP !== null && currentVWAP > prevVWAP;
    diag.vwapDown = currentVWAP !== null && prevVWAP !== null && currentVWAP < prevVWAP;

    // ── 5m Indicators ─────────────────────────────────────────
    const ema5m = calculateEMA(index5m);
    const currentEMAVal = ema5m[ema5m.length - 1];
    diag.currentEMA = currentEMAVal?.toFixed(2) || "0.00";
    diag.trendUp = last5m.close > (currentEMAVal ?? -Infinity);
    diag.trendDown = last5m.close < (currentEMAVal ?? Infinity);

    const atrArr = calculateATR(index5m, 14, diag.warnings);
    const rawATR = atrArr[atrArr.length - 1];
    const atrPrev = atrArr[atrArr.length - 2];
    if (rawATR !== null) {
        diag.currentATR = rawATR.toFixed(2);
        diag.dynamicSL = parseFloat(Math.min(CFG.ATR_SL_CAP, rawATR * CFG.ATR_SL_MULTIPLIER).toFixed(2));
        diag.dynamicTGT = parseFloat(Math.min(CFG.ATR_TGT_CAP, rawATR * CFG.ATR_TGT_MULTIPLIER).toFixed(2));
    }

    const adxArr = calculateADX(index5m, 14, diag.warnings);
    const rawADX = adxArr[adxArr.length - 1];
    if (rawADX !== null) {
        diag.currentADX = rawADX.toFixed(1);
        diag.trendStrong = rawADX >= CFG.ADX_MIN;
        // ✅ ADX SPIKE OVERRIDE: institutional momentum — force breakout entry
        // ADX > 45 = strong directional move, candle size doesn't matter
        if (rawADX > (CFG.ADX_SPIKE_MIN ?? 45)) {
            diag.breakoutStrong = true;
        }
    }

    const rsiArr = calculateRSI(index5m, 14, diag.warnings);
    const currentRSI = rsiArr[rsiArr.length - 1];
    if (currentRSI !== null) {
        diag.currentRSI = currentRSI.toFixed(1);
        diag.rsiBullish = currentRSI > CFG.RSI_BULL_MIN;
        diag.rsiBearish = currentRSI < CFG.RSI_BEAR_MAX;
    }

    // ── Gap ───────────────────────────────────────────────────
    diag.gapPoints = dailyLast.open - prevDay.close;
    diag.gapPercent = parseFloat(((dailyLast.open - prevDay.close) / prevDay.close * 100).toFixed(3));
    diag.gapUp = diag.gapPoints > CFG.GAP_THRESHOLD;
    diag.gapDown = diag.gapPoints < -CFG.GAP_THRESHOLD;
    diag.gapLabel =
        diag.gapUp ? `🔼 Gap Up (+${diag.gapPoints.toFixed(0)} pts / +${diag.gapPercent}%)` :
            diag.gapDown ? `🔽 Gap Down (${diag.gapPoints.toFixed(0)} pts / ${diag.gapPercent}%)` :
                `◾ Normal Day (${diag.gapPoints.toFixed(0)} pts)`;

    // ── Hard guards ───────────────────────────────────────────
    if (rawATR === null) return { signal: "NO_TRADE", reason: "atr_unavailable", ...diag };
    if (rawATR < CFG.ATR_MIN) return { signal: "NO_TRADE", reason: "low_volatility_atr", ...diag };
    if (rawADX === null) return { signal: "NO_TRADE", reason: "insufficient_adx_data", ...diag };

    // ── 15m structure ─────────────────────────────────────────
    const last3 = index15m.slice(-3);
    if (last3.length === 3) {
        diag.higherHigh = last3[2].high > last3[1].high && last3[1].high > last3[0].high;
        diag.higherLow = last3[2].low > last3[1].low && last3[1].low > last3[0].low;
        diag.lowerHigh = last3[2].high < last3[1].high && last3[1].high < last3[0].high;
        diag.lowerLow = last3[2].low < last3[1].low && last3[1].low < last3[0].low;
    }
    diag.bullishStructure = diag.higherHigh && diag.higherLow;
    diag.bearishStructure = diag.lowerHigh && diag.lowerLow;

    // ── 1m break ──────────────────────────────────────────────
    diag.breakUp = last1m.high > prev1m.high;
    diag.breakDown = last1m.low < prev1m.low;

    // ✅ FILTER 1: CONFIRMED BREAKOUT (2-candle confirmation)
    // Problem: false breakouts cause 1-bar SL hits
    // Fix: current candle must close BEYOND the breakout candle
    //      + breakout candle itself must be directional
    // Applied only to BREAKOUT engine (not TREND which uses alignment)
    // Using prev1m/prev2m because:
    //   prev2m = the candle that made the new high/low
    //   prev1m = the confirmation candle close
    //   last1m = current candle (our potential entry bar)
    diag.confirmBreakUp =
        diag.breakUp &&   // current bar makes new high
        last1m.close > prev1m.high &&   // current close above prev high
        prev1m.close > prev1m.open;         // breakout candle itself was bullish

    diag.confirmBreakDown =
        diag.breakDown &&   // current bar makes new low
        last1m.close < prev1m.low &&   // current close below prev low
        prev1m.close < prev1m.open;         // breakout candle itself was bearish

    // ── Volume + candle quality ───────────────────────────────
    diag.volConfirm = volumeSpike(future1m, future1m.length - 1);

    const body = Math.abs(last1m.close - last1m.open);
    const range = last1m.high - last1m.low;
    diag.strongBody = range > 0 && (body / range) > CFG.STRONG_BODY_RATIO;
    diag.bigCandle = prev1m && (range > (prev1m.high - prev1m.low) * CFG.BIG_CANDLE_MULT) && diag.strongBody;
    diag.breakoutStrong = (diag.breakUp || diag.breakDown) && diag.bigCandle && (diag.strongBody || diag.volConfirm);

    // ── Trend alignment ───────────────────────────────────────
    diag.trendAligned =
        (diag.dailyBias === "BULLISH" && diag.trendUp) ||
        (diag.dailyBias === "BEARISH" && diag.trendDown) ||
        (diag.dailyBias === "NEUTRAL" && diag.bullishStructure && diag.trendUp) ||
        (diag.dailyBias === "NEUTRAL" && diag.bearishStructure && diag.trendDown);

    // ── Future 5m + OI ────────────────────────────────────────
    const future5m = buildTimeframe(future1m, 5);
    if (!future5m || future5m.length < 2)
        return { signal: "NO_TRADE", reason: "insufficient_volume_data", ...diag };
    diag.volume = future5m[future5m.length - 1].volume;
    diag.oi = future5m[future5m.length - 1].oi;

    // ── Regime ────────────────────────────────────────────────
    const regimeResult = detectMarketRegime(rawADX, rawATR, atrPrev, index5m, minuteOfDay);
    diag.regime = regimeResult.regime;
    diag.subRegime = regimeResult.subRegime;
    diag.timeZone = regimeResult.timeZone;

    if (rawADX < CFG.ADX_CHOP && currentRSI > CFG.RSI_BEAR_MAX && currentRSI < CFG.RSI_BULL_MIN
        && diag.regime !== "RANGING") {
        diag.regime = "RANGING";
        diag.subRegime = "CHOP_REDIRECTED";
        regimeResult.engineOrder = ["RANGE"];
        diag.warnings.push("CHOP_REGIME_OVERRIDE");
    }

    // ── 4 Engines ─────────────────────────────────────────────
    const sweep = liquiditySweepEngine(index1m);
    diag.sweepHigh = sweep.sweepHigh; diag.sweepLow = sweep.sweepLow;
    diag.trapLong = sweep.trapLong; diag.trapShort = sweep.trapShort;

    const pb = pullbackEngine(index1m, ema5m);
    diag.pullbackLong = pb.pullbackLong;
    diag.pullbackShort = pb.pullbackShort;

    const rng = rangeMarketEngine(index5m, rawADX, currentRSI, CFG.ADX_CHOP);
    diag.isRanging = rng.isRanging; diag.rangeHigh = rng.rangeHigh; diag.rangeLow = rng.rangeLow;
    diag.fadeShort = rng.fadeShort; diag.fadeLong = rng.fadeLong;

    const rev = reversalEngine(index1m, currentRSI, rawATR);
    diag.bullReversal = rev.bullReversal; diag.bearReversal = rev.bearReversal;
    diag.exhaustedBull = rev.exhaustedBull; diag.exhaustedBear = rev.exhaustedBear;

    const gapDownFilled = diag.gapDown && last5m.close < prevDay.close;
    const gapUpFilled = diag.gapUp && last5m.close > prevDay.close;


    // ── Engine selection ──────────────────────────────────────
    const ENGINE_MAP = {
        TREND: (d) => runTrendEngine(d, gapDownFilled, gapUpFilled),
        BREAKOUT: runBreakoutEngine,
        PULLBACK: runPullbackEngine,
        SWEEP: runSweepEngine,
        RANGE: runRangeEngine,
        REVERSAL: runReversalEngine,
    };

    let engineResult = null;
    let firedEngine = "NONE";

    for (const engineName of regimeResult.engineOrder) {
        const fn = ENGINE_MAP[engineName];
        if (!fn) continue;
        const result = fn(diag);
        if (result !== null) { engineResult = result; firedEngine = engineName; break; }
    }

    diag.signalEngine = firedEngine;
    if (!engineResult) return { signal: "NO_TRADE", reason: "no_conditions_met", ...diag };

    // ── Score gate ────────────────────────────────────────────
    const direction = engineResult.signal === "CE" ? "BULL" : "BEAR";
    const scoreResult = scoreSignal(diag, direction, firedEngine);

    diag.signalScore = scoreResult.score;
    diag.signalGrade = scoreResult.grade;

    btLogger.info(
        `📊 Score:${scoreResult.score}/${scoreResult.threshold} [${scoreResult.grade}] ` +
        `Engine:${firedEngine} Regime:${diag.regime} Sub:${diag.subRegime}`
    );

    if (!scoreResult.qualified)
        return { signal: "NO_TRADE", reason: `score_too_low_${scoreResult.score}_of_${scoreResult.threshold}`, ...diag };

    // ─────────────────────────────────────────────────────────
    // ✅ FILTER 2: RSI MOMENTUM GATE (post-score)
    //
    // Neutral RSI = no directional momentum = coin flip
    // Loss pattern: ADX:20, RSI:48 → no direction → SL
    //
    // CE trades: RSI must be above 50 (bulls in control)
    // PE trades: RSI must be below 50 (bears in control)
    //
    // Using 50/50 (not 52/48) to avoid blocking valid reversals
    // Note: rsiBullish (RSI>55) already in score. This adds momentum floor.
    // ─────────────────────────────────────────────────────────
    if (
        firedEngine !== "TREND" &&
        engineResult.signal === "CE" &&
        !diag.vwapUp
    )
        return { signal: "NO_TRADE", reason: "vwap_not_rising", ...diag };

    if (
        firedEngine !== "TREND" &&
        engineResult.signal === "PE" &&
        !diag.vwapDown
    )
        return { signal: "NO_TRADE", reason: "vwap_not_falling", ...diag };



    // ─────────────────────────────────────────────────────────
    // ✅ FILTER 3: VWAP DISTANCE — only for BREAKOUT + SWEEP
    //
    // Problem: entering when price is already overextended from VWAP
    //          → reversal risk is high → SL hit
    //
    // Applied ONLY to BREAKOUT and SWEEP engines:
    //   TREND engine: price naturally far from VWAP in strong trends
    //     (Trade 41 ATR=242, Trade 42 ATR=214 both +300 wins on gap days)
    //     Hard distance filter would kill these
    //
    // Threshold: 1.5 ATR (not 1.2 — prevents blocking volatile winners)
    // ─────────────────────────────────────────────────────────
    if ((firedEngine === "BREAKOUT" || firedEngine === "SWEEP") && currentVWAP !== null) {
        const vwapDistance = Math.abs(lastFuture.close - currentVWAP);
        const vwapLimit =
            rawATR * (diag.regime === "TRENDING" ? 5 :
                diag.regime === "BREAKOUT" ? 4 :
                    3);
        if (vwapDistance > vwapLimit) {
            console.log("VWAP_OVEREXTENDED", vwapDistance, vwapLimit, firedEngine, lastFuture.close, currentVWAP);
            diag.warnings.push(`VWAP_OVEREXTENDED_${vwapDistance.toFixed(0)}pts`);
            return { signal: "NO_TRADE", reason: "overextended_from_vwap", ...diag };
        }
    }


    const adx = parseFloat(diag.currentADX);

    if (adx > 65)
        return { signal: "NO_TRADE", reason: "adx_too_high", ...diag };
    if (adx < 18)
        return { signal: "NO_TRADE", reason: "adx_too_low", ...diag };

    if (firedEngine === "SWEEP" && rawADX > 40)
        return { signal: "NO_TRADE", reason: "sweep_block_strong_trend", ...diag };

    // ── Risk levels ───────────────────────────────────────────
    const risk = computeRiskLevels(last1m.close, engineResult.signal, rawATR, diag.regime, rawADX);

    // ─────────────────────────────────────────────────────────
    // ✅ FILTER 5: MINIMUM REWARD-TO-RISK RATIO
    //
    // Low RR trades: winning 1 requires losing on 2+ losers
    // Minimum 1.5:1 RR ensures positive expectancy per trade
    //
    // Impact: minimal with current config (ATR_TGT=2.5x, ATR_SL=0.95x → RR≈2.6)
    // Catches edge cases: very low ATR days, tight SL configs
    // ─────────────────────────────────────────────────────────
    const rr = risk.dynamicTGT / risk.dynamicSL;
    // if (rr < 1.5)
    //     return { signal: "NO_TRADE", reason: `low_rr_${rr.toFixed(2)}_min_1.5`, ...diag };

    diag.dynamicSL = risk.dynamicSL; diag.dynamicTGT = risk.dynamicTGT;
    diag.slPrice = risk.slPrice; diag.tgtPrice = risk.tgtPrice;
    diag.partialExitPrice = risk.partialExitPrice;
    diag.trailingSlPrice = risk.trailingSlPrice;

    btLogger.info(
        `${engineResult.signal === "CE" ? "🔺" : "🔻"} ` +
        `${engineResult.signal} | ${engineResult.reason} | ` +
        `Score:${scoreResult.score} [${scoreResult.grade}] | ` +
        `SL:${risk.slPrice} Partial:${risk.partialExitPrice} TGT:${risk.tgtPrice} | ` +
        `ADX:${diag.currentADX} ATR:${diag.currentATR} RR:${rr.toFixed(2)}`
    );

    return { signal: engineResult.signal, reason: engineResult.reason, ...diag };
}