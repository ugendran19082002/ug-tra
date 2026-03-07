import dotenv from "dotenv";
dotenv.config();

import { logger, getISTTime } from "./logger.js";
import { sleep, getTodayFromDate, formatISTDateTime } from "./helpers.js";
import { login, clearTokenCache, getFeedToken } from "./api/auth.js";
import { getFutureToken } from "./api/tokens.js";
import { entryEngine, onTradeExit } from "./entryEngine.js";
import { backtest } from "./backtest.js";
import { startFeed, stopFeed, isFeedConnected } from "./wsMarketFeed.js";
import { isOpen, getPosition } from "./positionManager.js";
import { checkExitAndCleanup, getPositions, cleanupOrders } from "./order.js";

const USE_WEBSOCKET = process.env.USE_WEBSOCKET === "true";

// How long to wait after opening a position before polling broker for exit.
// AngelOne takes a few seconds to reflect the BUY in netqty — without this
// guard, the poll fires in the same loop tick and sees netqty=0, immediately
// false-closing the brand new position.
const BROKER_SETTLE_MS = parseInt(process.env.BROKER_SETTLE_MS ?? "10000"); // default 30s

// ─────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────
async function main() {

    const isBacktest = process.env.BACKTEST === "true" || process.argv.includes("--backtest");

    if (isBacktest) {
        logger.info("🧪 BACKTEST MODE");

        const btFrom = getTodayFromDate(29);
        const btTo = formatISTDateTime();
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

    // Tracks when the last position was opened (ms timestamp).
    // Used to skip broker-exit polling during the settling window.
    let _positionOpenedAt = null;

    // ── Single-exit guard ────────────────────────────────────────────────
    // Prevents both WebSocket handler AND REST poll from calling
    // onTradeExit() for the same trade (double dailyTrades count).
    // _exitLock  : true while an exit is being processed (async in-flight)
    // _exitFired : true once onTradeExit() has been called for this trade
    //              Reset to false only when a NEW position opens.
    let _exitLock = false;
    let _exitFired = false;

    function safeExit(pnl, reason, exitPrice = NaN) {
        if (_exitFired) {
            logger.warn(`⚠ safeExit: duplicate exit suppressed (reason: ${reason}) — trade already closed`);
            return;
        }
        _exitFired = true;
        _exitLock = false; // release in-flight lock before notifying
        onTradeExit(pnl, reason, exitPrice);
        _positionOpenedAt = null;
        logger.debug(`🔒 safeExit: fired [${reason}] | PnL:${pnl}`);
    }

    // ── WebSocket mode ───────────────────────────────────────────────────
    if (USE_WEBSOCKET) {
        logger.info("🔌 Starting WebSocket feed...");
        try {
            const jwt = await login();
            const futureToken = await getFutureToken(process.env.INDEX_SYMBOL || "SENSEX");
            const feedToken = getFeedToken() || process.env.FEED_TOKEN || "";

            async function handleLiveExit(jwt, tickLtp) {
                // _exitLock  : prevents concurrent WS ticks from double-processing
                // _exitFired : prevents WS + REST poll both calling onTradeExit()
                if (_exitLock || _exitFired || !isOpen()) return;

                // Skip exit monitoring during settling window after a new entry
                if (_positionOpenedAt && (Date.now() - _positionOpenedAt < BROKER_SETTLE_MS)) return;

                const pos = getPosition();
                if (!pos || pos.side === "NO_TRADE") return;

                _exitLock = true;

                try {
                    const price = parseFloat(tickLtp);
                    const isPE = pos.side === "PE";

                    const indexTriggered = isPE
                        ? (price >= pos.sl || price <= pos.target)
                        : (price <= pos.sl || price >= pos.target);

                    const status = await checkExitAndCleanup(jwt, pos.optionSymbol, {
                        currentIndexLTP: tickLtp,
                        indexSL: pos.sl,
                        indexTGT: pos.target,
                        isPE
                    });

                    if (status && status.exited) {
                        const exitReason = indexTriggered ? "TGT/SL HIT (INDEX LTP)" : "BROKER SL/TGT FILLED";
                        const pnl = isPE ? pos.entry - price : price - pos.entry;
                        logger.info(`🚨 LIVE EXIT [${exitReason}]: ${pos.side} closed @ ${tickLtp}`);
                        const actualExitPrice = status.exitPrice && !isNaN(status.exitPrice) ? status.exitPrice : price;
                        safeExit(pnl, exitReason, actualExitPrice); // ✅ single-exit guard
                    }
                } catch (err) {
                    logger.error(`❌ Live Exit Error: ${err.message}`);
                } finally {
                    _exitLock = false;
                }
            }

            startFeed(jwt, feedToken, futureToken, async (tick) => {
                if (Math.random() < 0.05) {
                    logger.info(`📡 WS Heartbeat → LTP:${tick.ltp} Vol:${tick.volume} OI:${tick.oi}`);
                }
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

            // ✅ Use formatISTDateTime() — always returns real IST time.
            // The old formatCurrentDateTime() used getHours() which is LOCAL time
            // (UTC on most servers), making todate 5:30h behind — API returns no data.
            const liveFrom = getTodayFromDate(29);
            // const liveTo = formatISTDateTime();
            // const liveTo = process.env.LIVE_TO_DATE || formatCurrentDateTime();
            const liveTo = "2026-03-06 14:42";
            const futureToken = await getFutureToken(process.env.INDEX_SYMBOL || "SENSEX", liveTo);

            const windowKey = `${liveFrom}_${liveTo}`;
            if (windowKey !== _lastWindowLog) {
                logger.info(`📅 Window: ${liveFrom} → ${liveTo}`);
                _lastWindowLog = windowKey;
            }

            const signalObj = await entryEngine(jwt, liveFrom, liveTo, futureToken);

            // If entryEngine returned a live signal (not NO_TRADE), a position was
            // just opened — record the timestamp so the broker poll skips this window.
            if (signalObj?.signal && signalObj.signal !== "NO_TRADE") {
                _positionOpenedAt = Date.now();
                _exitFired = false; // ✅ reset guard — new trade, fresh exit slot
                logger.debug(`📍 Position opened — broker poll paused for ${BROKER_SETTLE_MS / 1000}s settling`);
            }

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

            // ── Broker exit safety net ─────────────────────────────────────────
            // Detects when broker's own SL-M or Target order has filled, so we can
            // reset positionManager and allow the next entry.
            //
            // ⚠ CRITICAL: skip during BROKER_SETTLE_MS after opening.
            // The BUY order takes a few seconds to reflect in AngelOne's netqty.
            // Without this guard, the poll sees netqty=0 immediately after entry
            // and false-closes the position before it even starts monitoring.
            const positionJustOpened = _positionOpenedAt && (Date.now() - _positionOpenedAt < BROKER_SETTLE_MS);

            if (isOpen() && !positionJustOpened) {
                // ✅ Skip REST poll if WebSocket is already processing an exit
                if (_exitLock || _exitFired) {
                    logger.debug("⏭ REST poll skipped — WS exit already in progress or fired");
                } else {
                    const pos = getPosition();
                    if (pos?.optionSymbol) {
                        try {
                            const status = await checkExitAndCleanup(jwt, pos.optionSymbol, { isPE: pos.side === "PE" });
                            if (status && status.exited) {
                                logger.info(`🔔 Polling detected BROKER EXIT for ${pos.optionSymbol} — resetting state`);
                                // Fallback: if no filled order found in order book (e.g. all AMO cancelled),
                                // use the option's stored entry LTP as a rough exit price rather than NaN.
                                let exitPx = status.exitPrice;
                                if (isNaN(exitPx) || exitPx === 0) {
                                    exitPx = parseFloat(pos.optionEntry ?? NaN);
                                    if (!isNaN(exitPx)) {
                                        logger.warn(`⚠ Exit price not in order book — using optionEntry as fallback: ${exitPx}`);
                                    } else {
                                        logger.warn(`⚠ Exit price unavailable: no filled order found and no optionEntry stored`);
                                    }
                                }
                                safeExit(0, "BROKER SL/TGT FILLED (POLL)", exitPx); // ✅ single-exit guard
                            }
                        } catch (err) {
                            logger.warn(`⚠ Broker exit poll error: ${err.message}`);
                        }
                    }
                }
            } else if (positionJustOpened) {
                const elapsed = ((Date.now() - _positionOpenedAt) / 1000).toFixed(0);
                logger.debug(`⏳ Broker poll skipped — settling (${elapsed}s / ${BROKER_SETTLE_MS / 1000}s)`);
            }

        } catch (err) {
            logger.error(`❌ Loop #${iteration} Error: ${err.message}`);
            if (err.message === "INVALID_TOKEN") {
                logger.warn("🚨 Session expired — clearing cache and re-logging on next loop...");
                clearTokenCache();
                forceLogin = true;
            }
        }

        await sleep(3_000);
    }
}

// ── Graceful shutdown ─────────────────────────────────────────────────────
process.on("SIGINT", () => { stopFeed(); logger.info("👋 Shutting down..."); process.exit(0); });
process.on("SIGTERM", () => { stopFeed(); logger.info("👋 Shutting down..."); process.exit(0); });

main();