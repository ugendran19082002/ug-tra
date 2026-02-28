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
// LOGIN  (V2 error-handling + V1/V3 TOTP inside fn)
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
// HISTORICAL  (V3 retry + parameterised like V1)
// ─────────────────────────────────────────
async function getHistorical(jwt, exchange, token, interval, retries = 3) {
    const body = {
        exchange,
        symboltoken: token,
        interval,
        fromdate: "2026-02-15 09:15",
        todate: "2026-02-27 15:00",
        // todate: formatDateTime()
    };

    try {
        logger.debug(`📊 Fetching ${interval} | ${exchange} | ${token}`);
        const res = await axios.post(
            `${BASE_URL}/rest/secure/angelbroking/historical/v1/getCandleData`,
            body,
            { headers: buildHeaders(jwt) }
        );
        logger.info(`📈 ${interval} candles: ${res.data.data.length}`);
        return res.data.data;

    } catch (err) {
        if (err.response?.status === 403 && retries > 0) {
            logger.warn(`⚠ Rate-limit hit — retrying in 2s… (${retries} left)`);
            await sleep(2000);
            return getHistorical(jwt, exchange, token, interval, retries - 1);
        }
        logger.error(`❌ Historical failed: ${err.message}`);
        return [];
    }
}

// ─────────────────────────────────────────
// FORMAT
// ─────────────────────────────────────────
const format = raw => raw.map(c => ({
    time: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5], oi: c[6] ?? 0       // ✅ OI only present in BFO futures data

}));

// ─────────────────────────────────────────
// BUILD HIGHER TIMEFRAME FROM 1-MIN DATA  (V3)
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
// SWING S/R  (shared by V1 & V2)
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
// ROUND PSYCHOLOGICAL LEVELS  (V2)
// ─────────────────────────────────────────
function getRoundLevels(price, step = 500) {
    const base = Math.floor(price / step) * step;
    return [base - step, base, base + step, base + step * 2];
}

// ─────────────────────────────────────────
// CLEAN & SORT LEVELS
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
    return data[index].volume > avg * 0.1;
}

// ─────────────────────────────────────────
// FUTURE TOKEN  (V3 caching + V2 expiry parser)
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

    const monthMap = {
        JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
        JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11
    };

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

    // Persist to .env
    let env = fs.readFileSync(".env", "utf8");
    env = env.replace(/FUTURE_TOKEN=.*/, `FUTURE_TOKEN=${current.token}`);
    env = env.replace(/FUTURE_TOKEN_DATE=.*/, `FUTURE_TOKEN_DATE=${today}`);
    fs.writeFileSync(".env", env);

    return current.token;
}

// ─────────────────────────────────────────
// OI CONFIRMATION
// Price ↑ OI ↑ → Long Build-up   → BULLISH ✅
// Price ↓ OI ↑ → Short Build-up  → BEARISH ✅
// Price ↑ OI ↓ → Short Covering  → WEAK
// Price ↓ OI ↓ → Long Unwinding  → WEAK
// ─────────────────────────────────────────
function analyzeOI(future1m) {
    const len = future1m.length;

    if (len < 5) return { signal: "NEUTRAL", label: "⚪ Insufficient OI data" };

    // Compare last candle vs 5 candles ago for smoother OI trend
    const curr = future1m[len - 1];
    const prev = future1m[len - 5];

    const priceUp = curr.close > prev.close;
    const priceDown = curr.close < prev.close;
    const oiUp = curr.oi > prev.oi;
    const oiDown = curr.oi < prev.oi;

    const priceDiff = (curr.close - prev.close).toFixed(2);
    const oiDiff = curr.oi - prev.oi;

    logger.info(`OI Analysis → Price: ${prev.close} → ${curr.close} (${priceDiff}) | OI: ${prev.oi} → ${curr.oi} (${oiDiff > 0 ? "+" : ""}${oiDiff})`);

    if (priceUp && oiUp) {
        logger.info(`📈 OI: Long Build-up — STRONG BULLISH`);
        return { signal: "BULLISH", label: "📈 Long Build-up (Strong Bullish)", priceDiff, oiDiff };
    }

    if (priceDown && oiUp) {
        logger.info(`📉 OI: Short Build-up — STRONG BEARISH`);
        return { signal: "BEARISH", label: "📉 Short Build-up (Strong Bearish)", priceDiff, oiDiff };
    }

    if (priceUp && oiDown) {
        logger.info(`🔄 OI: Short Covering — WEAK BULLISH`);
        return { signal: "WEAK_BULLISH", label: "🔄 Short Covering (Weak Bullish)", priceDiff, oiDiff };
    }

    if (priceDown && oiDown) {
        logger.info(`🔄 OI: Long Unwinding — WEAK BEARISH`);
        return { signal: "WEAK_BEARISH", label: "🔄 Long Unwinding (Weak Bearish)", priceDiff, oiDiff };
    }

    return { signal: "NEUTRAL", label: "⚪ Neutral", priceDiff, oiDiff };
}

