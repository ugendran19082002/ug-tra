import winston from "winston";
import { logger, getISTTime } from "./logger.js";
import { sleep } from "./helpers.js";
import { getHistorical, getFuture, format } from "./api/historical.js";
import { generateSignal } from "./signals.js";

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

    // ── Fetch all timeframes
    logger.info("📥 Fetching 1m index...");
    const indexRaw1m = await getHistorical(jwt, "BSE", process.env.SYMBOLTOKEN, "ONE_MINUTE", btFrom, btTo);
    await sleep(500);
    logger.info("📥 Fetching 5m index...");
    const indexRaw5m = await getHistorical(jwt, "BSE", process.env.SYMBOLTOKEN, "FIVE_MINUTE", btFrom, btTo);
    await sleep(500);
    logger.info("📥 Fetching 15m index...");
    const indexRaw15m = await getHistorical(jwt, "BSE", process.env.SYMBOLTOKEN, "FIFTEEN_MINUTE", btFrom, btTo);
    await sleep(500);

    const p = n => String(n).padStart(2, "0");
    const warmupDate = new Date(btFrom);
    warmupDate.setDate(warmupDate.getDate() - 30);
    const dailyFrom = `${warmupDate.getFullYear()}-${p(warmupDate.getMonth() + 1)}-${p(warmupDate.getDate())} 09:15`;

    logger.info("📥 Fetching daily index...");
    const raw1D = await getHistorical(jwt, "BSE", process.env.SYMBOLTOKEN, "ONE_DAY", dailyFrom, btTo);
    await sleep(500);
    logger.info("📥 Fetching 1m future...");
    const futureRaw1m = await getFuture(futureToken, btFrom, btTo);

    if (!indexRaw1m.length || !futureRaw1m.length) {
        logger.error("❌ No data. Check API credentials or date range.");
        process.exit(1);
    }

    // ── Format + align index/future on matching timestamps
    const index1mAll = format(indexRaw1m);
    const index5mAll = format(indexRaw5m);
    const index15mAll = format(indexRaw15m);
    const future1mAll = format(futureRaw1m);
    const data1DAll = format(raw1D);

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
        logger.error("❌ Not enough aligned candles.");
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
            if (ist.getHours() * 60 + ist.getMinutes() >= (15 * 60 + 29) && !exitReason) {
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
    const totalPnL = trades.reduce((s, t) => s + t.pnl, 0);
    const winRate = trades.length > 0 ? ((winners.length / trades.length) * 100).toFixed(1) : 0;
    const avgWin = winners.length > 0 ? (winners.reduce((s, t) => s + t.pnl, 0) / winners.length).toFixed(2) : 0;
    const avgLoss = losers.length > 0 ? (losers.reduce((s, t) => s + t.pnl, 0) / losers.length).toFixed(2) : 0;
    const maxWin = winners.length > 0 ? Math.max(...winners.map(t => t.pnl)).toFixed(2) : 0;
    const maxLoss = losers.length > 0 ? Math.min(...losers.map(t => t.pnl)).toFixed(2) : 0;
    const totalSLPoints = trades.reduce((s, t) => s + (t.slPoints ?? 0), 0);
    const totalTGTPoints = trades.reduce((s, t) => s + (t.tgtPoints ?? 0), 0);

    let peak = 0, maxDD = 0, running = 0;
    for (const t of trades) {
        running += t.pnl;
        if (running > peak) peak = running;
        const dd = peak - running;
        if (dd > maxDD) maxDD = dd;
    }

    // ── Summary log
    btLogger.info("");
    btLogger.info("═══════════════════════════════════════════════════════");
    btLogger.info("  BACKTEST SUMMARY");
    btLogger.info("═══════════════════════════════════════════════════════");
    btLogger.info(`  Total Trades  : ${trades.length}`);
    btLogger.info(`  Winners       : ${winners.length}`);
    btLogger.info(`  Losers        : ${losers.length}`);
    btLogger.info(`  Win Rate      : ${winRate}%`);
    btLogger.info(`  Total PnL     : ${totalPnL >= 0 ? "+" : ""}${totalPnL.toFixed(2)} pts`);
    btLogger.info(`  Avg Win       : +${avgWin} pts`);
    btLogger.info(`  Avg Loss      : ${avgLoss} pts`);
    btLogger.info(`  Max Win       : +${maxWin} pts`);
    btLogger.info(`  Max Loss      : ${maxLoss} pts`);
    btLogger.info(`  Max Drawdown  : ${maxDD.toFixed(2)} pts`);
    btLogger.info(`  Total SL Points  : ${totalSLPoints.toFixed(2)} pts`);
    btLogger.info(`  Total TGT Points : ${totalTGTPoints.toFixed(2)} pts`);
    btLogger.info("═══════════════════════════════════════════════════════");

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

    return { trades, totalPnL, winRate, maxDD };
}