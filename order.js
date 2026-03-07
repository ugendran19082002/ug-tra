import axios from "axios";
import dotenv from "dotenv";
import { buildHeaders, sleep } from "./helpers.js";
import { logger } from "./logger.js";

dotenv.config();

const BASE_URL = process.env.KOTAK_BASEURL;
const LOT_SIZE = parseInt(process.env.LOT_SIZE ?? "20");

function kotakHeaders() {
    return {
        accept: "application/json",
        Auth: process.env.KOTAK_TOKEN,
        Sid: process.env.KOTAK_SID,
        "neo-fin-key": "neotradeapi",
        "Content-Type": "application/x-www-form-urlencoded"
    };
}

function jData(data) {
    // Axios requires the payload to be properly URL-encoded when Content-Type is x-www-form-urlencoded
    const params = new URLSearchParams();
    params.append('jData', JSON.stringify(data));
    return params.toString();
}

// Time check function to see if we are in market hours
function isMarketOpen() {
    const now = new Date();
    // Assuming machine is in IST timezone.
    const timeInMinutes = now.getHours() * 60 + now.getMinutes();

    // 9:15 AM to 3:30 PM (555 to 930)
    const marketStart = 9 * 60 + 15;
    const marketEnd = 15 * 60 + 30;

    return timeInMinutes >= marketStart && timeInMinutes <= marketEnd;
}

// ─────────────────────────────────────────────────────
// HELPER: Extract executed/average price from a Kotak order object
// Kotak uses inconsistent field names across API versions; try them all.
// ─────────────────────────────────────────────────────
function extractExecPrice(order) {
    // Common Kotak field names for average executed price
    const candidates = [
        order.avgExePrc,
        order.avgPrc,
        order.avgPr,
        order.fillPrc,
        order.flPr,      // fill price
        order.prc,
        order.pr,
        order.trdPrc,
        order.execPrc,
        order.exePrc,
    ];

    for (const v of candidates) {
        const n = parseFloat(v);
        if (!isNaN(n) && n > 0) return n;
    }

    // Last resort: fill amount / fill quantity
    const fillAmt = parseFloat(order.flAmt ?? order.fillAmt ?? order.trdVal);
    const fillQty = parseFloat(order.flQty ?? order.fillQty ?? order.qt ?? order.qty);
    if (!isNaN(fillAmt) && !isNaN(fillQty) && fillQty > 0) {
        const computed = fillAmt / fillQty;
        if (computed > 0) return computed;
    }

    return NaN;
}

// ─────────────────────────────────────────────────────
// PLACE REGULAR MKT ORDER (Kotak)
// ─────────────────────────────────────────────────────
async function placeRegularOrder(jwtToken, symbol, token, transactionType, price = "0", qty = LOT_SIZE) {
    try {
        const marketOpen = isMarketOpen();

        const body = {
            am: marketOpen ? "NO" : "YES",
            dq: "0",
            es: "bse_fo",
            mp: "0",
            pc: "NRML",
            pf: "N",
            pr: marketOpen ? "0" : String(price),
            pt: marketOpen ? "MKT" : "L",
            qt: String(qty),
            rt: "DAY",
            tp: "0",
            ts: symbol,
            tt: transactionType === "BUY" ? "B" : "S"
        };

        const res = await axios.post(
            `${BASE_URL}/quick/order/rule/ms/place`,
            jData(body),
            { headers: kotakHeaders(), timeout: 8000 }
        );

        if (res.data?.stat === "Ok" && res.data?.nOrdNo) {
            logger.info(`🟢 Kotak Entry Order Placed: ${res.data.nOrdNo}`);
            return res.data.nOrdNo;
        } else {
            logger.error(`❌ Kotak Entry Order Failed: ${JSON.stringify(res.data)}`);
            return null;
        }

    } catch (err) {
        const errorMsg = err.response?.data ? JSON.stringify(err.response.data) : err.message;
        logger.error(`❌ Kotak Entry Order Error: ${errorMsg}`);
        return null;
    }
}

