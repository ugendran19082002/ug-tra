import {
    calculateEMA, calculateRSI, calculateATR, calculateADX,
    findSupportResistance, getRoundLevels, cleanLevels, volumeSpike
} from "./indicators.js";

// ═════════════════════════════════════════════════════════════════════════════
//  generateSignal()
// ═════════════════════════════════════════════════════════════════════════════
export function generateSignal(index1m, index5m, index15m, future1m, data1D) {

    if (!index5m?.length || !index15m?.length)
        return { signal: "NO_TRADE", reason: "insufficient timeframe data" };

    const dailyData = (data1D?.length >= 2) ? data1D : [];
    if (dailyData.length < 2)
        return { signal: "NO_TRADE", reason: "insufficient daily data" };

    // ── Daily bias
    const dailyEMA = calculateEMA(dailyData);
    const dailyLast = dailyData[dailyData.length - 1];
    const emaAbove = dailyLast.close > dailyEMA[dailyEMA.length - 1];
    const bullCandle = dailyLast.close > dailyLast.open;
    const bearCandle = dailyLast.close < dailyLast.open;

    const dailyBias =
        (emaAbove && bullCandle) ? "BULLISH" :
            (!emaAbove && bearCandle) ? "BEARISH" : "NEUTRAL";

    if (dailyBias === "NEUTRAL")
        return { signal: "NO_TRADE", reason: "daily bias neutral" };

    // ── Prev day levels
    const prevDay = dailyData[dailyData.length - 2];
    const prevHigh = prevDay?.high ?? 0;
    const prevLow = prevDay?.low ?? 0;

    // ── Gap analysis
    const GAP_THRESHOLD = 300;
    const todayOpen = dailyLast.open;
    const prevClose = prevDay?.close ?? todayOpen;
    const gapPoints = todayOpen - prevClose;
    const gapUp = gapPoints > GAP_THRESHOLD;
    const gapDown = gapPoints < -GAP_THRESHOLD;
    const gapLabel =
        gapUp ? `🔼 Gap Up   (+${gapPoints.toFixed(0)} pts)` :
            gapDown ? `🔽 Gap Down (${gapPoints.toFixed(0)} pts)` :
                `◾ Normal day (${gapPoints.toFixed(0)} pts)`;

    // ── 15m structure
    const last3 = index15m.slice(-3);
    const hasStructure = last3.length >= 3;
    const higherHigh = hasStructure && last3[2].high > last3[1].high;
    const higherLow = hasStructure && last3[2].low > last3[1].low;
    const lowerHigh = hasStructure && last3[2].high < last3[1].high;
    const lowerLow = hasStructure && last3[2].low < last3[1].low;
    const bullishStructure = higherHigh && higherLow;
    const bearishStructure = lowerHigh && lowerLow;

    // ── S/R
    const { supports, resistances } = findSupportResistance(index15m);
    const currentPrice = index5m[index5m.length - 1].close;
    const roundLevels = getRoundLevels(currentPrice);
    const finalSupports = cleanLevels([...supports, prevLow, ...roundLevels.filter(r => r < currentPrice)]);
    const finalResistances = cleanLevels([...resistances, prevHigh, ...roundLevels.filter(r => r > currentPrice)]);

    // ── 5m trend
    const ema5m = calculateEMA(index5m);
    const last5m = index5m[index5m.length - 1];
    const trendUp = last5m.close > ema5m[ema5m.length - 1];
    const trendDown = last5m.close < ema5m[ema5m.length - 1];

    // ── ATR-based dynamic SL/TGT
    const ATR_SL_MULT = 1.0;
    const ATR_TGT_MULT = 2.5;
    const ATR_FALLBACK = 80;
    const atr5mArr = calculateATR(index5m, 14);
    const rawATR = atr5mArr[atr5mArr.length - 1];
    const currentATR = rawATR && rawATR > 0 ? rawATR : ATR_FALLBACK;
    const dynamicSL = parseFloat(Math.min(100, currentATR * ATR_SL_MULT).toFixed(2));
    const dynamicTGT = parseFloat(Math.max(100, currentATR * ATR_TGT_MULT).toFixed(2));

    // ── ADX
    const adx5mArr = calculateADX(index5m, 14);
    const currentADX = adx5mArr[adx5mArr.length - 1];
    const trendStrong = currentADX >= 20;

    // ── RSI
    const rsi5mArr = calculateRSI(index5m, 14);
    const currentRSI = rsi5mArr[rsi5mArr.length - 1];
    const rsiBullish = currentRSI > 55;
    const rsiBearish = currentRSI < 45;

    // ── 1m candle analysis
    const last1m = index1m[index1m.length - 1];
    const prev1m = index1m[index1m.length - 2];
    const last5 = index1m.slice(-6, -1);
    const max5High = Math.max(...last5.map(c => c.high));
    const min5Low = Math.min(...last5.map(c => c.low));
    const breakUp = last1m.close > max5High;
    const breakDown = last1m.close < min5Low;

    // ── S/R proximity
    const SR_THRESHOLD = 50;
    const nearSupport = finalSupports.filter(s => s < last1m.close).pop();
    const nearResistance = finalResistances.find(r => r > last1m.close);
    const breakBelow = nearSupport && last1m.close < nearSupport && Math.abs(last1m.close - nearSupport) <= SR_THRESHOLD;
    const breakAbove = nearResistance && last1m.close > nearResistance && Math.abs(last1m.close - nearResistance) <= SR_THRESHOLD;

    // ── Volume + candle body
    const volConfirm = volumeSpike(future1m, future1m.length - 1);
    const body = Math.abs(last1m.close - last1m.open);
    const range = last1m.high - last1m.low;
    const strongBody = range > 0 && (body / range) > 0.6;
    const bigCandle = (range > (prev1m.high - prev1m.low) * 1.5) && strongBody;
    const closeNearHigh = range > 0 && (last1m.high - last1m.close) / range < 0.2;
    const closeNearLow = range > 0 && (last1m.close - last1m.low) / range < 0.2;

    // ── Spread
    const lastFuture = future1m[future1m.length - 1];
    const spread = lastFuture.close - last1m.close;

    // ── Diagnostics payload
    const diag = {
        dailyBias, emaAbove, bullCandle, bearCandle,
        trendUp, trendDown,
        breakUp, breakDown, breakAbove, breakBelow,
        bigCandle, strongBody, volConfirm,
        bullishStructure, bearishStructure,
        higherHigh, higherLow, lowerHigh, lowerLow,
        trendStrong, currentADX: currentADX.toFixed(1),
        currentRSI: currentRSI.toFixed(1), rsiBullish, rsiBearish,
        currentATR: currentATR.toFixed(2), dynamicSL, dynamicTGT,
        closeNearHigh, closeNearLow,
        gapUp, gapDown, gapPoints: gapPoints.toFixed(0), gapLabel,
        spread: spread.toFixed(2),
        indexLTP: last1m.close.toFixed(2),
        futureLTP: lastFuture.close.toFixed(2),
        finalSupports, finalResistances,
    };

    // ═══════════════════════
    // ENTRY CONDITIONS
    // ═══════════════════════
    if (
        dailyBias === "BEARISH" &&
        trendStrong &&
        rsiBearish &&
        (trendDown || bigCandle) &&
        (breakDown || breakBelow) &&
        volConfirm &&
        !gapUp
    )
        return { signal: "PE", ...diag };

    if (
        dailyBias === "BULLISH" &&
        trendStrong &&
        rsiBullish &&
        (trendUp || bigCandle) &&
        (breakUp || breakAbove) &&
        volConfirm &&
        !gapDown
    )
        return { signal: "CE", ...diag };

    return { signal: "NO_TRADE", ...diag };
}