/**
 * @module app/state/params
 * @description Parameter state and preset management for the granular synthesizer.
 * Defines default cursor parameters, nominal values, pitch calculation utilities,
 * and functions to commit pitch changes to the audio worklet.
 */

import { hasSAB, getSabView, writeParamsToSAB } from '../engine/sab.js';
import { getWorkletNode } from '../engine/audio-engine.js';

const $ = (id) => document.getElementById(id);
const semisToRate = (s) => Math.pow(2, s / 12);
const rateToSemis = (r) => 12 * Math.log2(Math.max(1e-6, r));

// Relative pitch values (baseline + knob offset)
export const pitchKnobSemis     = [0, 0, 0];  // Knob value in relative semitones
export const pitchBaselineSemis = [0, 0, 0];  // Baseline pitch offset (not modified by keyboard)

// Default per-cursor parameters including filter settings
export const defaultCursorParams = () => ({
  attack:    parseFloat(($("attackRange")       || {}).value) || 0.1,
  release:   parseFloat(($("releaseRange")      || {}).value) || 0.1,
  density:   parseFloat(($("densityRange")      || {}).value) || 10,
  spread:    parseFloat(($("spreadRange")       || {}).value) || 0.1,
  pan:       parseFloat(($("panRange")          || {}).value) || 0,
  pitch:     1.0,
  cutoff:    parseFloat(($("filterCutoffRange") || {}).value) || 5000,
  qNorm:     parseFloat(($("filterQRange")      || {}).value) || 0.2,
  driveNorm: parseFloat(($("filterDriveRange")  || {}).value) || 0.0,
  slopeSel:  parseInt(  (($("filterSlopeSelect")|| {}).value), 10) || 0,
  lfoFreq:   parseFloat(($("lfoFreqRange")      || {}).value) || 1,
  lfoDepth:  parseFloat(($("lfoDepthRange")     || {}).value) || 0.2,
  scanSpeed: parseFloat(($("scanSpeedRange")    || {}).value) || 0,
  gain:      parseFloat(($("gainRange")         || {}).value) || 0.5,
  grainSize: parseFloat(($("grainSizeRange")    || {}).value) || 1.0,
});

export let cursorParams = [ defaultCursorParams(), defaultCursorParams(), defaultCursorParams() ];

export const NOMINAL = {
  attack: 0.5, release: 0.5, density: 30, spread: 0.1,
  pan: 0, pitch: 1.0, cutoff: 5000,
  qNorm: 0.2, driveNorm: 0.0, slopeSel: 0,
  lfoFreq: 1, lfoDepth: 0.2,
  scanSpeed: 0, gain: 0, grainSize: 1.0
};

export function commitPitch(idx) {
  const semis = (pitchBaselineSemis[idx] || 0) + (pitchKnobSemis[idx] || 0);
  const rate  = semisToRate(semis);
  cursorParams[idx].pitch = rate;
  if (hasSAB && getSabView()) {
    writeParamsToSAB(idx, cursorParams[idx]);
  } else {
    try { getWorkletNode()?.port.postMessage({ type: "setParamsFor", cursor: idx, params: { pitch: rate } }); } catch {}
  }
}

export function commitPitchAll() { commitPitch(0); commitPitch(1); commitPitch(2); }

// Expose globally for boot compatibility
window.__CommitPitchAll = commitPitchAll;
