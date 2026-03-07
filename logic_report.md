# Trading Bot Logic & Architecture Report

## 1. System Overview

The system is an automated options trading bot for the Indian Stock Market (specifically targeting indices like SENSEX via the AngelOne API). It operates on a multi-timeframe analysis (1m, 5m, 15m, 1D), evaluating momentum, trend structure, indicator filtering, and risk management.

**Core Execution Flow:**

1. **Market Data Polling / WebSocket:** `main.js` continuously polls for new market data using a 15-second loop, with an optional WebSocket feed (`wsMarketFeed.js`) for faster tick-based exit monitoring.
2. **Entry Engine:** `entryEngine.js` orchestrates data fetching, caches historical data (Redis), passes it for indicator computation (via Worker Threads for performance), and fetches ATM (At-The-Money) option strikes.
3. **Signal Generation:** `signals.js` acts as the brain. It evaluates multi-timeframe conditions to determine if a Call (CE), Put (PE), or NO_TRADE signal should be generated.
4. **Risk Verification:** `riskEngine.js` validates that daily limits (max trades, daily loss, drawdown) are not breached.
5. **Order Execution:** `order.js` submits orders using the AngelOne API (Market Entry, Limit Target, Stop-Loss Market) and sends Telegram alerts.

---

## 2. Core Strategy Logic (`signals.js`)

The strategy relies on a stringent priority-based filtering system before taking trades.

### A. Pre-Trade Filters (Guards)

- **Time Filter:** Trades are only allowed between 09:18 IST and 15:00 IST (configurable via `TIME_START_MIN` and `TIME_END_MIN`), avoiding morning volatility and EOD (End of Day) traps.
- **Chop Filter:** The market is considered "choppy" and trades are blocked if `ADX < 18` and `RSI` is stuck between 45 and 55.
- **Low Volatility Guard:** Blocked if `ATR < 40` (configurable `ATR_MIN`).
- **Insufficient Data:** Evaluates data continuity across required timeframes.

### B. Analytical Components

- **Daily Bias (1D):** Evaluates trend based on a 20-period EMA.
  - If `price > EMA` and a **bullish** candle formed, bias is `BULLISH`.
  - If `price < EMA` and a **bearish** candle formed, bias is `BEARISH`.
  - If bias is `NEUTRAL`, no trades are taken.
- **Institutional Bias (VWAP):** CE trades require `price > VWAP`. PE trades require `price < VWAP`.
- **Trend & Momentum (5m):**
  - **Trend Direction:** Evaluated by observing Price versus 5m EMA.
  - **Trend Strength:** ADX(14) must be `>= 20`.
  - **Momentum:** RSI(14) `> 55` for Bullish setups, `< 45` for Bearish setups.
- **Structure (15m):** Confirms higher highs/higher lows (Bullish structure) or lower highs/lower lows (Bearish structure).
- **Breakout & Volume (1m):** Detects 1m micro-breakouts backed by strong bodies (body/range `> 60%`) and Volume Spikes (`> 1.5x` previous volume).
- **Gap Analysis:** Tracks gap-ups and gap-downs. Trades against a gap are guarded unless the gap gets filled intraday.

### C. Entry Setups

Signals are evaluated strictly for trend continuation:

- **Bullish Setup (CE):**
  - Daily Bias is `BULLISH`.
  - Trend is aligned (Up) and Strong (ADX `>= 20`, RSI `> 55`).
  - Structure aligns (15m HH/HL) and `Price > VWAP`.
  - Breakout confirmed by strong body, large expansion, and volume spike.
- **Bearish Setup (PE):**
  - Daily Bias is `BEARISH`.
  - Trend is aligned (Down) and Strong (ADX `>= 20`, RSI `< 45`).
  - Structure aligns (15m LH/LL) and `Price < VWAP`.
  - Breakdown confirmed by strong body, large expansion, and volume spike.

---

## 3. Risk Management (`riskEngine.js`)

State is persisted in `risk_state.json`, ensuring the system remains stable across restarts. The bot will automatically block new trades if any of the following occur:

1. **Max Daily Trades:** Hits the cap of 5 trades (parameter: `MAX_TRADES_PER_DAY`).
2. **Max Daily Loss:** Index net PnL drops below -2000 points (`MAX_DAILY_LOSS_PTS`).
3. **Max Drawdown:** Open PnL drops 3% or more below the daily peak PnL (`MAX_DRAWDOWN_PCT`).

**Dynamic Stop Loss (SL) and Targets (TGT)** are driven by the Average True Range (ATR):

- `Dynamic SL` = `ATR * 0.85` (Capped at 90 pts).
- `Dynamic TGT` = `ATR * 2.5` (Capped at 300 pts).
- _This provides a dynamic Risk-to-Reward ratio based on real-time volatility._

---

## 4. Execution Pipeline (`order.js` & `entryEngine.js`)

1. Once a valid index signal (CE/PE) is generated, `entryEngine.js` identifies the At-The-Money (ATM) strike price for the active option expiry.
2. It fetches the Option's LTP and maps the index-level SL and Target point differentials precisely to the option's specific price.
3. A Telegram notification is dispatched immediately highlighting the exact parameters of the incoming trade.
4. `order.js` executes a 3-leg action via AngelOne:
   - **Leg 1:** Regular Market `BUY` Order for the Option (Entry Strategy).
   - **Leg 2:** Stoploss-Market `SELL` Order at the calculated Option SL price.
   - **Leg 3:** Limit `SELL` Order at the calculated Option Target price.
5. Exit can be triggered physically by the broker limits hitting (Leg 2/3), via WebSocket dynamically if the Index hits the SL/Target levels first (`main.js` handleLiveExit), or forced End-of-Day exiting via order-book cleanup.
