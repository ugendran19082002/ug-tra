import fs from "fs";
let scripMasterCache = null;
import winston from "winston";
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

export async function loadScripMaster(forceRefresh = false) {

    const CACHE_FILE = "./scripMaster_sensex.json";
    const SYMBOL = "SENSEX";

    // 1️⃣ In-memory cache
    if (scripMasterCache && !forceRefresh) {
        return scripMasterCache;
    }

    // 2️⃣ Load from local file
    if (!forceRefresh && fs.existsSync(CACHE_FILE)) {
        logger.info("📂 Loading SENSEX ScripMaster from local cache...");
        const raw = fs.readFileSync(CACHE_FILE, "utf8");
        scripMasterCache = JSON.parse(raw);
        return scripMasterCache;
    }

    // 3️⃣ Download full master
    logger.info("🌐 Downloading Full ScripMaster...");
    const res = await axios.get(
        "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json"
    );

    if (!Array.isArray(res.data)) {
        throw new Error("Invalid ScripMaster response");
    }

    // 🔥 Filter ONLY SENSEX (FUTIDX + OPTIDX)
    const filtered = res.data.filter(i =>
        i.name === SYMBOL &&
        (i.instrumenttype === "FUTIDX" || i.instrumenttype === "OPTIDX")
    );

    logger.info(`🎯 Filtered ${filtered.length} SENSEX instruments`);

    scripMasterCache = filtered;

    fs.writeFileSync(CACHE_FILE, JSON.stringify(filtered));
    logger.info("✅ SENSEX ScripMaster cached locally.");

    return scripMasterCache;
}