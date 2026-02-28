require("dotenv").config();
const axios = require("axios");
const speakeasy = require("speakeasy");
const os = require("os");

const BASE_URL = "https://apiconnect.angelone.in";

// ─────────────────────────────
// NETWORK
// ─────────────────────────────
function getLocalIP() {
    for (const ifaces of Object.values(os.networkInterfaces())) {
        for (const iface of ifaces) {
            if (iface.family === "IPv4" && !iface.internal)
                return iface.address;
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

// ─────────────────────────────
// LOGIN
// ─────────────────────────────
async function login() {

    const otp = speakeasy.totp({
        secret: process.env.TOTP_SECRET,
        encoding: "base32"
    });

    const res = await axios.post(
        `${BASE_URL}/rest/auth/angelbroking/user/v1/loginByPassword`,
        {
            clientcode: process.env.CLIENT_ID,
            password: process.env.PASSWORD,
            totp: otp
        },
        { headers: buildHeaders() }
    );

    return res.data.data.jwtToken;
}

// ─────────────────────────────
// QUOTE API CALL
// ─────────────────────────────
async function getQuote(jwtToken) {

    const res = await axios.post(
        `${BASE_URL}/rest/secure/angelbroking/market/v1/quote/`,
        {
            mode: "FULL",   // FULL / OHLC / LTP
            exchangeTokens: {
                BFO: ["825565"] // SBIN example
            }
        },
        { headers: buildHeaders(jwtToken) }
    );

    const data = res.data.data.fetched[0];

    console.log("📈 LTP:", data.ltp);
    console.log("🟢 Open:", data.open);
    console.log("🔼 High:", data.high);
    console.log("🔽 Low:", data.low);
    console.log("🔴 Close:", data.close);
    console.log("📊 Volume:", data.tradeVolume);
    console.log("📊 OI:", data.opnInterest || 0);
    ;
    console.log("------------------------");
}

// ─────────────────────────────
// MAIN
// ─────────────────────────────
async function main() {

    const jwtToken = await login();

    // Call every 5 seconds
    setInterval(async () => {
        try {
            await getQuote(jwtToken);
        } catch (err) {
            console.log("Error:", err.response?.data || err.message);
        }
    }, 5000);
}

main();