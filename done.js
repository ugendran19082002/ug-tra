require("dotenv").config();
const axios = require("axios");
const fs = require("fs");
const os = require("os");
const speakeasy = require("speakeasy");
const winston = require("winston");

const BASE_URL = "https://apiconnect.angelone.in";

// ─────────────────────────────────────────
// IST TIME (Asia/Kolkata UTC+5:30)
// ─────────────────────────────────────────
function getISTTime(date = new Date()) {
    return date.toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
    }).replace(",", " |");
}

// ─────────────────────────────────────────
// LOGGER
// ─────────────────────────────────────────
const logger = winston.createLogger({
    level: "debug",
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) =>
            `${timestamp} [IST: ${getISTTime()}] [${level.toUpperCase()}]: ${message}`
        )
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: "bot.log" })
    ]
});

const tradeLogger = winston.createLogger({
    level: "info",
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, message }) =>
            `${timestamp} [IST: ${getISTTime()}] | ${message}`
        )
    ),
    transports: [
        new winston.transports.File({ filename: "trade.log" })
    ]
});

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function getLocalIP() {
    for (const ifaces of Object.values(os.networkInterfaces())) {
        for (const iface of ifaces) {
            if (iface.family === "IPv4" && !iface.internal) return iface.address;
        }
    }
    return "127.0.0.1";
}

function buildHeaders(jwtToken = null) {
    return {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "X-UserType": "USER",
        "X-SourceID": "WEB",
        "X-ClientLocalIP": getLocalIP(),
        "X-ClientPublicIP": getLocalIP(),
        "X-MACAddress": "00:00:00:00:00:00",
        "X-PrivateKey": process.env.API_KEY,
        ...(jwtToken && { Authorization: `Bearer ${jwtToken}` })
    };
}

function formatDateTime(date = new Date()) {
    const p = n => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ` +
        `${p(date.getHours())}:${p(date.getMinutes())}`;
}

// ─────────────────────────────────────────
// Dynamic date helpers
// ─────────────────────────────────────────
function getTodayFromDate() {
    const p = n => String(n).padStart(2, "0");
    const d = new Date();
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} 09:15`;
}

