/**
 * @module app/state/cursors
 * @description Cursor/playhead state management for the granular synthesizer.
 * Manages active cursor selection, cursor positions, and synchronizes UI sliders
 * with per-cursor parameters. Handles communication with the audio worklet.
 */

import { initTriSwitch3 } from '../../ui/tri-switch.js';
import { setLayerParams } from '../../ui/background-animation.js';

import { hasSAB, getSabView, writeParamsToSAB } from '../engine/sab.js';
import { getWorkletNode, setEngineHooks } from '../engine/audio-engine.js';

import { cursorParams, pitchKnobSemis, pitchBaselineSemis, commitPitch } from './params.js';
import { updateHoldUI } from './hold.js';

// Waveform display imports
import { requestWaveformRedraw, drawWaveform } from '../../ui/waveform/waveform.js';
import { getAudioBuffer } from '../session/buffer-session.js';

const $ = (id) => document.getElementById(id);

export let positions = [0.15, 0.50, 0.85];
export let activeCursor = 0;

let __isApplyingCursorToUI = false;

export function getActiveCursor(){ return activeCursor; }

function clamp01(x) { return Math.max(0, Math.min(1, x)); }
function syncSlider(id){
  const el = $(id); if(!el) return;
  el.dispatchEvent(new Event('input',  { bubbles:true }));
  el.dispatchEvent(new Event('change', { bubbles:true }));
}

// Slider ID to parameter key mapping with UI conversion functions
const sliderMap = {
  attackRange:       { key: "attack",    fromUI: v => parseFloat(v), toUI: v => v },
  releaseRange:      { key: "release",   fromUI: v => parseFloat(v), toUI: v => v },
  densityRange:      { key: "density",   fromUI: v => parseFloat(v), toUI: v => v },
  spreadRange:       { key: "spread",    fromUI: v => parseFloat(v), toUI: v => v },
  panRange:          { key: "pan",       fromUI: v => parseFloat(v), toUI: v => v },
  pitchRange:        { key: "pitch",     fromUI: v => parseFloat(v), toUI: v => v.toFixed(1) },
  filterCutoffRange: { key: "cutoff",    fromUI: v => parseFloat(v), toUI: v => v },
  filterQRange:      { key: "qNorm",     fromUI: v => parseFloat(v), toUI: v => v },
  filterDriveRange:  { key: "driveNorm", fromUI: v => parseFloat(v), toUI: v => v },
  filterSlopeSelect: { key: "slopeSel",  fromUI: v => parseInt(v,10),toUI: v => v },
  lfoFreqRange:      { key: "lfoFreq",   fromUI: v => parseFloat(v), toUI: v => v },
  lfoDepthRange:     { key: "lfoDepth",  fromUI: v => parseFloat(v), toUI: v => v },
  scanSpeedRange:    { key: "scanSpeed", fromUI: v => parseFloat(v), toUI: v => v },
  gainRange:         { key: "gain",      fromUI: v => parseFloat(v), toUI: v => v },
  grainSizeRange:    { key: "grainSize", fromUI: v => parseFloat(v), toUI: v => v },
};
const perCursorSliderIds = Object.keys(sliderMap);

// Snap slider values to zero within threshold (rebindable via hotkeys)
let maybeSnapToZero = function(el){
  if (!el) return;
  const id = el.id;
  const val = parseFloat(el.value);
  if (id === "scanSpeedRange") {
    const thr = 0.005; if (Math.abs(val) < thr) { if (val !== 0) { el.value = "0"; el.dispatchEvent(new Event('input', { bubbles:true })); } }
  } else if (id === "panRange") {
    const thr = 0.12; if (Math.abs(val) < thr) { if (val !== 0) { el.value = "0"; el.dispatchEvent(new Event('input', { bubbles:true })); } }
  } else if (id === "pitchRange") {
    const thr = 0.15; if (Math.abs(val) < thr) { if (val !== 0) { el.value = "0"; el.dispatchEvent(new Event('input', { bubbles:true })); } }
  }
};

export function getMaybeSnapToZero(){ return maybeSnapToZero; }
export function setMaybeSnapToZero(fn){ maybeSnapToZero = fn; }

// Worklet messaging - send positions and parameters to audio processor
export function sendPositions() { try { getWorkletNode()?.port.postMessage({ type: "setPositions", positions }); } catch {} }

export function sendAllCursorParams() {
  try {
    getWorkletNode()?.port.postMessage({
      type: "setParamsAll",
      paramsA: cursorParams[0],
      paramsB: cursorParams[1],
      paramsC: cursorParams[2]
    });
  } catch {}
}

