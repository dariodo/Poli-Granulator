/**
 * @file limiter.js
 * @description Peak limiter with look-ahead and 2x true-peak estimation.
 *   Uses linear upsampling for inter-sample peak detection.
 *   Designed for use in AudioWorklet but platform-agnostic.
 */

'use strict';

/** dBFS helper */
export function toDb(x) {
  return (x <= 0) ? -Infinity : 20 * Math.log10(x);
}

/** Sanitize samples: handles NaN/Infinity/denormals and clamps runaway values */
function sanitizeSample(x) {
  if (!Number.isFinite(x)) return 0;
  const ax = Math.abs(x);
  if (ax < 1e-24) return 0;               // flush denormals
  if (ax > 1e6) return Math.sign(x) * 1e6; // clamp runaway
  return x;
}

function sanitizeBlock(l, r) {
  const N = l.length;
  for (let i = 0; i < N; i++) {
    l[i] = sanitizeSample(l[i]);
    r[i] = sanitizeSample(r[i]);
  }
}

/**
 * Create limiter state object.
 * @param {number} sampleRate
 * @param {object} [opts]
 * @param {number} [opts.lookaheadMs=3]   Look-ahead in milliseconds (~3 ms recommended)
 * @param {number} [opts.ceiling=0.98]    Maximum output level (linear) after trim
 * @param {number} [opts.releaseMs=50]    Gain release time (ms)
 * @param {number} [opts.masterTrim=0.80] Pre-limiter trim (headroom)
 * @param {number} [opts.extra=256]       Extra margin for ring buffer
 */
export function createLimiter(sampleRate, opts = {}) {
  const lookaheadMs = opts.lookaheadMs ?? 3;
  const lookahead = Math.max(1, Math.floor(sampleRate * (lookaheadMs / 1000)));
  const extra = Math.max(64, opts.extra ?? 256);
  const releaseMs = Math.max(1, opts.releaseMs ?? 50);

  const state = {
    sr: sampleRate,
    lookahead,
    ceil: opts.ceiling ?? 0.98,
    trim: opts.masterTrim ?? 0.80,
    rel: Math.exp(-1 / (sampleRate * (releaseMs / 1000))),
    bufL: new Float32Array(lookahead + extra),
    bufR: new Float32Array(lookahead + extra),
    write: 0,
    env: 1.0,
    lastTpDb: -Infinity,
    lastGrDb: 0
  };
  return state;
}

/**
 * Estimate 2x true-peak using linear upsampling: checks original and midpoint samples.
 * @param {Float32Array} l
 * @param {Float32Array} r
 * @returns {number} Maximum peak (linear)
 */
export function truePeak2x(l, r) {
  let tp = 0;
  const N = l.length;
  for (let i = 0; i < N - 1; i++) {
    const l0 = l[i], l1 = l[i + 1];
    const r0 = r[i], r1 = r[i + 1];
    // original samples
    const a0 = Math.max(Math.abs(l0), Math.abs(r0));
    const a1 = Math.max(Math.abs(l1), Math.abs(r1));
    // midpoint (2x linear upsample)
    const li = 0.5 * (l0 + l1);
    const ri = 0.5 * (r0 + r1);
    const ai = Math.max(Math.abs(li), Math.abs(ri));
    const m = Math.max(a0, a1, ai);
    if (m > tp) tp = m;
  }
  // edge case: single sample buffer
  if (N === 1) {
    tp = Math.max(Math.abs(l[0]), Math.abs(r[0]));
  }
  return tp;
}

/**
 * Apply master trim + limiter to the block (in-place).
 * Returns telemetry useful for UI.
 * @param {ReturnType<typeof createLimiter>} s
 * @param {Float32Array} outL
 * @param {Float32Array} outR
 * @returns {{tpDb:number, grDb:number, peakIn:number, peakOut:number}}
 */
export function processLimiter(s, outL, outR) {
  const N = outL.length;

  // (0) Sanitize block
  sanitizeBlock(outL, outR);

  // (0.1) Ring size safety: reallocate if necessary
  const need = s.lookahead + Math.max(N, 64);
  if (s.bufL.length < need) {
    const oldLen = s.bufL.length;
    const newLen = Math.max(need, oldLen * 2);
    const newL = new Float32Array(newLen);
    const newR = new Float32Array(newLen);
    // minimal circular copy preserving most recent content
    for (let i = 0; i < oldLen; i++) {
      newL[i] = s.bufL[(s.write + i) % oldLen];
      newR[i] = s.bufR[(s.write + i) % oldLen];
    }
    s.bufL = newL; s.bufR = newR;
    s.write = 0;
  }

  // 1) Master trim (architectural headroom)
  const trim = s.trim;
  if (trim !== 1) {
    for (let i = 0; i < N; i++) { outL[i] *= trim; outR[i] *= trim; }
  }

  // 2) 2x True-peak (on sanitized data)
  const tp = truePeak2x(outL, outR);
  const ceil = Math.max(0.1, Math.min(1.0, s.ceil)); // defensive clamp
  const needed = tp > 1e-12 ? Math.min(1, ceil / tp) : 1;

  // 3) Write to ring buffer
  for (let i = 0; i < N; i++) {
    s.bufL[s.write] = outL[i];
    s.bufR[s.write] = outR[i];
    s.write = (s.write + 1) % s.bufL.length;
  }

  // 4) Update envelope: instant attack (catch), exponential release
  if (needed < s.env) s.env = needed;            // immediate catch
  else s.env = 1 - (1 - s.env) * s.rel;          // smooth release

  // 5) Apply envelope to samples with look-ahead
  let read = (s.write - s.lookahead + s.bufL.length) % s.bufL.length;
  const env = Number.isFinite(s.env) ? s.env : 1;
  for (let i = 0; i < N; i++) {
    const xL = s.bufL[read];
    const xR = s.bufR[read];
    outL[i] = xL * env;
    outR[i] = xR * env;
    read = (read + 1) % s.bufL.length;
  }

  // 6) Telemetry
  const peakOut = tp * env;
  s.lastTpDb = toDb(peakOut);
  s.lastGrDb = toDb(env); // negative when env < 1

  return { tpDb: s.lastTpDb, grDb: s.lastGrDb, peakIn: tp, peakOut };
}

/** Reset limiter state (optional) */
export function resetLimiter(s) {
  s.write = 0;
  s.env = 1.0;
  s.lastTpDb = -Infinity;
  s.lastGrDb = 0;
  s.bufL.fill(0);
  s.bufR.fill(0);
}
