require("dotenv").config();
const axios = require("axios");


async function getFuture(token) {
    const INSTRUMENT_KEY = "BSE_FO|825565";


    const toDate = "2026-02-27";
    const fromDate = "2026-02-27";

    const url = `https://api.upstox.com/v3/historical-candle/${encodeURIComponent(INSTRUMENT_KEY)}/minutes/1/${toDate}/${fromDate}`;

    try {

        const res = await axios.get(url, {
            headers: {
                "Accept": "application/json",
                "Authorization": `Bearer`
            }
        });

        const candles = res.data?.data?.candles || [];

        if (!candles.length) {
            console.log("⚠ No candles returned");
            return;
        }

        candles.forEach(c => {
            console.log("━━━━━━━━━━━━━━━━━━");
            console.log("🕒 Time:", c[0]);
            console.log("🟢 Open:", c[1]);
            console.log("🔼 High:", c[2]);
            console.log("🔽 Low:", c[3]);
            console.log("🔴 Close:", c[4]);
            console.log("📊 Volume:", c[5]);
            console.log("📊 OI:", c[6]);
        });

    } catch (err) {
        console.error("❌ Error:", err.response?.data || err.message);
    }
}

getHistorical();