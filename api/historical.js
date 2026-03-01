import axios from "axios";
import { logger } from "../logger.js";
import { buildHeaders, sleep } from "../helpers.js";

const BASE_URL = "https://apiconnect.angelone.in";

// ─────────────────────────────────────────
// ANGELONE HISTORICAL (index candles)
// ─────────────────────────────────────────
export async function getHistorical(jwt, exchange, token, interval, fromdate, todate, retries = 3) {
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
// UPSTOX FUTURE 1m CANDLES
// ─────────────────────────────────────────
export async function getFuture(token, fromdate, todate, retries = 3) {
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

// ─────────────────────────────────────────
// FORMAT: AngelOne candle [time,o,h,l,c,vol,oi]
// ─────────────────────────────────────────
export const format = raw => raw.map(c => ({
    time: c[0],
    open: c[1],
    high: c[2],
    low: c[3],
    close: c[4],
    volume: c[5],
    oi: c[6] ?? 0
}));