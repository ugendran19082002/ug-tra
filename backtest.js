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
function getTodayFromDate(daysBack = 20) {
    const p = n => String(n).padStart(2, "0");
    const d = new Date();

    d.setDate(d.getDate() - daysBack);

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
        logger.info(`📈 ${interval} candles: ${res.data.data?.length || 0}`);
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
// FORMAT
// AngelOne candle: [time, open, high, low, close, volume]
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
// EMA
// ─────────────────────────────────────────
function calculateEMA(data, period = 20) {
    const k = 2 / (period + 1);
    let ema = data[0].close;
    return data.map(c => (ema = c.close * k + ema * (1 - k)));
}

// ─────────────────────────────────────────
// RSI(14)
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
// ATR(14) — Wilder's smoothing
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
// ADX(14) — Wilder's smoothing
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
// VOLUME SPIKE
// ─────────────────────────────────────────
function volumeSpike(data, index) {
    if (index < 10) return false;
    const avg = data.slice(index - 10, index).reduce((s, c) => s + c.volume, 0) / 10;
    return data[index].volume > avg * 1.5;
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
//  generateSignal()
// ═════════════════════════════════════════════════════════════════════════════
function generateSignal(index1m, index5m, index15m, future1m, data1D) {

    if (!index5m?.length || !index15m?.length)
        return { signal: "NO_TRADE", reason: "insufficient timeframe data" };

    const dailyData = (data1D?.length >= 2) ? data1D : [];
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

    const prevDay = dailyData[dailyData.length - 2];
    const prevHigh = prevDay?.high ?? 0;
    const prevLow = prevDay?.low ?? 0;

    const GAP_THRESHOLD = 300;
    const todayOpen = dailyLast.open;
    const prevClose = prevDay?.close ?? todayOpen;
    const gapPoints = todayOpen - prevClose;
    const gapUp = gapPoints > GAP_THRESHOLD;
    const gapDown = gapPoints < -GAP_THRESHOLD;
    const gapLabel =
        gapUp ? `🔼 Gap Up   (+${gapPoints.toFixed(0)} pts)` :
            gapDown ? `🔽 Gap Down (${gapPoints.toFixed(0)} pts)` :
                `◾ Normal day (${gapPoints.toFixed(0)} pts)`;

    const last3 = index15m.slice(-3);
    const hasStructure = last3.length >= 3;
    const higherHigh = hasStructure && last3[2].high > last3[1].high;
    const higherLow = hasStructure && last3[2].low > last3[1].low;
    const lowerHigh = hasStructure && last3[2].high < last3[1].high;
    const lowerLow = hasStructure && last3[2].low < last3[1].low;
    const bullishStructure = higherHigh && higherLow;
    const bearishStructure = lowerHigh && lowerLow;

    const { supports, resistances } = findSupportResistance(index15m);

    const currentPrice = index5m[index5m.length - 1].close;
    const roundLevels = getRoundLevels(currentPrice);

    const finalSupports = cleanLevels([...supports, prevLow, ...roundLevels.filter(r => r < currentPrice)]);
    const finalResistances = cleanLevels([...resistances, prevHigh, ...roundLevels.filter(r => r > currentPrice)]);

    const ema5m = calculateEMA(index5m);
    const last5m = index5m[index5m.length - 1];
    const trendUp = last5m.close > ema5m[ema5m.length - 1];
    const trendDown = last5m.close < ema5m[ema5m.length - 1];

    const ATR_SL_MULT = 1.0;
    const ATR_TGT_MULT = 2.5;
    const ATR_FALLBACK = 80;

    const atr5mArr = calculateATR(index5m, 14);
    const rawATR = atr5mArr[atr5mArr.length - 1];
    const currentATR = rawATR && rawATR > 0 ? rawATR : ATR_FALLBACK;

    // ✅ FIX: round dynamicSL and dynamicTGT to 2 decimal places
    const dynamicSL = parseFloat(Math.min(100, currentATR * ATR_SL_MULT).toFixed(2));
    const dynamicTGT = parseFloat(Math.max(100, currentATR * ATR_TGT_MULT).toFixed(2));

    const adx5mArr = calculateADX(index5m, 14);
    const currentADX = adx5mArr[adx5mArr.length - 1];
    const trendStrong = currentADX >= 20;

    const rsi5mArr = calculateRSI(index5m, 14);
    const currentRSI = rsi5mArr[rsi5mArr.length - 1];
    const rsiBullish = currentRSI > 55;
    const rsiBearish = currentRSI < 45;

    const last1m = index1m[index1m.length - 1];
    const prev1m = index1m[index1m.length - 2];
    const last5 = index1m.slice(-6, -1);
    const max5High = Math.max(...last5.map(c => c.high));
    const min5Low = Math.min(...last5.map(c => c.low));

    const breakUp = last1m.close > max5High;
    const breakDown = last1m.close < min5Low;

    const SR_THRESHOLD = 50;
    const nearSupport = finalSupports.filter(s => s < last1m.close).pop();
    const nearResistance = finalResistances.find(r => r > last1m.close);

    const breakBelow = nearSupport && last1m.close < nearSupport && Math.abs(last1m.close - nearSupport) <= SR_THRESHOLD;
    const breakAbove = nearResistance && last1m.close > nearResistance && Math.abs(last1m.close - nearResistance) <= SR_THRESHOLD;

    const volConfirm = volumeSpike(future1m, future1m.length - 1);

    const body = Math.abs(last1m.close - last1m.open);
    const range = last1m.high - last1m.low;
    const strongBody = range > 0 && (body / range) > 0.6;
    const bigCandle = (range > (prev1m.high - prev1m.low) * 1.5) && strongBody;

    const closeNearHigh = range > 0 && (last1m.high - last1m.close) / range < 0.2;
    const closeNearLow = range > 0 && (last1m.close - last1m.low) / range < 0.2;

    const lastFuture = future1m[future1m.length - 1];
    const spread = lastFuture.close - last1m.close;

    const diag = {
        dailyBias, emaAbove, bullCandle, bearCandle,
        trendUp, trendDown,
        breakUp, breakDown, breakAbove, breakBelow,
        bigCandle, strongBody, volConfirm,
        bullishStructure, bearishStructure,
        higherHigh, higherLow, lowerHigh, lowerLow,
        trendStrong, currentADX: currentADX.toFixed(1),
        currentRSI: currentRSI.toFixed(1), rsiBullish, rsiBearish,
        currentATR: currentATR.toFixed(2), dynamicSL, dynamicTGT,
        closeNearHigh, closeNearLow,
        gapUp, gapDown, gapPoints: gapPoints.toFixed(0), gapLabel,
        spread: spread.toFixed(2),
        indexLTP: last1m.close.toFixed(2),
        futureLTP: lastFuture.close.toFixed(2),
        finalSupports, finalResistances,
    };

    const prevFuture = future1m[future1m.length - 2];

    const oiIncreasing = lastFuture.oi > prevFuture.oi;
    const oiDecreasing = lastFuture.oi < prevFuture.oi;

    const priceUp = lastFuture.close > prevFuture.close;
    const priceDown = lastFuture.close < prevFuture.close;

    const longBuildup = priceUp && oiIncreasing;
    const shortBuildup = priceDown && oiIncreasing;
    const shortCovering = priceUp && oiDecreasing;
    const longUnwinding = priceDown && oiDecreasing;

    const strongTrend = currentADX >= 25;
    const mediumTrend = currentADX >= 20 && currentADX < 25;

    if (
        dailyBias === "BEARISH" &&
        trendStrong &&
        rsiBearish &&
        // (strongTrend || (mediumTrend && shortBuildup)) &&
        (trendDown || bigCandle) &&
        (breakDown || breakBelow) &&
        volConfirm &&
        !gapUp
    )
        return { signal: "PE", ...diag };

    if (
        dailyBias === "BULLISH" &&
        trendStrong &&
        rsiBullish &&
        // (strongTrend || (mediumTrend && longBuildup)) &&
        (trendUp || bigCandle) &&
        (breakUp || breakAbove) &&
        volConfirm &&
        !gapDown
    )
        return { signal: "CE", ...diag };

    return { signal: "NO_TRADE", ...diag };
}


// ─────────────────────────────────────────
// ENTRY ENGINE (live)
// ─────────────────────────────────────────
async function entryEngine(jwt, fromdate, todate, futureToken) {

    const indexRaw1m = await getHistorical(jwt, "BSE", process.env.SYMBOLTOKEN, "ONE_MINUTE", fromdate, todate);
    await sleep(300);
    const indexRaw5m = await getHistorical(jwt, "BSE", process.env.SYMBOLTOKEN, "FIVE_MINUTE", fromdate, todate);
    await sleep(300);
    const indexRaw15m = await getHistorical(jwt, "BSE", process.env.SYMBOLTOKEN, "FIFTEEN_MINUTE", fromdate, todate);
    await sleep(300);
    const raw1D = await getHistorical(jwt, "BSE", process.env.SYMBOLTOKEN, "ONE_DAY", getDailyFromDate(), todate);
    await sleep(300);
    const futureRaw1m = await getFuture(futureToken, fromdate, todate);
    // const futureRaw1m = await getHistorical(jwt, "BFO", futureToken, "ONE_MINUTE", fromdate, todate);
    await sleep(300);

    if (!indexRaw1m.length || !futureRaw1m.length) {
        logger.warn("⚠ Missing data — skipping");
        return "⚪ NO TRADE";
    }

    const index1m = format(indexRaw1m);
    const index5m = format(indexRaw5m);
    const index15m = format(indexRaw15m);
    const future1m = format(futureRaw1m);
    const data1D = format(raw1D);

    logger.info(`Timeframes → 1m:${index1m.length} 5m:${index5m.length} 15m:${index15m.length} 1D:${data1D.length}`);

    const r = generateSignal(index1m, index5m, index15m, future1m, data1D);

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
Break Below : ${r.breakBelow}
Near Low    : ${r.closeNearLow}
Volume OK   : ${r.volConfirm}
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
Break Above : ${r.breakAbove}
Near High   : ${r.closeNearHigh}
Volume OK   : ${r.volConfirm}
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

async function getFuture(token, fromdate, todate, retries = 3) {
    const INSTRUMENT_KEY = `BSE_FO|${token}`;

    const toDate = (todate ?? "").slice(0, 10) || new Date().toISOString().slice(0, 10);
    const fromDate = (fromdate ?? "").slice(0, 10) || toDate;

    const url = `https://api.upstox.com/v3/historical-candle/${encodeURIComponent(INSTRUMENT_KEY)}/minutes/1/${toDate}/${fromDate}`;

    try {
        const res = await axios.get(url, {
            headers: {
                "Accept": "application/json",
                "Authorization": `Bearer ${process.env.UPSTOX_ACCESS_TOKEN}`
            }
        });

        const candles = res.data?.data?.candles || [];

        if (!candles.length) {
            logger.warn("⚠ No future candles returned");
            return [];
        }

        logger.debug(`OI Sample:\n${JSON.stringify(candles.slice(0, 2), null, 2)}`);
        return candles;

    } catch (err) {
        if (err.response?.status === 403 && retries > 0) {
            logger.warn(`⚠ Future Rate-limit — retrying in 2s… (${retries} left)`);
            await sleep(2000);
            return getFuture(token, fromdate, todate, retries - 1);
        }
        logger.error(`❌ Future fetch failed: ${err.message}`);
        return [];
    }
}


// ═════════════════════════════════════════════════════════════════════════════
//  BACKTEST
// ═════════════════════════════════════════════════════════════════════════════
async function backtest(jwt, futureToken, btFrom, btTo, options = {}) {
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

    const index1mAll = format(indexRaw1m);
    const index5mAll = format(indexRaw5m);
    const index15mAll = format(indexRaw15m);
    const future1mAll = format(futureRaw1m);
    const data1DAll = format(raw1D);

    const futureMap = new Map(future1mAll.map(c => [c.time, c]));
    const alignedIndex = [];
    const alignedFuture = [];
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

    const origLevel = logger.level;
    logger.level = "error";

    for (let i = startBar; i <= endBar; i++) {

        const index1m = alignedIndex.slice(0, i + 1);
        const future1m = alignedFuture.slice(0, i + 1);
        const currentTime = index1m[index1m.length - 1].time;

        const index5m = index5mAll.filter(c => c.time <= currentTime);
        const index15m = index15mAll.filter(c => c.time <= currentTime);
        const dailySlice = data1DAll.filter(d => d.time <= currentTime);

        const currentClose = index1m[index1m.length - 1].close;

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

                // ✅ FIX: round sl/tgt price levels to 2 decimal places
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

    // ✅ FIX: all numeric columns use .toFixed(2) so columns never overflow
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


// ─────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────
async function main() {

    const isBacktest = process.env.BACKTEST === "true" || process.argv.includes("--backtest");

    if (isBacktest) {
        logger.info("🧪 BACKTEST MODE");

        const btFrom = process.env.BT_FROM ?? "2026-02-15 09:15";
        const btTo = process.env.BT_TO ?? "2026-02-27 15:30";
        logger.info(`📅 Window: ${btFrom} → ${btTo}`);

        const jwt = await login();
        const futureToken = await getFutureToken("SENSEX", btFrom);

        await backtest(jwt, futureToken, btFrom, btTo, {
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
            const liveTo = "2026-02-27 15:05";
            // const liveTo = formatDateTime();
            logger.info(`📅 Window: ${liveFrom} → ${liveTo}`);

            const signal = await entryEngine(jwt, liveFrom, liveTo, futureToken);

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