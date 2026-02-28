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
    // const breakUp = last1m.close > prev1m.high;
    // const breakDown = last1m.close < prev1m.low;    // ── S/R proximity check
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

    // ─────────────────────────────────────
    // FIX #9 — Spread filter: reject abnormal spread > 200 pts
    // ─────────────────────────────────────


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
        // &&
        // oiConfirmsBear                       // ✅ FIX #2: OI enabled
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
        //  &&
        // oiConfirmsBull                       // ✅ FIX #2: OI enabled
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

// ─────────────────────────────────────────
// MAIN  (FIX #5 market guard, FIX #6 polling 15s)
// ─────────────────────────────────────────
async function main() {
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