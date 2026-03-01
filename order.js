import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const BASE_URL = "https://developer.paytmmoney.com";
const GTT_URL = `${BASE_URL}/gtt/v2/gtt`;
const TOKEN_FILE = "./.paytm_token";

// ─────────────────────────────────────────────────────
// ACCESS TOKEN  (cached — REQUEST_TOKEN is one-time use)
// ─────────────────────────────────────────────────────
let _pmJwt = null;

export async function generateAccessToken() {
    if (_pmJwt) return _pmJwt;

    // 1️⃣ Load from file written by paytmLogin.js (preferred)
    if (fs.existsSync(TOKEN_FILE)) {
        _pmJwt = fs.readFileSync(TOKEN_FILE, "utf-8").trim();
        console.log("✅ Paytm Money Token loaded from file");
        return _pmJwt;
    }

    // 2️⃣ Fallback: exchange REQUEST_TOKEN (one-time use)
    try {
        const res = await axios.post(
            `${BASE_URL}/accounts/v2/gettoken`,
            {
                api_key: process.env.P_API_KEY,
                api_secret_key: process.env.P_API_SECRET,
                request_token: process.env.REQUEST_TOKEN
            },
            { headers: { "Content-Type": "application/json" } }
        );
        _pmJwt = res.data.access_token;
        console.log("✅ Paytm Money Token Generated (via REQUEST_TOKEN)");
        return _pmJwt;
    } catch (err) {
        console.log("❌ Token Error:", err.response?.data || err.message);
    }
}

// ─────────────────────────────────────────────────────
// PLACE REGULAR MKT ORDER  (entry BUY)
// ─────────────────────────────────────────────────────
async function placeRegularOrder(jwtToken, token, qty = 20) {
    const ist = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const mins = ist.getHours() * 60 + ist.getMinutes();
    const isOpen = mins >= 555 && mins <= 930;

    if (!isOpen) {
        console.log("⛔ Derivative orders not allowed after market hours — skipping entry");
        return null;
    }

    try {
        const res = await axios.post(
            `${BASE_URL}/orders/v1/place`,         // ✅ correct endpoint
            {
                source: "N",
                txn_type: "B",
                exchange: "BSE",
                segment: "D",
                product: "I",
                security_id: String(token),
                quantity: String(qty),
                validity: "DAY",
                order_type: "MKT",
                price: "0",
                order_ltp: "0",
                mkt_type: "NL",
                off_mkt_flag: false
            },
            {
                headers: {
                    "x-jwt-token": jwtToken,
                    "Content-Type": "application/json"
                }
            }
        );
        console.log("🟢 Entry Order Placed:", res.data);
        return res.data.order_no;
    } catch (err) {
        console.log("❌ Entry Order | Status:", err.response?.status);
        console.log("❌ Entry Order | Data  :", JSON.stringify(err.response?.data));
    }
}

// ─────────────────────────────────────────────────────
// GET ALL ACTIVE GTTs
// ─────────────────────────────────────────────────────
async function getAllGTT(jwtToken) {
    try {
        const res = await axios.get(GTT_URL, {
            headers: { "x-jwt-token": jwtToken }
        });
        return res.data ?? [];
    } catch (err) {
        console.log("❌ Get GTT Error:", err.response?.data || err.message);
        return [];
    }
}

// ─────────────────────────────────────────────────────
// DELETE GTT
// ─────────────────────────────────────────────────────
async function deleteGTT(jwtToken, gttId) {
    try {
        const res = await axios.delete(`${BASE_URL}/gtt/v1/gtt/${gttId}`, {  // v1 for delete
            headers: { "x-jwt-token": jwtToken }
        });
        console.log(`🗑 GTT ${gttId} deleted:`, res.data);
    } catch (err) {
        console.log("❌ Delete GTT Error:", err.response?.data || err.message);
    }
}

