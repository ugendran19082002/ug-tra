import axios from "axios";
import dotenv from "dotenv";
import { buildHeaders, sleep } from "./helpers.js";
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
// GET OPEN POSITIONS (AngelOne)
// ─────────────────────────────────────────────────────
export async function getPositions(jwtToken) {
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

// ─────────────────────────────────────────────────────
// GET ORDER BOOK (AngelOne)
// ─────────────────────────────────────────────────────
async function getOrderBook(jwtToken) {
    try {
        const res = await axios.get(
            `${BASE_URL}/rest/secure/angelbroking/order/v1/getOrderBook`,
            { headers: buildHeaders(jwtToken) }
        );
        if (res.data?.status && res.data.data) {
            return res.data.data;
        }
        return [];
    } catch (err) {
        logger.error(`❌ AngelOne GetOrderBook Error: ${JSON.stringify(err.response?.data || err.message)}`);
        return [];
    }
}

// ─────────────────────────────────────────────────────
// CANCEL ORDER (AngelOne)
// ─────────────────────────────────────────────────────
async function cancelOrder(jwtToken, variety, orderId) {
    try {
        const body = { variety, orderid: orderId };
        const res = await axios.post(
            `${BASE_URL}/rest/secure/angelbroking/order/v1/cancelOrder`,
            body,
            { headers: buildHeaders(jwtToken) }
        );
        if (res.data?.status) {
            logger.info(`✅ AngelOne Order Cancelled: ${orderId}`);
            return true;
        }
        logger.error(`❌ AngelOne Order Cancel Failed: ${res.data?.message}`);
        return false;
    } catch (err) {
        logger.error(`❌ AngelOne Order Cancel Error: ${JSON.stringify(err.response?.data || err.message)}`);
        return false;
    }
}

// ─────────────────────────────────────────────────────
// MARKET EXIT POSITION (AngelOne)
// ─────────────────────────────────────────────────────
export async function marketExit(jwtToken, symbol) {
    try {
        const positions = await getPositions(jwtToken);
        const p = positions.find(pos => pos.tradingsymbol === symbol && parseInt(pos.netqty) !== 0);

        if (!p) {
            logger.warn(`⚠ marketExit: No active position found for ${symbol} — performing cleanup only`);
            await cleanupOrders(jwtToken, symbol);
            return false;
        }

        const qty = Math.abs(parseInt(p.netqty));
        const side = parseInt(p.netqty) > 0 ? "SELL" : "BUY";

        logger.info(`🚨 SENSEX INDEX EXIT TRIGGERED: Exiting ${symbol} Qty:${qty} Side:${side}`);
        await sleep(1000); // Delay before position check

        const body = {
            variety: "NORMAL",
            tradingsymbol: symbol,
            symboltoken: p.symboltoken,
            transactiontype: side,
            exchange: p.exchange,
            ordertype: "MARKET",
            producttype: p.producttype,
            duration: "DAY",
            quantity: String(qty),
        };

        const res = await axios.post(
            `${BASE_URL}/rest/secure/angelbroking/order/v1/placeOrder`,
            body,
            { headers: buildHeaders(jwtToken) }
        );

        if (res.data?.status) {
            logger.info(`✅ AngelOne Market Exit Placed: ${res.data.data.orderid}`);
            // Always cleanup hanging orders after exit
            await cleanupOrders(jwtToken, symbol);
            return true;
        } else {
            logger.error(`❌ AngelOne Market Exit Failed: ${res.data?.message}`);
            return false;
        }
    } catch (err) {
        logger.error(`❌ AngelOne Market Exit Error: ${JSON.stringify(err.response?.data || err.message)}`);
        return false;
    }
}

// ─────────────────────────────────────────────────────
// CHECK IF POSITION CLOSED AND CLEANUP ORDERS
// ─────────────────────────────────────────────────────
export async function checkExitAndCleanup(jwtToken, symbol, params = {}) {
    if (!symbol) return;
    const { currentIndexLTP, indexSL, indexTGT, isPE } = params;

    // 1. First check structural exit (Index targets hit)
    if (currentIndexLTP && indexSL && indexTGT) {
        const price = parseFloat(currentIndexLTP);
        let triggered = false;

        if (isPE) {
            // PE: SL is above entry, TGT is below entry
            if (price >= indexSL) triggered = true;
            if (price <= indexTGT) triggered = true;
        } else {
            // CE: SL is below entry, TGT is above entry
            if (price <= indexSL) triggered = true;
            if (price >= indexTGT) triggered = true;
        }

        if (triggered) {
            logger.info(`🎯 Index Level Hit (LTP:${price} SL:${indexSL} TGT:${indexTGT}) — Triggering Market Exit`);
            await marketExit(jwtToken, symbol);
            return;
        }
    }

    // 2. Check current positions (if option-level SL/TGT was hit instead)
    const positions = await getPositions(jwtToken);
    const existing = positions.find(p => p.tradingsymbol === symbol && parseInt(p.netqty) !== 0);

    // If netqty is 0 (or position doesn't exist), clean up any pending orders for that symbol
    if (!existing) {
        await cleanupOrders(jwtToken, symbol);
    }
}

// ─────────────────────────────────────────────────────
// CLEANUP PENDING ORDERS FOR SYMBOL
// ─────────────────────────────────────────────────────
export async function cleanupOrders(jwtToken, symbol) {
    const orders = await getOrderBook(jwtToken);
    const pendingOrders = orders.filter(o =>
        o.tradingsymbol === symbol &&
        ["open", "pending", "trigger pending"].includes(String(o.status).toLowerCase())
    );

    if (pendingOrders.length > 0) {
        logger.info(`🧹 Cleaning up ${pendingOrders.length} pending orders for ${symbol}`);
        for (const o of pendingOrders) {

            let variety = o.variety || "NORMAL";
            if (!o.variety && String(o.ordertype).toUpperCase().includes("STOPLOSS")) {
                variety = "STOPLOSS";
            }

            logger.info(`   - Cancelling order ${o.orderid} (Variety: ${variety})`);
            await cancelOrder(jwtToken, variety, o.orderid);
            await sleep(800); // 800ms gap to avoid rate limits

        }
    }
}

export async function executeOrder(jwt, signal) {
    const { signal: type, optionToken, ceSymbol, peSymbol, optionLTP } = signal;

    if (!optionToken || optionLTP == null) {
        logger.warn("⚠ executeOrder: missing token or LTP — skipping order");
        return;
    }

    const symbol = type === "CE" ? ceSymbol : peSymbol;

    // ── First, clean up any old pending orders for this symbol
    await cleanupOrders(jwt, symbol);
    await sleep(1000); // Wait after cleanup before checking positions

    // ── Check if already in a position for this symbol
    const positions = await getPositions(jwt);
    const existing = positions.find(p => p.tradingsymbol === symbol && parseInt(p.netqty) !== 0);

    if (existing) {
        logger.warn(`⚠ executeOrder: Already in position for ${symbol} (Qty: ${existing.netqty}) — skipping entry`);
        return;
    }

    // ── Calculate Simplified Option SL & Target
    // Long trade (both CE/PE): Target is above entry premium, SL is below entry premium.
    const slPoints = parseFloat(signal.slPoints);
    const tgtPoints = parseFloat(signal.tgtPoints);

    const optionSL = parseFloat(Math.max(0.1, optionLTP - slPoints).toFixed(1));
    const optionTarget = parseFloat(Math.max(0.1, optionLTP + tgtPoints).toFixed(1));

    logger.info(`📐 Simplified Option Levels | LTP:${optionLTP} | SL:${optionSL} (pts:${slPoints}) | TGT:${optionTarget} (pts:${tgtPoints})`);

    const transactionType = "BUY";

    // 1️⃣ Place entry BUY
    const orderNo = await placeRegularOrder(jwt, symbol, optionToken, transactionType, 20);
    if (!orderNo) {
        logger.error("❌ AngelOne Entry order failed — skipping SL/TGT creation");
        return;
    }

    // Give broker time to process entry
    await sleep(1000);

    // 2️⃣ Place SL-M Order
    const slOrderId = await placeStopLossOrder(jwt, symbol, optionToken, optionSL, 20);

    await sleep(500);

    // 3️⃣ Place Target Limit Order
    const tgtOrderId = await placeLimitOrder(jwt, symbol, optionToken, optionTarget, 20);

    return { orderNo, slOrderId, tgtOrderId, optionSL, optionTarget };
}
