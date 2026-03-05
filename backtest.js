import dotenv from "dotenv";
dotenv.config();

import winston from "winston";
import { logger, getISTTime } from "./logger.js";
import { sleep, buildTimeframe } from "./helpers.js";
import { getHistorical, getFuture, format } from "./api/historical.js";
import { generateSignal } from "./signals.js";
import { login } from "./api/auth.js";

// ═════════════════════════════════════════════════════════════════════════════
//  BACKTEST
// ═════════════════════════════════════════════════════════════════════════════
export async function backtest(jwt, futureToken, btFrom, btTo, options = {}) {
    const {
        slPoints = 80,
        tgtPoints = 200,
        startBar = 30,
    } = options;

    const btLogger = winston.createLogger({
        level: "info",
        format: winston.format.combine(
            winston.format.printf(({ message }) => message)
        ),
        transports: [
            new winston.transports.Console(),
            new winston.transports.File({ filename: "backtest.log" })
        ]
    });

    btLogger.info("═══════════════════════════════════════════════════════");
    btLogger.info("  BACKTEST START");
    btLogger.info(`  Fallback SL: ${slPoints} | Fallback TGT: ${tgtPoints}`);
    btLogger.info(`  Window: ${btFrom} → ${btTo}`);
    btLogger.info("═══════════════════════════════════════════════════════");

    // ── Fetch with exponential backoff: 5s → 15s → 30s
    // AngelOne BSE historical blocks ALL requests when rate-limited
    // Exponential wait gives the API time to unblock
    async function fetchWithRetry(label, fn, maxRetries = 4) {
        logger.info(`📥 Fetching ${label}...`);
        const delays = [5000, 15000, 30000]; // 5s → 15s → 30s
        let attempt = 0;

        while (attempt < maxRetries) {
            try {
                const data = await fn();
                if (data && data.length) return data;

                if (attempt < maxRetries - 1) {
                    const wait = delays[attempt] ?? 30000;
                    logger.warn(`⚠ ${label} returned 0 — waiting ${wait / 1000}s before retry ${attempt + 1}/${maxRetries - 1}...`);
                    await sleep(wait);
                }
            } catch (err) {
                if (err.message === "INVALID_TOKEN") {
                    logger.warn(`🚨 ${label} failed: INVALID_TOKEN — attempting forced login...`);
                    try {
                        jwt = await login(true); // Update the jwt variable in outer scope
                        logger.info("✅ Re-login success, retrying fetch...");
                        // Don't increment attempt here, just retry with new token
                        continue;
                    } catch (loginErr) {
                        logger.error(`❌ Re-login failed: ${loginErr.message}`);
                        throw loginErr;
                    }
                }
                logger.error(`❌ ${label} error: ${err.message}`);
                if (attempt >= maxRetries - 1) throw err;
            }
            attempt++;
        }

        logger.warn(`⚠ ${label} still 0 after ${maxRetries - 1} retries`);
        return [];
    }

    const exchange = process.env.EXCHANGE || "BSE";
    const rawIndex1m = await fetchWithRetry("1m index", () => getHistorical(jwt, exchange, process.env.SYMBOLTOKEN, "ONE_MINUTE", btFrom, btTo));
    await sleep(2000);
    const rawIndex5m = await fetchWithRetry("5m index", () => getHistorical(jwt, exchange, process.env.SYMBOLTOKEN, "FIVE_MINUTE", btFrom, btTo));
    await sleep(2000);
    const rawIndex15m = await fetchWithRetry("15m index", () => getHistorical(jwt, exchange, process.env.SYMBOLTOKEN, "FIFTEEN_MINUTE", btFrom, btTo));
    await sleep(2000);

    const p = n => String(n).padStart(2, "0");
    const warmupDate = new Date(btFrom);
    warmupDate.setDate(warmupDate.getDate() - 30);
    const dailyFrom = `${warmupDate.getFullYear()}-${p(warmupDate.getMonth() + 1)}-${p(warmupDate.getDate())} 09:15`;

    const rawDaily = await fetchWithRetry("1D index", () => getHistorical(jwt, exchange, process.env.SYMBOLTOKEN, "ONE_DAY", dailyFrom, btTo));
    await sleep(1000);
    const rawFuture1m = await fetchWithRetry("1m future", () => getFuture(futureToken, btFrom, btTo));

    // Only abort if future data is missing OR both 1m AND 5m index are missing
    if (!rawFuture1m.length) {
        logger.error("❌ Future data missing — cannot run backtest without price/OI history");
        process.exit(1);
    }
    if (!rawIndex1m.length && !rawIndex5m.length) {
        logger.error("❌ Both 1m and 5m index data missing — aborting backtest");
        process.exit(1);
    }
    if (!rawIndex1m.length) {
        logger.warn("⚠ 1m index data missing — aligned candles may be 0, will check below");
    }

    // ── Format
    const index1mAll = format(rawIndex1m);
    const future1mAll = format(rawFuture1m);

    // ── buildTimeframe fallbacks (same as entryEngine)
    // 1 trading day = 375 one-minute candles (09:15 → 15:30)
    const index5mAll = rawIndex5m.length ? format(rawIndex5m) : buildTimeframe(index1mAll, 5);
    const index15mAll = rawIndex15m.length ? format(rawIndex15m) : buildTimeframe(index1mAll, 15);
    const data1DAll = rawDaily.length ? format(rawDaily) : buildTimeframe(index1mAll, 375);

    if (!rawIndex5m.length) logger.info("📐 5m  built from 1m candles");
    if (!rawIndex15m.length) logger.info("📐 15m built from 1m candles");
    if (!rawDaily.length) logger.info("📐 1D  built from 1m candles");

    // ── Align index/future on matching timestamps
    const futureMap = new Map(future1mAll.map(c => [c.time, c]));
    const alignedIndex = [], alignedFuture = [];
    for (const c of index1mAll) {
        if (futureMap.has(c.time)) {
            alignedIndex.push(c);
            alignedFuture.push(futureMap.get(c.time));
        }
    }

    btLogger.info(`  1m: ${alignedIndex.length} | 5m: ${index5mAll.length} | 15m: ${index15mAll.length} | 1D: ${data1DAll.length}`);

    if (alignedIndex.length < 60) {
        logger.error("❌ Not enough aligned candles — aborting backtest");
        process.exit(1);
    }


    const endBar = alignedIndex.length - 1;
    const trades = [];
    let openTrade = null;

    // Suppress debug logs during backtest loop
    const origLevel = logger.level;
    logger.level = "error";

    // ── Main simulation loop
    for (let i = startBar; i <= endBar; i++) {

        const index1m = alignedIndex.slice(0, i + 1);
        const future1m = alignedFuture.slice(0, i + 1);
        const currentTime = index1m[index1m.length - 1].time;

        const index5m = index5mAll.filter(c => c.time <= currentTime);
        const index15m = index15mAll.filter(c => c.time <= currentTime);
        const dailySlice = data1DAll.filter(d => d.time <= currentTime);

        const currentClose = index1m[index1m.length - 1].close;

        // ── Trade exit check
        if (openTrade) {
            let exitReason = null;
            let exitPrice = currentClose;

            if (openTrade.type === "CE") {
                if (currentClose <= openTrade.sl) { exitReason = "SL"; exitPrice = openTrade.sl; }
                if (currentClose >= openTrade.tgt) { exitReason = "TGT"; exitPrice = openTrade.tgt; }
            } else {
                if (currentClose >= openTrade.sl) { exitReason = "SL"; exitPrice = openTrade.sl; }
                if (currentClose <= openTrade.tgt) { exitReason = "TGT"; exitPrice = openTrade.tgt; }
            }

            const ist = new Date(new Date(currentTime).toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
            if ((ist.getHours() === 15 && ist.getMinutes() >= 29) && !exitReason) {
                exitReason = "EOD";
                exitPrice = currentClose;
            }

            if (exitReason) {
                const pnl = openTrade.type === "CE"
                    ? exitPrice - openTrade.entryPrice
                    : openTrade.entryPrice - exitPrice;

                const slPts = parseFloat(Math.abs(openTrade.entryPrice - openTrade.sl).toFixed(2));
                const tgtPts = parseFloat(Math.abs(openTrade.tgt - openTrade.entryPrice).toFixed(2));

                const trade = {
                    type: openTrade.type,
                    entryTime: openTrade.entryTime,
                    exitTime: currentTime,
                    entryPrice: openTrade.entryPrice,
                    exitPrice: parseFloat(exitPrice.toFixed(2)),
                    pnl: parseFloat(pnl.toFixed(2)),
                    exitReason,
                    entryBar: openTrade.entryBar,
                    exitBar: i,
                    sl: parseFloat(openTrade.sl.toFixed(2)),
                    tgt: parseFloat(openTrade.tgt.toFixed(2)),
                    slPoints: slPts,
                    tgtPoints: tgtPts,
                };
                trades.push(trade);

                btLogger.info(
                    `  EXIT  [${trade.type}] | ${exitReason.padEnd(3)} | ` +
                    `Entry: ${trade.entryPrice.toFixed(2)} @ bar[${trade.entryBar}] | ` +
                    `Exit : ${trade.exitPrice.toFixed(2)}  @ bar[${trade.exitBar}]  | ` +
                    `SL: ${trade.sl.toFixed(2)} TGT: ${trade.tgt.toFixed(2)} | ` +
                    `PnL  : ${pnl >= 0 ? "+" : ""}${trade.pnl.toFixed(2)}`
                );

                openTrade = null;
            }
        }

        // ── Trade entry check
        if (!openTrade) {
            const result = generateSignal(index1m, index5m, index15m, future1m, dailySlice);

            if (i % 200 === 0 && result.signal !== "NO_TRADE") {
                btLogger.info(
                    `  [bar ${i}] ${result.dailyBias} | ADX:${result.currentADX} RSI:${result.currentRSI}`
                );
            }

            if (result.signal === "CE" || result.signal === "PE") {
                const entryPrice = parseFloat(currentClose.toFixed(2));
                const sl = result.dynamicSL ?? slPoints;
                const tgt = result.dynamicTGT ?? tgtPoints;
                const slPrice = parseFloat((result.signal === "CE" ? entryPrice - sl : entryPrice + sl).toFixed(2));
                const tgtPrice = parseFloat((result.signal === "CE" ? entryPrice + tgt : entryPrice - tgt).toFixed(2));

                openTrade = {
                    type: result.signal,
                    entryPrice,
                    entryTime: currentTime,
                    entryBar: i,
                    sl: slPrice,
                    tgt: tgtPrice,
                };

                btLogger.info(
                    `  Volume : ${result.volume}\n` +
                    `  OI     : ${result.oi}\n` +
                    `  ENTRY [${result.signal}] | bar[${i}] | Close: ${entryPrice.toFixed(2)} | ` +
                    `SL: ${slPrice.toFixed(2)} (${sl.toFixed(2)}pts) | Tgt: ${tgtPrice.toFixed(2)} (${tgt.toFixed(2)}pts) | ` +
                    `ADX: ${result.currentADX} | RSI: ${result.currentRSI} | ATR: ${result.currentATR} | ` +
                    `Struct: Bull:${result.bullishStructure} Bear:${result.bearishStructure} | ` +
                    `Gap: ${result.gapPoints}pts | ` +
                    `IST: ${getISTTime(new Date(currentTime))}`
                );
            }
        }
    }

    logger.level = origLevel;

    // ── Close any open trade at last bar
    if (openTrade) {
        const lastClose = parseFloat(alignedIndex[endBar].close.toFixed(2));
        const pnl = openTrade.type === "CE"
            ? lastClose - openTrade.entryPrice
            : openTrade.entryPrice - lastClose;

        trades.push({
            type: openTrade.type,
            entryTime: openTrade.entryTime,
            exitTime: alignedIndex[endBar].time,
            entryPrice: openTrade.entryPrice,
            exitPrice: lastClose,
            pnl: parseFloat(pnl.toFixed(2)),
            exitReason: "LAST_BAR",
            entryBar: openTrade.entryBar,
            exitBar: endBar,
            sl: parseFloat(openTrade.sl.toFixed(2)),
            tgt: parseFloat(openTrade.tgt.toFixed(2)),
        });
    }

    // ── Summary stats
    const winners = trades.filter(t => t.pnl > 0);
    const losers = trades.filter(t => t.pnl < 0);
    const breakevens = trades.filter(t => t.pnl === 0);
    const totalPnL = trades.reduce((s, t) => s + t.pnl, 0);
    const winRate = trades.length > 0 ? ((winners.length / trades.length) * 100).toFixed(1) : 0;

    const sumWins = winners.reduce((s, t) => s + t.pnl, 0);
    const sumLosses = losers.reduce((s, t) => s + Math.abs(t.pnl), 0);
    const avgWin = winners.length > 0 ? (sumWins / winners.length).toFixed(2) : 0;
    const avgLoss = losers.length > 0 ? -(sumLosses / losers.length).toFixed(2) : 0;
    const maxWin = winners.length > 0 ? Math.max(...winners.map(t => t.pnl)).toFixed(2) : 0;
    const maxLoss = losers.length > 0 ? Math.min(...losers.map(t => t.pnl)).toFixed(2) : 0;

    const totalSLPoints = trades.reduce((s, t) => s + (t.slPoints ?? 0), 0);
    const totalTGTPoints = trades.reduce((s, t) => s + (t.tgtPoints ?? 0), 0);
    const slExitTrades = trades.filter(t => t.exitReason === "SL");
    const tgtExitTrades = trades.filter(t => t.exitReason === "TGT");
    const eodExitTrades = trades.filter(t => t.exitReason === "EOD");
    const slExitPoints = slExitTrades.reduce((s, t) => s + t.pnl, 0);
    const tgtExitPoints = tgtExitTrades.reduce((s, t) => s + t.pnl, 0);

    // ── Drawdown
    let peak = 0, maxDD = 0, running = 0;
    for (const t of trades) {
        running += t.pnl;
        if (running > peak) peak = running;
        const dd = peak - running;
        if (dd > maxDD) maxDD = dd;
    }

    // ── Advanced stats
    const profitFactor = sumLosses > 0 ? (sumWins / sumLosses).toFixed(2) : "∞";
    const wr = parseFloat(winRate) / 100;
    const expectancy = (wr * parseFloat(avgWin) + (1 - wr) * parseFloat(avgLoss)).toFixed(2);

    // Simplified Sharpe: avg PnL / stdDev PnL (per trade)
    const avgPnL = trades.length > 0 ? totalPnL / trades.length : 0;
    const variance = trades.length > 1
        ? trades.reduce((s, t) => s + Math.pow(t.pnl - avgPnL, 2), 0) / (trades.length - 1)
        : 0;
    const stdDevPnL = Math.sqrt(variance);
    const sharpe = stdDevPnL > 0 ? (avgPnL / stdDevPnL).toFixed(2) : "N/A";

    // ── Win / Loss streaks
    let maxWinStreak = 0, maxLossStreak = 0, curWin = 0, curLoss = 0;
    for (const t of trades) {
        if (t.pnl > 0) { curWin++; curLoss = 0; maxWinStreak = Math.max(maxWinStreak, curWin); }
        else { curLoss++; curWin = 0; maxLossStreak = Math.max(maxLossStreak, curLoss); }
    }

    // ── Daily breakdown
    const dailyMap = new Map(); // date → { trades, pnl, wins, losses }
    for (const t of trades) {
        const day = new Date(t.entryTime).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
        if (!dailyMap.has(day)) dailyMap.set(day, { trades: 0, pnl: 0, wins: 0, losses: 0 });
        const d = dailyMap.get(day);
        d.trades++;
        d.pnl += t.pnl;
        if (t.pnl > 0) d.wins++; else if (t.pnl < 0) d.losses++;
    }

    // ── Summary log
    btLogger.info("");
    btLogger.info("═══════════════════════════════════════════════════════");
    btLogger.info("  BACKTEST SUMMARY");
    btLogger.info("═══════════════════════════════════════════════════════");
    btLogger.info(`  From            : ${btFrom}`);
    btLogger.info(`  To              : ${btTo}`);
    btLogger.info(`  Total Trades    : ${trades.length}  (W:${winners.length} L:${losers.length} BE:${breakevens.length})`);
    btLogger.info(`  Win Rate        : ${winRate}%`);
    btLogger.info(`  Total PnL       : ${totalPnL >= 0 ? "+" : ""}${totalPnL.toFixed(2)} pts`);
    btLogger.info(`  Avg PnL/Trade   : ${avgPnL >= 0 ? "+" : ""}${avgPnL.toFixed(2)} pts`);
    btLogger.info(`  Avg Win         : +${avgWin} pts`);
    btLogger.info(`  Avg Loss        : ${avgLoss} pts`);
    btLogger.info(`  Max Win         : +${maxWin} pts`);
    btLogger.info(`  Max Loss        : ${maxLoss} pts`);
    btLogger.info(`  Max Drawdown    : ${maxDD.toFixed(2)} pts`);
    btLogger.info(`  Profit Factor   : ${profitFactor}`);
    btLogger.info(`  Expectancy/Trade: ${expectancy >= 0 ? "+" : ""}${expectancy} pts`);
    btLogger.info(`  Sharpe Ratio    : ${sharpe}`);
    btLogger.info(`  Max Win Streak  : ${maxWinStreak}`);
    btLogger.info(`  Max Loss Streak : ${maxLossStreak}`);
    btLogger.info(`  SL Exits        : ${slExitTrades.length}  | ${slExitPoints.toFixed(2)} pts`);
    btLogger.info(`  TGT Exits       : ${tgtExitTrades.length}  | +${tgtExitPoints.toFixed(2)} pts`);
    btLogger.info(`  EOD Exits       : ${eodExitTrades.length}`);
    btLogger.info(`  Total SL Pts    : ${totalSLPoints.toFixed(2)} pts`);
    btLogger.info(`  Total TGT Pts   : ${totalTGTPoints.toFixed(2)} pts`);
    btLogger.info("═══════════════════════════════════════════════════════");

    // ── Daily breakdown table
    btLogger.info("");
    btLogger.info("  DAILY BREAKDOWN");
    btLogger.info("  " + "─".repeat(60));
    btLogger.info("  " + "Date".padEnd(14) + "Trades".padEnd(9) + "Wins".padEnd(7) + "Losses".padEnd(9) + "PnL");
    btLogger.info("  " + "─".repeat(60));
    for (const [day, d] of [...dailyMap.entries()].sort()) {
        const pnlStr = (d.pnl >= 0 ? "+" : "") + d.pnl.toFixed(2) + " pts";
        btLogger.info(
            "  " +
            day.padEnd(14) +
            String(d.trades).padEnd(9) +
            String(d.wins).padEnd(7) +
            String(d.losses).padEnd(9) +
            pnlStr
        );
    }
    btLogger.info("  " + "─".repeat(60));

    // ── Trade-by-trade log
    btLogger.info("");
    btLogger.info("  TRADE LOG");
    btLogger.info("  " + "─".repeat(160));
    btLogger.info(
        "  " +
        "#".padEnd(5) + "Type".padEnd(6) +
        "Entry".padEnd(12) + "Exit".padEnd(12) +
        "SL".padEnd(12) + "TGT".padEnd(12) +
        "SLpts".padEnd(9) + "TGTpts".padEnd(9) +
        "PnL".padEnd(12) + "ExitR".padEnd(8) +
        "Bars".padEnd(7) + "Entry Time".padEnd(30) + "Exit Time"
    );
    btLogger.info("  " + "─".repeat(160));

    trades.forEach((t, idx) => {
        const pnlStr = (t.pnl >= 0 ? "+" : "") + t.pnl.toFixed(2);
        btLogger.info(
            "  " +
            String(idx + 1).padEnd(5) +
            t.type.padEnd(6) +
            t.entryPrice.toFixed(2).padEnd(12) +
            t.exitPrice.toFixed(2).padEnd(12) +
            t.sl.toFixed(2).padEnd(12) +
            t.tgt.toFixed(2).padEnd(12) +
            (t.slPoints != null ? t.slPoints.toFixed(2) : "-").padEnd(9) +
            (t.tgtPoints != null ? t.tgtPoints.toFixed(2) : "-").padEnd(9) +
            pnlStr.padEnd(12) +
            t.exitReason.padEnd(8) +
            String(t.exitBar - t.entryBar).padEnd(7) +
            getISTTime(new Date(t.entryTime)).padEnd(30) +
            getISTTime(new Date(t.exitTime))
        );
    });

    btLogger.info("═══════════════════════════════════════════════════════");
    btLogger.info("  Backtest complete. Results saved to backtest.log");
    btLogger.info("═══════════════════════════════════════════════════════");

    return {
        trades,
        totalPnL,
        winRate,
        maxDD,
        profitFactor,
        expectancy,
        sharpe,
        maxWinStreak,
        maxLossStreak,
        dailyBreakdown: Object.fromEntries(dailyMap),
    };
}