// ─────────────────────────────────────────
// ENTRY ENGINE  (best of all three)
// ─────────────────────────────────────────
async function entryEngine(index1m, future1m, data1D) {
    // ── Build higher timeframes
    const index5m = buildTimeframe(index1m, 5);
    const index15m = buildTimeframe(index1m, 15);
    const index1H = buildTimeframe(index1m, 60);

    logger.info(`Timeframes → 5m:${index5m.length} 15m:${index15m.length} 1H:${index1H.length}`);

    // ── Daily bias (prefer real 1D data; fall back to built)
    const dailyData = data1D?.length ? data1D : buildTimeframe(index1m, 375);
    const dailyEMA = calculateEMA(dailyData);
    const dailyLast = dailyData[dailyData.length - 1];
    const dailyBias = dailyLast.close > dailyEMA[dailyEMA.length - 1] ? "BULLISH" : "BEARISH";
    logger.info(`Daily Bias: ${dailyBias}`);

    // ── Previous day S/R
    const prevDay = data1D?.length >= 2 ? data1D[data1D.length - 2] : dailyData[dailyData.length - 2];
    logger.info(`Prev Day High: ${prevDay.high} | Low: ${prevDay.low}`);

    // ── Swing S/R from 5m
    const { supports, resistances } = findSupportResistance(index15m);

    // ── Round levels
    const currentPrice = index5m[index5m.length - 1].close;
    const roundLevels = getRoundLevels(currentPrice);

    // ── Combine & clean
    const finalSupports = cleanLevels([...supports, prevDay.low, ...roundLevels.filter(r => r < currentPrice)]);
    const finalResistances = cleanLevels([...resistances, prevDay.high, ...roundLevels.filter(r => r > currentPrice)]);

    logger.info(`Supports:    ${JSON.stringify(finalSupports)}`);
    logger.info(`Resistances: ${JSON.stringify(finalResistances)}`);

    // ── 5m trend
    const ema5m = calculateEMA(index5m);
    const last5m = index5m[index5m.length - 1];
    const trendUp = last5m.close > ema5m[ema5m.length - 1];
    const trendDown = last5m.close < ema5m[ema5m.length - 1];

    // ── 1m breakout
    const last1m = index1m[index1m.length - 1];
    const prev1m = index1m[index1m.length - 2];
    const breakUp = last1m.close > prev1m.high;
    const breakDown = last1m.close < prev1m.low;    // ── S/R proximity check
    const nearSupport = finalSupports.filter(s => s < last1m.close).pop();
    const nearResistance = finalResistances.find(r => r > last1m.close);
    const breakBelow = nearSupport && last1m.close < nearSupport;
    const breakAbove = nearResistance && last1m.close > nearResistance;

    // ── Volume
    const volConfirm = volumeSpike(future1m, future1m.length - 1);
    // Big momentum candle
    const bigCandle =
        (last1m.high - last1m.low) >
        ((prev1m.high - prev1m.low) * 1.5);

    const oi = analyzeOI(future1m);
    console.log(future1m[future1m.length - 1]);
    logger.info(`OI Signal: ${oi.label}`);

    // ── OI must AGREE with direction (only STRONG signals count)
    const oiConfirmsBull = oi.signal === "BULLISH";
    const oiConfirmsBear = oi.signal === "BEARISH";

    logger.info(`bigCandle:${bigCandle}`);
    logger.info(`trendUp:${trendUp} trendDown:${trendDown} breakUp:${breakUp} breakDown:${breakDown}`);
    logger.info(`breakAbove:${breakAbove} breakBelow:${breakBelow} volConfirm:${volConfirm}`);
    logger.info(`oiConfirmsBull:${oiConfirmsBull} oiConfirmsBear:${oiConfirmsBear}`);


    const lastIndex = index1m[index1m.length - 1];
    const lastFuture = future1m[future1m.length - 1];

    const indexTimeIST = getISTTime(new Date(lastIndex.time));
    const futureTimeIST = getISTTime(new Date(lastFuture.time));

    logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    logger.info(`📍 INDEX  LTP → ${lastIndex.close}  | IST: ${indexTimeIST}`);
    logger.info(`📍 FUTURE LTP → ${lastFuture.close} | IST: ${futureTimeIST}`);
    logger.info(`📊 Spread      → ${(lastFuture.close - lastIndex.close).toFixed(2)}`);
    logger.info(`🕐 System IST  → ${getISTTime()}`);
    logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    const body = Math.abs(last1m.close - last1m.open);
    const range = last1m.high - last1m.low;
    const strongBody = body > range * 0.6;

    // ── Decision Logic (Momentum override added)
    if (
        dailyBias === "BEARISH" &&
        (trendDown || (bigCandle && strongBody)) &&
        (breakDown || breakBelow) &&
        volConfirm
        // && oiConfirmsBear              // ✅ OI must show Short Build-up

    ) {

        const spread = (lastFuture.close - lastIndex.close).toFixed(2);

        const message = `
🟥 *PE ENTRY SIGNAL*

📉 Bias: ${dailyBias}
🕒 Time: ${getISTTime()}

━━━━━━━━━━━━━━━━━━a
📊 Price Info
Index LTP   : ${lastIndex.close}
Future LTP  : ${lastFuture.close}
Spread      : ${spread}

━━━━━━━━━━━━━━━━━━
📌 Conditions
Trend Down  : ${trendDown}
Big Candle  : ${bigCandle}
Break Down  : ${breakDown}
Break Below : ${breakBelow}
Volume OK   : ${volConfirm}
━━━━━━━━━━━━━━━━━━
`;

        tradeLogger.info(message);
        await sendTelegram(message);

        return "🟥 PE ENTRY";
    }
    if (
        dailyBias === "BULLISH" &&
        (trendUp || (bigCandle && strongBody)) &&
        (breakUp || breakAbove) &&
        volConfirm
        // && oiConfirmsBull              // ✅ OI must show Long Build-up

    ) {

        const spread = (lastFuture.close - lastIndex.close).toFixed(2);

        const message = `
🟢 *CE ENTRY SIGNAL*

📈 Bias: ${dailyBias}
🕒 Time: ${getISTTime()}

━━━━━━━━━━━━━━━━━━
📊 Price Info
Index LTP   : ${lastIndex.close}
Future LTP  : ${lastFuture.close}
Spread      : ${spread}

━━━━━━━━━━━━━━━━━━
📌 Conditions
Trend Up    : ${trendUp}
Big Candle  : ${bigCandle}
Break Up    : ${breakUp}
Break Above : ${breakAbove}
Volume OK   : ${volConfirm}
━━━━━━━━━━━━━━━━━━
`;

        tradeLogger.info(message);
        await sendTelegram(message);

        return "🟢 CE ENTRY";
    }
    const spread = (lastFuture.close - lastIndex.close).toFixed(2);

    const message = `
⚪ * NO TRADE*

📈 Bias: ${dailyBias}
🕒 Time: ${getISTTime()}

━━━━━━━━━━━━━━━━━━
📊 Price Info
Index LTP   : ${lastIndex.close}
Future LTP  : ${lastFuture.close}
Spread      : ${spread}

━━━━━━━━━━━━━━━━━━
📌 Conditions
Trend Up    : ${trendUp}
Big Candle  : ${bigCandle}
Break Up    : ${breakUp}
Break Above : ${breakAbove}
Volume OK   : ${volConfirm}
━━━━━━━━━━━━━━━━━━
`;
    logger.info(message);

    return "⚪ NO TRADE";
}