function getDailyFromDate() {
    const p = n => String(n).padStart(2, "0");
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} 09:15`;
}

// ─────────────────────────────────────────
// Market hours check (IST)
// ─────────────────────────────────────────
function isMarketOpen() {
    const now = new Date();
    const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const h = ist.getHours();
    const m = ist.getMinutes();
    const mins = h * 60 + m;
    return mins >= (9 * 60 + 15) && mins <= (15 * 60 + 30);
}

// ─────────────────────────────────────────
// LOGIN
// ─────────────────────────────────────────
async function login() {
    try {
        logger.info("🔐 Logging in...");
        const otp = speakeasy.totp({ secret: process.env.TOTP_SECRET, encoding: "base32" });

        const res = await axios.post(
            `${BASE_URL}/rest/auth/angelbroking/user/v1/loginByPassword`,
            { clientcode: process.env.CLIENT_ID, password: process.env.PASSWORD, totp: otp },
            { headers: buildHeaders() }
        );

        logger.info("✅ Login Success");
        return res.data.data.jwtToken;

    } catch (err) {
        logger.error(`❌ Login Failed: ${JSON.stringify(err.response?.data || err.message)}`);
        process.exit(1);
    }
}

// ─────────────────────────────────────────
// ✅ FIX #1 — getHistorical: dynamic fromdate + todate (no hardcoded dates ever again)
// ─────────────────────────────────────────
async function getHistorical(jwt, exchange, token, interval, fromdate, todate, retries = 3) {
    const body = { exchange, symboltoken: token, interval, fromdate, todate };

    try {
        logger.debug(`📊 Fetching ${interval} | ${exchange} | ${token} | ${fromdate} → ${todate}`);
        const res = await axios.post(
            `${BASE_URL}/rest/secure/angelbroking/historical/v1/getCandleData`,
            body,
            { headers: buildHeaders(jwt) }
        );
        logger.info(`📈 ${interval} candles: ${res.data.data.length}`);
        return res.data.data;

    } catch (err) {
        if (err.response?.status === 403 && retries > 0) {
            logger.warn(`⚠ Rate-limit — retrying in 2s… (${retries} left)`);
            await sleep(2000);
            return getHistorical(jwt, exchange, token, interval, fromdate, todate, retries - 1);
        }
        logger.error(`❌ Historical failed: ${err.message}`);
        return [];
    }
}

// ─────────────────────────────────────────
// GET OI DATA
// ─────────────────────────────────────────
async function getOIData(jwt, token, interval = "ONE_MINUTE", retries = 3) {
    const body = {
        exchange: "BFO",
        symboltoken: token,
        interval,
        fromdate: getTodayFromDate(),
        todate: formatDateTime()
    };

    try {
        logger.debug(`📊 Fetching OI | token: ${token}`);
        const res = await axios.post(
            `${BASE_URL}/rest/secure/angelbroking/historical/v1/getOIData`,
            body,
            { headers: buildHeaders(jwt) }
        );
        logger.info(`📈 OI candles: ${res.data.data.length}`);
        return res.data.data;

    } catch (err) {
        if (err.response?.status === 403 && retries > 0) {
            logger.warn(`⚠ OI Rate-limit — retrying in 2s… (${retries} left)`);
            await sleep(2000);
            return getOIData(jwt, token, interval, retries - 1);
        }
        logger.error(`❌ OI fetch failed: ${err.message}`);
        return [];
    }
}

// ─────────────────────────────────────────
// FORMAT
// ─────────────────────────────────────────
const format = raw => raw.map(c => ({
    time: c[0],
    open: c[1],
    high: c[2],
    low: c[3],
    close: c[4],
    volume: c[5],
    oi: c[6] ?? 0
}));

// ─────────────────────────────────────────
// BUILD HIGHER TIMEFRAME
// ─────────────────────────────────────────
function buildTimeframe(data, size) {
    const result = [];
    for (let i = 0; i < data.length; i += size) {
        const chunk = data.slice(i, i + size);
        if (chunk.length < size) continue;
        result.push({
            time: chunk[0].time,
            open: chunk[0].open,
            high: Math.max(...chunk.map(c => c.high)),
            low: Math.min(...chunk.map(c => c.low)),
            close: chunk[chunk.length - 1].close,
            volume: chunk.reduce((s, c) => s + c.volume, 0)
        });
    }
    return result;
}

// ─────────────────────────────────────────
// EMA
// ─────────────────────────────────────────
function calculateEMA(data, period = 20) {
    const k = 2 / (period + 1);
    let ema = data[0].close;
    return data.map(c => (ema = c.close * k + ema * (1 - k)));
}

// ─────────────────────────────────────────
// SWING S/R
// ─────────────────────────────────────────
function findSupportResistance(data, window = 8) {
    const supports = [], resistances = [];
    for (let i = window; i < data.length - window; i++) {
        let isSupport = true, isResistance = true;
        for (let j = i - window; j <= i + window; j++) {
            if (data[j].low < data[i].low) isSupport = false;
            if (data[j].high > data[i].high) isResistance = false;
        }
        if (isSupport) supports.push(data[i].low);
        if (isResistance) resistances.push(data[i].high);
    }
    return { supports, resistances };
}

// ─────────────────────────────────────────
// ROUND LEVELS
// ─────────────────────────────────────────
function getRoundLevels(price, step = 500) {
    const base = Math.floor(price / step) * step;
    return [base - step, base, base + step, base + step * 2];
}

// ─────────────────────────────────────────
// CLEAN LEVELS
// ─────────────────────────────────────────
function cleanLevels(levels, threshold = 20) {
    levels.sort((a, b) => a - b);
    return levels.reduce((acc, lvl) => {
        if (acc.length === 0 || Math.abs(lvl - acc[acc.length - 1]) > threshold)
            acc.push(lvl);
        return acc;
    }, []);
}

// ─────────────────────────────────────────
// VOLUME SPIKE
// ─────────────────────────────────────────
function volumeSpike(data, index) {
    if (index < 10) return false;
    const avg = data.slice(index - 10, index).reduce((s, c) => s + c.volume, 0) / 10;
    return data[index].volume > avg * 1.3;
}

// ─────────────────────────────────────────
// OI ANALYSIS  (shared by live + backtest)
// ─────────────────────────────────────────
function analyzeOI(future1m, oiData) {
    const fLen = future1m.length;
    const oLen = oiData?.length ?? 0;

    const useRealOI = oLen >= 5;
    const len = useRealOI ? oLen : fLen;

    if (len < 5) {
        return { signal: "NEUTRAL", label: "⚪ Insufficient OI data", priceDiff: "0.00", oiDiff: 0, oiChangePct: "0.00" };
    }

    const currPrice = future1m[fLen - 1].close;
    const prevPrice = future1m[fLen - 5].close;
    const currOI = useRealOI ? oiData[oLen - 1].oi : future1m[fLen - 1].oi;
    const prevOI = useRealOI ? oiData[oLen - 5].oi : future1m[fLen - 5].oi;

    const priceUp = currPrice > prevPrice;
    const priceDown = currPrice < prevPrice;

    const oiChangePct = prevOI > 0 ? Math.abs((currOI - prevOI) / prevOI) * 100 : 0;
    const oiUp = currOI > prevOI && oiChangePct >= 0.5;
    const oiDown = currOI < prevOI && oiChangePct >= 0.5;

    const priceDiff = (currPrice - prevPrice).toFixed(2);
    const oiDiff = currOI - prevOI;

    if (priceUp && oiUp) return { signal: "BULLISH", label: "📈 Long Build-up (Strong Bullish)", priceDiff, oiDiff, oiChangePct: oiChangePct.toFixed(2) };
    if (priceDown && oiUp) return { signal: "BEARISH", label: "📉 Short Build-up (Strong Bearish)", priceDiff, oiDiff, oiChangePct: oiChangePct.toFixed(2) };
    if (priceUp && oiDown) return { signal: "WEAK_BULLISH", label: "🔄 Short Covering (Weak Bullish)", priceDiff, oiDiff, oiChangePct: oiChangePct.toFixed(2) };
    if (priceDown && oiDown) return { signal: "WEAK_BEARISH", label: "🔄 Long Unwinding (Weak Bearish)", priceDiff, oiDiff, oiChangePct: oiChangePct.toFixed(2) };

    return { signal: "NEUTRAL", label: "⚪ Neutral (OI change < 0.5%)", priceDiff, oiDiff, oiChangePct: oiChangePct.toFixed(2) };
}

// ─────────────────────────────────────────
// FUTURE TOKEN (cached daily)
// ─────────────────────────────────────────
async function getFutureToken(symbolName = "SENSEX") {
    const today = new Date().toDateString();

    if (process.env.FUTURE_TOKEN && process.env.FUTURE_TOKEN_DATE === today) {
        logger.info("♻ Using cached future token");
        return process.env.FUTURE_TOKEN;
    }

    logger.info("🔄 Fetching new future token...");
    const res = await axios.get(
        "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json"
    );

    const monthMap = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
    const parseExpiry = str => new Date(parseInt(str.slice(5)), monthMap[str.slice(2, 5)], parseInt(str.slice(0, 2)));

    const now = new Date();
    const futures = res.data
        .filter(i => i.exch_seg === "BFO" && i.instrumenttype === "FUTIDX" && i.name === symbolName)
        .map(i => ({ ...i, expiryDate: parseExpiry(i.expiry) }))
        .filter(i => i.expiryDate >= now)
        .sort((a, b) => a.expiryDate - b.expiryDate);

    if (!futures.length) { logger.error("No valid futures found"); process.exit(1); }

    const current = futures[0];
    logger.info(`✅ Future: ${current.symbol} | token: ${current.token} | expiry: ${current.expiry}`);

    let env = fs.readFileSync(".env", "utf8");
    env = env.replace(/FUTURE_TOKEN=.*/, `FUTURE_TOKEN=${current.token}`);
    env = env.replace(/FUTURE_TOKEN_DATE=.*/, `FUTURE_TOKEN_DATE=${today}`);
    fs.writeFileSync(".env", env);

    return current.token;
}


// ═════════════════════════════════════════════════════════════════════════════
//  ✅ STRUCTURAL FIX — Single unified signal engine
//
//  generateSignal() is called by BOTH live (entryEngine) and backtest loop.
//  One function. One logic. Zero mismatch between live & backtest.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * generateSignal()
 *
 * Pure function — no side effects, no logging, no API calls.
 *
 * @param {Array} index1m   - 1m index candles  (sliced to current bar)
 * @param {Array} future1m  - 1m future candles (sliced to current bar)
 * @param {Array} data1D    - Daily candles      (sliced to current bar — no lookahead)
 * @param {Array} oiData    - OI data (live: from API  |  backtest: [] → falls back to candle OI)
 *
 * @returns {{ signal: "CE"|"PE"|"NO_TRADE", ...diagnostics }}
 */
function generateSignal(index1m, future1m, data1D, oiData = []) {

    // ── Build timeframes
    const index5m = buildTimeframe(index1m, 5);
    const index15m = buildTimeframe(index1m, 15);

    if (!index5m.length || !index15m.length)
        return { signal: "NO_TRADE", reason: "insufficient timeframe data" };

    // ── Daily bias (EMA + candle color must both agree)
    const dailyData = (data1D?.length >= 2) ? data1D : buildTimeframe(index1m, 375);
    if (dailyData.length < 2)
        return { signal: "NO_TRADE", reason: "insufficient daily data" };

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

    // ── Previous day S/R
    const prevDay = dailyData[dailyData.length - 2];
    const prevHigh = prevDay?.high ?? 0;
    const prevLow = prevDay?.low ?? 0;

    // ── Swing S/R (from 15m for cleaner levels)
    const { supports, resistances } = findSupportResistance(index15m);

    // ── Round levels
    const currentPrice = index5m[index5m.length - 1].close;
    const roundLevels = getRoundLevels(currentPrice);

    const finalSupports = cleanLevels([...supports, prevLow, ...roundLevels.filter(r => r < currentPrice)]);
    const finalResistances = cleanLevels([...resistances, prevHigh, ...roundLevels.filter(r => r > currentPrice)]);

    // ── 5m EMA trend
    const ema5m = calculateEMA(index5m);
    const last5m = index5m[index5m.length - 1];
    const trendUp = last5m.close > ema5m[ema5m.length - 1];
    const trendDown = last5m.close < ema5m[ema5m.length - 1];

    // ── 5-bar breakout (close vs last 5 bars' high/low)
    const last1m = index1m[index1m.length - 1];
    const prev1m = index1m[index1m.length - 2];
    const last5 = index1m.slice(-6, -1);
    const max5High = Math.max(...last5.map(c => c.high));
    const min5Low = Math.min(...last5.map(c => c.low));

    const breakUp = last1m.close > max5High;
    const breakDown = last1m.close < min5Low;

    // ── S/R proximity (within 50 pts)
    const SR_THRESHOLD = 50;
    const nearSupport = finalSupports.filter(s => s < last1m.close).pop();
    const nearResistance = finalResistances.find(r => r > last1m.close);

    const breakBelow = nearSupport && last1m.close < nearSupport && Math.abs(last1m.close - nearSupport) <= SR_THRESHOLD;
    const breakAbove = nearResistance && last1m.close > nearResistance && Math.abs(last1m.close - nearResistance) <= SR_THRESHOLD;

    // ── Volume spike
    const volConfirm = volumeSpike(future1m, future1m.length - 1);

    // ── Big candle (range > 1.5x prev AND body > 60% of range)
    const body = Math.abs(last1m.close - last1m.open);
    const range = last1m.high - last1m.low;
    const strongBody = range > 0 && (body / range) > 0.6;
    const bigCandle = (range > (prev1m.high - prev1m.low) * 1.5) && strongBody;

    // ── OI analysis (shared fn — live uses API oiData, backtest falls back to candle OI)
    const oi = analyzeOI(future1m, oiData);

    // ── ✅ FIX #6 — Spread filter: block if > 200 pts (expiry/spike protection)
    const lastFuture = future1m[future1m.length - 1];
    const spread = lastFuture.close - last1m.close;
    if (Math.abs(spread) > 200)
        return { signal: "NO_TRADE", reason: `spread too wide: ${spread.toFixed(2)}` };

    // ── Diagnostics bundle (used by live logger + backtest entry log)
    const diag = {
        dailyBias, emaAbove, bullCandle, bearCandle,
        trendUp, trendDown,
        breakUp, breakDown, breakAbove, breakBelow,
        bigCandle, strongBody, volConfirm,
        spread: spread.toFixed(2),
        oi,
        indexLTP: last1m.close,
        futureLTP: lastFuture.close,
        finalSupports, finalResistances,
    };

    // ── PE ENTRY
    if (
        dailyBias === "BEARISH" &&
        (trendDown || bigCandle) &&
        (breakDown || breakBelow) &&
        volConfirm
    ) return { signal: "PE", ...diag };

    // ── CE ENTRY
    if (
        dailyBias === "BULLISH" &&
        (trendUp || bigCandle) &&
        (breakUp || breakAbove) &&
        volConfirm
    ) return { signal: "CE", ...diag };

    return { signal: "NO_TRADE", ...diag };
}


// ─────────────────────────────────────────
// ENTRY ENGINE (live) — thin wrapper around generateSignal()
// ─────────────────────────────────────────
async function entryEngine(index1m, future1m, data1D, oiData = []) {

    const index5m = buildTimeframe(index1m, 5);
    const index15m = buildTimeframe(index1m, 15);
    const index1H = buildTimeframe(index1m, 60);
    logger.info(`Timeframes → 5m:${index5m.length} 15m:${index15m.length} 1H:${index1H.length}`);

    const r = generateSignal(index1m, future1m, data1D, oiData);

    // ── OI log
    if (r.oi) {
        logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        logger.info(`📊 OI | Source: ${oiData?.length >= 5 ? "API" : "Candle"} | ${r.oi.label}`);
        logger.info(`   Price Δ: ${r.oi.priceDiff} | OI Δ: ${r.oi.oiDiff} (${r.oi.oiChangePct}%)`);
    }

    logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    logger.info(`📍 INDEX  LTP → ${r.indexLTP}  | IST: ${getISTTime(new Date(index1m[index1m.length - 1].time))}`);
    logger.info(`📍 FUTURE LTP → ${r.futureLTP} | IST: ${getISTTime(new Date(future1m[future1m.length - 1].time))}`);
    logger.info(`📊 Spread      → ${r.spread}`);
    logger.info(`🕐 System IST  → ${getISTTime()}`);
    logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    logger.info(`Daily Bias  : ${r.dailyBias} | EMAAbove:${r.emaAbove} | bull:${r.bullCandle} | bear:${r.bearCandle}`);
    logger.info(`trendUp:${r.trendUp} trendDown:${r.trendDown}`);
    logger.info(`breakUp:${r.breakUp} breakDown:${r.breakDown} | breakAbove:${r.breakAbove} breakBelow:${r.breakBelow}`);
    logger.info(`bigCandle:${r.bigCandle} strongBody:${r.strongBody} volConfirm:${r.volConfirm}`);
    logger.info(`Supports: ${JSON.stringify(r.finalSupports)}`);
    logger.info(`Resistances: ${JSON.stringify(r.finalResistances)}`);

    if (r.signal === "NO_TRADE") {
        logger.info(`⚪ NO TRADE | ${r.reason ?? "conditions not met"}`);
        return "⚪ NO TRADE";
    }

    const isPE = r.signal === "PE";
    const msg = isPE ? `
