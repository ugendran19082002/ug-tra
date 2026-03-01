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
export function formatDateTime(date = new Date()) {
    const p = n => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ` +
        `${p(date.getHours())}:${p(date.getMinutes())}`;
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