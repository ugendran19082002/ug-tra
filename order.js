import axios from "axios";
import dotenv from "dotenv";
import { buildHeaders } from "./helpers.js";
import { logger } from "./logger.js";

dotenv.config();

const BASE_URL = "https://apiconnect.angelone.in";

// ─────────────────────────────────────────────────────
// PLACE REGULAR MKT ORDER (AngelOne)
// ─────────────────────────────────────────────────────
async function placeRegularOrder(jwtToken, symbol, token, transactionType, qty = 20) {
    try {
        const body = {
            variety: "NORMAL",
            tradingsymbol: symbol,
            symboltoken: String(token),
            transactiontype: transactionType,
            exchange: "BFO",
            ordertype: "MARKET",
            producttype: "CARRYFORWARD",
            duration: "DAY",
            quantity: String(qty),
        };

        const res = await axios.post(
            `${BASE_URL}/rest/secure/angelbroking/order/v1/placeOrder`,
            body,
            { headers: buildHeaders(jwtToken) }
        );

        if (res.data?.status) {
            logger.info(`🟢 AngelOne Entry Order Placed: ${JSON.stringify(res.data.data)}`);
            return res.data.data.orderid;
        } else {
            logger.error(`❌ AngelOne Entry Order Failed: ${res.data?.message}`);
            return null;
        }
    } catch (err) {
        logger.error(`❌ AngelOne Entry Order Error: ${err.response?.data?.message || err.message}`);
        return null;
    }
}

// ─────────────────────────────────────────────────────
// PLACE STOP LOSS ORDER (STOPLOSS_MARKET)
// ─────────────────────────────────────────────────────
async function placeStopLossOrder(jwtToken, symbol, token, triggerPrice, qty = 20) {
    try {
        const body = {
            variety: "STOPLOSS",
            tradingsymbol: symbol,
            symboltoken: String(token),
            transactiontype: "SELL",
            exchange: "BFO",
            ordertype: "STOPLOSS_MARKET",
            producttype: "CARRYFORWARD",
            duration: "DAY",
            price: "0", // Triggered at market
            triggerprice: String(triggerPrice),
            quantity: String(qty),
        };

        const res = await axios.post(
            `${BASE_URL}/rest/secure/angelbroking/order/v1/placeOrder`,
            body,
            { headers: buildHeaders(jwtToken) }
        );

        if (res.data?.status) {
            logger.info(`✅ AngelOne SL-M Order Placed: ${res.data.data.orderid}`);
            return res.data.data.orderid;
        } else {
            logger.error(`❌ AngelOne SL-M Failed: ${res.data?.message}`);
            return null;
        }
    } catch (err) {
        logger.error(`❌ AngelOne SL-M Error: ${JSON.stringify(err.response?.data || err.message)}`);
        return null;
    }
}

// ─────────────────────────────────────────────────────
// PLACE TARGET LIMIT ORDER
// ─────────────────────────────────────────────────────
async function placeLimitOrder(jwtToken, symbol, token, price, qty = 20) {
    try {
        const body = {
            variety: "NORMAL",
            tradingsymbol: symbol,
            symboltoken: String(token),
            transactiontype: "SELL",
            exchange: "BFO",
            ordertype: "LIMIT",
            producttype: "CARRYFORWARD",
            duration: "DAY",
            price: String(price),
            quantity: String(qty),
        };

        const res = await axios.post(
            `${BASE_URL}/rest/secure/angelbroking/order/v1/placeOrder`,
            body,
            { headers: buildHeaders(jwtToken) }
        );

        if (res.data?.status) {
            logger.info(`✅ AngelOne Target Limit Placed: ${res.data.data.orderid}`);
            return res.data.data.orderid;
        } else {
            logger.error(`❌ AngelOne Target Limit Failed: ${res.data?.message}`);
            return null;
        }
    } catch (err) {
        logger.error(`❌ AngelOne Target Limit Error: ${JSON.stringify(err.response?.data || err.message)}`);
        return null;
    }
}

// ─────────────────────────────────────────────────────
// GET OPEN POSITIONS
// ─────────────────────────────────────────────────────
async function getPositions(jwtToken) {
    try {
        const res = await axios.get(
            `${BASE_URL}/rest/secure/angelbroking/order/v1/getPosition`,
            { headers: buildHeaders(jwtToken) }
        );

        if (res.data?.status && res.data.data) {
            return res.data.data;
        }
        return [];
    } catch (err) {
        logger.error(`❌ AngelOne GetPositions Error: ${JSON.stringify(err.response?.data || err.message)}`);
        return [];
    }
}
export async function executeOrder(jwt, signal) {
    const { signal: type, optionToken, ceSymbol, peSymbol, optionLTP, optionSL, optionTarget } = signal;

    if (!optionToken || optionLTP == null) {
        logger.warn("⚠ executeOrder: missing token or LTP — skipping order");
        return;
    }

    const symbol = type === "CE" ? ceSymbol : peSymbol;

    // ── Check if already in a position for this symbol
    const positions = await getPositions(jwt);
    const existing = positions.find(p => p.tradingsymbol === symbol && parseInt(p.netqty) !== 0);

    if (existing) {
        logger.warn(`⚠ executeOrder: Already in position for ${symbol} (Qty: ${existing.netqty}) — skipping entry`);
        return;
    }

    const transactionType = "BUY";

    // 1️⃣ Place entry BUY
    const orderNo = await placeRegularOrder(jwt, symbol, optionToken, transactionType);
    if (!orderNo) {
        logger.error("❌ AngelOne Entry order failed — skipping GTT creation");
        return;
    }

    // 2️⃣ Place SL-M Order
    const slOrderId = await placeStopLossOrder(jwt, symbol, optionToken, optionSL, 20);

    // 3️⃣ Place Target Limit Order
    const tgtOrderId = await placeLimitOrder(jwt, symbol, optionToken, optionTarget, 20);

    return { orderNo, slOrderId, tgtOrderId };
}
