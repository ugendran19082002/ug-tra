import winston from "winston";

// ─────────────────────────────────────────
// IST TIME (Asia/Kolkata UTC+5:30)
// ─────────────────────────────────────────
export function getISTTime(date = new Date()) {
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

// ─────────────────────────────────────────
// MAIN LOGGER
// ─────────────────────────────────────────
export const logger = winston.createLogger({
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

// ─────────────────────────────────────────
// TRADE LOGGER
// ─────────────────────────────────────────
export const tradeLogger = winston.createLogger({
    level: "info",
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, message }) =>
            `${timestamp} [IST: ${getISTTime()}] | ${message}`
        )
    ),
    transports: [
        new winston.transports.File({ filename: "trade.log" })
    ]
});