// ─────────────────────────────────────────────────────
// PLACE STOP LOSS ORDER (Kotak)
// ─────────────────────────────────────────────────────
async function placeStopLossOrder(jwtToken, symbol, token, triggerPrice, transactionType = "SELL", qty = LOT_SIZE) {

    try {
        const marketOpen = isMarketOpen();

        const body = {
            am: marketOpen ? "NO" : "YES",
            dq: "0",
            es: "bse_fo",
            mp: "0",
            pc: "NRML",
            pf: "N",
            pr: "0",
            pt: "SL",
            qt: String(qty),
            rt: "DAY",
            tp: String(triggerPrice),
            ts: symbol,
            tt: transactionType === "SELL" ? "S" : "B"
        };

        const res = await axios.post(
            `${BASE_URL}/quick/order/rule/ms/place`,
            jData(body),
            { headers: kotakHeaders(), timeout: 8000 }
        );

        if (res.data?.stat === "Ok" && res.data?.nOrdNo) {
            logger.info(`✅ Kotak SL-M Order Placed: ${res.data.nOrdNo}`);
            return res.data.nOrdNo;
        } else {
            logger.error(`❌ Kotak SL-M Failed: ${JSON.stringify(res.data)}`);
            return null;
        }

    } catch (err) {
        const errorMsg = err.response?.data ? JSON.stringify(err.response.data) : err.message;
        logger.error(`❌ Kotak SL-M Error: ${errorMsg}`);
        return null;
    }
}

// ─────────────────────────────────────────────────────
// PLACE TARGET LIMIT ORDER (Kotak)
// ─────────────────────────────────────────────────────
async function placeLimitOrder(jwtToken, symbol, token, price, transactionType = "SELL", qty = LOT_SIZE) {

    try {
        const marketOpen = isMarketOpen();

        const body = {
            am: marketOpen ? "NO" : "YES",
            dq: "0",
            es: "bse_fo",
            mp: "0",
            pc: "NRML",
            pf: "N",
            pr: String(price),
            pt: "L",
            qt: String(qty),
            rt: "DAY",
            tp: "0",
            ts: symbol,
            tt: transactionType === "SELL" ? "S" : "B"
        };

        const res = await axios.post(
            `${BASE_URL}/quick/order/rule/ms/place`,
            jData(body),
            { headers: kotakHeaders(), timeout: 8000 }
        );

        if (res.data?.stat === "Ok" && res.data?.nOrdNo) {
            logger.info(`✅ Kotak Target Limit Placed: ${res.data.nOrdNo}`);
            return res.data.nOrdNo;
        } else {
            logger.error(`❌ Kotak Target Limit Failed: ${JSON.stringify(res.data)}`);
            return null;
        }

    } catch (err) {
        const errorMsg = err.response?.data ? JSON.stringify(err.response.data) : err.message;
        logger.error(`❌ Kotak Target Limit Error: ${errorMsg}`);
        return null;
    }
}

// ─────────────────────────────────────────────────────
// GET OPEN POSITIONS (Kotak)
// ─────────────────────────────────────────────────────
export async function getPositions(jwtToken) {

    try {

        const res = await axios.get(
            `${BASE_URL}/quick/user/positions`,
            { headers: kotakHeaders(), timeout: 8000 }
        );

        return res.data?.data ?? [];

    } catch (err) {

        logger.error(`❌ Kotak GetPositions Error: ${err.message}`);
        return [];
    }
}

// ─────────────────────────────────────────────────────
// GET ORDER BOOK (Kotak)
// ─────────────────────────────────────────────────────
async function getOrderBook(jwtToken) {

    try {

        const res = await axios.get(
            `${BASE_URL}/quick/user/orders`,
            { headers: kotakHeaders(), timeout: 8000 }
        );

        return res.data?.data ?? [];

    } catch (err) {

        logger.error(`❌ Kotak GetOrderBook Error: ${err.message}`);
        return [];
    }
}

// ─────────────────────────────────────────────────────
// CANCEL ORDER (Kotak)
// ─────────────────────────────────────────────────────
async function cancelOrder(jwtToken, variety, orderId) {

    try {
        const marketOpen = isMarketOpen();


        const body = {
            on: orderId,
            am: marketOpen ? "NO" : "YES",
        };

        const res = await axios.post(
            `${BASE_URL}/quick/order/cancel`,
            jData(body),
            { headers: kotakHeaders() }
        );

        logger.info(`✅ Kotak Order Cancelled: ${orderId}`);
        return true;

    } catch (err) {
        if (err.response?.status === 400) {
            // Silently return false without logging. Kotak often locks AMO orders off-hours
            // resulting in un-cancellable 400 errors. Logging them spams the console.
            return false;
        }
        logger.error(`❌ Kotak Order Cancel Error: ${err.message}`);
        return false;
    }
}

