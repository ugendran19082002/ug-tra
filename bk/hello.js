require("dotenv").config();
const axios = require("axios");
const fs = require("fs");
const os = require("os");
const speakeasy = require("speakeasy");
const winston = require("winston");

const BASE_URL = "https://apiconnect.angelone.in";

// ═══════════════════════════════════════════════════════════
// IST TIME
// ═══════════════════════════════════════════════════════════
function getISTTime(date = new Date()) {
    return date.toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
        hour12: false
    }).replace(",", " |");
}

// ═══════════════════════════════════════════════════════════
// LOGGER
// ═══════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════
// MARKET HOURS CHECK (IST)
// ═══════════════════════════════════════════════════════════
function isMarketOpen() {
    const now = new Date();
    const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const mins = ist.getHours() * 60 + ist.getMinutes();
    return mins >= (9 * 60 + 15) && mins <= (15 * 60 + 30);
}

// ═══════════════════════════════════════════════════════════
// LOGIN
// ═══════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════
// HISTORICAL DATA
// ═══════════════════════════════════════════════════════════
async function getHistorical(jwt, exchange, token, interval, fromdate = getTodayFromDate(), retries = 3) {
    const body = {
        exchange,
        symboltoken: token,
        interval,
        fromdate,
        todate: formatDateTime()
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

// ═══════════════════════════════════════════════════════════
// GET OI DATA
// ═══════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════
// LIVE QUOTE (Full market depth + OI + volume)
// ═══════════════════════════════════════════════════════════
async function getLiveQuote(jwt, exchange, symbolToken, retries = 3) {
    try {
        logger.debug(`📡 Fetching Live Quote | ${exchange} | ${symbolToken}`);
        const res = await axios.post(
            `${BASE_URL}/rest/secure/angelbroking/market/v1/quote/`,
            {
                mode: "FULL",
                exchangeTokens: {
                    [exchange]: [symbolToken]
                }
            },
            { headers: buildHeaders(jwt) }
        );

        const fetched = res.data?.data?.fetched;
        if (!fetched || fetched.length === 0) {
            logger.warn("⚠ Live quote returned empty");
            return null;
        }

        const q = fetched[0];
        logger.info(`📡 Live Quote | LTP: ${q.ltp} | Volume: ${q.tradeVolume} | OI: ${q.opnInterest}`);
        return q;

    } catch (err) {
        if (err.response?.status === 403 && retries > 0) {
            logger.warn(`⚠ Quote Rate-limit — retrying in 2s… (${retries} left)`);
            await sleep(2000);
            return getLiveQuote(jwt, exchange, symbolToken, retries - 1);
        }
        logger.error(`❌ Live Quote failed: ${err.message}`);
        return null;
    }
}

// ═══════════════════════════════════════════════════════════
// FORMAT CANDLES
// ═══════════════════════════════════════════════════════════
const format = raw => raw.map(c => ({
    time: c[0], open: c[1], high: c[2],
    low: c[3], close: c[4], volume: c[5], oi: c[6] ?? 0
}));

// ═══════════════════════════════════════════════════════════
// BUILD HIGHER TIMEFRAME
// ═══════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════
// EMA
// ═══════════════════════════════════════════════════════════
function calculateEMA(data, period = 20) {
    const k = 2 / (period + 1);
    let ema = data[0].close;
    return data.map(c => (ema = c.close * k + ema * (1 - k)));
}

// ═══════════════════════════════════════════════════════════
// SWING S/R
// ═══════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════
// ROUND LEVELS
// ═══════════════════════════════════════════════════════════
function getRoundLevels(price, step = 500) {
    const base = Math.floor(price / step) * step;
    return [base - step, base, base + step, base + step * 2];
}

// ═══════════════════════════════════════════════════════════
// CLEAN LEVELS
// ═══════════════════════════════════════════════════════════
function cleanLevels(levels, threshold = 20) {
    levels.sort((a, b) => a - b);
    return levels.reduce((acc, lvl) => {
        if (acc.length === 0 || Math.abs(lvl - acc[acc.length - 1]) > threshold)
            acc.push(lvl);
        return acc;
    }, []);
}

// ═══════════════════════════════════════════════════════════
// VOLUME SPIKE (1.3x average)
// ═══════════════════════════════════════════════════════════
function volumeSpike(data, index) {
    if (index < 10) return false;
    const avg = data.slice(index - 10, index).reduce((s, c) => s + c.volume, 0) / 10;
    return data[index].volume > avg * 1.3;
}

// ═══════════════════════════════════════════════════════════
// VOLUME ACCELERATION (sudden burst above prev candle)
// ═══════════════════════════════════════════════════════════
function volumeAcceleration(data, index, threshold = 1.5) {
    if (index < 2) return false;
    const curr = data[index].volume;
    const prev = data[index - 1].volume;
    return prev > 0 && curr > prev * threshold;
}

// ═══════════════════════════════════════════════════════════
// OI ANALYSIS
// ═══════════════════════════════════════════════════════════
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

    // OI must change by at least 1% to count (upgraded from 0.5%)
    const oiChangePct = prevOI > 0 ? Math.abs((currOI - prevOI) / prevOI) * 100 : 0;
    const oiUp = currOI > prevOI && oiChangePct >= 1.0;
    const oiDown = currOI < prevOI && oiChangePct >= 1.0;

    const priceDiff = (currPrice - prevPrice).toFixed(2);
    const oiDiff = currOI - prevOI;

    logger.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    logger.info(`📊 OI Analysis | Source: ${useRealOI ? "API" : "Candle"}`);
    logger.info(`   Price: ${prevPrice} → ${currPrice} (${priceDiff > 0 ? "+" : ""}${priceDiff})`);
    logger.info(`   OI   : ${prevOI} → ${currOI} (${oiDiff > 0 ? "+" : ""}${oiDiff}) | Chg: ${oiChangePct.toFixed(2)}%`);

    if (priceUp && oiUp) {
        logger.info("📈 Long Build-up — STRONG BULLISH");
        logger.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        return { signal: "BULLISH", label: "📈 Long Build-up (Strong Bullish)", priceDiff, oiDiff, oiChangePct: oiChangePct.toFixed(2) };
    }
    if (priceDown && oiUp) {
        logger.info("📉 Short Build-up — STRONG BEARISH");
        logger.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        return { signal: "BEARISH", label: "📉 Short Build-up (Strong Bearish)", priceDiff, oiDiff, oiChangePct: oiChangePct.toFixed(2) };
    }
    if (priceUp && oiDown) {
        logger.info("🔄 Short Covering — WEAK BULLISH");
        logger.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        return { signal: "WEAK_BULLISH", label: "🔄 Short Covering (Weak Bullish)", priceDiff, oiDiff, oiChangePct: oiChangePct.toFixed(2) };
    }
    if (priceDown && oiDown) {
        logger.info("🔄 Long Unwinding — WEAK BEARISH");
        logger.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        return { signal: "WEAK_BEARISH", label: "🔄 Long Unwinding (Weak Bearish)", priceDiff, oiDiff, oiChangePct: oiChangePct.toFixed(2) };
    }

    logger.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    return { signal: "NEUTRAL", label: "⚪ Neutral (OI change < 1%)", priceDiff, oiDiff, oiChangePct: oiChangePct.toFixed(2) };
}

// ═══════════════════════════════════════════════════════════
// ★ LIVE QUOTE FILTERS (NEW — All 7 filters)
// ═══════════════════════════════════════════════════════════

/**
 * Filter 1: VWAP Bias
 * avgPrice from live quote acts as intraday VWAP proxy.
 * LTP above avgPrice = Bullish VWAP bias, below = Bearish.
 */
function getVWAPBias(quote) {
    if (!quote) return { vwapBull: false, vwapBear: false, vwapLabel: "⚪ No Quote" };
    const vwapBull = quote.ltp > quote.avgPrice;
    const vwapBear = quote.ltp < quote.avgPrice;
    const vwapLabel = vwapBull ? "🟢 Above VWAP" : vwapBear ? "🔴 Below VWAP" : "⚪ At VWAP";
    return { vwapBull, vwapBear, vwapLabel };
}

/**
 * Filter 2: Order Flow Imbalance
 * totBuyQuan vs totSellQuan. 1.5x threshold = strong pressure.
 */
function getOrderFlow(quote) {
    if (!quote) return { buyPressure: false, sellPressure: false, flowLabel: "⚪ No Quote" };
    const buyPressure = quote.totBuyQuan > quote.totSellQuan * 1.5;
    const sellPressure = quote.totSellQuan > quote.totBuyQuan * 1.5;
    const flowRatio = quote.totSellQuan > 0
        ? (quote.totBuyQuan / quote.totSellQuan).toFixed(2)
        : "∞";
    const flowLabel = buyPressure
        ? `🟢 Buy Pressure (ratio: ${flowRatio})`
        : sellPressure
            ? `🔴 Sell Pressure (ratio: ${flowRatio})`
            : `⚪ Balanced (ratio: ${flowRatio})`;
    return { buyPressure, sellPressure, flowLabel, flowRatio };
}

/**
 * Filter 3: Depth Imbalance (Level 1 bid vs ask)
 * Best bid qty vs best ask qty. 1.3x = strong absorption.
 */
function getDepthBias(quote) {
    if (!quote?.depth?.buy?.length || !quote?.depth?.sell?.length) {
        return { depthStrongBuy: false, depthStrongSell: false, depthLabel: "⚪ No Depth" };
    }

    // Sum top 3 levels for more robust signal
    const buyDepth = quote.depth.buy.slice(0, 3).reduce((s, l) => s + l.quantity, 0);
    const sellDepth = quote.depth.sell.slice(0, 3).reduce((s, l) => s + l.quantity, 0);

    const depthStrongBuy = buyDepth > sellDepth * 1.3;
    const depthStrongSell = sellDepth > buyDepth * 1.3;

    const depthRatio = sellDepth > 0 ? (buyDepth / sellDepth).toFixed(2) : "∞";
    const depthLabel = depthStrongBuy
        ? `🟢 Buy Wall (ratio: ${depthRatio})`
        : depthStrongSell
            ? `🔴 Sell Wall (ratio: ${depthRatio})`
            : `⚪ Balanced Depth (ratio: ${depthRatio})`;

    return { depthStrongBuy, depthStrongSell, depthLabel, buyDepth, sellDepth };
}

/**
 * Filter 4: Circuit Proximity
 * Avoid trades if LTP is within 5 pts of circuit limits.
 * Prevents trapped entries on circuit-bound stocks/indices.
 */
function getCircuitStatus(quote) {
    if (!quote) return { nearUpper: false, nearLower: false, circuitLabel: "⚪ No Quote" };
    const BUFFER = 5;
    const nearUpper = (quote.upperCircuit - quote.ltp) < BUFFER;
    const nearLower = (quote.ltp - quote.lowerCircuit) < BUFFER;
    const circuitLabel = nearUpper
        ? "🚨 Near Upper Circuit!"
        : nearLower
            ? "🚨 Near Lower Circuit!"
            : "✅ Safe from Circuits";
    return { nearUpper, nearLower, circuitLabel };
}

/**
 * Filter 5: Intraday Strength
 * percentChange > 0.5% = meaningful trend, not sideways chop.
 */
function getIntradayStrength(quote) {
    if (!quote) return { strongTrend: false, bullStrength: false, bearStrength: false, strengthLabel: "⚪ No Quote" };
    const strongTrend = Math.abs(quote.percentChange) > 0.5;
    const bullStrength = strongTrend && quote.percentChange > 0;
    const bearStrength = strongTrend && quote.percentChange < 0;
    const strengthLabel = bullStrength
        ? `🟢 Strong Bull (+${quote.percentChange?.toFixed(2)}%)`
        : bearStrength
            ? `🔴 Strong Bear (${quote.percentChange?.toFixed(2)}%)`
            : `⚪ Weak/Sideways (${quote.percentChange?.toFixed(2)}%)`;
    return { strongTrend, bullStrength, bearStrength, strengthLabel };
}

// ═══════════════════════════════════════════════════════════
// FUTURE TOKEN (cached daily)
// ═══════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════
// ENTRY ENGINE — Full Hybrid with All Filters
// ═══════════════════════════════════════════════════════════
async function entryEngine(index1m, future1m, data1D, oiData = [], liveQuote = null) {

    // ── Build timeframes
    const index5m = buildTimeframe(index1m, 5);
    const index15m = buildTimeframe(index1m, 15);
    const index1H = buildTimeframe(index1m, 60);

    logger.info(`Timeframes → 5m:${index5m.length} 15m:${index15m.length} 1H:${index1H.length}`);

    if (!index5m.length || !index15m.length) {
        logger.warn("⚠ Not enough 1m data to build timeframes");
        return "⚪ NO TRADE";
    }

    // ──────────────────────────────────────
    // ★ LIVE QUOTE FILTERS — Extract all signals
    // ──────────────────────────────────────
    const { vwapBull, vwapBear, vwapLabel } = getVWAPBias(liveQuote);
    const { buyPressure, sellPressure, flowLabel } = getOrderFlow(liveQuote);
    const { depthStrongBuy, depthStrongSell, depthLabel } = getDepthBias(liveQuote);
    const { nearUpper, nearLower, circuitLabel } = getCircuitStatus(liveQuote);
    const { strongTrend, bullStrength, bearStrength, strengthLabel } = getIntradayStrength(liveQuote);

    logger.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    logger.info(`📡 Live Quote Filters`);
    logger.info(`   VWAP     : ${vwapLabel}`);
    logger.info(`   OrderFlow: ${flowLabel}`);
    logger.info(`   Depth    : ${depthLabel}`);
    logger.info(`   Circuit  : ${circuitLabel}`);
    logger.info(`   Strength : ${strengthLabel}`);
    logger.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    // ── Block circuit-bound entries immediately
    if (nearUpper || nearLower) {
        logger.warn(`⛔ Circuit proximity detected — ${circuitLabel} — Skipping`);
        return "⚪ NO TRADE (Circuit)";
    }

    // ──────────────────────────────────────
    // Daily Bias: EMA + candle direction
    // ──────────────────────────────────────
    const dailyData = (data1D?.length >= 2) ? data1D : buildTimeframe(index1m, 375);
    const dailyEMA = calculateEMA(dailyData);
    const dailyLast = dailyData[dailyData.length - 1];

    const emaAbove = dailyLast.close > dailyEMA[dailyEMA.length - 1];
    const bullCandle = dailyLast.close > dailyLast.open;
    const bearCandle = dailyLast.close < dailyLast.open;

    const dailyBias =
        (emaAbove && bullCandle) ? "BULLISH" :
            (!emaAbove && bearCandle) ? "BEARISH" : "NEUTRAL";

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

    // ── Swing S/R (15m for cleaner levels)
    const { supports, resistances } = findSupportResistance(index15m);
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

    // ── Breakout: close > max of last 5 highs / < min of last 5 lows
    const last1m = index1m[index1m.length - 1];
    const prev1m = index1m[index1m.length - 2];
    const last5 = index1m.slice(-6, -1);
    const max5High = Math.max(...last5.map(c => c.high));
    const min5Low = Math.min(...last5.map(c => c.low));
    const breakUp = last1m.close > max5High;
    const breakDown = last1m.close < min5Low;

    // ── S/R break (within 50 pts)
    const SR_THRESHOLD = 50;
    const nearSupport = finalSupports.filter(s => s < last1m.close).pop();
    const nearResistance = finalResistances.find(r => r > last1m.close);

    const breakBelow = nearSupport && last1m.close < nearSupport && Math.abs(last1m.close - nearSupport) <= SR_THRESHOLD;
    const breakAbove = nearResistance && last1m.close > nearResistance && Math.abs(last1m.close - nearResistance) <= SR_THRESHOLD;

    // ── Volume spike + acceleration
    const volConfirm = volumeSpike(future1m, future1m.length - 1);
    const volAccel = volumeAcceleration(future1m, future1m.length - 1);
    const volStrongOk = volConfirm || volAccel;

    // ── Big candle: range > 1.5x prev AND body > 60% of range
    const body = Math.abs(last1m.close - last1m.open);
    const range = last1m.high - last1m.low;
    const strongBody = range > 0 && (body / range) > 0.6;
    const bigCandle = (range > (prev1m.high - prev1m.low) * 1.5) && strongBody;

    // ── OI Analysis
    const oi = analyzeOI(future1m, oiData);
    const oiConfirmsBull = oi.signal === "BULLISH";
    const oiConfirmsBear = oi.signal === "BEARISH";

    // ── Spread filter
    const lastIndex = index1m[index1m.length - 1];
    const lastFuture = future1m[future1m.length - 1];
    const spread = lastFuture.close - lastIndex.close;
    const spreadOK = Math.abs(spread) < 150;   // reject abnormal divergence

    logger.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    logger.info(`📍 INDEX  LTP → ${lastIndex.close}  | IST: ${getISTTime(new Date(lastIndex.time))}`);
    logger.info(`📍 FUTURE LTP → ${lastFuture.close} | IST: ${getISTTime(new Date(lastFuture.time))}`);
    logger.info(`📊 Spread      → ${spread.toFixed(2)} | spreadOK: ${spreadOK}`);
    logger.info(`🕐 System IST  → ${getISTTime()}`);
    logger.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    logger.info(`trendUp:${trendUp} trendDown:${trendDown}`);
    logger.info(`breakUp:${breakUp} breakDown:${breakDown} (5-bar breakout)`);
    logger.info(`breakAbove:${breakAbove} breakBelow:${breakBelow} (within ${SR_THRESHOLD}pts)`);
    logger.info(`bigCandle:${bigCandle} strongBody:${strongBody}`);
    logger.info(`volConfirm:${volConfirm} volAccel:${volAccel}`);
    logger.info(`OI → ${oi.label} | Δ${oi.oiDiff} (${oi.oiChangePct}%)`);
    logger.info(`oiConfirmsBull:${oiConfirmsBull} oiConfirmsBear:${oiConfirmsBear}`);

    const spreadStr = spread.toFixed(2);

    // ──────────────────────────────────────
    // ★ PE ENTRY — Full Hybrid Logic
    //   Core: dailyBias + trend/candle + breakout + volume
    //   Upgraded: VWAP + OrderFlow + Depth + Strength + OI + Spread
    // ──────────────────────────────────────
    if (
        dailyBias === "BEARISH" &&   // Daily trend filter
        (trendDown || bigCandle) &&   // 5m trend or momentum candle
        (breakDown || breakBelow) &&   // 1m breakout or S/R break
        volStrongOk &&   // Volume spike or acceleration
        vwapBear &&   // LTP below VWAP (no fake sell)
        sellPressure &&   // Order flow: sellers dominating
        spreadOK &&   // Spread within normal range
        oiConfirmsBear                     // OI: Short build-up confirmed
        // depthStrongSell              &&   // Optional: sell wall in depth
        // bearStrength                      // Optional: strong intraday move
    ) {
        const msg = `
🟥 *PE ENTRY SIGNAL*

📉 Bias     : ${dailyBias}
🕒 Time     : ${getISTTime()}

━━━━━━━━━━━━━━━━━━
📊 Price Info
Index LTP   : ${lastIndex.close}
Future LTP  : ${lastFuture.close}
Spread      : ${spreadStr} ✅

━━━━━━━━━━━━━━━━━━
📌 Core Conditions
Trend Down  : ${trendDown}
Big Candle  : ${bigCandle}
Break Down  : ${breakDown}
Break Below : ${breakBelow}
Volume OK   : ${volStrongOk} (Spike:${volConfirm} | Accel:${volAccel})

━━━━━━━━━━━━━━━━━━
📡 Quote Filters
VWAP        : ${vwapLabel}
Order Flow  : ${flowLabel}
Depth       : ${depthLabel}
Strength    : ${strengthLabel}
Circuit     : ${circuitLabel}

━━━━━━━━━━━━━━━━━━
📉 OI Confirmation
${oi.label}
Price Δ     : ${oi.priceDiff}
OI Δ        : ${oi.oiDiff} (${oi.oiChangePct}%)
━━━━━━━━━━━━━━━━━━`;
        tradeLogger.info(msg);
        await sendTelegram(msg);
        return "🟥 PE ENTRY";
    }

    // ──────────────────────────────────────
    // ★ CE ENTRY — Full Hybrid Logic
    //   Core: dailyBias + trend/candle + breakout + volume
    //   Upgraded: VWAP + OrderFlow + Depth + Strength + OI + Spread
    // ──────────────────────────────────────
    if (
        dailyBias === "BULLISH" &&   // Daily trend filter
        (trendUp || bigCandle) &&   // 5m trend or momentum candle
        (breakUp || breakAbove) &&   // 1m breakout or S/R break
        volStrongOk &&   // Volume spike or acceleration
        vwapBull &&   // LTP above VWAP (no fake buy)
        buyPressure &&   // Order flow: buyers dominating
        spreadOK &&   // Spread within normal range
        oiConfirmsBull                     // OI: Long build-up confirmed
        // depthStrongBuy               &&   // Optional: buy wall in depth
        // bullStrength                      // Optional: strong intraday move
    ) {
        const msg = `
🟢 *CE ENTRY SIGNAL*

📈 Bias     : ${dailyBias}
🕒 Time     : ${getISTTime()}

━━━━━━━━━━━━━━━━━━
📊 Price Info
Index LTP   : ${lastIndex.close}
Future LTP  : ${lastFuture.close}
Spread      : ${spreadStr} ✅

━━━━━━━━━━━━━━━━━━
📌 Core Conditions
Trend Up    : ${trendUp}
Big Candle  : ${bigCandle}
Break Up    : ${breakUp}
Break Above : ${breakAbove}
Volume OK   : ${volStrongOk} (Spike:${volConfirm} | Accel:${volAccel})

━━━━━━━━━━━━━━━━━━
📡 Quote Filters
VWAP        : ${vwapLabel}
Order Flow  : ${flowLabel}
Depth       : ${depthLabel}
Strength    : ${strengthLabel}
Circuit     : ${circuitLabel}

━━━━━━━━━━━━━━━━━━
📈 OI Confirmation
${oi.label}
Price Δ     : ${oi.priceDiff}
OI Δ        : ${oi.oiDiff} (${oi.oiChangePct}%)
━━━━━━━━━━━━━━━━━━`;
        tradeLogger.info(msg);
        await sendTelegram(msg);
        return "🟢 CE ENTRY";
    }

    logger.info(`⚪ NO TRADE | OI: ${oi.label}`);
    return "⚪ NO TRADE";
}

// ═══════════════════════════════════════════════════════════
// TELEGRAM
// ═══════════════════════════════════════════════════════════
async function sendTelegram(message) {
    try {
        const res = await axios.post(
            `https://api.telegram.org/bot${process.env.TG_TOKEN}/sendMessage`,
            { chat_id: process.env.TG_CHAT_ID, text: message, parse_mode: "Markdown" }
        );
        logger.info(`📱 Telegram sent | msg_id: ${res.data.result.message_id}`);
    } catch (err) {
        logger.error(`📱 Telegram error: ${err.response?.data?.description || err.message}`);
    }
}

// ═══════════════════════════════════════════════════════════
// MAIN LOOP
// ═══════════════════════════════════════════════════════════
async function main() {
    logger.info("🚀 BOT STARTED");
    logger.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    logger.info("📋 Active Filters:");
    logger.info("   ✅ Daily Bias (EMA + candle direction)");
    logger.info("   ✅ 5m EMA Trend");
    logger.info("   ✅ 1m 5-bar Breakout");
    logger.info("   ✅ S/R Level Break (within 50pts)");
    logger.info("   ✅ Volume Spike (1.3x avg)");
    logger.info("   ✅ Volume Acceleration (1.5x prev)");
    logger.info("   ✅ Big Candle (range + body filter)");
    logger.info("   ✅ VWAP Bias (LTP vs avgPrice)");
    logger.info("   ✅ Order Flow Imbalance (1.5x threshold)");
    logger.info("   ✅ Depth Imbalance (top 3 levels, 1.3x)");
    logger.info("   ✅ Circuit Proximity Guard");
    logger.info("   ✅ Intraday Strength (0.5% change)");
    logger.info("   ✅ OI Confirmation (1% threshold)");
    logger.info("   ✅ Spread Filter (< 150pts)");
    logger.info("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

    const jwt = await login();
    const futureToken = await getFutureToken();

    let lastSignal = null;
    let iteration = 0;

    while (true) {
        iteration++;

        // Market hours guard
        if (!isMarketOpen()) {
            logger.info(`⏸ Market closed | IST: ${getISTTime()} | Next check in 60s`);
            await sleep(60_000);
            continue;
        }

        try {
            logger.info(`🔄 Loop #${iteration} | IST: ${getISTTime()}`);

            // ── Fetch all data in parallel where possible
            const indexRaw = await getHistorical(jwt, "BSE", process.env.SYMBOLTOKEN, "ONE_MINUTE");
            await sleep(300);

            const raw1D = await getHistorical(jwt, "BSE", process.env.SYMBOLTOKEN, "ONE_DAY", getDailyFromDate());
            await sleep(300);

            const futureRaw = await getHistorical(jwt, "BFO", futureToken, "ONE_MINUTE");
            await sleep(300);

            const oiRaw = await getOIData(jwt, futureToken, "ONE_MINUTE");
            await sleep(300);

            // ── ★ Fetch live full quote for advanced filters
            const liveQuote = await getLiveQuote(jwt, "BSE", process.env.FUTURE_TOKEN);

            if (!indexRaw.length || !futureRaw.length) {
                logger.warn(`⚠ Missing data — skipping loop #${iteration}`);
                await sleep(15_000);
                continue;
            }

            const signal = await entryEngine(
                format(indexRaw),
                format(futureRaw),
                format(raw1D),
                oiRaw,
                liveQuote       // ★ Pass live quote for all 7 advanced filters
            );

            logger.info(`🎯 SIGNAL: ${signal}`);

            if (signal !== "⚪ NO TRADE" && signal !== "⚪ NO TRADE (Circuit)" && signal !== lastSignal) {
                logger.info(`🚨 NEW SIGNAL: ${signal}`);
                lastSignal = signal;
            }
            if (signal === "⚪ NO TRADE" || signal === "⚪ NO TRADE (Circuit)") {
                lastSignal = null;
            }

        } catch (err) {
            logger.error(`❌ Loop #${iteration} Error: ${err.message}`);
        }

        // Poll every 15 seconds
        await sleep(15_000);
    }
}

main();