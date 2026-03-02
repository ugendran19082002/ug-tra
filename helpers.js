import os from "os";

// ─────────────────────────────────────────
// SLEEP
// ─────────────────────────────────────────
export const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────
// LOCAL IP
// ─────────────────────────────────────────
export function getLocalIP() {
    for (const ifaces of Object.values(os.networkInterfaces())) {
        for (const iface of ifaces) {
            if (iface.family === "IPv4" && !iface.internal) return iface.address;
        }
    }
    return "127.0.0.1";
}


export function buildTimeframe(data, size) {
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
            volume: chunk.reduce((s, c) => s + c.volume, 0),
            oi: chunk.reduce((s, c) => s + c.oi, 0)
        });
    }
    return result;
}

// ─────────────────────────────────────────
// API HEADERS
// ─────────────────────────────────────────
export function buildHeaders(jwtToken = null) {
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

// ─────────────────────────────────────────
// DATE FORMATTING
// ─────────────────────────────────────────
export function formatDateTime() {
    const date = new Date();

    // Go 20 days back
    date.setDate(date.getDate() - 20);

    // Set fixed time 09:15
    date.setHours(9);
    date.setMinutes(15);
    date.setSeconds(0);
    date.setMilliseconds(0);

    const p = n => String(n).padStart(2, "0");

    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ` +
        `${p(date.getHours())}:${p(date.getMinutes())}`;
}


// export function formatCurrentDateTime() {
//     const now = new Date();
//     const p = n => String(n).padStart(2, "0");

//     return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ` +
//         `${p(now.getHours())}:${p(now.getMinutes())}`;
// }

export function formatCurrentDateTime() {
    const now = new Date();

    // Remove seconds & milliseconds
    now.setSeconds(0, 0);

    // Go 1 minute back
    now.setMinutes(now.getMinutes() - 1);

    const p = n => String(n).padStart(2, "0");

    return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ` +
        `${p(now.getHours())}:${p(now.getMinutes())}`;
}
// ─────────────────────────────────────────
// DYNAMIC DATE HELPERS
// ─────────────────────────────────────────
export function getTodayFromDate(daysBack = 20) {
    const p = n => String(n).padStart(2, "0");
    const d = new Date();
    d.setDate(d.getDate() - daysBack);
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} 09:15`;
}

export function getDailyFromDate() {
    const p = n => String(n).padStart(2, "0");
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} 09:15`;
}

// ─────────────────────────────────────────
// MARKET HOURS CHECK (IST)
// ─────────────────────────────────────────
export function isMarketOpen() {
    const now = new Date();
    const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const h = ist.getHours();
    const m = ist.getMinutes();
    const mins = h * 60 + m;
    return mins >= (9 * 60 + 15) && mins <= (15 * 60 + 30);
}


export function formatISTDateTime() {
    const now = new Date(
        new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })
    );

    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    const hh = String(now.getHours()).padStart(2, "0");
    const min = String(now.getMinutes()).padStart(2, "0");

    return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}