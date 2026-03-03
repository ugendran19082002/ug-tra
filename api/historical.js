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

        if (res.data?.errorCode === "AG8001") {
            throw new Error("INVALID_TOKEN");
        }

        const candles = res.data?.data;

        if (!Array.isArray(candles)) {
            logger.error(`❌ Historical data is not an array: ${JSON.stringify(res.data)}`);
            return [];
        }

        candles.sort((a, b) => {
            return new Date(a[0]).getTime() - new Date(b[0]).getTime();
        });

        logger.info(`📈 ${interval} candles: ${candles.length}`);

        // if (checkLastCandleStaleness(candles, "index", logger, 5)) {
        //     return [];
        // }




        return candles;

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
// export async function getFuture(token, fromdate, todate, retries = 3) {
//     const INSTRUMENT_KEY = `BSE_FO|${token}`;

//     const toDate = (todate ?? "").slice(0, 10) || new Date().toISOString().slice(0, 10);
//     const fromDate = (fromdate ?? "").slice(0, 10) || toDate;

//     console.log("toDate", toDate);
//     console.log("fromDate", fromDate);

//     const url = `https://api.upstox.com/v3/historical-candle/${encodeURIComponent(INSTRUMENT_KEY)}/minutes/2/${toDate}/${fromDate}`;

//     try {
//         const res = await axios.get(url, {
//             headers: {
//                 "Accept": "application/json",
//                 "Authorization": `Bearer ${process.env.UPSTOX_ACCESS_TOKEN}`
//             }
//         });

//         const candles = res.data?.data?.candles || [];

//         if (!candles.length) {
//             logger.warn("⚠ No future candles returned");
//             return [];
//         }

//         candles.sort((a, b) => {
//             return new Date(a[0]).getTime() - new Date(b[0]).getTime();
//         });

//         // if (checkLastCandleStaleness(candles, "future", logger, 5)) {
//         //     return [];
//         // }

//         // Latest 1m candle
//         const lastCandle = candles[candles.length - 1];

//         console.log("📍 Latest 1m Candle:");
//         console.log("Time   :", lastCandle[0]);
//         console.log("Open   :", lastCandle[1]);
//         console.log("High   :", lastCandle[2]);
//         console.log("Low    :", lastCandle[3]);
//         console.log("Close  :", lastCandle[4]);
//         console.log("Volume :", lastCandle[5]);
//         console.log("OI     :", lastCandle[6] ?? "N/A");
//         logger.debug(`OI Sample:\n${JSON.stringify(candles.slice(0, 2), null, 2)}`);
//         return candles;

//     } catch (err) {
//         if (err.response?.status === 403 && retries > 0) {
//             logger.warn(`⚠ Future Rate-limit — retrying in 2s… (${retries} left)`);
//             await sleep(2000);
//             return getFuture(token, fromdate, todate, retries - 1);
//         }
//         logger.error(`❌ Future fetch failed: ${err.message}`);
//         return [];
//     }
// }

