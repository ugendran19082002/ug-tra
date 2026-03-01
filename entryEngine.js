import { logger, tradeLogger, getISTTime } from "./logger.js";
import { sleep, getDailyFromDate, calculateOptionLevels } from "./helpers.js";
import { getHistorical, getFuture, format } from "./api/historical.js";
import { getATMOptionTokens, getLTP } from "./getStrick.js";
import { generateSignal } from "./signals.js";
import { sendTelegram } from "./telegram.js";
import { executeOrder } from "./order.js";

// ═════════════════════════════════════════════════════════════════════════════
//  ENTRY ENGINE (live)
// ═════════════════════════════════════════════════════════════════════════════
export async function entryEngine(jwt, fromdate, todate, futureToken) {

    const indexRaw1m = await getHistorical(jwt, "BSE", process.env.SYMBOLTOKEN, "ONE_MINUTE", fromdate, todate);
    await sleep(300);
    const indexRaw5m = await getHistorical(jwt, "BSE", process.env.SYMBOLTOKEN, "FIVE_MINUTE", fromdate, todate);
    await sleep(300);
    const indexRaw15m = await getHistorical(jwt, "BSE", process.env.SYMBOLTOKEN, "FIFTEEN_MINUTE", fromdate, todate);
    await sleep(300);
    const raw1D = await getHistorical(jwt, "BSE", process.env.SYMBOLTOKEN, "ONE_DAY", getDailyFromDate(), todate);
    await sleep(300);
    const futureRaw1m = await getFuture(futureToken, fromdate, todate);
    await sleep(300);

    if (!indexRaw1m.length || !futureRaw1m.length) {
        logger.warn("⚠ Missing data — skipping");
        return { signal: "NO_TRADE", reason: "missing data" };
    }

    const index1m = format(indexRaw1m);
    const index5m = format(indexRaw5m);
    const index15m = format(indexRaw15m);
    const future1m = format(futureRaw1m);
    const data1D = format(raw1D);

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
    logger.info(`Supports: ${JSON.stringify(r.finalSupports)}`);
    logger.info(`Resistances: ${JSON.stringify(r.finalResistances)}`);

    if (r.signal === "NO_TRADE") {
        logger.info(`⚪ NO TRADE | ${r.reason ?? "conditions not met"}`);
        return { signal: "NO_TRADE", reason: r.reason ?? "conditions not met" };
    }

    // ── Price levels
    const isPE = r.signal === "PE";
    const entryPrice = parseFloat(r.indexLTP);
    const slPrice = isPE
        ? parseFloat((entryPrice + r.dynamicSL).toFixed(2))
        : parseFloat((entryPrice - r.dynamicSL).toFixed(2));
    const tgtPrice = isPE
        ? parseFloat((entryPrice - r.dynamicTGT).toFixed(2))
        : parseFloat((entryPrice + r.dynamicTGT).toFixed(2));
    const riskReward = (r.dynamicTGT / r.dynamicSL).toFixed(2);

    logger.info(`🎯 Entry:${entryPrice} | SL:${slPrice} | TGT:${tgtPrice} | RR:${riskReward}`);

    // ── ATM Option Token fetch
    let optionToken = null, optionSymbol = null, optionLTP = null, atmStrike = null, optionExpiry = null;
    let optionSL = null, optionTarget = null;

    try {
        const atm = await getATMOptionTokens("SENSEX", entryPrice);

        if (atm) {
            atmStrike = atm.strike;
            optionExpiry = new Date(atm.expiry).toDateString();
            optionToken = isPE ? atm.peToken : atm.ceToken;
            optionSymbol = isPE ? `SENSEX${atm.strike}PE` : `SENSEX${atm.strike}CE`;

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