/**
 * @fileoverview Transport controls UI (play/stop/record buttons).
 * Binds transport switch controls, reflects play button state,
 * and handles play/stop/reset button click events.
 *
 * @module ui/transport/transport-ui
 */

import { ensureAudio, getAudioCtx, getWorkletNode } from '../../app/engine/audio-engine.js';
import { restoreTransportGain, setPlayingState, isPlaying } from '../../app/engine/transport.js';
import { getAudioBuffer } from '../../app/session/buffer-session.js';

import { startRecording, stopRecordingAndExport, setRecorderHooks, getIsRecording } from '../../app/session/recorder-session.js';
import { clearKbMute } from '../../app/input/keyboard-glue.js';

import { getActiveCursor, applyCursorToUI } from '../../app/state/cursors.js';
import { cursorParams, NOMINAL, pitchKnobSemis, pitchBaselineSemis, commitPitch } from '../../app/state/params.js';
import { hasSAB, getSabView, writeParamsToSAB } from '../../app/engine/sab.js';
import { setLayerParams } from '../background-animation.js';

export function getPlaySwitchInput() { return document.querySelector('#playSwitch input, .switch.switch--play input'); }
export function getRecSwitchInput()  { return document.querySelector('#recSwitch input, .switch.switch--rec input'); }
export function setPlaySwitchUI(on)  { const sw = getPlaySwitchInput(); if (sw && sw.checked !== !!on) sw.checked = !!on; }
export function setRecSwitchUI(on)   { const sw = getRecSwitchInput();  if (sw && sw.checked !== !!on) sw.checked = !!on; }

setRecorderHooks({ setRecSwitchUI });

export function reflectPlayButtonState() {
  const btn = document.getElementById("playButton");
  if (btn) {
    btn.setAttribute("data-state", isPlaying ? "pause" : "play");
    btn.setAttribute("aria-pressed", isPlaying ? "true" : "false");
    btn.title = isPlaying ? "Pause" : "Play";
  }
  setPlaySwitchUI(isPlaying);
}

export function bindTransportSwitches() {
  const playSW = getPlaySwitchInput();
  const recSW  = getRecSwitchInput();

  if (playSW && !playSW.__bound) {
    playSW.__bound = true;
    playSW.addEventListener('change', async () => {
      const wantPlay = playSW.checked;
      await ensureAudio();
      if (!getAudioBuffer()) { setPlaySwitchUI(false); return; }
      const audioCtx = getAudioCtx();
      if (audioCtx.state === "suspended") { try { await audioCtx.resume(); } catch {} }

      if (wantPlay) restoreTransportGain();
      setPlayingState(!!wantPlay);
      try { getWorkletNode()?.port.postMessage({ type: "setPlaying", value: !!wantPlay }); } catch {}

      if (wantPlay) { try { clearKbMute(); } catch {} }

      reflectPlayButtonState();
    });
  }

  if (recSW && !recSW.__bound) {
    recSW.__bound = true;
    recSW.addEventListener('change', async () => {
      const wantRec = recSW.checked;
      if (wantRec && !getIsRecording()) { await startRecording(); }
      else if (!wantRec && getIsRecording()) { stopRecordingAndExport(); }
    });
  }
}

// Play button click handler
document.getElementById("playButton")?.addEventListener("click", async () => {
  await ensureAudio();
  if (!getAudioBuffer()) return;
  const audioCtx = getAudioCtx();
  if (audioCtx.state === "suspended") { try { await audioCtx.resume(); } catch {} }
  if (!isPlaying) restoreTransportGain();

  const next = !isPlaying;
  setPlayingState(next);
  try { getWorkletNode()?.port.postMessage({ type: "setPlaying", value: next }); } catch {}

  if (next) { try { clearKbMute(); } catch {} }

  reflectPlayButtonState();
});

// Stop/Reset button click handler
document.getElementById("stopButton")?.addEventListener("click", () => {
  const idx = getActiveCursor();

  cursorParams[idx] = { ...NOMINAL };
  pitchKnobSemis[idx] = 0;
  pitchBaselineSemis[idx] = 0;
  commitPitch(idx);

  try {
    const p = cursorParams[idx];
    setLayerParams(idx, {
      grainSize: p.grainSize,
      spread:    p.spread,
      density:   p.density
    });
  } catch (err) {
    console.warn('[bg-anim] setLayerParams on reset error:', err);
  }

  applyCursorToUI(idx);

  if (hasSAB && getSabView()) {
    writeParamsToSAB(idx, cursorParams[idx]);
  } else {
    try {
      getWorkletNode()?.port.postMessage({
        type: "setParamsFor",
        cursor: idx,
        params: cursorParams[idx]
      });
    } catch {}
  }
});