// ─────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────
async function main() {
    logger.info("🚀 BOT STARTED");

    const jwt = await login();
    logger.info("🚀 jwt", jwt);

    const futureToken = await getFutureToken();

    let lastSignal = null;
    let iteration = 0;

    while (true) {
        iteration++;

        try {
            // const now = new Date();
            // const h = now.getHours();
            // const m = now.getMinutes();
            // const totalMin = h * 60 + m;

            // const marketStart = 9  * 60 + 15;   // 09:15
            // const marketEnd   = 15 * 60 + 30;   // 15:30

            // // ── Skip outside market hours
            // if (totalMin < marketStart || totalMin > marketEnd) {
            //     logger.info(`⏸ Market closed | IST: ${ getISTTime() } | Waiting...`);
            //     await sleep(60_000);   // check every 1 min outside hours
            //     continue;
            // }

            logger.info(`🔄 Loop #${iteration} | IST: ${getISTTime()} `);

            // ── Fetch data
            const indexRaw = await getHistorical(jwt, "BSE", process.env.SYMBOLTOKEN, "ONE_MINUTE");
            await sleep(300);

            const raw1D = await getHistorical(jwt, "BSE", process.env.SYMBOLTOKEN, "ONE_DAY");
            await sleep(300);

            const futureRaw = await getHistorical(jwt, "BFO", futureToken, "ONE_MINUTE");

            // ── Validate
            if (!indexRaw.length || !futureRaw.length) {
                logger.warn(`⚠ Missing data — skipping loop #${iteration} `);
                await sleep(1000);
                continue;
            }

            // ── Run engine
            const signal = await entryEngine(
                format(indexRaw),
                format(futureRaw),
                format(raw1D)
            );

            logger.info(`🎯 SIGNAL: ${signal} `);

            // ── Only log to trade.log on NEW signal change
            if (signal !== "⚪ NO TRADE" && signal !== lastSignal) {
                logger.info(`🚨 NEW SIGNAL DETECTED: ${signal} `);
                lastSignal = signal;
            }

            // ── Reset lastSignal when market changes direction
            if (signal === "⚪ NO TRADE") lastSignal = null;

        } catch (err) {
            logger.error(`❌ Loop #${iteration} Error: ${err.message} `);
        }

        // ── Wait 1 second before next iteration
        await sleep(1000);
    }
}
async function sendTelegram(message) {
    try {
        const url = `https://api.telegram.org/bot${process.env.TG_TOKEN}/sendMessage`;

        const res = await axios.post(url, {
            chat_id: process.env.TG_CHAT_ID,
            text: message
        });

        console.log("Telegram sent:", res.data);

    } catch (err) {
        console.log("Telegram error:",
            err.response?.data || err.message
        );
    }
}
main();  