// ─────────────────────────────────────────────────────
// MARKET EXIT POSITION (Kotak)
// ─────────────────────────────────────────────────────
export async function marketExit(jwtToken, symbol) {

    try {

        const positions = await getPositions(jwtToken);

        const p = positions.find(pos => pos.trdSym === symbol && parseInt(pos.qty) !== 0);

        if (!p) {
            logger.warn(`⚠ marketExit: No active position found`);
            await cleanupOrders(jwtToken, symbol);
            return false;
        }

        const qty = Math.abs(parseInt(p.qty));
        const marketOpen = isMarketOpen();

        const body = {
            am: marketOpen ? "NO" : "YES",
            dq: "0",
            es: p.exSeg || "bse_fo",
            mp: "0",
            pc: p.prod || "NRML",
            pf: "N",
            pr: "0",
            pt: "MKT", // Kotak exit orders can often be MKT if limit price is unknown
            qt: String(qty),
            rt: "DAY",
            tp: "0",
            ts: symbol,
            tt: parseInt(p.qty) > 0 ? "S" : "B"
        };

        const res = await axios.post(
            `${BASE_URL}/quick/order/rule/ms/place`,
            jData(body),
            { headers: kotakHeaders() }
        );

        if (res.data?.stat === "Ok" && res.data?.nOrdNo) {
            logger.info(`✅ Kotak Market Exit Placed: ${res.data.nOrdNo}`);
            await cleanupOrders(jwtToken, symbol);
            return true;
        }

        return false;

    } catch (err) {

        logger.error(`❌ Kotak Market Exit Error: ${err.message}`);
        return false;
    }
}

// ─────────────────────────────────────────────────────
// CLEANUP PENDING ORDERS
// ─────────────────────────────────────────────────────
export async function cleanupOrders(jwtToken, symbol) {

    const orders = await getOrderBook(jwtToken);

    const pendingOrders = orders.filter(o =>
        o.trdSym === symbol &&
        // o.tt === "S" && // Only clean up pending SELL orders (SL & Targets)
        ["open", "pending", "trigger pending", "after market order req received"].includes(String(o.ordSt).toLowerCase())
    );

    if (pendingOrders.length > 0) {

        logger.info(`🧹 Cleaning ${pendingOrders.length} pending orders`);

        for (const o of pendingOrders) {
            logger.debug(`Cancelling order ${o.nOrdNo}...`); // Downgraded to debug to reduce spam
            await cancelOrder(jwtToken, "NORMAL", o.nOrdNo);
            await sleep(800);
        }
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

            let finalExitPrice = NaN;
            try {
                const orders = await getOrderBook(jwtToken);
                // Filter all orders for this symbol (any side — SL-M exit could show as BUY or SELL depending on direction)
                const symOrders = orders.filter(o => o.trdSym === symbol);
                const FILLED_STATUSES = ["traded", "complete", "filled", "executed", "f", "s"];
                const ex = symOrders.find(o =>
                    FILLED_STATUSES.includes(String(o.ordSt).toLowerCase()) &&
                    (o.tt === "S" || o.tt === "s")  // must be a SELL to close long position
                );

                if (ex) {
                    finalExitPrice = extractExecPrice(ex);
                    if (isNaN(finalExitPrice) || finalExitPrice === 0) {
                        logger.warn(`⚠ (Index triggered) Found executed order but exit price was 0 or NaN. Order dump: ${JSON.stringify(ex)}`);
                    }
                } else {
                    // Log ALL symbol orders so we can see what statuses/fields Kotak is actually sending
                    // logger.warn(`⚠ (Index triggered) No filled SELL order found for ${symbol}. All orders for symbol: ${JSON.stringify(symOrders.map(o => ({ ordSt: o.ordSt, tt: o.tt, avgExePrc: o.avgExePrc, avgPrc: o.avgPrc, flPr: o.flPr, prc: o.prc })))}`);
                }
            } catch (e) {
                logger.error(`❌ Error fetching orderbook for index-triggered exit price extraction: ${e.message}`);
            }

            return { exited: true, exitPrice: finalExitPrice };
        }
    }

    // 2. Check current positions (if option-level SL/TGT was hit instead)
    const positions = await getPositions(jwtToken);
    const existing = positions.find(p => p.trdSym === symbol && parseInt(p.qty) !== 0);

    // If netqty is 0 (or position doesn't exist), broker's SL-M or Target order has already filled.
    // Return true so the caller (handleLiveExit / polling loop) triggers onTradeExit() correctly.
    if (!existing) {
        let finalExitPrice = NaN;
        try {
            const orders = await getOrderBook(jwtToken);
            const symOrders = orders.filter(o => o.trdSym === symbol);
            const FILLED_STATUSES = ["traded", "complete", "filled", "executed", "f", "s"];
            const ex = symOrders.find(o =>
                FILLED_STATUSES.includes(String(o.ordSt).toLowerCase()) &&
                (o.tt === "S" || o.tt === "s")  // SELL to close long
            );

            if (ex) {
                finalExitPrice = extractExecPrice(ex);
                if (isNaN(finalExitPrice) || finalExitPrice === 0) {
                    logger.warn(`⚠ Found executed order but exit price was 0 or NaN. Order dump: ${JSON.stringify(ex)}`);
                }
            } else {
                // Log all orders for this symbol so we can see what statuses/fields Kotak sends
                // logger.warn(`⚠ No filled SELL order found for ${symbol}. All orders for symbol: ${JSON.stringify(symOrders.map(o => ({ ordSt: o.ordSt, tt: o.tt, avgExePrc: o.avgExePrc, avgPrc: o.avgPrc, flPr: o.flPr, prc: o.prc })))}`);
            }
        } catch (e) {
            logger.error(`❌ Error fetching orderbook for exit price extraction: ${e.message}`);
        }

        await cleanupOrders(jwtToken, symbol);
        return { exited: true, exitPrice: finalExitPrice };   // ✅ FIX: broker exit detected → triggers onTradeExit → unlocks _tradeLock
    }

    return false;
}


