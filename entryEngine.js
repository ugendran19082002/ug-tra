import dotenv from "dotenv";
dotenv.config();

import { logger, tradeLogger, getISTTime } from "./logger.js";
import { sleep, getDailyFromDate, calculateOptionLevels, buildTimeframe } from "./helpers.js";
import { getHistorical, getFuture, format } from "./api/historical.js";
import { getATMOptionTokens, getLTP, } from "./getStrick.js";
import { generateSignal } from "./signals.js";
import { sendTelegram } from "./telegram.js";
import { Worker } from "worker_threads";
import { fileURLToPath } from "url";
import path from "path";

// ── Feature-flag imports (graceful if deps not installed) ───────────────────
import { canTrade, recordTrade, getRiskStatus, resetDaily } from "./riskEngine.js";
import { isFlat, isOpen, openPosition, closePosition, getPosition, logStatus } from "./positionManager.js";
import { setCandles, getCandles } from "./redisCache.js";
import { addOrderJob } from "./orderQueue.js";

const USE_WORKER_THREADS = process.env.USE_WORKER_THREADS === "true";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────
// Worker Thread: run indicator calculations off main thread
// ─────────────────────────────────────────
function runIndicatorWorker(workerData) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(
            path.join(__dirname, "indicatorWorker.js"),
            { workerData }
        );
        worker.on("message", resolve);
        worker.on("error", reject);
        worker.on("exit", (code) => {
            if (code !== 0) reject(new Error(`Indicator worker exited with code ${code}`));
        });
    });
}

// ─────────────────────────────────────────
// Redis-aware fetch helper
// ─────────────────────────────────────────
async function cachedFetch(cacheKey, tfLabel, fetchFn) {
    const cached = await getCandles(cacheKey);
    if (cached) return cached; // cache HIT

    const raw = await fetchFn();
    if (raw && raw.length) await setCandles(cacheKey, raw, tfLabel);
    return raw;
}

// ─────────────────────────────────────────
// Daily reset tracker
// ─────────────────────────────────────────
let _lastResetDay = null;
function maybeDailyReset() {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    if (_lastResetDay !== today) {
        _lastResetDay = today;
        resetDaily();
    }
}

// ── Execution mutex — prevents duplicate orders if loop outruns signal reset ──
let _tradeLock = false;

