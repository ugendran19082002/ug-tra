import axios from "axios";
import speakeasy from "speakeasy";
import fs from "fs";
import path from "path";
import { logger } from "../logger.js";
import { buildHeaders } from "../helpers.js";

const BASE_URL = "https://apiconnect.angelone.in";
const TOKEN_FILE = path.resolve("./jwt_cache.json");

// AngelOne JWT is valid for ~24h — we refresh 30 min before expiry
const TOKEN_TTL_MS = 23.5 * 60 * 60 * 1000; // 23.5 hours

function loadCachedToken() {
    try {
        if (!fs.existsSync(TOKEN_FILE)) return null;
        const { jwt, savedAt } = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf-8"));
        const age = Date.now() - savedAt;
        if (age < TOKEN_TTL_MS) {
            logger.info(`✅ Reusing cached JWT (age: ${(age / 3600000).toFixed(2)}h)`);
            return jwt;
        }
        logger.info("🔄 Cached JWT expired — refreshing...");
        return null;
    } catch {
        return null;
    }
}

export function clearTokenCache() {
    if (fs.existsSync(TOKEN_FILE)) {
        fs.unlinkSync(TOKEN_FILE);
        logger.info("🗑 Cached JWT cleared");
    }
}

function saveToken(jwt) {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ jwt, savedAt: Date.now() }), "utf-8");
}

export async function login(force = false) {
    // Return cached token if still valid
    if (!force) {
        const cached = loadCachedToken();
        if (cached) return cached;
    } else {
        logger.warn("🔄 Forced login requested...");
    }

    try {
        logger.info("🔐 Logging in...");
        const otp = speakeasy.totp({ secret: process.env.TOTP_SECRET, encoding: "base32" });

        const res = await axios.post(
            `${BASE_URL}/rest/auth/angelbroking/user/v1/loginByPassword`,
            { clientcode: process.env.CLIENT_ID, password: process.env.PASSWORD, totp: otp },
            { headers: buildHeaders() }
        );

        const jwt = res.data.data.jwtToken;
        saveToken(jwt);

        logger.info("✅ Login Success — JWT cached to disk");
        return jwt;

    } catch (err) {
        logger.error(`❌ Login Failed: ${JSON.stringify(err.response?.data || err.message)}`);
        process.exit(1);
    }
}