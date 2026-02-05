/**
 * @file windows.js
 * @description DSP utilities for grain envelopes and panning.
 *   Provides Hann window lookup table, envelope interpolation,
 *   and equal-power panning coefficients.
 */

'use strict';

/**
 * Create a lookup table for the Hann window over [0..1]
 * @param {number} size Number of samples in the table (>= 16)
 * @returns {Float32Array}
 */
export function createHannLUT(size = 1024) {
  const N = Math.max(16, (size | 0));
  const lut = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);          // 0..1 inclusive
    // Precise Hann: sin^2(pi * t)
    lut[i] = Math.sin(Math.PI * t) ** 2;
  }
  return lut;
}

/**
 * Read Hann envelope value via LUT with linear interpolation.
 * Equivalent to sin^2(pi * (pos/(len-1))), but much more efficient.
 *
 * @param {number} pos Current index in the envelope [0..len-1]
 * @param {number} len Total envelope length (frames)
 * @param {Float32Array} lut Hann table created with createHannLUT()
 * @returns {number} Envelope value 0..1
 */
export function envAtFromLUT(pos, len, lut) {
  if (!len || len <= 1) return 1;
  const L = lut.length;
  // Clamp pos to valid window range
  const p = Math.max(0, Math.min(len - 1, pos));
  const t = (p / (len - 1)) * (L - 1);
  const i = Math.floor(t);
  const f = t - i;
  const a = lut[i];
  const b = lut[Math.min(i + 1, L - 1)];
  return a + (b - a) * f;
}

/**
 * Equal-power panning (cos/sin), maintains constant perceived loudness
 * @param {number} pan -1 (left) .. +1 (right)
 * @returns {{L:number,R:number}} Channel coefficients
 */
export function equalPowerPan(pan) {
  const p = Math.max(-1, Math.min(1, pan || 0));
  const angle = (p + 1) * 0.25 * Math.PI; // 0..π/2
  return { L: Math.cos(angle), R: Math.sin(angle) };
}

/** Linear interpolation helper */
export const lerp = (a, b, t) => a + (b - a) * t;
