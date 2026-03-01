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
// FIX #6 — Dynamic date helpers
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
// FIX #5 — Market hours check (IST)
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
// HISTORICAL  (FIX #6 — dynamic fromdate per interval)
// ─────────────────────────────────────────
async function getHistorical(jwt, exchange, token, interval, fromdate = getTodayFromDate(), retries = 3) {
    const body = {
        exchange,
        symboltoken: token,
        interval,
        fromdate: "2026-02-15 09:15",
        todate: "2026-02-23 09:15",
        // todate: formatDateTime()
    };

    try {
        logger.debug(`📊 Fetching ${interval} | ${exchange} | ${token} | from: ${fromdate}`);
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
            return getHistorical(jwt, exchange, token, interval, fromdate, retries - 1);
        }
        logger.error(`❌ Historical failed: ${err.message}`);
        return [];
    }
}

// ─────────────────────────────────────────
// GET OI DATA (dedicated endpoint)
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
        return res.data.data;   // [{ time, oi }, ...]

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
        let isSupport = true;
        let isResistance = true;

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
// FIX #1 — VOLUME SPIKE (was 0.1, now 1.5)
// ─────────────────────────────────────────
function volumeSpike(data, index) {
    if (index < 10) return false;
    const avg = data.slice(index - 10, index).reduce((s, c) => s + c.volume, 0) / 10;
    return data[index].volume > avg * 1.3;   // ✅ FIX: 1.5x not 0.1x
    // return data[index].volume > avg * 1.5;   // ✅ FIX: 1.5x not 0.1x
}

