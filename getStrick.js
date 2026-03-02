import axios from "axios";
import { logger } from "./logger.js";
import { loadScripMaster } from "./scriptMaster.js";
import { buildHeaders } from "./helpers.js";

const MONTH_MAP = {
    JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
    JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11
};

const MARKET_URL = "https://apiconnect.angelone.in/rest/secure/angelbroking/market/v1/quote/";

function parseExpiry(str) {
    return new Date(parseInt(str.slice(5)), MONTH_MAP[str.slice(2, 5)], parseInt(str.slice(0, 2)));
}

function getATMStrike(price, step = 100) {
    return Math.round(price / step) * step;
}

// ─────────────────────────────────────────
// LAST COMPLETED CANDLE TIME
// Works for any timeframe: 1m, 2m, 5m, 15m, 30m
// ─────────────────────────────────────────
export function getLastCompletedCandleTime(timeframe = 1) {
    const now = new Date();
    const minutes = now.getMinutes();

    // Floor to nearest timeframe boundary
    const flooredMin = Math.floor(minutes / timeframe) * timeframe;
    now.setMinutes(flooredMin);
    now.setSeconds(0, 0);

    // If we are exactly ON the boundary, we just crossed — go back one full timeframe
    // e.g. at 09:45:00 exactly, the 09:40–09:45 candle JUST closed → use 09:40
    if (minutes % timeframe === 0) {
        now.setMinutes(now.getMinutes() - timeframe);
    } else {
        // e.g. at 09:43:27 → floor = 09:40 → last completed = one before = 09:35
        now.setMinutes(now.getMinutes() - timeframe);
    }

    return now;
}

// Format Date → "YYYY-MM-DD HH:MM"
export function formatCandleTime(date) {
    const p = n => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ` +
        `${p(date.getHours())}:${p(date.getMinutes())}`;
}

// ─────────────────────────────────────────
// ATM OPTION TOKENS
// ─────────────────────────────────────────
export async function getATMOptionTokens(symbolName = "SENSEX", price, refDate = new Date()) {
    const res = await loadScripMaster();

    const today = new Date(refDate);
    today.setHours(0, 0, 0, 0);

    const options = res
        .filter(i =>
            i.exch_seg === "BFO" &&
            i.instrumenttype === "OPTIDX" &&
            i.name === symbolName
        )
        .map(i => ({ ...i, expiryDate: parseExpiry(i.expiry) }))
        .filter(i => i.expiryDate >= today);

    if (!options.length) {
        logger.error("❌ No options found");
        process.exit(1);
    }

    // Get nearest weekly expiry
    const expiryDates = [...new Set(options.map(o => o.expiryDate.getTime()))].sort((a, b) => a - b);
    const weeklyExpiry = new Date(expiryDates[0]);

    const weeklyOptions = options.filter(o => o.expiryDate.getTime() === weeklyExpiry.getTime());

    const atmStrike = getATMStrike(price, 100);

    const ce = weeklyOptions.find(o => parseFloat(o.strike) / 100 === atmStrike && o.symbol.endsWith("CE"));
    const pe = weeklyOptions.find(o => parseFloat(o.strike) / 100 === atmStrike && o.symbol.endsWith("PE"));

    if (!ce || !pe) {
        logger.error("❌ ATM CE/PE not found");
        process.exit(1);
    }

    logger.info(`📅 Weekly Expiry: ${weeklyExpiry.toDateString()}`);
    logger.info(`🎯 ATM Strike: ${atmStrike}`);
    logger.info(`🟢 CE: ${ce.symbol} | Token: ${ce.token}`);
    logger.info(`🔴 PE: ${pe.symbol} | Token: ${pe.token}`);

    return {
        strike: atmStrike,
        expiry: weeklyExpiry,
        ceToken: ce.token,
        peToken: pe.token
    };
}

// ─────────────────────────────────────────
// LTP ONLY (lightweight — for option LTP)
// ─────────────────────────────────────────
export async function getLTP(jwtToken, exchangeTokens) {
    try {
        const response = await axios.post(
            MARKET_URL,
            { mode: "LTP", exchangeTokens },
            { headers: buildHeaders(jwtToken) }
        );

        if (!response.data?.status) {
            throw new Error(response.data?.message || "LTP fetch failed");
        }

        return response.data.data.fetched;

    } catch (err) {
        logger.error(`❌ LTP Fetch Error: ${err.response?.data?.message || err.message}`);
        return [];
    }
}

// ─────────────────────────────────────────
// FULL LIVE DATA (LTP + OHLC + OI + Volume)
// ─────────────────────────────────────────
export async function getLiveData(jwtToken, exchange, token) {
    try {
        const response = await axios.post(
            MARKET_URL,
            { mode: "FULL", exchangeTokens: { [exchange]: [token] } },
            { headers: buildHeaders(jwtToken) }
        );

        if (!response.data?.status) {
            throw new Error(response.data?.message || "Live data fetch failed");
        }

        const fetched = response.data.data?.fetched ?? [];
        return fetched[0] ?? null;

    } catch (err) {
        logger.error(`❌ Live Data Error: ${err.response?.data?.message || err.message}`);
        return null;
    }
}

// ─────────────────────────────────────────
// GET CLOSED CANDLE FROM LIVE DATA
// Only returns data for last COMPLETED candle
// Never uses currently-forming (incomplete) candle
// ─────────────────────────────────────────
export async function getClosedCandle(jwtToken, exchange, token, timeframe = 1) {
    const data = await getLiveData(jwtToken, exchange, token);
    if (!data) return null;

    // The last completed candle's close time
    const closedTime = getLastCompletedCandleTime(timeframe);
    const closedTimeStr = formatCandleTime(closedTime);

    logger.info(`✅ Closed Candle Time [${timeframe}m]: ${closedTimeStr}`);
    logger.info(`   LTP: ${data.ltp} | O:${data.open} H:${data.high} L:${data.low} Vol:${data.tradeVolume} OI:${data.opnInterest}`);

    return {
        time: closedTimeStr,
        open: data.open,
        high: data.high,
        low: data.low,
        close: data.ltp,          // LTP is the close at candle boundary
        volume: data.tradeVolume,
        oi: data.opnInterest ?? 0
    };
}