// Engine hook: fallback for non-SAB mode, sends all parameters
setEngineHooks({ sendAllCursorParams });

// Send parameters for the currently active cursor only
function sendParamsForActiveCursor() {
  if (hasSAB && getSabView()) return;
  try {
    getWorkletNode()?.port.postMessage({
      type: "setParamsFor",
      cursor: activeCursor,
      params: cursorParams[activeCursor]
    });
  } catch {}
}

function updateCursorSwitchUI(source = 'generic'){
  const panel = document.querySelector(".granular-ui");
  if (panel) {
    const idx = Math.max(0, Math.min(2, activeCursor));
    panel.setAttribute("data-cursor", idx === 0 ? "a" : idx === 1 ? "b" : "c");
  }

  const tri = window.__TriSwitchCtrl;
  if (tri && typeof tri.setValue === 'function') {
    if (source !== 'tri') {
      tri.setValue(Math.max(0, Math.min(2, activeCursor)), false);
    }
  }
}

export function setActiveCursor(n, source = 'generic'){
  const idx = (n === 1 || n === 2) ? n : 0;
  if (idx === activeCursor) return;

  activeCursor = idx;
  const sel = $("positionTarget");
  if (sel) sel.value = String(activeCursor);

  updateCursorSwitchUI(source);
  updateHoldUI();

  requestAnimationFrame(() => {
    applyCursorToUI(activeCursor);
    sendParamsForActiveCursor();
    requestWaveformRedraw();
  });
}

function initCursorSwitch(){
  const el = document.querySelector('.slide-switch3');
  if (!el) return;

  const ctrl = initTriSwitch3(el, {
    value: 0,
    onChange: ({ value }) => {
      setActiveCursor(value, 'tri');
    }
  });

  window.__TriSwitchCtrl = ctrl;
  updateCursorSwitchUI('generic');
  requestWaveformRedraw();
}

$("positionTarget")?.addEventListener("change", (e) => {
  const v = parseInt(e.target.value, 10);
  const idx = (v === 1 || v === 2) ? v : 0;
  setActiveCursor(idx, 'generic');
});

export function applyCursorToUI(index) {
  const p = cursorParams[index];

  __isApplyingCursorToUI = true;
  try {
    Object.entries(sliderMap).forEach(([id, map]) => {
      const el = $(id);
      if (!el) return;

      let valUI;
      if (id === "pitchRange") {
        valUI = (pitchKnobSemis[index] || 0).toFixed(1);
      } else {
        valUI = map.toUI(p[map.key]);
      }

      el.value = String(valUI);
      syncSlider(id);
    });
  } finally {
    __isApplyingCursorToUI = false;
  }
}

// Slider input listeners - update parameters on user interaction
perCursorSliderIds.forEach((id) => {
  const el = $(id);
  const map = sliderMap[id];
  if (!el || !map) return;

  el.addEventListener("input", () => {
    if (__isApplyingCursorToUI) return;

    if (id === "scanSpeedRange" || id === "panRange" || id === "pitchRange") {
      maybeSnapToZero(el);
    }

    const newVal = map.fromUI(el.value);

    if (id === "pitchRange") {
      pitchKnobSemis[activeCursor] = isFinite(newVal) ? newVal : 0;
      commitPitch(activeCursor);
    } else {
      cursorParams[activeCursor][map.key] = newVal;

      if (hasSAB && getSabView()) {
        writeParamsToSAB(activeCursor, cursorParams[activeCursor]);
      } else {
        try {
          getWorkletNode()?.port.postMessage({
            type: "setParamsFor",
            cursor: activeCursor,
            params: cursorParams[activeCursor]
          });
        } catch {}
      }

      if (id === "grainSizeRange" || id === "spreadRange" || id === "densityRange") {
        const p = cursorParams[activeCursor];
        try {
          setLayerParams(activeCursor, {
            grainSize: p.grainSize,
            spread:    p.spread,
            density:   p.density
          });
        } catch (err) {
          console.warn('[bg-anim] setLayerParams error:', err);
        }
      }
    }
  });
});

// Initialize cursor switch on DOM ready
document.addEventListener("DOMContentLoaded", () => {
  initCursorSwitch();
});

// Helper function for hotkeys - redraws waveform if buffer exists
export function drawWaveformIfAny(){
  const buf = getAudioBuffer();
  if (buf) drawWaveform(buf);
}
