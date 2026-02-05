/**
 * @file sab.js
 * @description SharedArrayBuffer management for real-time parameter updates
 *              between the main thread and the AudioWorklet processor.
 * @module app/engine/sab
 */

// Check if SharedArrayBuffer is available and cross-origin isolation is enabled
export const hasSAB = (typeof SharedArrayBuffer === 'function' && self.crossOriginIsolated === true);

export const CURSOR_STRIDE = 15;
export const TOTAL_PARAMS  = CURSOR_STRIDE * 3;

export let sabParams = null;
export let sabView   = null;

// Getter functions for reliable access after init
export function getSabParams() { return sabParams; }
export function getSabView()   { return sabView; }

export function writeParamsToSAB(cursorIndex, p){
  if (!sabView) return;
  const base = cursorIndex * CURSOR_STRIDE;
  sabView[base + 0]  = p.attack;
  sabView[base + 1]  = p.release;
  sabView[base + 2]  = p.density;
  sabView[base + 3]  = p.spread;
  sabView[base + 4]  = p.pan;
  sabView[base + 5]  = p.pitch;
  sabView[base + 6]  = p.cutoff;
  sabView[base + 7]  = p.lfoFreq;
  sabView[base + 8]  = p.lfoDepth;
  sabView[base + 9]  = p.scanSpeed;
  sabView[base +10]  = p.gain;
  sabView[base +11]  = p.grainSize;
  sabView[base +12]  = p.qNorm;
  sabView[base +13]  = p.driveNorm;
  sabView[base +14]  = p.slopeSel;
}

export function initSAB(workletNode, cursorParams){
  if (!hasSAB) return;
  sabParams = new SharedArrayBuffer(Float32Array.BYTES_PER_ELEMENT * TOTAL_PARAMS);
  sabView   = new Float32Array(sabParams);
  writeParamsToSAB(0, cursorParams[0]);
  writeParamsToSAB(1, cursorParams[1]);
  writeParamsToSAB(2, cursorParams[2]);
  try { workletNode?.port.postMessage({ type: "setParamSAB", sab: sabParams, stride: CURSOR_STRIDE }); } catch {}
}