export async function executeOrder(jwt, signal) {
    const { signal: type, optionToken, optionSymbol, optionLTP } = signal;

    if (!optionToken || optionLTP == null) {
        logger.warn("⚠ executeOrder: missing token or LTP — skipping order");
        return;
    }

    const symbol = optionSymbol;

    // ── First, clean up any old pending orders for this symbol
    await cleanupOrders(jwt, symbol);
    await sleep(500); // Wait after cleanup before checking positions

    // ── Check if already in a position for this symbol
    const positions = await getPositions(jwt);
    const existing = positions.find(p => p.trdSym === symbol && parseInt(p.qty) !== 0);

    if (existing) {
        logger.warn(`⚠ executeOrder: Already in position for ${symbol} (Qty: ${existing.qty}) — skipping entry`);
        return;
    }

    // ── Calculate Option SL & Target (Prioritize pre-calculated model points)
    const slPts = parseFloat(signal.optionSL ?? signal.slPoints);
    const tgtPts = parseFloat(signal.optionTarget ?? signal.tgtPoints);

    const optionSL = parseFloat(Math.max(0.1, optionLTP - slPts).toFixed(1));
    const optionTarget = parseFloat(Math.max(0.1, optionLTP + tgtPts).toFixed(1));

    logger.info(`📐 Simplified Option Levels | LTP:${optionLTP} | SL:${optionSL} (pts:${slPts}) | TGT:${optionTarget} (pts:${tgtPts})`);

    // Entry is always BUY (long options: CE or PE)
    const transactionType = "BUY";
    const exitType = "SELL";  // exit long position

    // Kotak rejects MKT orders off-hours. Calculate a limit buffer price just in case:
    const limitPrice = parseFloat((optionLTP * 1.01).toFixed(1));

    // 1️⃣ Place entry BUY
    const orderNo = await placeRegularOrder(jwt, symbol, optionToken, transactionType, limitPrice, LOT_SIZE);
    if (!orderNo) {
        logger.error("❌ Kotak Entry order failed — skipping SL/TGT creation");
        return;
    }

    await sleep(500);

    // 2️⃣ Place SL-M Order (SELL to exit long)
    const slOrderId = await placeStopLossOrder(jwt, symbol, optionToken, optionSL, exitType, LOT_SIZE);

    await sleep(500);

    // 3️⃣ Place Target Limit Order (SELL to exit long)
    const tgtOrderId = await placeLimitOrder(jwt, symbol, optionToken, optionTarget, exitType, LOT_SIZE);

    return { orderNo, slOrderId, tgtOrderId, optionSL, optionTarget };
}