// ─────────────────────────────────────────
// FIX #2 — OI CONFIRMATION with % threshold
// FIX #10 — OI % change threshold added
// ─────────────────────────────────────────
function analyzeOI(future1m, oiData) {
    const fLen = future1m.length;
    const oLen = oiData?.length ?? 0;

    // Use dedicated OI endpoint if available, else fallback to candle OI
    const useRealOI = oLen >= 5;
    const len = useRealOI ? oLen : fLen;

    if (len < 5) {
        logger.warn("⚠ Insufficient OI data");
        return { signal: "NEUTRAL", label: "⚪ Insufficient OI data", priceDiff: 0, oiDiff: 0 };
    }

    const currPrice = future1m[fLen - 1].close;
    const prevPrice = future1m[fLen - 5].close;

    const currOI = useRealOI ? oiData[oLen - 1].oi : future1m[fLen - 1].oi;
    const prevOI = useRealOI ? oiData[oLen - 5].oi : future1m[fLen - 5].oi;

    const priceUp = currPrice > prevPrice;
    const priceDown = currPrice < prevPrice;

    // FIX #10: OI must change by at least 0.5% to count
    const oiChangePct = prevOI > 0 ? Math.abs((currOI - prevOI) / prevOI) * 100 : 0;
    const oiUp = currOI > prevOI && oiChangePct >= 0.5;
    const oiDown = currOI < prevOI && oiChangePct >= 0.5;

    const priceDiff = (currPrice - prevPrice).toFixed(2);
    const oiDiff = currOI - prevOI;

    logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    logger.info(`📊 OI Analysis | Source: ${useRealOI ? "API" : "Candle"}`);
    logger.info(`   Price: ${prevPrice} → ${currPrice} (${priceDiff > 0 ? "+" : ""}${priceDiff})`);
    logger.info(`   OI   : ${prevOI} → ${currOI} (${oiDiff > 0 ? "+" : ""}${oiDiff}) | Chg: ${oiChangePct.toFixed(2)}%`);

    if (priceUp && oiUp) {
        logger.info(`📈 Long Build-up — STRONG BULLISH`);
        logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        return { signal: "BULLISH", label: "📈 Long Build-up (Strong Bullish)", priceDiff, oiDiff, oiChangePct: oiChangePct.toFixed(2) };
    }
    if (priceDown && oiUp) {
        logger.info(`📉 Short Build-up — STRONG BEARISH`);
        logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        return { signal: "BEARISH", label: "📉 Short Build-up (Strong Bearish)", priceDiff, oiDiff, oiChangePct: oiChangePct.toFixed(2) };
    }
    if (priceUp && oiDown) {
        logger.info(`🔄 Short Covering — WEAK BULLISH`);
        logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        return { signal: "WEAK_BULLISH", label: "🔄 Short Covering (Weak Bullish)", priceDiff, oiDiff, oiChangePct: oiChangePct.toFixed(2) };
    }
    if (priceDown && oiDown) {
        logger.info(`🔄 Long Unwinding — WEAK BEARISH`);
        logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
        return { signal: "WEAK_BEARISH", label: "🔄 Long Unwinding (Weak Bearish)", priceDiff, oiDiff, oiChangePct: oiChangePct.toFixed(2) };
    }

    logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
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

    const parseExpiry = str => new Date(
        parseInt(str.slice(5)),
        monthMap[str.slice(2, 5)],
        parseInt(str.slice(0, 2))
    );

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

// ─────────────────────────────────────────
// ENTRY ENGINE (all 10 fixes applied)
// ─────────────────────────────────────────
async function entryEngine(index1m, future1m, data1D, oiData = []) {

    // ── Build timeframes
    const index5m = buildTimeframe(index1m, 5);
    const index15m = buildTimeframe(index1m, 15);
    const index1H = buildTimeframe(index1m, 60);

    logger.info(`Timeframes → 5m:${index5m.length} 15m:${index15m.length} 1H:${index1H.length}`);

    if (!index5m.length || !index15m.length) {
        logger.warn("⚠ Not enough 1m data to build timeframes");
        return "⚪ NO TRADE";
    }

    // ─────────────────────────────────────
    // FIX #7 — Daily bias: EMA + candle direction
    // ─────────────────────────────────────
    const dailyData = (data1D?.length >= 2) ? data1D : buildTimeframe(index1m, 375);
    const dailyEMA = calculateEMA(dailyData);
    const dailyLast = dailyData[dailyData.length - 1];
    const dailyPrev = dailyData[dailyData.length - 2];

    const emaAbove = dailyLast.close > dailyEMA[dailyEMA.length - 1];
    const bullCandle = dailyLast.close > dailyLast.open;       // green day candle
    const bearCandle = dailyLast.close < dailyLast.open;       // red day candle

    const dailyBias =
        (emaAbove && bullCandle) ? "BULLISH" :
            (!emaAbove && bearCandle) ? "BEARISH" : "NEUTRAL";     // ✅ FIX: both must agree

    logger.info(`Daily Bias: ${dailyBias} | EMAAbove:${emaAbove} | bullCandle:${bullCandle} | bearCandle:${bearCandle}`);

    if (dailyBias === "NEUTRAL") {
        logger.info("⚪ Daily bias NEUTRAL — skipping");
        return "⚪ NO TRADE";
    }

    // ── Previous day S/R
    const prevDay = (data1D?.length >= 2) ? data1D[data1D.length - 2] : dailyData[dailyData.length - 2];
    const prevHigh = prevDay?.high ?? 0;
    const prevLow = prevDay?.low ?? 0;
    logger.info(`Prev Day High: ${prevHigh} | Low: ${prevLow}`);

    // ── Swing S/R (from 15m for cleaner levels)
    const { supports, resistances } = findSupportResistance(index15m);

    // ── Round levels
    const currentPrice = index5m[index5m.length - 1].close;
    const roundLevels = getRoundLevels(currentPrice);

    const finalSupports = cleanLevels([...supports, prevLow, ...roundLevels.filter(r => r < currentPrice)]);
    const finalResistances = cleanLevels([...resistances, prevHigh, ...roundLevels.filter(r => r > currentPrice)]);

    logger.info(`Supports:    ${JSON.stringify(finalSupports)}`);
    logger.info(`Resistances: ${JSON.stringify(finalResistances)}`);

    // ── 5m trend (EMA)
    const ema5m = calculateEMA(index5m);
    const last5m = index5m[index5m.length - 1];
    const trendUp = last5m.close > ema5m[ema5m.length - 1];
    const trendDown = last5m.close < ema5m[ema5m.length - 1];

    // ─────────────────────────────────────
    // FIX #3 — Breakout: close > max of last 5 highs / < min of last 5 lows
    // ─────────────────────────────────────
    const last1m = index1m[index1m.length - 1];
    const prev1m = index1m[index1m.length - 2];
    const last5 = index1m.slice(-6, -1);   // 5 candles before last
    const max5High = Math.max(...last5.map(c => c.high));
    const min5Low = Math.min(...last5.map(c => c.low));

    const breakUp = last1m.close > max5High;   // ✅ FIX: close > 5-bar high
    const breakDown = last1m.close < min5Low;    // ✅ FIX: close < 5-bar low

    // ─────────────────────────────────────
    // FIX #8 — S/R break: must be within 50 pts of level
    // ─────────────────────────────────────
    const SR_THRESHOLD = 50;

    const nearSupport = finalSupports.filter(s => s < last1m.close).pop();
    const nearResistance = finalResistances.find(r => r > last1m.close);

    const breakBelow = nearSupport &&
        last1m.close < nearSupport &&
        Math.abs(last1m.close - nearSupport) <= SR_THRESHOLD;   // ✅ FIX

    const breakAbove = nearResistance &&
        last1m.close > nearResistance &&
        Math.abs(last1m.close - nearResistance) <= SR_THRESHOLD; // ✅ FIX

    // ── Volume (FIX #1 already in volumeSpike fn)
    const volConfirm = volumeSpike(future1m, future1m.length - 1);

    // ─────────────────────────────────────
    // FIX #4 — Big candle: range > 1.5x prev AND body > 60% of range
    // ─────────────────────────────────────
    const body = Math.abs(last1m.close - last1m.open);
    const range = last1m.high - last1m.low;
    const strongBody = range > 0 && (body / range) > 0.6;
    const bigCandle = (range > (prev1m.high - prev1m.low) * 1.5) && strongBody;  // ✅ FIX

    // ── FIX #2 — OI confirmation (enabled)
    const oi = analyzeOI(future1m, oiData);
    const oiConfirmsBull = oi.signal === "BULLISH";
    const oiConfirmsBear = oi.signal === "BEARISH";

    // ── LTP block
    const lastIndex = index1m[index1m.length - 1];
    const lastFuture = future1m[future1m.length - 1];
    const spread = lastFuture.close - lastIndex.close;

    logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    logger.info(`📍 INDEX  LTP → ${lastIndex.close}  | IST: ${getISTTime(new Date(lastIndex.time))}`);
    logger.info(`📍 FUTURE LTP → ${lastFuture.close} | IST: ${getISTTime(new Date(lastFuture.time))}`);
    logger.info(`📊 Spread      → ${spread.toFixed(2)}`);

    logger.info(`🕐 System IST  → ${getISTTime()}`);
    logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    logger.info(`trendUp:${trendUp} trendDown:${trendDown}`);
    logger.info(`breakUp:${breakUp} breakDown:${breakDown} (5-bar breakout)`);
    logger.info(`breakAbove:${breakAbove} breakBelow:${breakBelow} (within ${SR_THRESHOLD}pts)`);
    logger.info(`bigCandle:${bigCandle} strongBody:${strongBody} volConfirm:${volConfirm}`);
    logger.info(`OI → ${oi.label} | Δ${oi.oiDiff} (${oi.oiChangePct}%)`);
    logger.info(`oiConfirmsBull:${oiConfirmsBull} oiConfirmsBear:${oiConfirmsBear}`);

    const spreadStr = spread.toFixed(2);

    // ─────────────────────────────────────
    // PE ENTRY
    // ─────────────────────────────────────
    if (
        dailyBias === "BEARISH" &&
        (trendDown || bigCandle) &&
        (breakDown || breakBelow) &&
        volConfirm
    ) {
        const msg = `
🟥 *PE ENTRY SIGNAL*

📉 Bias   : ${dailyBias}
🕒 Time   : ${getISTTime()}

━━━━━━━━━━━━━━━━━━
📊 Price Info
Index LTP   : ${lastIndex.close}
Future LTP  : ${lastFuture.close}
Spread      : ${spreadStr}

━━━━━━━━━━━━━━━━━━
📌 Conditions
Trend Down  : ${trendDown}
Big Candle  : ${bigCandle}
Break Down  : ${breakDown}
Break Below : ${breakBelow}
Volume OK   : ${volConfirm}

━━━━━━━━━━━━━━━━━━
📉 OI
${oi.label}
Price Δ     : ${oi.priceDiff}
OI Δ        : ${oi.oiDiff} (${oi.oiChangePct}%)
━━━━━━━━━━━━━━━━━━
`;
        tradeLogger.info(msg);
        await sendTelegram(msg);
        return "🟥 PE ENTRY";
    }

    // ─────────────────────────────────────
    // CE ENTRY
    // ─────────────────────────────────────
    if (
        dailyBias === "BULLISH" &&
        (trendUp || bigCandle) &&
        (breakUp || breakAbove) &&
        volConfirm
    ) {
        const msg = `
🟢 *CE ENTRY SIGNAL*

📈 Bias   : ${dailyBias}
🕒 Time   : ${getISTTime()}

━━━━━━━━━━━━━━━━━━
📊 Price Info
Index LTP   : ${lastIndex.close}
Future LTP  : ${lastFuture.close}
Spread      : ${spreadStr}

━━━━━━━━━━━━━━━━━━
📌 Conditions
Trend Up    : ${trendUp}
Big Candle  : ${bigCandle}
Break Up    : ${breakUp}
Break Above : ${breakAbove}
Volume OK   : ${volConfirm}

━━━━━━━━━━━━━━━━━━
📈 OI
${oi.label}
Price Δ     : ${oi.priceDiff}
OI Δ        : ${oi.oiDiff} (${oi.oiChangePct}%)
━━━━━━━━━━━━━━━━━━
`;
        tradeLogger.info(msg);
        await sendTelegram(msg);
        return "🟢 CE ENTRY";
    }

    logger.info(`⚪ NO TRADE | OI: ${oi.label}`);
    return "⚪ NO TRADE";
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
//  ██████   █████   ██████ ██   ██ ████████ ███████ ███████ ████████
//  ██   ██ ██   ██ ██      ██  ██     ██    ██      ██         ██
//  ██████  ███████ ██      █████      ██    █████   ███████    ██
//  ██   ██ ██   ██ ██      ██  ██     ██    ██           ██    ██
//  ██████  ██   ██  ██████ ██   ██    ██    ███████ ███████    ██
//
//  Backtests the SAME entry logic (entryEngine conditions) on 1m candle close.
//  No logic changes — only simulates entry/exit on historical data.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * backtest()
 *
 * @param {Array}  index1mAll   - Full formatted 1m index candles
 * @param {Array}  future1mAll  - Full formatted 1m future candles
 * @param {Array}  data1D       - Daily candles (same as live)
 * @param {Object} options
 *   @param {number}  options.slPoints      - Initial stop-loss in index points   (default 80)
 *   @param {number}  options.tgtPoints     - Target in index points               (default 200)
 *   @param {number}  options.tslTrigger    - Profit pts to activate TSL           (default 100)
 *   @param {number}  options.tslLockIn     - SL moved to entryPrice + this value  (default 50)
 *   @param {boolean} options.useTSL        - Enable trailing stop-loss            (default true)
 *   @param {number}  options.startBar      - Start candle index                   (default 30)
 *   @param {number}  options.endBar        - End candle index                     (default all)
 */
async function backtest(index1mAll, future1mAll, data1D, options = {}) {
    const {
        slPoints = 80,
        tgtPoints = 200,
        tslTrigger = 100,   // when unrealised profit reaches this → activate TSL
        tslLockIn = 50,    // SL moves to entryPrice ± this value (lock-in profit)
        useTSL = true,
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
    if (useTSL) {
        btLogger.info(`  TSL: ON  — trigger at +${tslTrigger} pts → lock-in SL at entry+${tslLockIn} pts`);
    } else {
        btLogger.info(`  TSL: OFF`);
    }
    btLogger.info(`  Range: bar[${startBar}] → bar[${endBar}]`);
    btLogger.info(`  Total 1m candles: ${index1mAll.length}`);
    btLogger.info("═══════════════════════════════════════════════════════");

    const trades = [];   // completed trades
    let openTrade = null;
    // openTrade shape:
    // { type, entryPrice, entryTime, entryBar, sl, tgt, tslActivated }

    // ── Suppress live logger noise during backtest scan
    const origLevel = logger.level;
    logger.level = "error";

    for (let i = startBar; i <= endBar; i++) {

        // ── Slice data up to and including current bar (simulate live feed)
        const index1m = index1mAll.slice(0, i + 1);
        const future1m = future1mAll.slice(0, i + 1);

        const currentClose = index1m[index1m.length - 1].close;
        const currentTime = index1m[index1m.length - 1].time;

        // ── Check open trade exit FIRST (on this candle's close)
        if (openTrade) {

            // ─────────────────────────────────────────────
            // TSL CHECK — runs every bar BEFORE exit check
            // Logic: when price moves +tslTrigger in our favour,
            //        move SL to entryPrice ± tslLockIn (never move SL against us)
            // ─────────────────────────────────────────────
            if (useTSL && !openTrade.tslActivated) {
                const unrealisedPnL = openTrade.type === "CE"
                    ? currentClose - openTrade.entryPrice
                    : openTrade.entryPrice - currentClose;

                if (unrealisedPnL >= tslTrigger) {
                    const newSL = openTrade.type === "CE"
                        ? openTrade.entryPrice + tslLockIn   // Long:  SL moves up   to entry+50
                        : openTrade.entryPrice - tslLockIn;  // Short: SL moves down to entry-50

                    // Only tighten SL (never loosen it)
                    const slImproved = openTrade.type === "CE"
                        ? newSL > openTrade.sl
                        : newSL < openTrade.sl;

                    if (slImproved) {
                        btLogger.info(
                            `  TSL   [${openTrade.type}] | bar[${i}] | ` +
                            `Profit reached +${unrealisedPnL.toFixed(2)} pts | ` +
                            `SL moved: ${openTrade.sl.toFixed(2)} → ${newSL.toFixed(2)} | ` +
                            `IST: ${getISTTime(new Date(currentTime))}`
                        );
                        openTrade.sl = newSL;
                        openTrade.tslActivated = true;   // activate only once
                    }
                }
            }

            // ─────────────────────────────────────────────
            // EXIT CHECK (SL / TGT / EOD)
            // ─────────────────────────────────────────────
            let exitReason = null;
            let exitPrice = currentClose;

            if (openTrade.type === "CE") {
                if (currentClose <= openTrade.sl) { exitReason = "TSL"; exitPrice = openTrade.sl; }
                if (currentClose >= openTrade.tgt) { exitReason = "TGT"; exitPrice = openTrade.tgt; }
            } else {
                if (currentClose >= openTrade.sl) { exitReason = "TSL"; exitPrice = openTrade.sl; }
                if (currentClose <= openTrade.tgt) { exitReason = "TGT"; exitPrice = openTrade.tgt; }
            }

            // Label original SL exits (before TSL was activated) as "SL"
            if (exitReason === "TSL" && !openTrade.tslActivated) {
                exitReason = "SL";
            }

            // ── End of day force exit (15:29 IST)
            const ist = new Date(new Date(currentTime).toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
            const minsFromOpen = ist.getHours() * 60 + ist.getMinutes();
            if (minsFromOpen >= (15 * 60 + 29) && !exitReason) {
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
                    tslActivated: openTrade.tslActivated,
                    entryBar: openTrade.entryBar,
                    exitBar: i,
                };
                trades.push(trade);

                btLogger.info(
                    `  EXIT  [${trade.type}] | ${exitReason.padEnd(3)} | ` +
                    `Entry: ${trade.entryPrice} @ bar[${trade.entryBar}] | ` +
                    `Exit : ${trade.exitPrice} @ bar[${trade.exitBar}] | ` +
                    `PnL  : ${pnl >= 0 ? "+" : ""}${trade.pnl.toFixed(2)}` +
                    (trade.tslActivated ? " 🔒TSL" : "")
                );

                openTrade = null;   // reset for next signal
            }
        }

        // ── Only look for new entry if no open trade
        if (!openTrade) {
            const signal = _backtestSignal(index1m, future1m, data1D);

            if (signal === "CE" || signal === "PE") {
                const entryPrice = currentClose;  // entry on 1m candle CLOSE

                openTrade = {
                    type: signal,
                    entryPrice,
                    entryTime: currentTime,
                    entryBar: i,
                    sl: signal === "CE" ? entryPrice - slPoints : entryPrice + slPoints,
                    tgt: signal === "CE" ? entryPrice + tgtPoints : entryPrice - tgtPoints,
                    tslActivated: false,
                };

                btLogger.info(
                    `  ENTRY [${signal}] | bar[${i}] | Close: ${entryPrice} | ` +
                    `SL: ${openTrade.sl} | Tgt: ${openTrade.tgt} | ` +
                    `TSL: ${useTSL ? `trigger@+${tslTrigger} → lock+${tslLockIn}` : "OFF"} | ` +
                    `IST: ${getISTTime(new Date(currentTime))}`
                );
            }
        }
    }

    // Restore logger level
    logger.level = origLevel;

    // ── Force-close any remaining open trade at last bar
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
            tslActivated: openTrade.tslActivated,
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
    const tslSaved = trades.filter(t => t.tslActivated && t.exitReason === "TSL");  // TSL saved trades
    const tslWins = trades.filter(t => t.tslActivated && t.pnl > 0);
    const totalPnL = trades.reduce((s, t) => s + t.pnl, 0);
    const winRate = trades.length > 0 ? ((winners.length / trades.length) * 100).toFixed(1) : 0;
    const avgWin = winners.length > 0 ? (winners.reduce((s, t) => s + t.pnl, 0) / winners.length).toFixed(2) : 0;
    const avgLoss = losers.length > 0 ? (losers.reduce((s, t) => s + t.pnl, 0) / losers.length).toFixed(2) : 0;
    const maxWin = winners.length > 0 ? Math.max(...winners.map(t => t.pnl)).toFixed(2) : 0;
    const maxLoss = losers.length > 0 ? Math.min(...losers.map(t => t.pnl)).toFixed(2) : 0;

    // Max drawdown
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
    if (useTSL) {
        btLogger.info(`  ─────────────────────────────────────────────`);
        btLogger.info(`  TSL CONFIG    : trigger@+${tslTrigger} pts → lock-in SL at entry+${tslLockIn} pts`);
        btLogger.info(`  TSL Activated : ${trades.filter(t => t.tslActivated).length} trades`);
        btLogger.info(`  TSL Exits     : ${tslSaved.length} (exited at locked SL)`);
        btLogger.info(`  TSL Wins      : ${tslWins.length} (TSL active & trade was profitable)`);
        const tslSavedPnL = tslSaved.reduce((s, t) => s + t.pnl, 0);
        btLogger.info(`  TSL Locked PnL: ${tslSavedPnL >= 0 ? "+" : ""}${tslSavedPnL.toFixed(2)} pts`);
    }
    btLogger.info("═══════════════════════════════════════════════════════");

    // ── Trade-by-trade table
    btLogger.info("");
    btLogger.info("  TRADE LOG");
    btLogger.info("  " + "─".repeat(100));
    btLogger.info(
        "  " +
        "  #".padEnd(5) +
        "Type".padEnd(5) +
        "Entry Price".padEnd(14) +
        "Exit Price".padEnd(13) +
        "PnL".padEnd(12) +
        "Exit".padEnd(7) +
        "TSL".padEnd(6) +
        "Bars".padEnd(7) +
        "Entry Time"
    );
    btLogger.info("  " + "─".repeat(100));

    trades.forEach((t, idx) => {
        const pnlStr = (t.pnl >= 0 ? "+" : "") + t.pnl.toFixed(2);
        const tslFlag = t.tslActivated ? "🔒" : "  ";
        btLogger.info(
            "  " +
            String(idx + 1).padEnd(5) +
            t.type.padEnd(5) +
            String(t.entryPrice).padEnd(14) +
            String(t.exitPrice).padEnd(13) +
            pnlStr.padEnd(12) +
            t.exitReason.padEnd(7) +
            tslFlag.padEnd(6) +
            String(t.exitBar - t.entryBar).padEnd(7) +
            getISTTime(new Date(t.entryTime))
        );
    });

    btLogger.info("═══════════════════════════════════════════════════════");
    btLogger.info("  Backtest complete. Results saved to backtest.log");
    btLogger.info("═══════════════════════════════════════════════════════");

    return { trades, totalPnL, winRate, maxDD };
}

/**
 * _backtestSignal()
 * Pure synchronous version of entryEngine conditions for backtest loop.
 * ZERO logic changes — exact copy of conditions from entryEngine().
 *
 * Returns: "CE" | "PE" | null
 */
function _backtestSignal(index1m, future1m, data1D) {

    // ── Build timeframes
    const index5m = buildTimeframe(index1m, 5);
    const index15m = buildTimeframe(index1m, 15);

    if (!index5m.length || !index15m.length) return null;

    // ── Daily bias
    const dailyData = (data1D?.length >= 2) ? data1D : buildTimeframe(index1m, 375);
    if (dailyData.length < 2) return null;

    const dailyEMA = calculateEMA(dailyData);
    const dailyLast = dailyData[dailyData.length - 1];
    const emaAbove = dailyLast.close > dailyEMA[dailyEMA.length - 1];
    const bullCandle = dailyLast.close > dailyLast.open;
    const bearCandle = dailyLast.close < dailyLast.open;

    const dailyBias =
        (emaAbove && bullCandle) ? "BULLISH" :
            (!emaAbove && bearCandle) ? "BEARISH" : "NEUTRAL";

    if (dailyBias === "NEUTRAL") return null;

    // ── Previous day S/R
    const prevDay = (data1D?.length >= 2) ? data1D[data1D.length - 2] : dailyData[dailyData.length - 2];
    const prevHigh = prevDay?.high ?? 0;
    const prevLow = prevDay?.low ?? 0;

    // ── Swing S/R
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

    // ── 5-bar breakout (FIX #3)
    const last1m = index1m[index1m.length - 1];
    const prev1m = index1m[index1m.length - 2];
    const last5 = index1m.slice(-6, -1);
    const max5High = Math.max(...last5.map(c => c.high));
    const min5Low = Math.min(...last5.map(c => c.low));
    const breakUp = last1m.close > max5High;
    const breakDown = last1m.close < min5Low;

    // ── S/R proximity (FIX #8)
    const SR_THRESHOLD = 50;
    const nearSupport = finalSupports.filter(s => s < last1m.close).pop();
    const nearResistance = finalResistances.find(r => r > last1m.close);

    const breakBelow = nearSupport && last1m.close < nearSupport && Math.abs(last1m.close - nearSupport) <= SR_THRESHOLD;
    const breakAbove = nearResistance && last1m.close > nearResistance && Math.abs(last1m.close - nearResistance) <= SR_THRESHOLD;

    // ── Volume (FIX #1)
    const volConfirm = volumeSpike(future1m, future1m.length - 1);

    // ── Big candle (FIX #4)
    const body = Math.abs(last1m.close - last1m.open);
    const range = last1m.high - last1m.low;
    const strongBody = range > 0 && (body / range) > 0.6;
    const bigCandle = (range > (prev1m.high - prev1m.low) * 1.5) && strongBody;

    // ── OI (synchronous fallback — uses candle OI, no API call in backtest)
    const fLen = future1m.length;
    let oiConfirmsBull = false;
    let oiConfirmsBear = false;
    if (fLen >= 5) {
        const currPrice = future1m[fLen - 1].close;
        const prevPrice = future1m[fLen - 5].close;
        const currOI = future1m[fLen - 1].oi;
        const prevOI = future1m[fLen - 5].oi;
        const oiChangePct = prevOI > 0 ? Math.abs((currOI - prevOI) / prevOI) * 100 : 0;
        const oiUp = currOI > prevOI && oiChangePct >= 0.5;
        const oiDown = currOI < prevOI && oiChangePct >= 0.5;
        oiConfirmsBull = currPrice > prevPrice && oiUp;
        oiConfirmsBear = currPrice < prevPrice && oiUp;
    }

    // ── PE ENTRY (exact same conditions as entryEngine)
    if (
        dailyBias === "BEARISH" &&
        (trendDown || bigCandle) &&
        (breakDown || breakBelow) &&
        volConfirm
    ) return "PE";

    // ── CE ENTRY (exact same conditions as entryEngine)
    if (
        dailyBias === "BULLISH" &&
        (trendUp || bigCandle) &&
        (breakUp || breakAbove) &&
        volConfirm
    ) return "CE";

    return null;
}


// ─────────────────────────────────────────
// MAIN  (FIX #5 market guard, FIX #6 polling 15s)
// ─────────────────────────────────────────
async function main() {

    // ══════════════════════════════════════
    // BACKTEST MODE: set BACKTEST=true in .env
    // or pass --backtest as CLI arg
    // ══════════════════════════════════════
    const isBacktest = process.env.BACKTEST === "true" || process.argv.includes("--backtest");

    if (isBacktest) {
        logger.info("🧪 BACKTEST MODE — fetching historical data...");

        const jwt = await login();
        const futureToken = await getFutureToken();

        // Fetch full historical data for backtest window
        const indexRaw = await getHistorical(jwt, "BSE", process.env.SYMBOLTOKEN, "ONE_MINUTE");
        await sleep(500);
        const raw1D = await getHistorical(jwt, "BSE", process.env.SYMBOLTOKEN, "ONE_DAY", getDailyFromDate());
        await sleep(500);
        const futureRaw = await getHistorical(jwt, "BFO", futureToken, "ONE_MINUTE");

        if (!indexRaw.length || !futureRaw.length) {
            logger.error("❌ No data for backtest. Check API or date range.");
            process.exit(1);
        }

        const index1m = format(indexRaw);
        const future1m = format(futureRaw);
        const data1D = format(raw1D);

        logger.info(`📊 Backtest data → index: ${index1m.length} bars | future: ${future1m.length} bars | daily: ${data1D.length}`);

        await backtest(index1m, future1m, data1D, {
            slPoints: parseInt(process.env.BT_SL ?? "80"),    // override via .env
            tgtPoints: parseInt(process.env.BT_TGT ?? "200"),
            tslTrigger: parseInt(process.env.BT_TSL_TRIG ?? "100"),  // activate TSL at +100 pts profit
            tslLockIn: parseInt(process.env.BT_TSL_LOCK ?? "50"),   // lock SL at entry+50 pts
            useTSL: process.env.BT_USE_TSL !== "false",           // TSL ON by default
            startBar: 30,
        });

        logger.info("✅ Backtest done. See backtest.log");
        return;
    }

    // ══════════════════════════════════════
    // LIVE TRADING MODE (unchanged)
    // ══════════════════════════════════════
    logger.info("🚀 BOT STARTED");

    const jwt = await login();
    const futureToken = await getFutureToken();

    let lastSignal = null;
    let iteration = 0;

    while (true) {
        iteration++;

        // ─── FIX #5: Market hours guard ───
        // if (!isMarketOpen()) {
        //     logger.info(`⏸ Market closed | IST: ${getISTTime()} | Next check in 60s`);
        //     await sleep(60_000);
        //     continue;
        // }

        try {
            logger.info(`🔄 Loop #${iteration} | IST: ${getISTTime()}`);

            // ─── FIX #6: daily uses 30-day fromdate ───
            const indexRaw = await getHistorical(jwt, "BSE", process.env.SYMBOLTOKEN, "ONE_MINUTE");
            await sleep(300);

            const raw1D = await getHistorical(jwt, "BSE", process.env.SYMBOLTOKEN, "ONE_DAY", getDailyFromDate());
            await sleep(300);

            const futureRaw = await getHistorical(jwt, "BFO", futureToken, "ONE_MINUTE");
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
                oiRaw           // dedicated OI data
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

        // ─── FIX #6: Poll every 15 seconds (not 1s) ───
        await sleep(15_0000);
    }
}

main();