🟥 *PE ENTRY SIGNAL*

📉 Bias   : ${r.dailyBias}
🕒 Time   : ${getISTTime()}

━━━━━━━━━━━━━━━━━━
📊 Price Info
Index LTP   : ${r.indexLTP}
Future LTP  : ${r.futureLTP}
Spread      : ${r.spread}

━━━━━━━━━━━━━━━━━━
📌 Conditions
Trend Down  : ${r.trendDown}
Big Candle  : ${r.bigCandle}
Break Down  : ${r.breakDown}
Break Below : ${r.breakBelow}
Volume OK   : ${r.volConfirm}

━━━━━━━━━━━━━━━━━━
📉 OI
${r.oi.label}
Price Δ     : ${r.oi.priceDiff}
OI Δ        : ${r.oi.oiDiff} (${r.oi.oiChangePct}%)
━━━━━━━━━━━━━━━━━━
` : `
🟢 *CE ENTRY SIGNAL*

📈 Bias   : ${r.dailyBias}
🕒 Time   : ${getISTTime()}

━━━━━━━━━━━━━━━━━━
📊 Price Info
Index LTP   : ${r.indexLTP}
Future LTP  : ${r.futureLTP}
Spread      : ${r.spread}

━━━━━━━━━━━━━━━━━━
📌 Conditions
Trend Up    : ${r.trendUp}
Big Candle  : ${r.bigCandle}
Break Up    : ${r.breakUp}
Break Above : ${r.breakAbove}
Volume OK   : ${r.volConfirm}

