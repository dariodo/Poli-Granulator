/**
 * @file safe.js
 * @description Safe/default preset values for the granular synthesizer.
 *              Applies conservative, neutral parameter values to all three cursors.
 *              Used as a fallback or reset preset to ensure stable audio output.
 */

// ============================
// applyPresetSAFE (same as main)
// ============================

import { hasSAB, getSabView, writeParamsToSAB } from '../engine/sab.js';
import { getWorkletNode } from '../engine/audio-engine.js';
import { setActiveCursor } from '../state/cursors.js';
import { cursorParams } from '../state/params.js';

export function applyPresetSAFE() {
  const set = (id, v) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = String(v);
    el.dispatchEvent(new Event('input',  { bubbles:true }));
    el.dispatchEvent(new Event('change', { bubbles:true }));
  };

  try { window.MasterFader?.setDb?.(-2); } catch {}

  // A
  setActiveCursor(0);
  set("grainSizeRange",     1.00);
  set("attackRange",        0.5);
  set("releaseRange",       0.5);
  set("densityRange",       30);
  set("spreadRange",        0.1);
  set("panRange",           0);
  set("pitchRange",         0);
  set("filterCutoffRange",  5000);
  set("filterQRange",       0.20);
  set("filterDriveRange",   0.00);
  set("filterSlopeSelect",  0);
  set("lfoFreqRange",       1);
  set("lfoDepthRange",      0.2);
  set("scanSpeedRange",     0.00);
  set("gainRange",          0);
  if (hasSAB && getSabView()) writeParamsToSAB(0, cursorParams[0]); else try { getWorkletNode()?.port.postMessage({ type:"setParamsFor", cursor:0, params:cursorParams[0] }); } catch {}

  // B
  setActiveCursor(1);
  set("grainSizeRange",     1.00);
  set("attackRange",        0.5);
  set("releaseRange",       0.5);
  set("densityRange",       30);
  set("spreadRange",        0.1);
  set("panRange",           0);
  set("pitchRange",         0);
  set("filterCutoffRange",  5000);
  set("filterQRange",       0.20);
  set("filterDriveRange",   0.00);
  set("filterSlopeSelect",  0);
  set("lfoFreqRange",       1);
  set("lfoDepthRange",      0.2);
  set("scanSpeedRange",     0.00);
  set("gainRange",          0);
  if (hasSAB && getSabView()) writeParamsToSAB(1, cursorParams[1]); else try { getWorkletNode()?.port.postMessage({ type:"setParamsFor", cursor:1, params:cursorParams[1] }); } catch {}

  // C
  setActiveCursor(2);
  set("grainSizeRange",     1.00);
  set("attackRange",        0.5);
  set("releaseRange",       0.5);
  set("densityRange",       30);
  set("spreadRange",        0.1);
  set("panRange",           0);
  set("pitchRange",         0);
  set("filterCutoffRange",  5000);
  set("filterQRange",       0.20);
  set("filterDriveRange",   0.00);
  set("filterSlopeSelect",  0);
  set("lfoFreqRange",       1);
  set("lfoDepthRange",      0.2);
  set("scanSpeedRange",     0.00);
  set("gainRange",          0);
  if (hasSAB && getSabView()) writeParamsToSAB(2, cursorParams[2]); else try { getWorkletNode()?.port.postMessage({ type:"setParamsFor", cursor:2, params:cursorParams[2] }); } catch {}

  setActiveCursor(0);
}
