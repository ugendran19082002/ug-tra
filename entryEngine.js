import { logger, tradeLogger, getISTTime } from "./logger.js";
import { sleep, getDailyFromDate, calculateOptionLevels, buildTimeframe } from "./helpers.js";
import { getHistorical, getFuture, format } from "./api/historical.js";
import { getATMOptionTokens, getLTP, getClosedCandle, getLiveData } from "./getStrick.js";
import { generateSignal } from "./signals.js";
import { sendTelegram } from "./telegram.js";
import { executeOrder } from "./order.js";



// ─────────────────────────────────────────
// In-memory cache — survives across loop iterations
// Used when AngelOne API intermittently returns 0 candles
// ─────────────────────────────────────────
let _cache = {
    indexRaw1m: null,
    indexRaw5m: null,
    indexRaw15m: null,
    raw1D: null,
    futureRaw1m: null,
};

function useOrCache(key, fresh) {
    if (fresh.length) {
        _cache[key] = fresh;       // update cache with fresh data
        return fresh;
    }
    if (_cache[key]?.length) {
        logger.warn(`⚠ ${key}: API returned 0 — using cached data (${_cache[key].length} candles)`);
        return _cache[key];         // fallback to last known good
    }
    return [];                     // no cache either — truly empty
}

// ═════════════════════════════════════════════════════════════════════════════
//  ENTRY ENGINE (live)
// ═════════════════════════════════════════════════════════════════════════════
export async function entryEngine(jwt, fromdate, todate, futureToken) {

    // ── Fetch with retry-once on 0 candles (guards against first-loop cache miss)
    async function fetchWithRetry(key, fn) {
        let data = await fn();
        if (!data.length && !_cache[key]?.length) {
            // Cache empty too — retry once before giving up
            logger.warn(`⚠ ${key}: 0 candles, no cache — retrying in 1s...`);
            await sleep(1000);
            data = await fn();
        }
        return data;
    }

    const rawIndex1m = await fetchWithRetry("indexRaw1m", () => getHistorical(jwt, "BSE", process.env.SYMBOLTOKEN, "ONE_MINUTE", fromdate, todate));
    await sleep(300);
    const rawIndex5m = await fetchWithRetry("indexRaw5m", () => getHistorical(jwt, "BSE", process.env.SYMBOLTOKEN, "FIVE_MINUTE", fromdate, todate));
    await sleep(300);
    const rawIndex15m = await fetchWithRetry("indexRaw15m", () => getHistorical(jwt, "BSE", process.env.SYMBOLTOKEN, "FIFTEEN_MINUTE", fromdate, todate));
    await sleep(300);
    const rawDaily = await fetchWithRetry("raw1D", () => getHistorical(jwt, "BSE", process.env.SYMBOLTOKEN, "ONE_DAY", getDailyFromDate(), todate));
    await sleep(300);
    const rawFuture1m = await fetchWithRetry("futureRaw1m", () => getFuture(futureToken, fromdate, todate));

    await sleep(300);

    // Apply cache fallback for each timeframe
    const indexRaw1m = useOrCache("indexRaw1m", rawIndex1m);
    const indexRaw5m = useOrCache("indexRaw5m", rawIndex5m);
    const indexRaw15m = useOrCache("indexRaw15m", rawIndex15m);
    const raw1D = useOrCache("raw1D", rawDaily);
    const futureRaw1m = useOrCache("futureRaw1m", rawFuture1m);


    let index1m = format(indexRaw1m);
    let future1m = format(futureRaw1m);


    // ── Fetch live closed candle for INDEX (BSE) from SmartAPI FULL mode
    await sleep(300);
    const liveIndex = await getClosedCandle(jwt, "BSE", process.env.SYMBOLTOKEN, 1);

    if (liveIndex) {
        const lastIndex = index1m[index1m.length - 1];
        if (lastIndex && Date.parse(lastIndex.time) === Date.parse(liveIndex.time)) {
            index1m[index1m.length - 1] = liveIndex;
            logger.info(`🔄 Index: Updated last candle with live data: C:${liveIndex.close}`);
        } else {
            index1m.push(liveIndex);
            logger.info(`➕ Index: Appended live closed candle: ${liveIndex.time} | C:${liveIndex.close}`);
        }
    } else {
        logger.warn("⚠ Live index candle fetch failed — using historical data only");
    }

    // ── Fetch live closed candle for FUTURE (BFO) from SmartAPI FULL mode
    // This gives real-time OI and is guaranteed to be a COMPLETED candle
    await sleep(300);
    const liveCandle = await getClosedCandle(jwt, "BFO", futureToken, 1);

    if (liveCandle) {
        const lastFuture = future1m[future1m.length - 1];
        if (lastFuture && Date.parse(lastFuture.time) === Date.parse(liveCandle.time)) {
            future1m[future1m.length - 1] = liveCandle; // update with live OI
            logger.info(`🔄 Future: Updated last candle with live OI: ${liveCandle.oi}`);
        } else {
            future1m.push(liveCandle); // append new closed candle
            logger.info(`➕ Future: Appended live closed candle: ${liveCandle.time} | OI: ${liveCandle.oi}`);
        }
    } else {
        logger.warn("⚠ Live future candle fetch failed — using historical data only");
    }

    if (!index1m.length || !future1m.length) {
        logger.warn("⚠ Missing data — skipping");
        return { signal: "NO_TRADE", reason: "missing data" };
    }
    // ── Log latest candle being used for signal
    const latest = future1m[future1m.length - 1];
    logger.info(`📍 Signal Candle → Time:${latest.time} O:${latest.open} H:${latest.high} L:${latest.low} C:${latest.close} Vol:${latest.volume} OI:${latest.oi}`);

    // ── Fall back to building 5m / 15m / 1D from 1m when API returns empty
    // 1 trading day = 375 one-minute candles (09:15 → 15:30)
    const index5m = (indexRaw5m?.length) ? format(indexRaw5m) : buildTimeframe(index1m, 5);
    const index15m = (indexRaw15m?.length) ? format(indexRaw15m) : buildTimeframe(index1m, 15);
    const data1D = (raw1D?.length) ? format(raw1D) : buildTimeframe(index1m, 375);

    if (!index5m.length) logger.warn("⚠ 5m  empty even after buildTimeframe fallback");
    if (!index15m.length) logger.warn("⚠ 15m empty even after buildTimeframe fallback");
    if (!data1D.length) logger.warn("⚠ 1D  empty even after buildTimeframe fallback");

    if (!indexRaw5m?.length) logger.info("📐 5m  built from 1m candles");
    if (!indexRaw15m?.length) logger.info("📐 15m built from 1m candles");
    if (!raw1D?.length) logger.info("📐 1D  built from 1m candles");

    logger.info(`Timeframes → 1m:${index1m.length} 5m:${index5m.length} 15m:${index15m.length} 1D:${data1D.length}`);

    const r = generateSignal(index1m, index5m, index15m, future1m, data1D);


    logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    logger.info(`📍 INDEX  LTP → ${r.indexLTP}  | IST: ${getISTTime(new Date(index1m[index1m.length - 1].time))}`);
    logger.info(`📍 FUTURE LTP → ${r.futureLTP} | IST: ${getISTTime(new Date(future1m[future1m.length - 1].time))}`);
    logger.info(`📊 Spread      → ${r.spread}`);
    logger.info(`🕐 System IST  → ${getISTTime()}`);
    logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    logger.info(`Daily Bias  : ${r.dailyBias} | EMAAbove:${r.emaAbove} | bull:${r.bullCandle} | bear:${r.bearCandle}`);
    logger.info(`🔷 Gap       : ${r.gapLabel}`);
    logger.info(`🔷 Structure : HH:${r.higherHigh} HL:${r.higherLow} | LH:${r.lowerHigh} LL:${r.lowerLow} | Bull:${r.bullishStructure} Bear:${r.bearishStructure}`);
    logger.info(`🔷 ADX(14)   : ${r.currentADX} (TrendStrong: ${r.trendStrong})`);
    logger.info(`🔷 RSI(14)   : ${r.currentRSI} | bullish:${r.rsiBullish} bearish:${r.rsiBearish}`);
    logger.info(`🔷 ATR(14)   : ${r.currentATR} → SL:${r.dynamicSL} TGT:${r.dynamicTGT}`);
    logger.info(`trendUp:${r.trendUp} trendDown:${r.trendDown}`);
    logger.info(`breakUp:${r.breakUp} breakDown:${r.breakDown} | breakAbove:${r.breakAbove} breakBelow:${r.breakBelow}`);
    logger.info(`bigCandle:${r.bigCandle} strongBody:${r.strongBody} | closeNearHigh:${r.closeNearHigh} closeNearLow:${r.closeNearLow} | volConfirm:${r.volConfirm}`);
    logger.info(`🔷 Sweep     : EqHi:${r.equalHigh} SweepHi:${r.sweepHigh} BearRej:${r.bearishRejection} | EqLo:${r.equalLow} SweepLo:${r.sweepLo} BullRej:${r.bullishRejection}`);
    logger.info(`Supports: ${JSON.stringify(r.finalSupports)}`);
    logger.info(`Resistances: ${JSON.stringify(r.finalResistances)}`);


    if (r.signal === "NO_TRADE") {
        logger.info(`⚪ NO TRADE | ${r.reason ?? "conditions not met"}`);
        return { signal: "NO_TRADE", reason: r.reason ?? "conditions not met" };
    }

    // ── Price levels
    const isPE = r.signal === "PE";
    const entryPrice = parseFloat(r.indexLTP) || index1m[index1m.length - 1].close;

    if (isNaN(entryPrice)) {
        logger.error("❌ Entry Price is NaN - Aborting Trade");
        return { signal: "NO_TRADE", reason: "NaN Entry Price" };
    }

    const slPrice = isPE
        ? parseFloat((entryPrice + r.dynamicSL).toFixed(2))
        : parseFloat((entryPrice - r.dynamicSL).toFixed(2));
    const tgtPrice = isPE
        ? parseFloat((entryPrice - r.dynamicTGT).toFixed(2))
        : parseFloat((entryPrice + r.dynamicTGT).toFixed(2));
    const riskReward = (r.dynamicTGT / r.dynamicSL).toFixed(2);

    logger.info(`🎯 Entry:${entryPrice} | SL:${slPrice} | TGT:${tgtPrice} | RR:${riskReward}`);

    // ── ATM Option Token fetch
    let atm = null;
    let optionToken = null, optionSymbol = null, optionLTP = null, atmStrike = null, optionExpiry = null;
    let optionSL = null, optionTarget = null;
    try {
        atm = await getATMOptionTokens("SENSEX", entryPrice);

        if (atm) {
            atmStrike = atm.strike;
            optionExpiry = new Date(atm.expiry).toDateString();
            optionToken = isPE ? atm.peToken : atm.ceToken;
            optionSymbol = isPE ? atm.peSymbol : atm.ceSymbol;

            logger.info(`📌 ATM Strike  : ${atmStrike}`);
            logger.info(`📌 Option      : ${optionSymbol} | Token: ${optionToken}`);
            logger.info(`📌 Expiry      : ${optionExpiry}`);

            await sleep(300);
            const ltpData = await getLTP(jwt, { BFO: [optionToken] });

            if (ltpData.length) {
                optionLTP = parseFloat(ltpData[0].ltp.toFixed(2));
                logger.info(`💰 Option LTP  : ${optionLTP}`);

                // ── Option-level SL & Target via delta/gamma model
                const levels = calculateOptionLevels({
                    indexEntry: entryPrice,
                    indexSL: slPrice,
                    indexTarget: tgtPrice,
                    optionLTP,
                });
                optionSL = parseFloat(levels.optionSL.toFixed(2));
                optionTarget = parseFloat(levels.optionTarget.toFixed(2));
                logger.info(`📐 Option SL   : ${optionSL}  | Option TGT: ${optionTarget}`);
            } else {
                logger.warn("⚠ Option LTP fetch returned empty");
            }
        } else {
            logger.warn("⚠ ATM tokens unavailable — continuing without option data");
        }
    } catch (err) {
        logger.error(`❌ ATM fetch error: ${err.message}`);
    }

    // ── Telegram message
    const optionLine = optionToken
        ? `\n━━━━━━━━━━━━━━━━━━\n🏷 Option Info\nSymbol      : ${optionSymbol}\nToken       : ${optionToken}\nATM Strike  : ${atmStrike}\nExpiry      : ${optionExpiry}\nOption LTP  : ${optionLTP ?? "N/A"}\nOption SL   : ${optionSL ?? "N/A"}\nOption TGT  : ${optionTarget ?? "N/A"}`
        : "";

    const msg = isPE ? `
🟥 *PE ENTRY SIGNAL*

📉 Bias   : ${r.dailyBias}
🕒 Time   : ${getISTTime()}
${r.gapLabel}

━━━━━━━━━━━━━━━━━━
📊 Price Info
Index LTP   : ${r.indexLTP}
Future LTP  : ${r.futureLTP}
Spread      : ${r.spread}

━━━━━━━━━━━━━━━━━━
🎯 Trade Levels
Entry       : ${entryPrice}
Stop Loss   : ${slPrice}  (${r.dynamicSL} pts ⬆)
Target      : ${tgtPrice}  (${r.dynamicTGT} pts ⬇)
Risk:Reward : 1 : ${riskReward}
Option SL   : ${optionSL ?? "N/A"}
Option TGT  : ${optionTarget ?? "N/A"}
${optionLine}
━━━━━━━━━━━━━━━━━━
📌 Conditions
Structure   : ${r.bearishStructure ? "✅ LH+LL" : "❌ Weak"}
ADX(14)     : ${r.currentADX} ${r.trendStrong ? "✅" : "❌"}
RSI(14)     : ${r.currentRSI} ${r.rsiBearish ? "✅ < 45" : "❌"}
ATR(14)     : ${r.currentATR}
Trend Down  : ${r.trendDown}
Big Candle  : ${r.bigCandle}
Break Down  : ${r.breakDown}
Break Below : ${r.breakBelow}
Near Low    : ${r.closeNearLow}
Volume OK   : ${r.volConfirm}
━━━━━━━━━━━━━━━━━━
` : `
🟢 *CE ENTRY SIGNAL*

📈 Bias   : ${r.dailyBias}
🕒 Time   : ${getISTTime()}
${r.gapLabel}

━━━━━━━━━━━━━━━━━━
📊 Price Info
Index LTP   : ${r.indexLTP}
Future LTP  : ${r.futureLTP}
Spread      : ${r.spread}

━━━━━━━━━━━━━━━━━━
🎯 Trade Levels
Entry       : ${entryPrice}
Stop Loss   : ${slPrice}  (${r.dynamicSL} pts ⬇)
Target      : ${tgtPrice}  (${r.dynamicTGT} pts ⬆)
Risk:Reward : 1 : ${riskReward}
Option SL   : ${optionSL ?? "N/A"}
Option TGT  : ${optionTarget ?? "N/A"}
${optionLine}
━━━━━━━━━━━━━━━━━━
📌 Conditions
Structure   : ${r.bullishStructure ? "✅ HH+HL" : "❌ Weak"}
ADX(14)     : ${r.currentADX} ${r.trendStrong ? "✅" : "❌"}
RSI(14)     : ${r.currentRSI} ${r.rsiBullish ? "✅ > 55" : "❌"}
ATR(14)     : ${r.currentATR}
Trend Up    : ${r.trendUp}
Big Candle  : ${r.bigCandle}
Break Up    : ${r.breakUp}
Break Above : ${r.breakAbove}
Near High   : ${r.closeNearHigh}
Volume OK   : ${r.volConfirm}
━━━━━━━━━━━━━━━━━━
`;

    const signalObj = {
        signal: r.signal,
        time: getISTTime(),
        entryPrice,
        slPrice,
        tgtPrice,
        slPoints: r.dynamicSL,
        tgtPoints: r.dynamicTGT,
        riskReward,
        indexLTP: r.indexLTP,
        futureLTP: r.futureLTP,
        spread: r.spread,
        dailyBias: r.dailyBias,
        gapLabel: r.gapLabel,
        currentADX: r.currentADX,
        currentRSI: r.currentRSI,
        currentATR: r.currentATR,
        trendStrong: r.trendStrong,
        optionToken,
        optionSymbol,
        ceSymbol: atm?.ceSymbol,
        peSymbol: atm?.peSymbol,
        optionLTP,
        optionSL,
        optionTarget,
        atmStrike,
        optionExpiry,
    };

    tradeLogger.info(msg);
    await sendTelegram(msg);

    // ── Place / replace bracket order
    await executeOrder(jwt, signalObj);

    return signalObj;
}