━━━━━━━━━━━━━━━━━━
📈 OI
${r.oi.label}
Price Δ     : ${r.oi.priceDiff}
OI Δ        : ${r.oi.oiDiff} (${r.oi.oiChangePct}%)
━━━━━━━━━━━━━━━━━━
`;

    tradeLogger.info(msg);
    await sendTelegram(msg);
    return isPE ? "🟥 PE ENTRY" : "🟢 CE ENTRY";
}

// ─────────────────────────────────────────
// TELEGRAM
// ─────────────────────────────────────────
async function sendTelegram(message) {
    try {
        const res = await axios.post(
            `https://api.telegram.org/bot${process.env.TG_TOKEN}/sendMessage`,
            { chat_id: process.env.TG_CHAT_ID, text: message }
        );
        logger.info(`📱 Telegram sent | msg_id: ${res.data.result.message_id}`);
    } catch (err) {
        logger.error(`📱 Telegram error: ${err.response?.data?.description || err.message}`);
    }
}


// ═════════════════════════════════════════════════════════════════════════════
//  BACKTEST
// ═════════════════════════════════════════════════════════════════════════════

/**
 * backtest()
 *
 * @param {Array}  index1mAll   - Full formatted 1m index candles
 * @param {Array}  future1mAll  - Full formatted 1m future candles (same length as index)
 * @param {Array}  data1D       - Full daily candles (sliced per bar inside loop — no lookahead)
 * @param {Object} options
 *   @param {number} options.slPoints   - Stop-loss in index points  (default 80)
 *   @param {number} options.tgtPoints  - Target in index points      (default 200)
 *   @param {number} options.startBar   - Start candle index          (default 30)
 *   @param {number} options.endBar     - End candle index            (default all)
 */
