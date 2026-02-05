/**
 * @module app/input/keyboard-glue
 * @description Keyboard input binding to the audio engine.
 * Handles QWERTY keyboard note events, manages keyboard state,
 * and provides solo mode functionality for muting inactive cursors.
 */

import { ensureAudio, getAudioCtx, getWorkletNode, setDbMeterEnabled } from '../engine/audio-engine.js';
import { restoreTransportGain, isPlaying } from '../engine/transport.js';
import { initPianoKeyboard } from '../piano-keyboard.js';

import { hasSAB, getSabView, writeParamsToSAB } from '../engine/sab.js';
import { cursorParams, pitchBaselineSemis, pitchKnobSemis, commitPitch, commitPitchAll } from '../state/params.js';
import { getActiveCursor } from '../state/cursors.js';
import { holdState } from '../state/hold.js';

const SOLO_MODE = false;

// Optional hooks for external wiring
const keyboardHooks = {
  meterEnable: (on) => { try { setDbMeterEnabled(!!on); } catch {} }
};
export function setKeyboardHooks(partial = {}) { Object.assign(keyboardHooks, partial); }

// Keyboard/MIDI session state
const kbState = {
  heldAll: 0,
  heldByCursor: [0,0,0],
  muteApplied: false,
  muted: [false,false,false],
  savedGain: [null,null,null]
};

async function ensureAudibleForKb(){
  await ensureAudio();
  const audioCtx = getAudioCtx();
  if (audioCtx.state === "suspended") { try { await audioCtx.resume(); } catch {} }
  restoreTransportGain();
  try { keyboardHooks.meterEnable(true); } catch {}
}

function setCursorGain(idx, g){
  cursorParams[idx].gain = g;
  if (hasSAB && getSabView()) writeParamsToSAB(idx, cursorParams[idx]);
  else try { getWorkletNode()?.port.postMessage({ type: "setParamsFor", cursor: idx, params: { gain: g } }); } catch {}
}

// Disabled when SOLO_MODE=false: we no longer mute other cursors when playing from keyboard
function applyKbMuteIfNeeded(targetCursor){
  if (!SOLO_MODE) return;
  if (isPlaying) return; // Only applies when playback is stopped
  if (kbState.heldAll > 0) return;
  if (kbState.muteApplied) return;

  for (let i = 0; i < 3; i++){
    if (i === targetCursor) continue;
    kbState.savedGain[i] = cursorParams[i].gain;
    setCursorGain(i, 0);
    kbState.muted[i] = true;
  }
  kbState.muteApplied = true;
}

export function clearKbMute(){
  if (!SOLO_MODE) return;
  if (!kbState.muteApplied) return;
  for (let i = 0; i < 3; i++){
    if (kbState.muted[i]) {
      const g = (kbState.savedGain[i] != null) ? kbState.savedGain[i] : cursorParams[i].gain;
      setCursorGain(i, g);
    }
    kbState.muted[i] = false;
    kbState.savedGain[i] = null;
  }
  kbState.muteApplied = false;
}

function reapplySingleMuteIfEligible(){
  if (!SOLO_MODE) { return; }
  if (isPlaying) { clearKbMute(); return; }
  if (kbState.heldAll > 0) { clearKbMute(); return; }
  const totalSingle = kbState.heldByCursor[0] + kbState.heldByCursor[1] + kbState.heldByCursor[2];
  if (totalSingle === 0) { clearKbMute(); return; }
  const cursorsWithHolds = [0,1,2].filter(i => kbState.heldByCursor[i] > 0);
  if (cursorsWithHolds.length === 1) {
    applyKbMuteIfNeeded(cursorsWithHolds[0]);
  } else {
    clearKbMute();
  }
}

// Shared helpers: used by both QWERTY keyboard and MIDI controller
async function kbNoteOnSingle(cursorIdx, semis) {
  await ensureAudibleForKb();
  kbState.heldByCursor[cursorIdx] = Math.max(0, kbState.heldByCursor[cursorIdx] + 1);
  applyKbMuteIfNeeded(cursorIdx); // (no-op se SOLO_MODE=false)
  try { getWorkletNode()?.port.postMessage({ type:'noteOn', cursor: cursorIdx, semis }); } catch {}
}

function kbNoteOffSingle(cursorIdx, semis) {
  kbState.heldByCursor[cursorIdx] = Math.max(0, kbState.heldByCursor[cursorIdx] - 1);

  // If hold is active for this cursor, ignore noteOff (keep note latched)
  if (!holdState[cursorIdx]) {
    try { getWorkletNode()?.port.postMessage({ type:'noteOff', cursor: cursorIdx, semis }); } catch {}
  }

  const total = kbState.heldByCursor[0] + kbState.heldByCursor[1] + kbState.heldByCursor[2];
  if (kbState.heldAll === 0 && total === 0) clearKbMute();
  else reapplySingleMuteIfEligible();
}

async function kbNoteOnAll(semis) {
  await ensureAudibleForKb();
  kbState.heldAll++;
  clearKbMute();
  try { getWorkletNode()?.port.postMessage({ type:'noteOnAll', semis }); } catch {}
}

function kbNoteOffAll(semis) {
  kbState.heldAll = Math.max(0, kbState.heldAll - 1);
  try { getWorkletNode()?.port.postMessage({ type:'noteOffAll', semis }); } catch {}
  reapplySingleMuteIfEligible();
}

export function initKbModule(){
  initPianoKeyboard({
    getActiveCursor: () => getActiveCursor(),
    noteOn: kbNoteOnSingle,
    noteOff: kbNoteOffSingle,
    noteOnAll: kbNoteOnAll,
    noteOffAll: kbNoteOffAll,

    onOctaveChange: (oct) => {
      const el = document.getElementById('pitchRange');
      if (el) el.setAttribute('data-octave', String(oct));
    },
    pitchKnobEl: document.getElementById('pitchRange'),

    baselineSemis: pitchBaselineSemis,
    knobSemis:     pitchKnobSemis,
    commitPitch,
    commitPitchAll
  });
}

// export extra (se ti serve altrove)
export { kbState, kbNoteOnSingle, kbNoteOffSingle, kbNoteOnAll, kbNoteOffAll };
