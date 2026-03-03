// ─────────────────────────────────────────
// EMA
// FIX #10 — Seed with SMA of first `period` candles (not data[0].close)
//           Eliminates EMA distortion on short daily arrays
// ─────────────────────────────────────────
export function calculateEMA(data, period = 20) {
    if (!data || data.length < period) return Array(data?.length || 0).fill(null);

    const k = 2 / (period + 1);

    // ✅ SMA seed over first `period` candles
    let ema = data.slice(0, period).reduce((sum, c) => sum + c.close, 0) / period;

    const result = Array(period - 1).fill(null);
    result.push(ema);

    for (let i = period; i < data.length; i++) {
        ema = data[i].close * k + ema * (1 - k);
        result.push(ema);
    }

    return result;
}

// ─────────────────────────────────────────
// RSI(14)
// FIX #4 — Accepts `warnings[]`; pushes "RSI_FALLBACK" when data too short
// ─────────────────────────────────────────
export function calculateRSI(data, period = 14, warnings = []) {
    const n = data.length;
    if (n < period + 1) {
        warnings.push("RSI_FALLBACK");
        return Array(n).fill(50);
    }

    const result = Array(period).fill(50);
    let avgGain = 0, avgLoss = 0;

    for (let i = 1; i <= period; i++) {
        const diff = data[i].close - data[i - 1].close;
        if (diff > 0) avgGain += diff;
        else avgLoss -= diff;
    }
    avgGain /= period;
    avgLoss /= period;

    const toRSI = (g, l) => l === 0 ? 100 : 100 - 100 / (1 + g / l);
    result.push(toRSI(avgGain, avgLoss));

    for (let i = period + 1; i < n; i++) {
        const diff = data[i].close - data[i - 1].close;
        avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
        avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
        result.push(toRSI(avgGain, avgLoss));
    }
    return result;
}

// ─────────────────────────────────────────
// ATR(14) — Wilder's smoothing
// FIX #3 — Returns null array when data insufficient (no hardcoded 80 fallback)
// ─────────────────────────────────────────
export function calculateATR(data, period = 14, warnings = []) {
    const n = data.length;
    if (n < period + 1) {
        warnings.push("ATR_FALLBACK");
        return Array(n).fill(null); // ✅ null — caller must gate on this
    }

    const tr = data.map((c, i) =>
        i === 0
            ? c.high - c.low
            : Math.max(
                c.high - c.low,
                Math.abs(c.high - data[i - 1].close),
                Math.abs(c.low - data[i - 1].close)
            )
    );

    const result = Array(period).fill(null);
    let atr = tr.slice(0, period).reduce((s, v) => s + v, 0) / period;
    result.push(atr);

    for (let i = period; i < n; i++) {
        atr = (atr * (period - 1) + tr[i]) / period;
        result.push(atr);
    }
    return result;
}

// ─────────────────────────────────────────
// ADX(14) — Wilder's smoothing
// FIX #5 — Returns null-filled array when data < 2*period+1
//           null (not 0) lets caller distinguish "no data" from "flat trend"
// ─────────────────────────────────────────
export function calculateADX(data, period = 14, warnings = []) {
    const n = data.length;
    const minRequired = 2 * period + 1;

    if (n < minRequired) {
        warnings.push("ADX_SHORT");
        return new Array(n).fill(null); // ✅ null, not 0
    }

    const result = new Array(n).fill(null);
    const tr = [], pdm = [], mdm = [];

    for (let i = 1; i < n; i++) {
        const up = data[i].high - data[i - 1].high;
        const dn = data[i - 1].low - data[i].low;
        pdm.push(up > dn && up > 0 ? up : 0);
        mdm.push(dn > up && dn > 0 ? dn : 0);
        tr.push(Math.max(
            data[i].high - data[i].low,
            Math.abs(data[i].high - data[i - 1].close),
            Math.abs(data[i].low - data[i - 1].close)
        ));
    }

    let sTR = tr.slice(0, period).reduce((a, b) => a + b, 0);
    let sPDM = pdm.slice(0, period).reduce((a, b) => a + b, 0);
    let sMDM = mdm.slice(0, period).reduce((a, b) => a + b, 0);

    const dx = [];
    const toDX = () => {
        if (sTR === 0) return 0;
        const pdi = sPDM / sTR * 100;
        const mdi = sMDM / sTR * 100;
        return (pdi + mdi) === 0 ? 0 : Math.abs(pdi - mdi) / (pdi + mdi) * 100;
    };
    dx.push(toDX());

    for (let i = period; i < tr.length; i++) {
        sTR = sTR - sTR / period + tr[i];
        sPDM = sPDM - sPDM / period + pdm[i];
        sMDM = sMDM - sMDM / period + mdm[i];
        dx.push(toDX());
    }

    let adx = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
    result[2 * period - 1] = adx;

    for (let i = period; i < dx.length; i++) {
        adx = (adx * (period - 1) + dx[i]) / period;
        result[2 * period + (i - period)] = adx;
    }

    return result;
}

// ─────────────────────────────────────────
// SWING S/R — unchanged
// ─────────────────────────────────────────
export function findSupportResistance(data, window = 8) {
    const supports = [], resistances = [];
    for (let i = window; i < data.length - window; i++) {
        let isSupport = true, isResistance = true;
        for (let j = i - window; j <= i + window; j++) {
            if (data[j].low < data[i].low) isSupport = false;
            if (data[j].high > data[i].high) isResistance = false;
        }
        if (isSupport) supports.push(data[i].low);
        if (isResistance) resistances.push(data[i].high);
    }
    return { supports, resistances };
}

