import dotenv from "dotenv";
dotenv.config();

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

    // Floor down to nearest timeframe boundary, then subtract one full timeframe
    // e.g. at 10:43 with 1m → floor=10:43 → subtract 1 → 10:42 (last completed)
    // e.g. at 10:43 with 5m → floor=10:40 → subtract 5 → 10:35 (last completed)
    const flooredMin = Math.floor(minutes / timeframe) * timeframe;
    now.setMinutes(flooredMin - timeframe);
    now.setSeconds(0, 0);
    now.setMilliseconds(0);

    return now;
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
            i.exch_seg === (process.env.EXCHANGE_SEGMENT || "BFO") &&
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
        ceSymbol: ce.symbol,
        peToken: pe.token,
        peSymbol: pe.symbol
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
        const errorMsg = err.response?.data?.message || err.message;
        const errorCode = err.response?.data?.errorCode;

        if (errorCode === "AG8001" || errorMsg === "Invalid Token") {
            throw new Error("INVALID_TOKEN");
        }

        logger.error(`❌ LTP Fetch Error: ${errorMsg}`);
        return [];
    }
}

