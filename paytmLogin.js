import express from "express";
import axios from "axios";
import fs from "fs";
import dotenv from "dotenv";
import { exec } from "child_process";

dotenv.config();

const app = express();
const PORT = 3000;

const BASE_URL = "https://developer.paytmmoney.com";
const API_KEY = process.env.P_API_KEY;
const API_SECRET = process.env.P_API_SECRET;
const STATE = "TRADING_BOT";
const TOKEN_FILE = "./.paytm_token";

const LOGIN_URL =
    `https://login.paytmmoney.com/merchant-login?apiKey=${API_KEY}&state=${STATE}&redirect_uri=http://localhost:${PORT}`;

console.log("\n🌐 Starting Paytm Login Server...");
console.log(`🔗 Login URL:\n${LOGIN_URL}\n`);

// ─────────────────────────────────────────
// EXPRESS CALLBACK ROUTE
// ─────────────────────────────────────────
app.get("/", async (req, res) => {
    try {
        const requestToken =
            req.query.request_token || req.query.requestToken;

        if (!requestToken) {
            return res.send("❌ No request_token found in URL");
        }

        console.log("✅ Received request_token:", requestToken);

        const tokenRes = await axios.post(
            `${BASE_URL}/accounts/v2/gettoken`,
            {
                api_key: API_KEY,
                api_secret_key: API_SECRET,
                request_token: requestToken
            },
            { headers: { "Content-Type": "application/json" } }
        );

        const accessToken = tokenRes.data.access_token;

        fs.writeFileSync(TOKEN_FILE, accessToken, "utf-8");

        console.log("✅ Access token saved to .paytm_token");

        res.send("🎉 Login Successful! You can close this tab and start your bot.");

        setTimeout(() => process.exit(0), 2000);

    } catch (err) {
        console.error("❌ Token exchange failed:", err.response?.data || err.message);
        res.send("❌ Token exchange failed. Check console.");
    }
});

// ─────────────────────────────────────────
// START SERVER + OPEN BROWSER
// ─────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
    exec(`start "" "${LOGIN_URL}"`);
});