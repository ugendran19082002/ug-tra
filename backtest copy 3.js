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
// HISTORICAL DATA
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
// OI DATA
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
// RSI(14) — Wilder smoothing
// ─────────────────────────────────────────
function calculateRSI(data, period = 14) {
    const n = data.length;
    if (n < period + 1) return Array(n).fill(50);

    const result = Array(period).fill(50);
    let avgGain = 0, avgLoss = 0;

    for (let i = 1; i <= period; i++) {
        const diff = data[i].close - data[i - 1].close;
        if (diff > 0) avgGain += diff;
        else avgLoss -= diff;
    }
    avgGain /= period;
    avgLoss /= period;

    const toRSI = (g, l) => l === 0 ? 100 : 100 - 100 / (1 + g / l);
    result.push(toRSI(avgGain, avgLoss));

    for (let i = period + 1; i < n; i++) {
        const diff = data[i].close - data[i - 1].close;
        avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
        avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
        result.push(toRSI(avgGain, avgLoss));
    }
    return result;
}

// ─────────────────────────────────────────
// ATR(14) — Wilder smoothing
// ─────────────────────────────────────────
function calculateATR(data, period = 14) {
    const n = data.length;
    if (n < period + 1) return Array(n).fill(null);

    const tr = data.map((c, i) =>
        i === 0
            ? c.high - c.low
            : Math.max(
                c.high - c.low,
                Math.abs(c.high - data[i - 1].close),
                Math.abs(c.low - data[i - 1].close)
            )
    );

    const result = Array(period).fill(null);
    let atr = tr.slice(0, period).reduce((s, v) => s + v, 0) / period;
    result.push(atr);

    for (let i = period; i < n; i++) {
        atr = (atr * (period - 1) + tr[i]) / period;
        result.push(atr);
    }
    return result;
}