// ═════════════════════════════════════════════════════════════════════════════
//  ENTRY ENGINE (live)
// ═════════════════════════════════════════════════════════════════════════════
export async function entryEngine(jwt, fromdate, todate, futureToken) {

    // Guard: if a previous trade is still in-flight, skip this loop tick
    if (_tradeLock) {
        logger.warn("⚠ EntryEngine locked — trade in-flight, skipping loop tick");
        return { signal: "NO_TRADE", reason: "execution_locked" };
    }

    // ── Daily state reset at start of each new day ────────────────────────
    maybeDailyReset();

    // ── Log position status ───────────────────────────────────────────────
    logStatus();

    // ── Risk Engine check: don't run if daily limits hit ─────────────────
    const risk = canTrade();
    if (!risk.allowed) {
        logger.warn(`🚨 RiskEngine BLOCKED: ${risk.reason}`);
        const rs = getRiskStatus();
        logger.info(
            `📊 Risk Status | Trades:${rs.dailyTrades}/${rs.maxTrades} | ` +
            `PnL:${rs.dailyPnL} | Reason:${rs.blockReason}`
        );
        return { signal: "NO_TRADE", reason: `risk_blocked_${risk.reason}` };
    }

    // ── If position already open, skip new signal ─────────────────────────
    if (isOpen()) {
        const pos = getPosition();
        logger.info(`⏳ Position already open: ${pos.side} @ ${pos.entry} — skipping new signal`);
        return { signal: "NO_TRADE", reason: "position_already_open" };
    }

    // ── Fetch market data (Redis-cached where enabled) ─────────────────────
    const exchange = process.env.EXCHANGE || "BSE";
    const indexRaw1m = await cachedFetch(
        `index1m_${todate}`, "1m",
        () => getHistorical(jwt, exchange, process.env.SYMBOLTOKEN, "ONE_MINUTE", fromdate, todate)
    );
    await sleep(1000);

    const indexRaw5m = await cachedFetch(
        `index5m_${todate}`, "5m",
        () => getHistorical(jwt, exchange, process.env.SYMBOLTOKEN, "FIVE_MINUTE", fromdate, todate)
    );
    await sleep(1000);

    const indexRaw15m = await cachedFetch(
        `index15m_${todate}`, "15m",
        () => getHistorical(jwt, exchange, process.env.SYMBOLTOKEN, "FIFTEEN_MINUTE", fromdate, todate)
    );
    await sleep(1000);

    const raw1D = await cachedFetch(
        `index1D_${getDailyFromDate()}`, "1D",
        () => getHistorical(jwt, exchange, process.env.SYMBOLTOKEN, "ONE_DAY", getDailyFromDate(), todate)
    );
    await sleep(1000);

    const futureRaw1m = await cachedFetch(
        `future1m_${todate}`, "1m",
        () => getFuture(futureToken, fromdate, todate)
    );
    await sleep(1000);

    const index1m = format(indexRaw1m);
    let future1m = format(futureRaw1m);
    const data1D = format(raw1D);

    if (!indexRaw1m.length || !futureRaw1m.length) {
        logger.warn("⚠ Missing data — skipping");
        return { signal: "NO_TRADE", reason: "missing data" };
    }

    // ── Log latest candle being used for signal
    const latest = future1m[future1m.length - 1];
    logger.info(`📍 Signal Candle → Time:${latest.time} O:${latest.open} H:${latest.high} L:${latest.low} C:${latest.close} Vol:${latest.volume} OI:${latest.oi}`);

    // ── Fall back to building 5m / 15m from 1m when API returns empty
    const index5m = (indexRaw5m && indexRaw5m.length) ? format(indexRaw5m) : buildTimeframe(index1m, 5);
    const index15m = (indexRaw15m && indexRaw15m.length) ? format(indexRaw15m) : buildTimeframe(index1m, 15);

    if (!index5m.length) logger.warn("⚠ 5m data empty even after buildTimeframe fallback");
    if (!index15m.length) logger.warn("⚠ 15m data empty even after buildTimeframe fallback");

    logger.debug(`Timeframes → 1m:${index1m.length} 5m:${index5m.length} 15m:${index15m.length} 1D:${data1D.length}`);

    // ── Indicator computation (Worker Thread or inline) ───────────────────
    let r;
    if (USE_WORKER_THREADS) {
        try {
            logger.debug("🧵 Worker Thread: running indicators...");
            // Worker computes indicators; generateSignal still runs on main thread
            // for signal logic (uses pre-computed arrays via injected results)
            const workerResult = await runIndicatorWorker({
                index1m, index5m, index15m, future1m, data1D
            });
            if (!workerResult.ok) throw new Error(workerResult.error);
            logger.debug(`🧵 Worker Thread: done (warnings: ${workerResult.warnings.join(",") || "none"})`);
            // Fall through to generateSignal which re-uses full data sets
            // (worker pre-validates; actual signal struct built in main thread)
            r = generateSignal(index1m, index5m, index15m, future1m, data1D);
        } catch (err) {
            logger.warn(`⚠ Worker Thread failed (${err.message}) — falling back to inline`);
            r = generateSignal(index1m, index5m, index15m, future1m, data1D);
        }
    } else {
        r = generateSignal(index1m, index5m, index15m, future1m, data1D);
    }

    logger.info(`📍 LTP → Index:${r.indexLTP}  Future:${r.futureLTP}  Spread:${r.spread}  Bias:${r.dailyBias}  Signal:${r.signal}`);
    if (r.signal === "NO_TRADE") logger.debug(`   Reason: ${r.reason} | ADX:${r.currentADX} RSI:${r.currentRSI} ATR:${r.currentATR} | trend↑${r.trendUp} ↓${r.trendDown}`);

    if (r.signal === "NO_TRADE") {
        logger.info(`⚪ NO TRADE | ${r.reason ?? "conditions not met"}`);
        return { signal: "NO_TRADE", reason: r.reason ?? "conditions not met" };
    }

    // ── Price levels
    const isPE = r.signal === "PE";
    const lastCandle = index1m[index1m.length - 1];
    const entryPrice = parseFloat(r.indexLTP) || index1m[index1m.length - 1].close;

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
        const signalDate = new Date(lastCandle.time);
        const atm = await getATMOptionTokens(process.env.INDEX_SYMBOL || "SENSEX", entryPrice, signalDate);

        if (atm) {
            atmStrike = atm.strike;
            optionExpiry = new Date(atm.expiry).toDateString();
            optionToken = isPE ? atm.peToken : atm.ceToken;
            optionSymbol = isPE ? atm.peSymbol : atm.ceSymbol;

            logger.info(`📌 ATM: ${optionSymbol} | Strike:${atmStrike} | Expiry:${optionExpiry}`);

            await sleep(300);
            const reqPayload = {};
            reqPayload[process.env.EXCHANGE_SEGMENT || "BFO"] = [optionToken];
            const ltpData = await getLTP(jwt, reqPayload);

            if (ltpData.length) {
                optionLTP = parseFloat(ltpData[0].ltp.toFixed(2));
                logger.info(`💰 Option LTP  : ${optionLTP}`);

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

    // ── Open position in Position Manager ───────────────────────────────────────────
    _tradeLock = true;   // ⚠ Lock: no new entries until this trade resolves
    openPosition(signalObj);

    // ── Place order via Queue (or direct fallback) ─────────────────────
    await addOrderJob(signalObj, jwt);

    // Lock stays ON — released via onTradeExit() when the trade closes
    return signalObj;
}

/**
 * Called externally (e.g. from main.js) when a trade exits.
 * Updates Risk Engine with final PnL.
 * @param {number} pnl - index points, positive=profit negative=loss
 * @param {string} reason - "SL" | "TGT" | "EOD" | "MANUAL"
 */
export function onTradeExit(pnl, reason = "UNKNOWN") {
    closePosition(reason, NaN);
    recordTrade(pnl);
    _tradeLock = false;   // ✅ Unlock: bot can accept a new entry now
    logger.info(`📊 Trade closed: ${reason} | PnL: ${pnl > 0 ? "+" : ""}${pnl}`);
}