// ─────────────────────────────────────────
// STRONG SWING PIVOTS
// Only keeps pivots where the post-pivot reaction > ATR * 1.2
// Eliminates weak pivots that didn't cause real moves
// ─────────────────────────────────────────
export function findStrongPivots(data, window = 8, atr = 0) {

    const supports = [];
    const resistances = [];

    if (!data || data.length < window * 2 + 5) {
        return { supports, resistances };
    }

    const minReaction = atr * 1.2;

    for (let i = window; i < data.length - window - 5; i++) {

        let isSupport = true;
        let isResistance = true;

        // ── Swing Detection ──
        for (let j = i - window; j <= i + window; j++) {
            if (data[j].low < data[i].low) isSupport = false;
            if (data[j].high > data[i].high) isResistance = false;
        }

        // ── Volume at pivot ──
        const pivotVolume = data[i].volume ?? 0;
        const avgVol = (
            data.slice(i - 5, i)
                .reduce((sum, c) => sum + (c.volume ?? 0), 0) / 5
        );

        const volumeSpikeAtPivot = pivotVolume > avgVol * 1.2;

        // ────────────────────────────────
        // SUPPORT LOGIC
        // ────────────────────────────────
        if (isSupport) {

            // Reaction measured only using NEXT 5 candles
            const postData = data.slice(i + 1, i + 6);
            const postHigh = Math.max(...postData.map(c => c.high ?? 0));

            const reaction = postHigh - data[i].low;

            if (reaction > minReaction) {

                let score = 1;

                if (volumeSpikeAtPivot) score += 1;
                if (reaction > atr * 1.8) score += 1;

                supports.push({
                    price: data[i].low,
                    strength: score
                });
            }
        }

        // ────────────────────────────────
        // RESISTANCE LOGIC
        // ────────────────────────────────
        if (isResistance) {

            const postData = data.slice(i + 1, i + 6);
            const postLow = Math.min(...postData.map(c => c.low ?? Infinity));

            const reaction = data[i].high - postLow;

            if (reaction > minReaction) {

                let score = 1;

                if (volumeSpikeAtPivot) score += 1;
                if (reaction > atr * 1.8) score += 1;

                resistances.push({
                    price: data[i].high,
                    strength: score
                });
            }
        }
    }

    return { supports, resistances };
}

// ─────────────────────────────────────────
// S/R LEVEL STRENGTH SCORING
// Keeps only levels that appear clustered >= minTouches times
// Higher touch count = stronger institutional zone
// ─────────────────────────────────────────
export function getLevelStrength(levels, threshold = 30, minTouches = 2) {
    return levels
        .map(level => {
            const touches = levels.filter(l => Math.abs(l - level) < threshold).length;
            return { level, strength: touches };
        })
        .filter(l => l.strength >= minTouches)
        .map(l => l.level);
}


// ─────────────────────────────────────────
// ROUND LEVELS — unchanged
// ─────────────────────────────────────────
export function getRoundLevels(price, step = 500) {
    const base = Math.floor(price / step) * step;
    return [base - step, base, base + step, base + step * 2];
}

// ─────────────────────────────────────────
// CLEAN LEVELS — unchanged
// ─────────────────────────────────────────
export function cleanLevels(levels, threshold = 20) {
    levels.sort((a, b) => a - b);
    return levels.reduce((acc, lvl) => {
        if (acc.length === 0 || Math.abs(lvl - acc[acc.length - 1]) > threshold)
            acc.push(lvl);
        return acc;
    }, []);
}

export function clusterLevels(levels, atr) {
    if (!levels.length) return [];

    const sorted = levels.sort((a, b) => a.price - b.price);
    const clustered = [];

    const threshold = atr * 0.6; // merge if within 0.6 ATR

    let currentCluster = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
        const prev = currentCluster[currentCluster.length - 1];
        const curr = sorted[i];

        if (Math.abs(curr.price - prev.price) <= threshold) {
            currentCluster.push(curr);
        } else {
            // push strongest in cluster
            clustered.push(
                currentCluster.reduce((a, b) =>
                    b.strength > a.strength ? b : a
                )
            );
            currentCluster = [curr];
        }
    }

    // push last cluster
    clustered.push(
        currentCluster.reduce((a, b) =>
            b.strength > a.strength ? b : a
        )
    );

    return clustered;
}

// ─────────────────────────────────────────
// VOLUME SPIKE
// FIX #2 — Threshold 1.1× → 1.5× for genuine spike detection
// ─────────────────────────────────────────
export function volumeSpike(data, index) {
    if (index < 10) return false;
    const avg = data.slice(index - 10, index).reduce((s, c) => s + c.volume, 0) / 10;
    return data[index].volume > avg * 1.5; // ✅ 150% — real spike, not noise
}

// ─────────────────────────────────────────
// OI CLASSIFICATION — unchanged
// ─────────────────────────────────────────
export function classifyOI(last, prev) {
    if (!last || !prev) {
        return {
            longBuildup: false,
            shortBuildup: false,
            shortCovering: false,
            longUnwinding: false,
            callOi: false,
            putOi: false
        };
    }

    const priceChange = last.close - prev.close;
    const oiChange = (last.oi ?? 0) - (prev.oi ?? 0);

    const longBuildup = priceChange > 0 && oiChange > 0;
    const shortBuildup = priceChange < 0 && oiChange > 0;
    const shortCovering = priceChange > 0 && oiChange < 0;
    const longUnwinding = priceChange < 0 && oiChange < 0;

    return {
        longBuildup,
        shortBuildup,
        shortCovering,
        longUnwinding,
        callOi: longBuildup || shortCovering,
        putOi: shortBuildup || longUnwinding
    };
}