async function backtest(index1mAll, future1mAll, data1D, options = {}) {
    const {
        slPoints = 80,
        tgtPoints = 200,
        startBar = 30,
        endBar = index1mAll.length - 1,
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
    btLogger.info(`  SL: ${slPoints} pts | Target: ${tgtPoints} pts`);
    btLogger.info(`  Range: bar[${startBar}] → bar[${endBar}]`);
    btLogger.info(`  Total 1m candles: ${index1mAll.length}`);
    btLogger.info("═══════════════════════════════════════════════════════");

    const trades = [];
    let openTrade = null;

    // Suppress live logger noise during scan
    const origLevel = logger.level;
    logger.level = "error";

    for (let i = startBar; i <= endBar; i++) {

        // ── Slice up to current bar only (simulate live data stream)
        const index1m = index1mAll.slice(0, i + 1);
        const future1m = future1mAll.slice(0, i + 1);

        const currentClose = index1m[index1m.length - 1].close;
        const currentTime = index1m[index1m.length - 1].time;

        // ── ✅ FIX #2 — Slice daily candles to current bar (eliminates lookahead bias)
        const dailySlice = data1D.filter(d => new Date(d.time) <= new Date(currentTime));

        // ── Exit check (runs before entry — no same-bar entry+exit)
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

            // Force exit at 15:29 IST
            const ist = new Date(new Date(currentTime).toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
            if (ist.getHours() * 60 + ist.getMinutes() >= (15 * 60 + 29) && !exitReason) {
                exitReason = "EOD";
                exitPrice = currentClose;
            }

            if (exitReason) {
                const pnl = openTrade.type === "CE"
                    ? exitPrice - openTrade.entryPrice
                    : openTrade.entryPrice - exitPrice;

                const trade = {
                    type: openTrade.type,
                    entryTime: openTrade.entryTime,
                    exitTime: currentTime,
                    entryPrice: openTrade.entryPrice,
                    exitPrice,
                    pnl: parseFloat(pnl.toFixed(2)),
                    exitReason,
                    entryBar: openTrade.entryBar,
                    exitBar: i,
                };
                trades.push(trade);

                btLogger.info(
                    `  EXIT  [${trade.type}] | ${exitReason.padEnd(3)} | ` +
                    `Entry: ${trade.entryPrice} @ bar[${trade.entryBar}] | ` +
                    `Exit : ${trade.exitPrice}  @ bar[${trade.exitBar}]  | ` +
                    `PnL  : ${pnl >= 0 ? "+" : ""}${trade.pnl.toFixed(2)}`
                );

                openTrade = null;
            }
        }

        // ── Entry check (only when flat)
        if (!openTrade) {

            // ✅ FIX #3 — Uses unified generateSignal() — same logic as live, no separate function
            //             oiData = [] → analyzeOI() falls back to candle OI automatically
            const result = generateSignal(index1m, future1m, dailySlice, []);

            if (result.signal === "CE" || result.signal === "PE") {
                const entryPrice = currentClose;

                openTrade = {
                    type: result.signal,
                    entryPrice,
                    entryTime: currentTime,
                    entryBar: i,
                    sl: result.signal === "CE" ? entryPrice - slPoints : entryPrice + slPoints,
                    tgt: result.signal === "CE" ? entryPrice + tgtPoints : entryPrice - tgtPoints,
                };

                btLogger.info(
                    `  ENTRY [${result.signal}] | bar[${i}] | Close: ${entryPrice} | ` +
                    `SL: ${openTrade.sl} | Tgt: ${openTrade.tgt} | ` +
                    `Bias: ${result.dailyBias} | Vol: ${result.volConfirm} | ` +
                    `Spread: ${result.spread} | ` +
                    `IST: ${getISTTime(new Date(currentTime))}`
                );
            }
        }
    }

    logger.level = origLevel;

    // ── Force-close any trade still open at final bar
    if (openTrade) {
        const lastClose = index1mAll[endBar].close;
        const pnl = openTrade.type === "CE"
            ? lastClose - openTrade.entryPrice
            : openTrade.entryPrice - lastClose;

        trades.push({
            type: openTrade.type,
            entryTime: openTrade.entryTime,
            exitTime: index1mAll[endBar].time,
            entryPrice: openTrade.entryPrice,
            exitPrice: lastClose,
            pnl: parseFloat(pnl.toFixed(2)),
            exitReason: "LAST_BAR",
            entryBar: openTrade.entryBar,
            exitBar: endBar,
        });
        openTrade = null;
    }

    // ─────────────────────────────────────
    // SUMMARY
    // ─────────────────────────────────────
    const winners = trades.filter(t => t.pnl > 0);
    const losers = trades.filter(t => t.pnl < 0);
    const totalPnL = trades.reduce((s, t) => s + t.pnl, 0);
    const winRate = trades.length > 0 ? ((winners.length / trades.length) * 100).toFixed(1) : 0;
    const avgWin = winners.length > 0 ? (winners.reduce((s, t) => s + t.pnl, 0) / winners.length).toFixed(2) : 0;
    const avgLoss = losers.length > 0 ? (losers.reduce((s, t) => s + t.pnl, 0) / losers.length).toFixed(2) : 0;
    const maxWin = winners.length > 0 ? Math.max(...winners.map(t => t.pnl)).toFixed(2) : 0;
    const maxLoss = losers.length > 0 ? Math.min(...losers.map(t => t.pnl)).toFixed(2) : 0;

    let peak = 0, maxDD = 0, running = 0;
    for (const t of trades) {
        running += t.pnl;
        if (running > peak) peak = running;
        const dd = peak - running;
        if (dd > maxDD) maxDD = dd;
    }

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
    btLogger.info("═══════════════════════════════════════════════════════");

    // ── Trade-by-trade table
    btLogger.info("");
    btLogger.info("  TRADE LOG");
    btLogger.info("  " + "─".repeat(90));
    btLogger.info(
        "  " +
        "  #".padEnd(5) + "Type".padEnd(5) + "Entry Price".padEnd(14) +
        "Exit Price".padEnd(13) + "PnL".padEnd(12) + "Exit".padEnd(7) +
        "Bars".padEnd(7) + "Entry Time"
    );
    btLogger.info("  " + "─".repeat(90));

    trades.forEach((t, idx) => {
        const pnlStr = (t.pnl >= 0 ? "+" : "") + t.pnl.toFixed(2);
        btLogger.info(
            "  " +
            String(idx + 1).padEnd(5) + t.type.padEnd(5) +
            String(t.entryPrice).padEnd(14) + String(t.exitPrice).padEnd(13) +
            pnlStr.padEnd(12) + t.exitReason.padEnd(7) +
            String(t.exitBar - t.entryBar).padEnd(7) +
            getISTTime(new Date(t.entryTime))
        );
    });

    btLogger.info("═══════════════════════════════════════════════════════");
    btLogger.info("  Backtest complete. Results saved to backtest.log");
    btLogger.info("═══════════════════════════════════════════════════════");

    return { trades, totalPnL, winRate, maxDD };
}


// ─────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────
async function main() {

    const isBacktest = process.env.BACKTEST === "true" || process.argv.includes("--backtest");

    if (isBacktest) {
        logger.info("🧪 BACKTEST MODE");

        // ── ✅ FIX #1 — Date range fully controlled via .env (BT_FROM / BT_TO)
        const btFrom = process.env.BT_FROM ?? "2026-02-15 09:15";
        const btTo = process.env.BT_TO ?? "2026-02-27 15:30";
        logger.info(`📅 Window: ${btFrom} → ${btTo}`);

        const jwt = await login();
        const futureToken = await getFutureToken();

        // Daily: fetch 30 days before backtest start for EMA warmup
        const p = n => String(n).padStart(2, "0");
        const warmupDate = new Date(btFrom);
        warmupDate.setDate(warmupDate.getDate() - 30);
        const dailyFrom = `${warmupDate.getFullYear()}-${p(warmupDate.getMonth() + 1)}-${p(warmupDate.getDate())} 09:15`;

        const indexRaw = await getHistorical(jwt, "BSE", process.env.SYMBOLTOKEN, "ONE_MINUTE", btFrom, btTo);
        await sleep(500);
        const raw1D = await getHistorical(jwt, "BSE", process.env.SYMBOLTOKEN, "ONE_DAY", dailyFrom, btTo);
        await sleep(500);
        const futureRaw = await getHistorical(jwt, "BFO", futureToken, "ONE_MINUTE", btFrom, btTo);

        if (!indexRaw.length || !futureRaw.length) {
            logger.error("❌ No data. Check API credentials or date range.");
            process.exit(1);
        }

        const index1m = format(indexRaw);
        const future1m = format(futureRaw);
        const data1D = format(raw1D);

        // ✅ Align index & future to same length (FIX #4 — prevents mismatch)
        const minLen = Math.min(index1m.length, future1m.length);
        logger.info(`📊 index: ${index1m.length} | future: ${future1m.length} | aligned: ${minLen} | daily: ${data1D.length}`);

        await backtest(index1m.slice(0, minLen), future1m.slice(0, minLen), data1D, {
            slPoints: parseInt(process.env.BT_SL ?? "80"),
            tgtPoints: parseInt(process.env.BT_TGT ?? "200"),
            startBar: 30,
        });

        logger.info("✅ Done. See backtest.log");
        return;
    }

    // ── LIVE TRADING MODE
    logger.info("🚀 BOT STARTED");

    const jwt = await login();
    const futureToken = await getFutureToken();

    let lastSignal = null;
    let iteration = 0;

    while (true) {
        iteration++;

        try {
            logger.info(`🔄 Loop #${iteration} | IST: ${getISTTime()}`);

            const liveFrom = getTodayFromDate();
            const liveTo = formatDateTime();

            const indexRaw = await getHistorical(jwt, "BSE", process.env.SYMBOLTOKEN, "ONE_MINUTE", liveFrom, liveTo);
            await sleep(300);
            const raw1D = await getHistorical(jwt, "BSE", process.env.SYMBOLTOKEN, "ONE_DAY", getDailyFromDate(), liveTo);
            await sleep(300);
            const futureRaw = await getHistorical(jwt, "BFO", futureToken, "ONE_MINUTE", liveFrom, liveTo);
            await sleep(300);
            const oiRaw = await getOIData(jwt, futureToken, "ONE_MINUTE");

            if (!indexRaw.length || !futureRaw.length) {
                logger.warn(`⚠ Missing data — skipping loop #${iteration}`);
                await sleep(15_000);
                continue;
            }

            const signal = await entryEngine(
                format(indexRaw),
                format(futureRaw),
                format(raw1D),
                oiRaw
            );

            logger.info(`🎯 SIGNAL: ${signal}`);

            if (signal !== "⚪ NO TRADE" && signal !== lastSignal) {
                logger.info(`🚨 NEW SIGNAL: ${signal}`);
                lastSignal = signal;
            }
            if (signal === "⚪ NO TRADE") lastSignal = null;

        } catch (err) {
            logger.error(`❌ Loop #${iteration} Error: ${err.message}`);
        }

        // ✅ FIX #5 — Was 15_0000 (150s). Correct is 15_000 (15s)
        await sleep(15_000);
    }
}

main();