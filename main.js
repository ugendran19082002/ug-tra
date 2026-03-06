import dotenv from "dotenv";
dotenv.config();

import { logger, getISTTime } from "./logger.js";
import { sleep, getTodayFromDate, formatCurrentDateTime } from "./helpers.js";
import { login, clearTokenCache, getFeedToken } from "./api/auth.js";
import { getFutureToken } from "./api/tokens.js";
import { entryEngine, onTradeExit } from "./entryEngine.js";
import { backtest } from "./backtest.js";
import { startFeed, stopFeed, isFeedConnected } from "./wsMarketFeed.js";
import { isOpen, getPosition } from "./positionManager.js";
import { checkExitAndCleanup } from "./order.js";

const USE_WEBSOCKET = process.env.USE_WEBSOCKET === "true";

// ─────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────
async function main() {

    const isBacktest = process.env.BACKTEST === "true" || process.argv.includes("--backtest");

    if (isBacktest) {
        logger.info("🧪 BACKTEST MODE");

        const btFrom = getTodayFromDate(29);
        console.log("btFrom", btFrom);
        const btTo = formatCurrentDateTime();
        // const btTo = "2026-01-29 15:29";
        console.log("btTo", btTo);
        logger.info(`📅 Window: ${btFrom} → ${btTo}`);

        const jwt = await login();
        const futureToken = await getFutureToken(process.env.INDEX_SYMBOL || "SENSEX", btFrom);

        await backtest(jwt, futureToken, btFrom, btTo, {
            slPoints: parseInt(process.env.BT_SL ?? "80"),
            tgtPoints: parseInt(process.env.BT_TGT ?? "200"),
            startBar: 30,
        });

        logger.info("✅ Done. See backtest.log");
        return;
    }

    // ── LIVE TRADING MODE ─────────────────────────────────────────────────
    logger.info("🚀 BOT STARTED");
    logger.info(`⚙ WebSocket mode: ${USE_WEBSOCKET ? "ON" : "OFF (polling)"}`);

    let lastSignal = null;
    let iteration = 0;
    let forceLogin = false;
    let _lastWindowLog = null;
    let _noTradeLogCount = 0;

    // ── WebSocket mode ───────────────────────────────────────────────────
    if (USE_WEBSOCKET) {
        logger.info("🔌 Starting WebSocket feed...");
        try {
            const jwt = await login();
            const futureToken = await getFutureToken(process.env.INDEX_SYMBOL || "SENSEX");

            // feedToken is persisted in jwt_cache.json alongside the JWT string
            const feedToken = getFeedToken() || process.env.FEED_TOKEN || "";

            let _exitLock = false; // Lock to prevent overlapping exit checks

            async function handleLiveExit(jwt, tickLtp) {
                if (_exitLock || !isOpen()) return;

                const pos = getPosition();
                if (!pos || pos.side === "NO_TRADE") return;

                _exitLock = true;

                try {
                    const exited = await checkExitAndCleanup(jwt, pos.optionSymbol, {
                        currentIndexLTP: tickLtp,
                        indexSL: pos.sl,
                        indexTGT: pos.target,
                        isPE: pos.side === "PE"
                    });

                    if (exited) {
                        logger.info(`🚨 LIVE EXIT: ${pos.side} closed by WebSocket Index hit @ ${tickLtp}`);
                        // Compute local PnL for logging
                        const pnl = pos.side === "PE"
                            ? pos.entry - tickLtp
                            : tickLtp - pos.entry;
                        onTradeExit(pnl, "TGT/SL HIT (LTP)");
                    }
                } catch (err) {
                    logger.error(`❌ Live Exit Error: ${err.message}`);
                } finally {
                    _exitLock = false;
                }
            }

            startFeed(jwt, feedToken, futureToken, async (tick) => {
                // Periodically log heartbeat 
                if (Math.random() < 0.05) {
                    logger.info(`📡 WS Heartbeat → LTP:${tick.ltp} Vol:${tick.volume} OI:${tick.oi}`);
                }
                // Continuous Exit Monitoring
                await handleLiveExit(jwt, tick.ltp);
            });

            logger.info("✅ WebSocket feed running — REST polling still active for candle strategy");
        } catch (err) {
            logger.error(`❌ WebSocket startup failed: ${err.message} — falling back to polling only`);
        }
    }

    // ── Main polling loop (always runs, even alongside WebSocket) ─────────
    while (true) {
        iteration++;

        try {
            logger.info(`🔄 Loop #${iteration} | IST: ${getISTTime()}`);

            const jwt = await login(forceLogin);
            forceLogin = false;

            const liveFrom = getTodayFromDate(29);
            const liveTo = formatCurrentDateTime();
            // const liveTo = process.env.LIVE_TO_DATE || formatCurrentDateTime();
            // const liveTo = "2026-03-02 10:11";
            const futureToken = await getFutureToken(process.env.INDEX_SYMBOL || "SENSEX");

            const windowKey = `${liveFrom}_${liveTo}`;
            if (windowKey !== _lastWindowLog) {
                logger.info(`📅 Window: ${liveFrom} → ${liveTo}`);
                _lastWindowLog = windowKey;
            }

            const signalObj = await entryEngine(jwt, liveFrom, liveTo, futureToken);

            const signalType = signalObj?.signal ?? "NO_TRADE";
            const isNoTrade = signalType === "NO_TRADE";

            if (isNoTrade) {
                _noTradeLogCount++;
                if (lastSignal !== "NO_TRADE" || _noTradeLogCount % 20 === 1) {
                    logger.info(`🎯 SIGNAL: NO_TRADE`);
                }
                lastSignal = "NO_TRADE";
            } else {
                _noTradeLogCount = 0;
                if (signalType !== lastSignal) {
                    logger.info(`🚨 NEW SIGNAL: ${signalType} | Entry:${signalObj.entryPrice} | SL:${signalObj.slPrice} | TGT:${signalObj.tgtPrice} | RR:${signalObj.riskReward}`);
                    lastSignal = signalType;
                }
            }


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

// ── Graceful shutdown ─────────────────────────────────────────────────────
process.on("SIGINT", () => { stopFeed(); logger.info("👋 Shutting down..."); process.exit(0); });
process.on("SIGTERM", () => { stopFeed(); logger.info("👋 Shutting down..."); process.exit(0); });

main();