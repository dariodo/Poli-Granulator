/**
 * @file mic-session.js
 * @description Microphone input session handling for hold-to-record functionality.
 *              Manages mic controller lifecycle, recording state, and buffer processing.
 * @module app/session/mic-session
 */

import * as Mic from '../mic-capture.js';
import { ensureAudio, getAudioCtx } from '../engine/audio-engine.js';
import { pauseSynthWithFade, isPlaying } from '../engine/transport.js';
import { useDecodedBuffer } from './buffer-session.js';

// Microphone visualizer UI module
import { startMicVisualizerWithAnalyser, stopMicVisualizer } from '../../ui/mic/mic-visualizer.js';

let micCtrl = null;
const MIC_MAX_SECONDS = 120;

export function getMicCtrl(){ return micCtrl; }
export { MIC_MAX_SECONDS };

/**
 * Helper to find the mic button element regardless of ID convention.
 * @returns {HTMLElement|null} The mic button element
 */
function __getMicBtn(){
  return document.getElementById('ioMicBtn')
      || document.getElementById('micBtn')
      || document.getElementById('btnMic')
      || document.querySelector('[data-action="mic"]');
}

/**
 * Starts microphone recording (keyboard or pointer-down equivalent).
 * Arms the mic button, pauses playback if needed, and begins recording.
 */
export async function micHoldStart(){
  const micBtn = __getMicBtn();
  if (micBtn) micBtn.classList.add('is-armed');

  try {
    if (isPlaying) await pauseSynthWithFade(180);
    await ensureAudio();
    const audioCtx = getAudioCtx();
    if (audioCtx.state === 'suspended') { try { await audioCtx.resume(); } catch {} }

    const rec = await Mic.startHoldRecording({ audioCtx, maxSeconds: MIC_MAX_SECONDS });
    micCtrl = rec;

    await startMicVisualizerWithAnalyser(rec.analyser);
    if (micBtn) micBtn.classList.add('is-recording');
  } catch (err) {
    console.warn('Mic start error (kb):', err);
    if (micBtn) micBtn.classList.remove('is-armed','is-recording');
    micCtrl = null;
    await stopMicVisualizer();
  }
}

/**
 * Stops microphone recording (keyboard or pointer-up equivalent).
 * Processes the recorded buffer and loads it for playback.
 */
export async function micHoldStop(){
  const micBtn = __getMicBtn();

  if (!micCtrl) {
    if (micBtn) micBtn.classList.remove('is-armed','is-recording');
    await stopMicVisualizer();
    return;
  }
  let buf = null;
  try { buf = await micCtrl.stop(); } catch (e) { console.warn('Mic stop error (kb):', e); }
  micCtrl = null;

  if (micBtn) micBtn.classList.remove('is-armed','is-recording');
  await stopMicVisualizer();
  if (buf && buf.length > 0) await useDecodedBuffer(buf);
}