export async function getFuture(token, fromdate, todate, interval = 2, retries = 3) {

    const INSTRUMENT_KEY = `BSE_FO|${token}`;
    const BASE_URL = "https://api.upstox.com/v3";

    const today = new Date().toISOString().slice(0, 10);
    const toDate = (todate ?? "").slice(0, 10) || today;
    const fromDate = (fromdate ?? "").slice(0, 10) || toDate;

    console.log("toDate  :", toDate);
    console.log("fromDate:", fromDate);

    try {

        // ─────────────────────────────
        // 1️⃣ Fetch Historical
        // ─────────────────────────────
        const historicalUrl =
            `${BASE_URL}/historical-candle/${encodeURIComponent(INSTRUMENT_KEY)}` +
            `/minutes/${interval}/${toDate}/${fromDate}`;

        const historicalRes = await axios.get(historicalUrl, {
            headers: {
                Accept: "application/json",
                Authorization: `Bearer ${process.env.UPSTOX_ACCESS_TOKEN}`
            }
        });

        const historical = historicalRes.data?.data?.candles || [];

        // ─────────────────────────────
        // 2️⃣ Fetch Intraday
        // ─────────────────────────────
        const intradayUrl =
            `${BASE_URL}/historical-candle/intraday/${encodeURIComponent(INSTRUMENT_KEY)}` +
            `/minutes/${interval}`;

        const intradayRes = await axios.get(intradayUrl, {
            headers: {
                Accept: "application/json",
                Authorization: `Bearer ${process.env.UPSTOX_ACCESS_TOKEN}`
            }
        });

        const intraday = intradayRes.data?.data?.candles || [];

        console.log("Historical:", historical.length);
        console.log("Intraday  :", intraday.length);

        // ─────────────────────────────
        // 3️⃣ Merge + Remove Duplicates
        // ─────────────────────────────
        const map = new Map();

        for (const c of historical) map.set(c[0], c);
        for (const c of intraday) map.set(c[0], c);

        const candles = Array.from(map.values());

        // ─────────────────────────────
        // 4️⃣ Sort and Filter by toDate (Crucial for Replay Parity)
        // ─────────────────────────────
        candles.sort((a, b) => Date.parse(a[0]) - Date.parse(b[0]));

        const endBoundaryTs = todate ? new Date(todate).getTime() : Date.now();
        const filteredCandles = candles.filter(c => new Date(c[0]).getTime() <= endBoundaryTs);

        if (!filteredCandles.length) {
            logger.warn(`⚠ No candles remaining after filtering by toDate: ${todate}`);
            return [];
        }

        // ─────────────────────────────
        // 5️⃣ Log Last Candle Age (Relative to toDate if replay testing)
        // ─────────────────────────────
        const lastCandle = filteredCandles[filteredCandles.length - 1];
        const lastTime = Date.parse(lastCandle[0]);
        const diffMin = (endBoundaryTs - lastTime) / 60000;

        console.log("🕒 Last Candle:", lastCandle[0]);
        console.log("⏱ Delay (min):", diffMin.toFixed(2), todate ? "(relative to todate)" : "");

        if (!todate && diffMin > 30) {
            logger.warn(`⚠ Future data is ${diffMin.toFixed(1)} min old — check Upstox connection`);
        }

        // ─────────────────────────────
        // 6️⃣ Print Latest Candle
        // ─────────────────────────────
        console.log("📍 Latest Candle:");
        console.log("Time   :", lastCandle[0]);
        console.log("Open   :", lastCandle[1]);
        console.log("High   :", lastCandle[2]);
        console.log("Low    :", lastCandle[3]);
        console.log("Close  :", lastCandle[4]);
        logger.info(`  Volume : ${lastCandle[5]}`);
        logger.info(`  OI     : ${lastCandle[6] ?? "N/A"}`);

        logger.debug(`OI Sample:\n${JSON.stringify(filteredCandles.slice(0, 2), null, 2)}`);

        return filteredCandles;

    } catch (err) {

        if (err.response?.status === 403 && retries > 0) {
            logger.warn(`⚠ Rate-limit — retrying (${retries} left)`);
            await new Promise(r => setTimeout(r, 2000));
            return getFuture(token, fromdate, todate, interval, retries - 1);
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

export function checkLastCandleStaleness(
    candles,
    type,
    logger,
    maxAgeMinutes = 10
) {
    if (!candles?.length) {
        logger.warn(`⚠ No ${type} candles available`);
        return true;
    }

    const lastRaw = candles.at(-1)[0];
    const lastCandleTime = new Date(lastRaw);
    const now = new Date();

    const ageMinutes = (now - lastCandleTime) / (1000 * 60);

    logger.info(
        `🕒 ${type} Last Candle IST : ${lastCandleTime.toLocaleString("en-IN", {
            timeZone: "Asia/Kolkata",
            hour12: false
        })
        }`
    );

    logger.info(`⏳ ${type} Candle Age : ${ageMinutes.toFixed(2)} mins`);

    if (ageMinutes > maxAgeMinutes) {
        logger.warn(
            `⚠ ${type} candle stale (${ageMinutes.toFixed(2)} mins old)`
        );
        return true;
    }

    return false;
}

export function mergeCandlesUnique(oldCandles = [], intradayCandles = []) {
    const map = new Map();

    // Add old candles
    for (const c of oldCandles) {
        map.set(c[0], c);
    }

    // Add intraday candles (will overwrite if same timestamp)
    for (const c of intradayCandles) {
        map.set(c[0], c);
    }

    // Convert back to array
    const merged = Array.from(map.values());

    // Sort old → new
    merged.sort((a, b) => Date.parse(a[0]) - Date.parse(b[0]));

    return merged;
}