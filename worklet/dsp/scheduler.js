/**
 * @file scheduler.js
 * @description Poisson-based grain scheduler and OLA (overlap-add) utilities.
 *   Provides exponentially-distributed inter-grain intervals to avoid
 *   periodic phase-locking artifacts, plus overlap estimation and autogain.
 */

'use strict';

/** Clamp helper */
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

/** Safe floor with upper limit to prevent overflow */
const INT_MAX = 0x7fffffff;
const safeFloor = (x) => Math.min(INT_MAX, Math.max(1, Math.floor(x)));

/**
 * Returns the number of frames until next grain spawn
 * using a Poisson process (exponential inter-arrival).
 * Avoids periodic patterns that sum in phase.
 *
 * @param {number} sampleRate
 * @param {number} density grains/sec (>= 1e-6)
 * @returns {number} frames (>=1)
 */
export function nextIntervalFramesPoisson(sampleRate, density) {
  const d = Math.max(1e-6, density || 0);
  const mean = sampleRate / d;
  const u = Math.random();                 // U ~ [0,1)
  const exp = -mean * Math.log(1 - u);     // exponential
  return safeFloor(exp);
}

/**
 * Uniform + jitter variant: useful when you want a fixed average rate
 * but with slight instability to avoid periodic peaks.
 *
 * @param {number} sampleRate
 * @param {number} density grains/sec
 * @param {number} jitter 0..1 (0 = fixed, 1 = +/-100%)
 * @returns {number} frames (>=1)
 */
export function nextIntervalFramesUniformJitter(sampleRate, density, jitter = 0.2) {
  const d = Math.max(1e-6, density || 0);
  const base = sampleRate / d;
  const j = clamp(jitter ?? 0.2, 0, 1);
  const span = base * j;
  // uniform in [base - span, base + span]
  const v = base + (Math.random() * 2 - 1) * span;
  return safeFloor(v);
}

/**
 * Estimate average number of overlapping grains (OLA)
 * Overlaps ~= density * (attack + release)
 *
 * @param {number} density grains/sec
 * @param {number} attack seconds
 * @param {number} release seconds
 * @returns {number} overlaps >= 1
 */
export function expectedOverlaps(density, attack, release) {
  const d = Math.max(1e-6, density || 0);
  const dur = Math.max(0.002, (attack || 0) + (release || 0));
  return Math.max(1, d * dur);
}

/**
 * OLA-aware autogain: compensates level based on expected overlap count.
 * curve = 'sqrt' uses 1/sqrt(ov) (musical); curve = 'linear' uses 1/ov (flatter).
 *
 * @param {number} density
 * @param {number} attack
 * @param {number} release
 * @param {'sqrt'|'linear'} curve
 * @returns {number} compensation factor
 */
export function autogainFromOLA(density, attack, release, curve = 'sqrt') {
  const ov = expectedOverlaps(density, attack, release);
  if (curve === 'linear') return 1 / ov;
  return 1 / Math.sqrt(ov);
}

/**
 * Generate a small sequence of Poisson intervals (for debug/testing)
 * @param {number} sampleRate
 * @param {number} density
 * @param {number} n how many intervals
 * @returns {Int32Array}
 */
export function poissonSequence(sampleRate, density, n = 8) {
  const out = new Int32Array(Math.max(1, n|0));
  for (let i = 0; i < out.length; i++) {
    out[i] = nextIntervalFramesPoisson(sampleRate, density);
  }
  return out;
}
