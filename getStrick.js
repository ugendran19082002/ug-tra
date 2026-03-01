const BASE_URL = "https://apiconnect.angelone.in";
// const winston = require("winston");
import winston from "winston";
import { loadScripMaster } from "./scriptMaster.js";
import axios from "axios";

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



export async function getATMOptionTokens(symbolName = "SENSEX", price, refDate = new Date()) {

    const res = await loadScripMaster();

    const monthMap = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
    const parseExpiry = str => new Date(parseInt(str.slice(5)), monthMap[str.slice(2, 5)], parseInt(str.slice(0, 2)));

    const today = new Date(refDate);
    today.setHours(0, 0, 0, 0);

    // Filter SENSEX options
    const options = res
        .filter(i =>
            i.exch_seg === "BFO" &&
            i.instrumenttype === "OPTIDX" &&
            i.name === symbolName
        )
        .map(i => ({
            ...i,
            expiryDate: parseExpiry(i.expiry)
        }))
        .filter(i => i.expiryDate >= today);

    if (!options.length) {
        logger.error("❌ No options found");
        process.exit(1);
    }

    // Get unique expiry dates
    const expiryDates = [...new Set(options.map(o => o.expiryDate.getTime()))]
        .sort((a, b) => a - b);

    const weeklyExpiry = new Date(expiryDates[0]);

    const weeklyOptions = options.filter(o =>
        o.expiryDate.getTime() === weeklyExpiry.getTime()
    );

    const atmStrike = getATMStrike(price, 100);

    const ce = weeklyOptions.find(o =>
        parseFloat(o.strike) / 100 === atmStrike && o.symbol.endsWith("CE")
    );

    const pe = weeklyOptions.find(o =>
        parseFloat(o.strike) / 100 === atmStrike && o.symbol.endsWith("PE")
    );

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

function getATMStrike(price, step = 100) {
    return Math.round(price / step) * step;
}

export async function getLTP(jwtToken, exchangeTokens) {

    const url = "https://apiconnect.angelone.in/rest/secure/angelbroking/market/v1/quote/";

    try {

        const response = await axios.post(
            url,
            {
                mode: "LTP",
                exchangeTokens
            },
            {
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${jwtToken}`,
                    "X-PrivateKey": process.env.API_KEY,
                    "Accept": "application/json",
                    "X-UserType": "USER",
                    "X-SourceID": "WEB"
                }
            }
        );

        if (!response.data?.status) {
            throw new Error(response.data?.message || "LTP fetch failed");
        }

        return response.data.data.fetched;

    } catch (err) {
        console.error("❌ LTP Fetch Error:", err.response?.data || err.message);
        return [];
    }
}