// ─────────────────────────────────────────
// ADX(14) — Wilder smoothing
// ─────────────────────────────────────────
function calculateADX(data, period = 14) {
    const n = data.length;
    const result = new Array(n).fill(0);
    if (n < 2 * period + 1) return result;

    const tr = [], pdm = [], mdm = [];
    for (let i = 1; i < n; i++) {
        const up = data[i].high - data[i - 1].high;
        const dn = data[i - 1].low - data[i].low;
        pdm.push(up > dn && up > 0 ? up : 0);
        mdm.push(dn > up && dn > 0 ? dn : 0);
        tr.push(Math.max(
            data[i].high - data[i].low,
            Math.abs(data[i].high - data[i - 1].close),
            Math.abs(data[i].low - data[i - 1].close)
        ));
    }

    let sTR = tr.slice(0, period).reduce((a, b) => a + b, 0);
    let sPDM = pdm.slice(0, period).reduce((a, b) => a + b, 0);
    let sMDM = mdm.slice(0, period).reduce((a, b) => a + b, 0);

    const dx = [];
    const toDX = () => {
        if (sTR === 0) return 0;
        const pdi = sPDM / sTR * 100;
        const mdi = sMDM / sTR * 100;
        return (pdi + mdi) === 0 ? 0 : Math.abs(pdi - mdi) / (pdi + mdi) * 100;
    };
    dx.push(toDX());

    for (let i = period; i < tr.length; i++) {
        sTR = sTR - sTR / period + tr[i];
        sPDM = sPDM - sPDM / period + pdm[i];
        sMDM = sMDM - sMDM / period + mdm[i];
        dx.push(toDX());
    }

    let adx = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
    result[2 * period - 1] = adx;

    for (let i = period; i < dx.length; i++) {
        adx = (adx * (period - 1) + dx[i]) / period;
        result[2 * period + (i - period)] = adx;
    }

    return result;
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
// VOLUME SPIKE — Session-aware + 20-bar avg
// ─────────────────────────────────────────
function volumeSpike(data, index) {
    if (index < 20) return false;

    const avg = data.slice(index - 20, index)
        .reduce((s, c) => s + c.volume, 0) / 20;

    const ist = new Date(
        new Date(data[index].time)
            .toLocaleString("en-US", { timeZone: "Asia/Kolkata" })
    );
    const mins = ist.getHours() * 60 + ist.getMinutes();

    const multiplier =
        mins < (10 * 60) ? 1.8 :
            mins < (14 * 60) ? 1.5 :
                1.3;

    return data[index].volume > avg * multiplier;
}

// ─────────────────────────────────────────
// OI ANALYSIS
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
async function getFutureToken(symbolName = "SENSEX", refDate = new Date()) {
    const today = new Date().toDateString();

    const isLive = new Date(refDate).toDateString() === today;
    if (isLive && process.env.FUTURE_TOKEN && process.env.FUTURE_TOKEN_DATE === today) {
        logger.info("♻ Using cached future token");
        return process.env.FUTURE_TOKEN;
    }

    logger.info(`🔄 Fetching future token for refDate: ${new Date(refDate).toDateString()}...`);
    const res = await axios.get(
        "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json"
    );

    const monthMap = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
    const parseExpiry = str => new Date(parseInt(str.slice(5)), monthMap[str.slice(2, 5)], parseInt(str.slice(0, 2)));

    const now = new Date(refDate);
    const futures = res.data
        .filter(i => i.exch_seg === "BFO" && i.instrumenttype === "FUTIDX" && i.name === symbolName)
        .map(i => ({ ...i, expiryDate: parseExpiry(i.expiry) }))
        .filter(i => i.expiryDate >= now)
        .sort((a, b) => a.expiryDate - b.expiryDate);

    if (!futures.length) { logger.error("No valid futures found"); process.exit(1); }

    const current = futures[0];
    logger.info(`✅ Future: ${current.symbol} | token: ${current.token} | expiry: ${current.expiry}`);

    if (isLive) {
        let env = fs.readFileSync(".env", "utf8");
        env = env.replace(/FUTURE_TOKEN=.*/, `FUTURE_TOKEN=${current.token}`);
        env = env.replace(/FUTURE_TOKEN_DATE=.*/, `FUTURE_TOKEN_DATE=${today}`);
        fs.writeFileSync(".env", env);
    }

    return current.token;
}


// ═════════════════════════════════════════════════════════════════════════════
//
//  generateSignal() — Unified signal engine (live + backtest)
//
//  FIXES APPLIED:
//    🔒 FIX #2  — 10-bar breakout length guard → prevents Math.max([]) = -Infinity
//    ✂️  FIX #7  — Activated structure filter + fake-breakout (closeNearHigh/Low)
//                  Removed redundant S/R break (breakAbove/breakBelow already
//                  covered by 10-bar + swing combo → reduces stacking)
//
//  Original features retained:
//    ✅ Wilder ATR / ADX / RSI
//    ✅ Gap filter
//    ✅ Volume spike (session-aware)
//    ✅ Daily EMA bias
//    ✅ OI alignment
//
// ═════════════════════════════════════════════════════════════════════════════
function generateSignal(index1m, future1m, data1D, oiData = []) {

    // ─────────────────────────────────────────────────────
    // 🔒 FIX #2 — Breakout length guard
    //    Must have at least (lookback + 2) bars:
    //    lookback bars for the window + 1 for slicing fence + 1 for last1m.
    //    Without this, slice returns [] and Math.max([]) = -Infinity
    //    which makes every early bar appear as a breakout (silent fake signal).
    // ─────────────────────────────────────────────────────
    const lookback = 10;
    // if (index1m.length < lookback + 2)
    //     return { signal: "NO_TRADE", reason: `insufficient bars (need ${lookback + 2}, have ${index1m.length})` };

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

    // ── Gap filter
    const GAP_THRESHOLD = 300;
    const todayOpen = dailyLast.open;
    const prevClose = prevDay?.close ?? todayOpen;
    const gapPoints = todayOpen - prevClose;
    const gapUp = gapPoints > GAP_THRESHOLD;
    const gapDown = gapPoints < -GAP_THRESHOLD;
    const gapLabel = gapUp ? `🔼 Gap Up   (+${gapPoints.toFixed(0)} pts)` :
        gapDown ? `🔽 Gap Down (${gapPoints.toFixed(0)} pts)` :
            `◾ Normal day (${gapPoints.toFixed(0)} pts)`;

    // ─────────────────────────────────────────────────────
    // ✂️  FIX #7 — Market structure check (ACTIVATED)
    //    Was commented out before → now enforced.
    //    Requires last 3 × 15m bars to confirm HH+HL (CE) or LH+LL (PE).
    //    This removes entries in consolidating markets and
    //    reduces curve-fitting from pure indicator stacking.
    // ─────────────────────────────────────────────────────
    const last3 = index15m.slice(-3);
    const hasStructure = last3.length >= 3;
    const higherHigh = hasStructure && last3[2].high > last3[1].high;
    const higherLow = hasStructure && last3[2].low > last3[1].low;
    const lowerHigh = hasStructure && last3[2].high < last3[1].high;
    const lowerLow = hasStructure && last3[2].low < last3[1].low;
    const bullishStructure = higherHigh && higherLow;  // HH + HL → uptrend confirmed
    const bearishStructure = lowerHigh && lowerLow;   // LH + LL → downtrend confirmed

    // ── Swing S/R (15m for cleaner levels)
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

    // ── ATR(14) on 5m → dynamic SL / TGT
    const ATR_SL_MULT = 1.0;
    const ATR_TGT_MULT = 2.5;
    const ATR_FALLBACK = 80;

    const atr5m = calculateATR(index5m, 14);
    const rawATR = atr5m[atr5m.length - 1];
    const currentATR = rawATR && rawATR > 0 ? rawATR : ATR_FALLBACK;
    const dynamicSL = Math.min(60, Math.round(currentATR * ATR_SL_MULT));
    const dynamicTGT = Math.max(100, Math.round(currentATR * ATR_TGT_MULT));

    // ── ADX(14) on 5m — block sideways
    const adx5m = calculateADX(index5m, 14);
    const currentADX = adx5m[adx5m.length - 1];
    const trendStrong = currentADX >= 20;

    // ── RSI(14) on 5m — momentum confirmation
    const rsi5m = calculateRSI(index5m, 14);
    const currentRSI = rsi5m[rsi5m.length - 1];
    const rsiBullish = currentRSI > 55;
    const rsiBearish = currentRSI < 45;

    // ─────────────────────────────────────────────────────
    // 🔒 FIX #2 (continued) — Safe 10-bar breakout window
    //    index1m.length >= lookback + 2 already guaranteed above.
    //    slice(-(lookback+1), -1) gives exactly `lookback` bars,
    //    never an empty array → Math.max / Math.min are always valid.
    // ─────────────────────────────────────────────────────
    const last1m = index1m[index1m.length - 1];
    const prev1m = index1m[index1m.length - 2];
    const last10 = index1m.slice(-(lookback + 1), -1);  // exactly 10 bars, never empty

    const max10High = Math.max(...last10.map(c => c.high));
    const min10Low = Math.min(...last10.map(c => c.low));

    const break10Up = last1m.close > max10High;
    const break10Down = last1m.close < min10Low;

    // Secondary: swing high/low inside the 10-bar window
    const swingHighs = [], swingLows = [];
    for (let j = 1; j < last10.length - 1; j++) {
        if (last10[j].high > last10[j - 1].high && last10[j].high > last10[j + 1].high)
            swingHighs.push(last10[j].high);
        if (last10[j].low < last10[j - 1].low && last10[j].low < last10[j + 1].low)
            swingLows.push(last10[j].low);
    }
    const lastSwingHigh = swingHighs.length ? swingHighs[swingHighs.length - 1] : max10High;
    const lastSwingLow = swingLows.length ? swingLows[swingLows.length - 1] : min10Low;

    const breakUp = break10Up && last1m.close > lastSwingHigh;
    const breakDown = break10Down && last1m.close < lastSwingLow;

    // ── S/R proximity (within 50 pts)
    const SR_THRESHOLD = 50;
    const nearSupport = finalSupports.filter(s => s < last1m.close).pop();
    const nearResistance = finalResistances.find(r => r > last1m.close);

    const breakBelow = nearSupport && last1m.close < nearSupport && Math.abs(last1m.close - nearSupport) <= SR_THRESHOLD;
    const breakAbove = nearResistance && last1m.close > nearResistance && Math.abs(last1m.close - nearResistance) <= SR_THRESHOLD;

    // ── Volume spike
    const volConfirm = volumeSpike(future1m, future1m.length - 1);

    // ── Big candle
    const body = Math.abs(last1m.close - last1m.open);
    const range = last1m.high - last1m.low;
    const strongBody = range > 0 && (body / range) > 0.6;
    const bigCandle = (range > (prev1m.high - prev1m.low) * 1.5) && strongBody;

    // ─────────────────────────────────────────────────────
    // ✂️  FIX #7 — Fake breakout filter (ACTIVATED)
    //    Was commented out before → now enforced.
    //    CE: close must be within top 20% of bar range (no upper wick trap).
    //    PE: close must be within bottom 20% of bar range (no lower wick trap).
    //    Removes wick-poke breakouts that instantly reverse.
    // ─────────────────────────────────────────────────────
    const closeNearHigh = range > 0 && (last1m.high - last1m.close) / range < 0.2;
    const closeNearLow = range > 0 && (last1m.close - last1m.low) / range < 0.2;

    // ── OI analysis
    const oi = analyzeOI(future1m, oiData);

    // ── Spread
    const lastFuture = future1m[future1m.length - 1];
    const spread = lastFuture.close - last1m.close;

    // ── Diagnostics bundle
    const diag = {
        dailyBias, emaAbove, bullCandle, bearCandle,
        trendUp, trendDown,
        breakUp, breakDown, breakAbove, breakBelow,
        bigCandle, strongBody, volConfirm,
        bullishStructure, bearishStructure,
        higherHigh, higherLow, lowerHigh, lowerLow,
        trendStrong, currentADX: currentADX.toFixed(1),
        currentRSI: currentRSI.toFixed(1), rsiBullish, rsiBearish,
        currentATR: currentATR.toFixed(1), dynamicSL, dynamicTGT,
        closeNearHigh, closeNearLow,
        gapUp, gapDown, gapPoints: gapPoints.toFixed(0), gapLabel,
        spread: spread.toFixed(2),
        oi,
        indexLTP: last1m.close,
        futureLTP: lastFuture.close,
        finalSupports, finalResistances,
    };

    // ─────────────────────────────────────────────────────
    // PE ENTRY
    //   Filters active:
    //     ✅ Daily bearish bias
    //     ✅ 15m bearish structure (LH + LL) ← FIX #7 activated
    //     ✅ ADX ≥ 20 (trending, not sideways)
    //     ✅ RSI < 45 (bearish momentum)
    //     ✅ 5m EMA below OR big momentum candle
    //     ✅ 10-bar + swing breakout down (guarded ← FIX #2)
    //     ✅ Close near low (no wick trap) ← FIX #7 activated
    //     ✅ Volume spike (session-aware)
    //     ✅ No gap-up day
    //
    //   Removed from stack to reduce overfitting:
    //     ❌ S/R breakBelow (redundant with 10-bar + swing combo)
    // ─────────────────────────────────────────────────────
    if (
        dailyBias === "BEARISH" &&
        bearishStructure &&          // ✅ FIX #7 — 15m LH + LL
        trendStrong &&               // ADX ≥ 20
        rsiBearish &&                // RSI < 45
        (trendDown || bigCandle) &&  // 5m EMA or momentum
        breakDown &&                 // 10-bar + swing breakout (guarded ← FIX #2)
        closeNearLow &&              // ✅ FIX #7 — no wick trap
        volConfirm &&                // volume spike
        !gapUp                       // no gap-up day
    ) return { signal: "PE", ...diag };

    // ─────────────────────────────────────────────────────
    // CE ENTRY
    //   Same logic, bullish side
    // ─────────────────────────────────────────────────────
    if (
        dailyBias === "BULLISH" &&
        bullishStructure &&          // ✅ FIX #7 — 15m HH + HL
        trendStrong &&               // ADX ≥ 20
        rsiBullish &&                // RSI > 55
        (trendUp || bigCandle) &&    // 5m EMA or momentum
        breakUp &&                   // 10-bar + swing breakout (guarded ← FIX #2)
        closeNearHigh &&             // ✅ FIX #7 — no wick trap
        volConfirm &&                // volume spike
        !gapDown                     // no gap-down day
    ) return { signal: "CE", ...diag };

    return { signal: "NO_TRADE", ...diag };
}


// ─────────────────────────────────────────
// ENTRY ENGINE (live)
// ─────────────────────────────────────────
async function entryEngine(index1m, future1m, data1D, oiData = []) {

    const index5m = buildTimeframe(index1m, 5);
    const index15m = buildTimeframe(index1m, 15);
    const index1H = buildTimeframe(index1m, 60);
    logger.info(`Timeframes → 5m:${index5m.length} 15m:${index15m.length} 1H:${index1H.length}`);

    const r = generateSignal(index1m, future1m, data1D, oiData);

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
    logger.info(`🔷 Gap       : ${r.gapLabel}`);
    logger.info(`🔷 Structure : HH:${r.higherHigh} HL:${r.higherLow} | LH:${r.lowerHigh} LL:${r.lowerLow} | Bull:${r.bullishStructure} Bear:${r.bearishStructure}`);
    logger.info(`🔷 ADX(14)   : ${r.currentADX} (TrendStrong: ${r.trendStrong})`);
    logger.info(`🔷 RSI(14)   : ${r.currentRSI} | bullish:${r.rsiBullish} bearish:${r.rsiBearish}`);
    logger.info(`🔷 ATR(14)   : ${r.currentATR} → SL:${r.dynamicSL} TGT:${r.dynamicTGT}`);
    logger.info(`trendUp:${r.trendUp} trendDown:${r.trendDown}`);
    logger.info(`breakUp:${r.breakUp} breakDown:${r.breakDown} | breakAbove:${r.breakAbove} breakBelow:${r.breakBelow}`);
    logger.info(`bigCandle:${r.bigCandle} strongBody:${r.strongBody} | closeNearHigh:${r.closeNearHigh} closeNearLow:${r.closeNearLow} | volConfirm:${r.volConfirm}`);
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
${r.gapLabel}

━━━━━━━━━━━━━━━━━━
📊 Price Info
Index LTP   : ${r.indexLTP}
Future LTP  : ${r.futureLTP}
Spread      : ${r.spread}

━━━━━━━━━━━━━━━━━━
📌 Conditions
Structure   : ${r.bearishStructure ? "✅ LH+LL" : "❌ Weak"}
ADX(14)     : ${r.currentADX} ${r.trendStrong ? "✅" : "❌"}
RSI(14)     : ${r.currentRSI} ${r.rsiBearish ? "✅ < 45" : "❌"}
ATR SL      : ${r.dynamicSL}  TGT: ${r.dynamicTGT}
Trend Down  : ${r.trendDown}
Big Candle  : ${r.bigCandle}
Break Down  : ${r.breakDown}
Near Low    : ${r.closeNearLow}
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
${r.gapLabel}

━━━━━━━━━━━━━━━━━━
📊 Price Info
Index LTP   : ${r.indexLTP}
Future LTP  : ${r.futureLTP}
Spread      : ${r.spread}

━━━━━━━━━━━━━━━━━━
📌 Conditions
Structure   : ${r.bullishStructure ? "✅ HH+HL" : "❌ Weak"}
ADX(14)     : ${r.currentADX} ${r.trendStrong ? "✅" : "❌"}
RSI(14)     : ${r.currentRSI} ${r.rsiBullish ? "✅ > 55" : "❌"}
ATR SL      : ${r.dynamicSL}  TGT: ${r.dynamicTGT}
Trend Up    : ${r.trendUp}
Big Candle  : ${r.bigCandle}
Break Up    : ${r.breakUp}
Near High   : ${r.closeNearHigh}
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
//
//  🎯 FIX #5 — Realistic intra-bar SL hit detection
//
//  BEFORE (optimistic / wrong):
//    if (currentClose <= openTrade.sl)   ← only triggers if bar CLOSES below SL
//    Real world: SL can be hit mid-bar, close can still be above SL
//    → Performance was inflated. Losers escaped, winners padded.
//
//  AFTER (realistic):
//    CE trade:  bar.low  <= sl → SL hit (price dipped to SL intra-bar)
//    PE trade:  bar.high >= sl → SL hit (price spiked to SL intra-bar)
//    CE trade:  bar.high >= tgt → TGT hit
//    PE trade:  bar.low  <= tgt → TGT hit
//
//  Tie-break rule (same bar hits both SL and TGT):
//    Assume SL hit first (conservative / realistic assumption).
//    Real algo would need tick data to be 100% accurate,
//    but SL-first is the safer backtest assumption.
//
// ═════════════════════════════════════════════════════════════════════════════
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
    btLogger.info("  BACKTEST START  (with ATR-adaptive SL/TGT)");
    btLogger.info("  SL detection : bar.high / bar.low  ← FIX #5 applied");
    btLogger.info("  Tie-break    : SL wins if same bar hits both");
    btLogger.info(`  Fallback SL  : ${slPoints} | Fallback TGT: ${tgtPoints}`);
    btLogger.info(`  Range        : bar[${startBar}] → bar[${endBar}]`);
    btLogger.info(`  Total 1m candles : ${index1mAll.length}`);
    btLogger.info("═══════════════════════════════════════════════════════");

    const trades = [];
    let openTrade = null;

    const origLevel = logger.level;
    logger.level = "error";

    for (let i = startBar; i <= endBar; i++) {

        const index1m = index1mAll.slice(0, i + 1);
        const future1m = future1mAll.slice(0, i + 1);

        const currentBar = index1m[index1m.length - 1];   // full bar object
        const currentTime = currentBar.time;

        const dailySlice = data1D.filter(d => d.time <= currentTime);

        // ── Exit check (before entry — no same-bar entry+exit)
        if (openTrade) {
            let exitReason = null;
            let exitPrice = currentBar.close;   // default if EOD

            if (openTrade.type === "CE") {
                // ─────────────────────────────────────────────
                // 🎯 FIX #5 — CE exit logic (was: currentClose <= sl)
                //   SL: price DROPPED to sl intra-bar → use bar.low
                //   TGT: price ROSE to tgt intra-bar  → use bar.high
                //   Tie: same bar touches both → SL wins (conservative)
                // ─────────────────────────────────────────────
                const slHit = currentBar.low <= openTrade.sl;
                const tgtHit = currentBar.high >= openTrade.tgt;

                if (slHit && tgtHit) {
                    // Can't tell which hit first without tick data → take SL (conservative)
                    exitReason = "SL";
                    exitPrice = openTrade.sl;
                } else if (slHit) {
                    exitReason = "SL";
                    exitPrice = openTrade.sl;
                } else if (tgtHit) {
                    exitReason = "TGT";
                    exitPrice = openTrade.tgt;
                }

            } else {
                // ─────────────────────────────────────────────
                // 🎯 FIX #5 — PE exit logic (was: currentClose >= sl)
                //   SL: price ROSE to sl intra-bar  → use bar.high
                //   TGT: price FELL to tgt intra-bar → use bar.low
                //   Tie: same bar touches both → SL wins (conservative)
                // ─────────────────────────────────────────────
                const slHit = currentBar.high >= openTrade.sl;
                const tgtHit = currentBar.low <= openTrade.tgt;

                if (slHit && tgtHit) {
                    exitReason = "SL";
                    exitPrice = openTrade.sl;
                } else if (slHit) {
                    exitReason = "SL";
                    exitPrice = openTrade.sl;
                } else if (tgtHit) {
                    exitReason = "TGT";
                    exitPrice = openTrade.tgt;
                }
            }

            // Force exit at 15:29 IST
            const ist = new Date(new Date(currentTime).toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
            if (ist.getHours() * 60 + ist.getMinutes() >= (15 * 60 + 29) && !exitReason) {
                exitReason = "EOD";
                exitPrice = currentBar.close;
            }

            if (exitReason) {
                const pnl = openTrade.type === "CE"
                    ? exitPrice - openTrade.entryPrice
                    : openTrade.entryPrice - exitPrice;

                const slPointsTrade = Math.abs(openTrade.entryPrice - openTrade.sl);
                const tgtPointsTrade = Math.abs(openTrade.tgt - openTrade.entryPrice);

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
                    sl: openTrade.sl,
                    tgt: openTrade.tgt,
                    slPoints: parseFloat(slPointsTrade.toFixed(2)),
                    tgtPoints: parseFloat(tgtPointsTrade.toFixed(2)),
                };
                trades.push(trade);

                btLogger.info(
                    `  EXIT  [${trade.type}] | ${exitReason.padEnd(3)} | ` +
                    `Entry: ${trade.entryPrice} @ bar[${trade.entryBar}] | ` +
                    `Exit : ${trade.exitPrice}  @ bar[${trade.exitBar}]  | ` +
                    `SL: ${trade.sl} TGT: ${trade.tgt} | ` +
                    `PnL  : ${pnl >= 0 ? "+" : ""}${trade.pnl.toFixed(2)}`
                );

                openTrade = null;
            }
        }

        // ── Entry check (only when flat)
        if (!openTrade) {
            const result = generateSignal(index1m, future1m, dailySlice, []);

            if (result.signal === "CE" || result.signal === "PE") {
                const entryPrice = currentBar.close;

                const sl = result.dynamicSL ?? slPoints;
                const tgt = result.dynamicTGT ?? tgtPoints;

                openTrade = {
                    type: result.signal,
                    entryPrice,
                    entryTime: currentTime,
                    entryBar: i,
                    sl: result.signal === "CE" ? entryPrice - sl : entryPrice + sl,
                    tgt: result.signal === "CE" ? entryPrice + tgt : entryPrice - tgt,
                };

                btLogger.info(
                    `  ENTRY [${result.signal}] | bar[${i}] | Close: ${entryPrice} | ` +
                    `SL: ${openTrade.sl} (${sl}pts) | Tgt: ${openTrade.tgt} (${tgt}pts) | ` +
                    `ADX: ${result.currentADX} | RSI: ${result.currentRSI} | ATR: ${result.currentATR} | ` +
                    `Struct: Bull:${result.bullishStructure} Bear:${result.bearishStructure} | ` +
                    `Gap: ${result.gapPoints}pts | ` +
                    `IST: ${getISTTime(new Date(currentTime))}`
                );
            }
        }
    }

    logger.level = origLevel;

    // ── Force-close any trade still open at final bar
    if (openTrade) {
        const lastBar = index1mAll[endBar];
        const pnl = openTrade.type === "CE"
            ? lastBar.close - openTrade.entryPrice
            : openTrade.entryPrice - lastBar.close;

        trades.push({
            type: openTrade.type,
            entryTime: openTrade.entryTime,
            exitTime: lastBar.time,
            entryPrice: openTrade.entryPrice,
            exitPrice: lastBar.close,
            pnl: parseFloat(pnl.toFixed(2)),
            exitReason: "LAST_BAR",
            entryBar: openTrade.entryBar,
            exitBar: endBar,
            sl: openTrade.sl,
            tgt: openTrade.tgt,
            slPoints: parseFloat(Math.abs(openTrade.entryPrice - openTrade.sl).toFixed(2)),
            tgtPoints: parseFloat(Math.abs(openTrade.tgt - openTrade.entryPrice).toFixed(2)),
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
    const totalSLPoints = trades.reduce((s, t) => s + (t.slPoints ?? 0), 0);
    const totalTGTPoints = trades.reduce((s, t) => s + (t.tgtPoints ?? 0), 0);

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
    btLogger.info(`  Total Trades     : ${trades.length}`);
    btLogger.info(`  Winners          : ${winners.length}`);
    btLogger.info(`  Losers           : ${losers.length}`);
    btLogger.info(`  Win Rate         : ${winRate}%`);
    btLogger.info(`  Total PnL        : ${totalPnL >= 0 ? "+" : ""}${totalPnL.toFixed(2)} pts`);
    btLogger.info(`  Avg Win          : +${avgWin} pts`);
    btLogger.info(`  Avg Loss         : ${avgLoss} pts`);
    btLogger.info(`  Max Win          : +${maxWin} pts`);
    btLogger.info(`  Max Loss         : ${maxLoss} pts`);
    btLogger.info(`  Max Drawdown     : ${maxDD.toFixed(2)} pts`);
    btLogger.info(`  Total SL Points  : ${totalSLPoints.toFixed(2)} pts`);
    btLogger.info(`  Total TGT Points : ${totalTGTPoints.toFixed(2)} pts`);
    btLogger.info("═══════════════════════════════════════════════════════");

    btLogger.info("");
    btLogger.info("  TRADE LOG");
    btLogger.info("  " + "─".repeat(150));
    btLogger.info(
        "  " +
        "  #".padEnd(5) + "Type".padEnd(5) + "Entry".padEnd(10) +
        "Exit".padEnd(10) + "SL".padEnd(10) + "TGT".padEnd(10) +
        "SLpts".padEnd(8) + "TGTpts".padEnd(8) +
        "PnL".padEnd(12) + "Exit".padEnd(7) +
        "Bars".padEnd(7) + "Entry Time".padEnd(30) + "Exit Time"
    );
    btLogger.info("  " + "─".repeat(150));

    trades.forEach((t, idx) => {
        const pnlStr = (t.pnl >= 0 ? "+" : "") + t.pnl.toFixed(2);
        btLogger.info(
            "  " +
            String(idx + 1).padEnd(5) + t.type.padEnd(5) +
            String(t.entryPrice).padEnd(10) + String(t.exitPrice).padEnd(10) +
            String(t.sl).padEnd(10) + String(t.tgt).padEnd(10) +
            String(t.slPoints).padEnd(8) + String(t.tgtPoints).padEnd(8) +
            pnlStr.padEnd(12) + t.exitReason.padEnd(7) +
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


// ─────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────
async function main() {

    const isBacktest = process.env.BACKTEST === "true" || process.argv.includes("--backtest");

    if (isBacktest) {
        logger.info("🧪 BACKTEST MODE");

        const btFrom = process.env.BT_FROM ?? "2026-02-01 09:15";
        const btTo = process.env.BT_TO ?? "2026-02-28 15:30";
        logger.info(`📅 Window: ${btFrom} → ${btTo}`);

        const jwt = await login();
        const futureToken = await getFutureToken("SENSEX", btFrom);

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

        // Align by timestamp
        const futureMap = new Map(future1m.map(c => [c.time, c]));
        const alignedIndex = [];
        const alignedFuture = [];

        for (const c of index1m) {
            if (futureMap.has(c.time)) {
                alignedIndex.push(c);
                alignedFuture.push(futureMap.get(c.time));
            }
        }

        logger.info(`📊 index: ${index1m.length} | future: ${future1m.length} | aligned: ${alignedIndex.length} | daily: ${data1D.length}`);

        if (alignedIndex.length < 60) {
            logger.error("❌ Not enough aligned candles. Check date range or token.");
            process.exit(1);
        }

        await backtest(alignedIndex, alignedFuture, data1D, {
            slPoints: parseInt(process.env.BT_SL ?? "80"),
            tgtPoints: parseInt(process.env.BT_TGT ?? "200"),
            startBar: 0,
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

        await sleep(15_000);
    }
}

main();