// ─────────────────────────────────────────────────────
// CREATE GTT OCO  (STOPLOSS + TARGET)
// ─────────────────────────────────────────────────────
// optionSL / optionTarget are MOVE values from calculateOptionLevels
// Absolute prices:  SL  = ltp - slMove
//                   TGT = ltp + tgtMove
async function createGTTOCO(jwtToken, { optionToken, optionLTP, optionSL, optionTarget }, qty = 20) {
    const slPrice = parseFloat((optionLTP - optionSL).toFixed(2));
    const tgtPrice = parseFloat((optionLTP + optionTarget).toFixed(2));
    // SL limit slightly below trigger (~2% buffer) so fast moves still fill
    const slLimit = parseFloat((slPrice * 0.98).toFixed(2));

    console.log(`📐 GTT OCO | LTP:${optionLTP}  SL trigger:${slPrice} limit:${slLimit}  TGT:${tgtPrice}`);

    try {
        const res = await axios.post(
            GTT_URL,
            {
                segment: "D",
                exchange: "BSE",
                security_id: String(optionToken),
                product_type: "M",        // Margin (derivatives)
                set_price: String(optionLTP),
                transaction_type: "S",         // SELL to exit
                trigger_type: "OCO",
                transaction_details: [
                    {
                        sub_type: "STOPLOSS",
                        quantity: String(qty),
                        trigger_price: String(slPrice),
                        limit_price: String(slLimit),   // LMT ~2% below trigger
                        order_type: "LMT"
                    },
                    {
                        sub_type: "TARGET",
                        quantity: String(qty),
                        trigger_price: String(tgtPrice),
                        limit_price: String(tgtPrice),
                        order_type: "LMT"
                    }
                ]
            },
            {
                headers: {
                    "x-jwt-token": jwtToken,
                    "Content-Type": "application/json"
                }
            }
        );
        console.log("✅ GTT OCO Created:", res.data);
        return res.data?.id;
    } catch (err) {
        console.log("❌ GTT Create Error:", err.response?.data || err.message);
    }
}

// ─────────────────────────────────────────────────────
// MAIN ORDER ORCHESTRATOR
// ─────────────────────────────────────────────────────
// Flow:
//  1. Get Paytm Money JWT
//  2. Cancel existing ACTIVE GTT on this token (if any)
//  3. Place regular MKT BUY (entry)
//  4. Create GTT OCO (STOPLOSS + TARGET exit)
export async function executeOrder(_unusedJwt, signal) {
    const { optionToken, optionLTP, optionSL, optionTarget } = signal;

    if (!optionToken || optionLTP == null) {
        console.log("⚠ executeOrder: missing token or LTP — skipping order");
        return;
    }

    // 0️⃣  Paytm Money JWT
    const pmJwt = await generateAccessToken();
    if (!pmJwt) {
        console.log("❌ executeOrder: could not get Paytm Money token — skipping order");
        return;
    }

    // 1️⃣  Cancel any existing active GTT on this token
    const allGTTs = await getAllGTT(pmJwt);
    const gttList = Array.isArray(allGTTs) ? allGTTs
        : Array.isArray(allGTTs?.data) ? allGTTs.data
            : [];
    const existing = gttList.filter(g =>
        String(g.security_id) === String(optionToken) &&
        ["ACTIVE", "CREATED"].includes((g.status ?? "").toUpperCase())
    );

    for (const g of existing) {
        console.log(`🔄 Cancelling existing GTT ${g.id} for token ${optionToken}`);
        await deleteGTT(pmJwt, g.id);
    }

    if (existing.length) await new Promise(r => setTimeout(r, 1000));

    // 2️⃣  Place entry BUY
    const orderNo = await placeRegularOrder(pmJwt, optionToken);
    if (!orderNo) {
        console.log("❌ Entry order failed — skipping GTT creation");
        return;
    }

    // small wait for entry to register
    await new Promise(r => setTimeout(r, 1500));

    // 3️⃣  Create GTT OCO for exit management
    const gttId = await createGTTOCO(pmJwt, {
        optionToken,
        optionLTP,
        optionSL: optionSL ?? 10,
        optionTarget: optionTarget ?? 20,
    });

    if (gttId) console.log(`✅ GTT OCO active: ${gttId}`);

    return { orderNo, gttId };
}
