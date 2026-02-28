require("dotenv").config();
const axios = require("axios");
const fs = require("fs");
const os = require("os");
const speakeasy = require("speakeasy");
const winston = require("winston");

const BASE_URL = "https://apiconnect.angelone.in";

// ─────────────────────────────────────────
// MODE FLAG — switch between LIVE and BACKTEST
// ─────────────────────────────────────────
const MODE = process.env.MODE || "BACKTEST"; // "LIVE" | "BACKTEST"

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
// LOGGER — Console + bot.log
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

// ─────────────────────────────────────────
// TRADE LOGGER — trade.log
// ─────────────────────────────────────────
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
// BACKTEST LOGGER — backtest.log (CSV format)
// ─────────────────────────────────────────
const backtestLogger = winston.createLogger({
    level: "info",
    format: winston.format.printf(({ message }) => message),
    transports: [
        new winston.transports.File({ filename: "backtest.log", options: { flags: "w" } }) // overwrite each run
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
// HISTORICAL — fromdate & todate fully dynamic
// ─────────────────────────────────────────
async function getHistorical(jwt, exchange, token, interval, fromdate = getTodayFromDate(), todate = formatDateTime(), retries = 3) {
    const body = {
        exchange,
        symboltoken: token,
        interval,
        fromdate,   // ✅ dynamic — passed from caller
        todate      // ✅ dynamic — passed from caller
    };

    try {
        logger.debug(`📊 Fetching ${interval} | ${exchange} | ${token} | ${fromdate} → ${todate}`);
        const res = await axios.post(
            `${BASE_URL}/rest/secure/angelbroking/historical/v1/getCandleData`,
            body,
            { headers: buildHeaders(jwt) }
        );
        logger.info(`📈 ${interval} candles fetched: ${res.data.data.length}`);
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
// GET OI DATA — fromdate & todate dynamic
// ─────────────────────────────────────────
async function getOIData(jwt, token, interval = "ONE_MINUTE", fromdate = getTodayFromDate(), todate = formatDateTime(), retries = 3) {
    const body = {
        exchange: "BFO",
        symboltoken: token,
        interval,
        fromdate,
        todate
    };

    try {
        logger.debug(`📊 Fetching OI | token: ${token} | ${fromdate} → ${todate}`);
        const res = await axios.post(
            `${BASE_URL}/rest/secure/angelbroking/historical/v1/getOIData`,
            body,
            { headers: buildHeaders(jwt) }
        );
        logger.info(`📈 OI candles fetched: ${res.data.data.length}`);
        return res.data.data;

    } catch (err) {
        if (err.response?.status === 403 && retries > 0) {
            logger.warn(`⚠ OI Rate-limit — retrying in 2s… (${retries} left)`);
            await sleep(2000);
            return getOIData(jwt, token, interval, fromdate, todate, retries - 1);
        }
        logger.error(`❌ OI fetch failed: ${err.message}`);
        return [];
    }
}

// ─────────────────────────────────────────
// FORMAT raw candle array → object
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
// BUILD HIGHER TIMEFRAME from 1m slices
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
// CLEAN LEVELS (remove duplicates within threshold)
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
// VOLUME SPIKE (1.3x average of last 10)
// ─────────────────────────────────────────
function volumeSpike(data, index) {
    if (index < 10) return false;
    const avg = data.slice(index - 10, index).reduce((s, c) => s + c.volume, 0) / 10;
    return data[index].volume > avg * 1.3;
}

// ─────────────────────────────────────────
// OI ANALYSIS with 0.5% threshold
// ─────────────────────────────────────────
function analyzeOI(future1m, oiData) {
    const fLen = future1m.length;
    const oLen = oiData?.length ?? 0;
    const useRealOI = oLen >= 5;
    const len = useRealOI ? oLen : fLen;

    if (len < 5) {
        logger.warn("⚠ Insufficient OI data");
        return { signal: "NEUTRAL", label: "⚪ Insufficient OI data", priceDiff: 0, oiDiff: 0, oiChangePct: "0.00" };
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
// TELEGRAM (skipped in BACKTEST mode)
// ─────────────────────────────────────────
async function sendTelegram(message) {
    if (MODE === "BACKTEST") return; // ✅ No Telegram in backtest

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
// ENTRY ENGINE
// ─────────────────────────────────────────
async function entryEngine(index1m, future1m, data1D, oiData = []) {

    // ── Build timeframes (v2: includes 1H)
    const index5m = buildTimeframe(index1m, 5);
    const index15m = buildTimeframe(index1m, 15);
    const index1H = buildTimeframe(index1m, 60);

    logger.info(`Timeframes → 5m:${index5m.length} 15m:${index15m.length} 1H:${index1H.length}`);

    if (!index5m.length || !index15m.length) {
        logger.warn("⚠ Not enough 1m data to build timeframes");
        return "⚪ NO TRADE";
    }

    // ── Daily bias: EMA + candle direction (both must agree)
    const dailyData = (data1D?.length >= 2) ? data1D : buildTimeframe(index1m, 375);
    const dailyEMA = calculateEMA(dailyData);
    const dailyLast = dailyData[dailyData.length - 1];
    const dailyPrev = dailyData[dailyData.length - 2];   // v2: prev daily candle available

    const emaAbove = dailyLast.close > dailyEMA[dailyEMA.length - 1];
    const bullCandle = dailyLast.close > dailyLast.open;  // green day candle
    const bearCandle = dailyLast.close < dailyLast.open;  // red day candle

    const dailyBias =
        (emaAbove && bullCandle) ? "BULLISH" :
            (!emaAbove && bearCandle) ? "BEARISH" : "NEUTRAL";

    logger.info(`Daily Bias: ${dailyBias} | EMAAbove:${emaAbove} | bullCandle:${bullCandle} | bearCandle:${bearCandle}`);

    if (dailyBias === "NEUTRAL") {
        logger.info("⚪ Daily bias NEUTRAL — skipping");
        return "⚪ NO TRADE";
    }

    // ── Daily range filter (0.8% min — uncomment to enable)
    // const dailyRangePct = ((dailyLast.high - dailyLast.low) / dailyLast.low) * 100;
    // logger.info(`📏 Daily Range: ${dailyRangePct.toFixed(2)}% | Min required: 0.8%`);
    // if (dailyRangePct < 0.8) {
    //     logger.info("⚪ Daily range too small (<0.8%) — flat day, skipping");
    //     return "⚪ NO TRADE";
    // }

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

    // ── Breakout: close > max/min of last 5 bars (v2 — no buffer)
    const last1m = index1m[index1m.length - 1];
    const prev1m = index1m[index1m.length - 2];
    const last5 = index1m.slice(-6, -1);   // 5 candles before last
    const max5High = Math.max(...last5.map(c => c.high));
    const min5Low = Math.min(...last5.map(c => c.low));
    const breakUp = last1m.close > max5High;   // v2: plain close > 5-bar high
    const breakDown = last1m.close < min5Low;    // v2: plain close < 5-bar low

    // ── S/R break: must be within 50 pts of level
    const SR_THRESHOLD = 50;
    const nearSupport = finalSupports.filter(s => s < last1m.close).pop();
    const nearResistance = finalResistances.find(r => r > last1m.close);

    const breakBelow = nearSupport && last1m.close < nearSupport && Math.abs(last1m.close - nearSupport) <= SR_THRESHOLD;
    const breakAbove = nearResistance && last1m.close > nearResistance && Math.abs(last1m.close - nearResistance) <= SR_THRESHOLD;

    // ── Volume spike
    const volConfirm = volumeSpike(future1m, future1m.length - 1);

    // ── Big candle: range > 1.5x prev AND body > 60% of range
    const body = Math.abs(last1m.close - last1m.open);
    const range = last1m.high - last1m.low;
    const strongBody = range > 0 && (body / range) > 0.6;
    const bigCandle = (range > (prev1m.high - prev1m.low) * 1.5) && strongBody;

    // ── OI confirmation
    const oi = analyzeOI(future1m, oiData);
    const oiConfirmsBull = oi.signal === "BULLISH";
    const oiConfirmsBear = oi.signal === "BEARISH";

    // ── LTP + spread
    const lastIndex = index1m[index1m.length - 1];
    const lastFuture = future1m[future1m.length - 1];
    const spread = lastFuture.close - lastIndex.close;
    const spreadStr = spread.toFixed(2);

    logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    logger.info(`📍 INDEX  LTP → ${lastIndex.close}  | IST: ${getISTTime(new Date(lastIndex.time))}`);
    logger.info(`📍 FUTURE LTP → ${lastFuture.close} | IST: ${getISTTime(new Date(lastFuture.time))}`);
    logger.info(`📊 Spread      → ${spreadStr}`);
    // Spread filter: reject abnormal spread > 200 pts (uncomment to enable)
    // if (Math.abs(spread) > 200) { logger.warn("⚠ Abnormal spread — skipping"); return "⚪ NO TRADE"; }
    logger.info(`🕐 System IST  → ${getISTTime()}`);
    logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    logger.info(`trendUp:${trendUp} trendDown:${trendDown}`);
    logger.info(`breakUp:${breakUp} breakDown:${breakDown} (5-bar breakout)`);
    logger.info(`breakAbove:${breakAbove} breakBelow:${breakBelow} (within ${SR_THRESHOLD}pts)`);
    logger.info(`bigCandle:${bigCandle} strongBody:${strongBody} volConfirm:${volConfirm}`);
    logger.info(`OI → ${oi.label} | Δ${oi.oiDiff} (${oi.oiChangePct}%)`);
    logger.info(`oiConfirmsBull:${oiConfirmsBull} oiConfirmsBear:${oiConfirmsBear}`);

    // ─────────────────────────────────────
    // PE ENTRY
    // ─────────────────────────────────────
    if (
        dailyBias === "BEARISH" &&
        (trendDown || bigCandle) &&
        (breakDown || breakBelow) &&
        volConfirm
        // && oiConfirmsBear  // uncomment to enable OI filter
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
        // && oiConfirmsBull  // uncomment to enable OI filter
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

// ═══════════════════════════════════════════════════════════
//  ██████╗  █████╗  ██████╗██╗  ██╗████████╗███████╗███████╗████████╗
//  ██╔══██╗██╔══██╗██╔════╝██║ ██╔╝╚══██╔══╝██╔════╝██╔════╝╚══██╔══╝
//  ██████╔╝███████║██║     █████╔╝    ██║   █████╗  ███████╗   ██║
//  ██╔══██╗██╔══██║██║     ██╔═██╗    ██║   ██╔══╝  ╚════██║   ██║
//  ██████╔╝██║  ██║╚██████╗██║  ██╗   ██║   ███████╗███████║   ██║
//  ╚═════╝ ╚═╝  ╚═╝ ╚═════╝╚═╝  ╚═╝   ╚═╝   ╚══════╝╚══════╝   ╚═╝
// ═══════════════════════════════════════════════════════════
//
//  runBacktest(jwt, fromDate, toDate)
//
//  ✅ Iterates candle by candle (simulates live feed)
//  ✅ Calls entryEngine() with historical slice
//  ✅ Logs every entry to backtest.log (CSV)
//  ✅ No Telegram — blocked by MODE flag
//  ✅ P&L calculation (SL 50 pts / Target 100 pts)
//  ✅ Trade stats summary at end
// ═══════════════════════════════════════════════════════════

async function runBacktest(jwt, fromDate, toDate) {

    logger.info(`${"═".repeat(60)}`);
    logger.info(`📊 BACKTEST MODE STARTED`);
    logger.info(`   From : ${fromDate}`);
    logger.info(`   To   : ${toDate}`);
    logger.info(`${"═".repeat(60)}`);

    // ── Fetch all historical data for the date range
    const futureToken = await getFutureToken();

    // Daily data: go 60 days back from fromDate for enough EMA history
    const dailyFrom = (() => {
        const d = new Date(fromDate);
        d.setDate(d.getDate() - 60);
        const p = n => String(n).padStart(2, "0");
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} 09:15`;
    })();

    logger.info(`📅 Fetching data...`);

    const indexRaw = await getHistorical(jwt, "BSE", process.env.SYMBOLTOKEN, "ONE_MINUTE", fromDate, toDate);
    await sleep(400);
    const futureRaw = await getHistorical(jwt, "BFO", futureToken, "ONE_MINUTE", fromDate, toDate);
    await sleep(400);
    const raw1D = await getHistorical(jwt, "BSE", process.env.SYMBOLTOKEN, "ONE_DAY", dailyFrom, toDate);
    await sleep(400);
    const oiRaw = await getOIData(jwt, futureToken, "ONE_MINUTE", fromDate, toDate);

    const index1m = format(indexRaw);
    const future1m = format(futureRaw);
    const data1D = format(raw1D);

    if (index1m.length < 110 || future1m.length < 110) {
        logger.error("❌ Not enough historical data for backtest (need 110+ candles)");
        return;
    }

    logger.info(`✅ Data fetched → Index:${index1m.length} Future:${future1m.length} Daily:${data1D.length} OI:${oiRaw.length}`);
    logger.info(`🔁 Starting candle-by-candle simulation...`);

    // ── CSV header
    backtestLogger.info(
        `No,EntryTime,Signal,IndexPrice,FuturePrice,ExitTime,ExitPrice,ExitReason,PLPoints`
    );

    // ── State tracking
    let lastSignal = null;
    let tradeNo = 0;
    let openTrade = null;  // { signal, entryTime, entryPrice, entryFuturePrice }

    // ✅ Cooldown after SL hit — skip COOLDOWN_CANDLES before next entry
    const COOLDOWN_CANDLES = 15;  // 15 x 1m candles = 15 min wait
    let cooldownLeft = 0;        // counts down each candle

    // ── P&L accumulators
    let totalTrades = 0;
    let wins = 0;
    let losses = 0;
    let totalPL = 0;
    let maxWin = 0;
    let maxLoss = 0;

    const SL_POINTS = 50;   // initial SL before trail kicks in
    const TRAIL_STEP = 50;   // trail SL every 50 pts of profit
    const TGT_POINTS = 250;  // ✅ fixed target — exit immediately if hit

    // ── Candle loop — start at 100 for enough EMA history
    for (let i = 100; i < index1m.length; i++) {

        const sliceIndex = index1m.slice(0, i + 1);
        const sliceFuture = future1m.slice(0, i + 1);
        const sliceOI = oiRaw.slice(0, i + 1);

        const currentCandle = sliceIndex[sliceIndex.length - 1];
        const currentFuture = sliceFuture[sliceFuture.length - 1];
        const currentTime = currentCandle.time;
        const indexPrice = currentCandle.close;
        const futurePrice = currentFuture.close;

        // ══════════════════════════════════════════════════════
        // TSL — Break-even + Step Trail  (no fixed target)
        // ══════════════════════════════════════════════════════
        //  CE entry = 82000, TRAIL_STEP = 50, SL_POINTS = 50
        //
        //  Price 82000→82049  move= 0–49   → SL = 81950  (initial -50, trail inactive)
        //  Price 82050        move= 50      → SL = 82000  (break-even 🟡)
        //  Price 82100        move= 100     → SL = 82050  (+50 locked 🔒)
        //  Price 82150        move= 150     → SL = 82100  (+100 locked 🔒)
        //  Price 82200        move= 200     → SL = 82150  (+150 locked 🔒)
        //
        //  SL checked using candle.low (CE) / candle.high (PE) — NEVER close
        // ══════════════════════════════════════════════════════
        if (openTrade) {
            let exitReason = null;
            let pl = 0;

            const candleHigh = currentCandle.high;
            const candleLow = currentCandle.low;

            // ─── Get last 5m candle low/high for smarter trail anchor ───
            // Pro trail: after break-even, SL hugs last 5m swing low/high
            const slice5m = buildTimeframe(sliceIndex, 5);
            const last5mCandle = slice5m.length >= 2 ? slice5m[slice5m.length - 2] : null; // prev closed 5m candle

            if (openTrade.signal === "🟢 CE ENTRY") {

                // ── Step 1: track max favourable move using candle high
                const move = candleHigh - openTrade.entryPrice;
                if (move > openTrade.maxFavourable)
                    openTrade.maxFavourable = move;

                // ── Step 2: update trailingSL when move >= TRAIL_STEP
                if (openTrade.maxFavourable >= TRAIL_STEP) {
                    const steps = Math.floor(openTrade.maxFavourable / TRAIL_STEP);

                    // Base step trail: entry + (steps-1)*50
                    const stepSL = openTrade.entryPrice + (steps - 1) * TRAIL_STEP;

                    // 🔥 Pro trail: after break-even, also check last 5m candle low
                    // Use whichever is HIGHER (tighter protection for CE)
                    const swing5mSL = (last5mCandle && steps >= 2) ? last5mCandle.low : null;
                    const newSL = swing5mSL ? Math.max(stepSL, swing5mSL) : stepSL;

                    // SL only moves UP — never backwards
                    if (openTrade.trailingSL === null || newSL > openTrade.trailingSL)
                        openTrade.trailingSL = newSL;
                }

                // ── Step 3: determine active SL level
                const slLevel = openTrade.trailingSL ?? (openTrade.entryPrice - SL_POINTS);

                logger.info(
                    `📐 CE TSL | move:${(candleHigh - openTrade.entryPrice).toFixed(0)} ` +
                    `maxFav:${openTrade.maxFavourable.toFixed(0)} ` +
                    `trailSL:${openTrade.trailingSL ?? "inactive"} ` +
                    `activeSL:${slLevel}`
                );

                // ── Step 4a: Fixed Target hit (checked FIRST — take profit immediately)
                if (candleHigh >= openTrade.entryPrice + TGT_POINTS) {
                    exitReason = "TARGET";
                    pl = TGT_POINTS;
                }
                // ── Step 4b: TSL exit (only if target not hit)
                else if (candleLow <= slLevel) {
                    exitReason = "TSL";
                    pl = slLevel - openTrade.entryPrice;
                }

            } else if (openTrade.signal === "🟥 PE ENTRY") {

                // ── Step 1: track max favourable move using candle low
                const move = openTrade.entryPrice - candleLow;
                if (move > openTrade.maxFavourable)
                    openTrade.maxFavourable = move;

                // ── Step 2: update trailingSL when move >= TRAIL_STEP
                if (openTrade.maxFavourable >= TRAIL_STEP) {
                    const steps = Math.floor(openTrade.maxFavourable / TRAIL_STEP);

                    // Base step trail: entry - (steps-1)*50
                    const stepSL = openTrade.entryPrice - (steps - 1) * TRAIL_STEP;

                    // 🔥 Pro trail: after break-even, also check last 5m candle high
                    // Use whichever is LOWER (tighter protection for PE)
                    const swing5mSL = (last5mCandle && steps >= 2) ? last5mCandle.high : null;
                    const newSL = swing5mSL ? Math.min(stepSL, swing5mSL) : stepSL;

                    // SL only moves DOWN — never backwards
                    if (openTrade.trailingSL === null || newSL < openTrade.trailingSL)
                        openTrade.trailingSL = newSL;
                }

                // ── Step 3: determine active SL level
                const slLevel = openTrade.trailingSL ?? (openTrade.entryPrice + SL_POINTS);

                logger.info(
                    `📐 PE TSL | move:${(openTrade.entryPrice - candleLow).toFixed(0)} ` +
                    `maxFav:${openTrade.maxFavourable.toFixed(0)} ` +
                    `trailSL:${openTrade.trailingSL ?? "inactive"} ` +
                    `activeSL:${slLevel}`
                );

                // ── Step 4a: Fixed Target hit (checked FIRST — take profit immediately)
                if (candleLow <= openTrade.entryPrice - TGT_POINTS) {
                    exitReason = "TARGET";
                    pl = TGT_POINTS;
                }
                // ── Step 4b: TSL exit (only if target not hit)
                else if (candleHigh >= slLevel) {
                    exitReason = "TSL";
                    pl = openTrade.entryPrice - slLevel;
                }
            }

            if (exitReason) {
                totalTrades++;
                totalPL += pl;
                if (pl > 0) { wins++; if (pl > maxWin) maxWin = pl; }
                else { losses++; if (pl < maxLoss) maxLoss = pl; }

                backtestLogger.info(
                    `${openTrade.no},${openTrade.entryTime},${openTrade.signal},` +
                    `${openTrade.entryPrice},${openTrade.entryFuturePrice},` +
                    `${currentTime},${indexPrice},${exitReason},${pl.toFixed(2)}`
                );

                logger.info(
                    `🏁 TRADE #${openTrade.no} CLOSED | ${exitReason} | ` +
                    `${openTrade.signal} | MaxFav:${openTrade.maxFavourable.toFixed(0)} | ` +
                    `P&L: ${pl >= 0 ? "+" : ""}${pl.toFixed(2)} pts`
                );

                openTrade = null;
                lastSignal = null;

                // ✅ Cooldown only on a losing exit (pl <= 0 = initial SL hit, no profit locked)
                if (pl <= 0) {
                    cooldownLeft = COOLDOWN_CANDLES;
                    logger.info(`🧊 COOLDOWN — ${COOLDOWN_CANDLES} candles blocked after loss`);
                }
            }
        }

        // ── Cooldown countdown (tick every candle after SL)
        if (cooldownLeft > 0) {
            cooldownLeft--;
            logger.info(`🧊 Cooldown: ${cooldownLeft} candles remaining — entry blocked`);
            continue;  // skip entry engine entirely during cooldown
        }

        // ── Run entry engine on this candle slice
        const signal = await entryEngine(sliceIndex, sliceFuture, data1D, sliceOI);

        // ── New signal — open trade
        if (signal !== "⚪ NO TRADE" && signal !== lastSignal && !openTrade) {
            tradeNo++;

            openTrade = {
                no: tradeNo,
                signal,
                entryTime: currentTime,
                entryPrice: indexPrice,
                entryFuturePrice: futurePrice,
                trailingSL: null,    // ✅ TSL: starts as null, activates after first TRAIL_STEP
                maxFavourable: 0        // ✅ TSL: tracks peak profit move
            };

            logger.info(`📌 BACKTEST ENTRY #${tradeNo} → ${signal} @ ${indexPrice} | ${currentTime}`);
            lastSignal = signal;
        }

        if (signal === "⚪ NO TRADE") lastSignal = null;

        // Small delay to avoid CPU hammering on large datasets
        if (i % 50 === 0) await sleep(10);
    }

    // ── Close any still-open trade at end of data
    if (openTrade) {
        const lastCandle = index1m[index1m.length - 1];
        const pl = openTrade.signal === "🟢 CE ENTRY"
            ? lastCandle.close - openTrade.entryPrice
            : openTrade.entryPrice - lastCandle.close;

        totalTrades++;
        totalPL += pl;
        if (pl > 0) wins++; else losses++;

        backtestLogger.info(
            `${openTrade.no},${openTrade.entryTime},${openTrade.signal},` +
            `${openTrade.entryPrice},${openTrade.entryFuturePrice},` +
            `${lastCandle.time},${lastCandle.close},EOD,${pl.toFixed(2)}`
        );
    }

    // ─────────────────────────────────────
    // TRADE STATS SUMMARY
    // ─────────────────────────────────────
    const winRate = totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : "0";
    const avgPL = totalTrades > 0 ? (totalPL / totalTrades).toFixed(2) : "0";

    const summary = `
${"═".repeat(50)}
📊 BACKTEST SUMMARY
${"═".repeat(50)}
📅 Period      : ${fromDate}  →  ${toDate}
─────────────────────────────────────────────
📈 Total Trades : ${totalTrades}
✅ Wins         : ${wins}
❌ Losses       : ${losses}
🎯 Win Rate     : ${winRate}%
─────────────────────────────────────────────
💰 Total P&L    : ${totalPL >= 0 ? "+" : ""}${totalPL.toFixed(0)} pts
📊 Avg P&L/Trade: ${avgPL} pts
🚀 Max Win      : +${maxWin} pts
💥 Max Loss     : ${maxLoss} pts
${"═".repeat(50)}
`;

    logger.info(summary);
    backtestLogger.info(`\n${summary}`);

    logger.info("✅ BACKTEST COMPLETED → check backtest.log");
}

// ─────────────────────────────────────────
// LIVE MAIN LOOP
// ─────────────────────────────────────────
async function runLive() {
    logger.info("🚀 LIVE MODE STARTED");

    const jwt = await login();
    const futureToken = await getFutureToken();

    let lastSignal = null;
    let iteration = 0;

    while (true) {
        iteration++;

        if (!isMarketOpen()) {
            logger.info(`⏸ Market closed | IST: ${getISTTime()} | Next check in 60s`);
            await sleep(60_000);
            continue;
        }

        try {
            logger.info(`🔄 Loop #${iteration} | IST: ${getISTTime()}`);

            const todate = formatDateTime();
            const fromdate = getTodayFromDate();
            const dailyfrom = getDailyFromDate();

            const indexRaw = await getHistorical(jwt, "BSE", process.env.SYMBOLTOKEN, "ONE_MINUTE", fromdate, todate);
            await sleep(300);
            const raw1D = await getHistorical(jwt, "BSE", process.env.SYMBOLTOKEN, "ONE_DAY", dailyfrom, todate);
            await sleep(300);
            const futureRaw = await getHistorical(jwt, "BFO", futureToken, "ONE_MINUTE", fromdate, todate);
            await sleep(300);
            const oiRaw = await getOIData(jwt, futureToken, "ONE_MINUTE", fromdate, todate);

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

        await sleep(15_000);
    }
}

// ─────────────────────────────────────────
// ENTRY POINT — switch via MODE env var
//
//  BACKTEST: MODE=BACKTEST node bot.js
//  LIVE:     MODE=LIVE     node bot.js
//
// ─────────────────────────────────────────
async function main() {
    if (MODE === "BACKTEST") {

        logger.info("🗂 MODE = BACKTEST");

        const jwt = await login();

        // ✅ Change these dates to your desired backtest window
        await runBacktest(
            jwt,
            process.env.BT_FROM || "2026-02-01 09:15",
            process.env.BT_TO || "2026-02-25 15:30"
        );

    } else {
        logger.info("🗂 MODE = LIVE");
        await runLive();
    }
}

main();