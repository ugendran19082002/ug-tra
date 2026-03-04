import dotenv from "dotenv";
dotenv.config();

import { logger, getISTTime } from "./logger.js";
import { sleep, getTodayFromDate, formatCurrentDateTime } from "./helpers.js";
import { login, clearTokenCache } from "./api/auth.js";
import { getFutureToken } from "./api/tokens.js";
import { entryEngine } from "./entryEngine.js";
import { backtest } from "./backtest.js";

// ─────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────
async function main() {

    const isBacktest = process.env.BACKTEST === "true" || process.argv.includes("--backtest");

    if (isBacktest) {
        logger.info("🧪 BACKTEST MODE");

        // const btFrom = process.env.BT_FROM ?? "2026-02-15 09:15";
        // const btTo = process.env.BT_TO ?? "2026-02-27 15:30";

        // const btFrom = getTodayFromDate(20);
        const btFrom = "2025-12-31 09:15";
        console.log("btFrom", btFrom);
        // const btTo = formatCurrentDateTime(); // ✅ FIX: replace with formatDateTime() for real live use
        const btTo = "2026-01-31 15:30"; // ✅ FIX: replace with formatDateTime() for real live use
        // const btTo = "2026-03-02 11:10"; // ✅ FIX: replace with formatDateTime() for real live use
        console.log("btTo", btTo);
        logger.info(`📅 Window: ${btFrom} → ${btTo}`);

        const jwt = await login();
        const futureToken = await getFutureToken("SENSEX", btFrom);

        await backtest(jwt, futureToken, btFrom, btTo, {
            slPoints: parseInt(process.env.BT_SL ?? "80"),
            tgtPoints: parseInt(process.env.BT_TGT ?? "200"),
            startBar: 30,
        });

        logger.info("✅ Done. See backtest.log");
        return;
    }

    // ── LIVE TRADING MODE
    logger.info("🚀 BOT STARTED");

    let lastSignal = null;
    let iteration = 0;
    let forceLogin = false;

    while (true) {
        iteration++;

        try {
            logger.info(`🔄 Loop #${iteration} | IST: ${getISTTime()}`);

            const jwt = await login(forceLogin);
            forceLogin = false; // reset after success

            const liveFrom = getTodayFromDate(20);
            console.log("liveFrom", liveFrom);
            // const liveTo = "2026-03-02 13:59"; // ✅ FIX: replace with formatDateTime() for real live use
            const liveTo = formatCurrentDateTime(); // ✅ FIX: replace with formatDateTime() for real live use
            console.log("liveTo", liveTo);
            const futureToken = await getFutureToken("SENSEX");

            logger.info(`📅 Window: ${liveFrom} → ${liveTo}`);

            const signalObj = await entryEngine(jwt, liveFrom, liveTo, futureToken);

            const signalType = signalObj?.signal ?? "NO_TRADE";
            const isNoTrade = signalType === "NO_TRADE";

            logger.info(`🎯 SIGNAL: ${signalType}`);

            if (!isNoTrade && signalType !== lastSignal) {
                logger.info(`🚨 NEW SIGNAL: ${signalType}`);
                logger.info(`   Entry : ${signalObj.entryPrice}`);
                logger.info(`   SL    : ${signalObj.slPrice}  (${signalObj.slPoints} pts)`);
                logger.info(`   TGT   : ${signalObj.tgtPrice}  (${signalObj.tgtPoints} pts)`);
                logger.info(`   RR    : 1 : ${signalObj.riskReward}`);
                lastSignal = signalType;
            }

            if (isNoTrade) lastSignal = null;

        } catch (err) {
            logger.error(`❌ Loop #${iteration} Error: ${err.message}`);
            if (err.message === "INVALID_TOKEN") {
                logger.warn("🚨 Session expired — clearing cache and re-logging on next loop...");
                clearTokenCache();
                forceLogin = true;
            }
        }

        await sleep(15_000);
    }
}

main();