/**
 * @file buffer-session.js
 * @description Audio buffer session management for loading, decoding, and processing samples.
 *              Handles file input, buffer extraction, loudness analysis, and worklet communication.
 * @module app/session/buffer-session
 */

import { ensureAudio, waitForWorkletReady, getAudioCtx, getWorkletNode, setEngineHooks } from '../engine/audio-engine.js';
import { cursorParams, commitPitchAll } from '../state/params.js';
import { sendAllCursorParams, sendPositions } from '../state/cursors.js';

// Waveform UI module
import { resizeWaveformCanvas, resetWaveformCache, rebuildPeaksIfNeeded, drawWaveform, requestWaveformRedraw } from '../../ui/waveform/waveform.js';

export let audioBuffer = null;

// Getter function for reliable access in circular dependencies
export function getAudioBuffer() { return audioBuffer; }

/**
 * Extracts and clones all channels from an AudioBuffer.
 * @param {AudioBuffer} buf - The audio buffer to extract channels from
 * @returns {Float32Array[]} Array of cloned channel data
 */
function extractChannels(buf){
  const chs = buf.numberOfChannels;
  const out = new Array(chs);
  for (let ch = 0; ch < chs; ch++) {
    out[ch] = new Float32Array(buf.getChannelData(ch)); // clone
  }
  return out;
}

export async function useDecodedBuffer(buf) {
  await ensureAudio();
  const audioCtx = getAudioCtx();
  if (audioCtx.state === "suspended") { try { await audioCtx.resume(); } catch {} }
  audioBuffer = buf;

  // Reset waveform cache and resize canvas
  try { resetWaveformCache(); } catch {}
  try { resizeWaveformCanvas(); } catch {}

  await waitForWorkletReady();

  const chs = extractChannels(audioBuffer); // Array<Float32Array>
  try {
    getWorkletNode().port.postMessage(
      {
        type: "setBuffer",
        sampleRate: audioBuffer.sampleRate,
        length: audioBuffer.length,
        channels: chs.map(c => c.buffer)
      },
      chs.map(c => c.buffer) // transferables
    );
  } catch {}

  // Build loudness map using left channel for UI consistency
  const loud = buildLoudnessMap(audioBuffer, 2048);
  const rmsCopy = new Float32Array(loud.rms);
  try {
    getWorkletNode().port.postMessage(
      { type: "setLoudnessMap", map: { rms: rmsCopy.buffer, win: loud.win, sr: loud.sr, len: loud.len } },
      [rmsCopy.buffer]
    );
  } catch {}

  try { rebuildPeaksIfNeeded(); } catch {}
  try { drawWaveform(audioBuffer); } catch {}
  requestAnimationFrame(() => { try { drawWaveform(audioBuffer); } catch {} });

  sendAllCursorParams();
  commitPitchAll();
  sendPositions();
  requestWaveformRedraw();
}

/**
 * Binds the file input element to handle audio file selection.
 * Only binds once to prevent duplicate event listeners.
 */
function bindFileInputOnce(){
  const el = document.getElementById("audioFileInput");
  if (!el || el.__bufBound) return;
  el.__bufBound = true;

  el.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    await ensureAudio();
    const audioCtx = getAudioCtx();
    if (audioCtx.state === "suspended") { try { await audioCtx.resume(); } catch {} }
    const arrayBuffer = await file.arrayBuffer();
    const decoded = await audioCtx.decodeAudioData(arrayBuffer);
    await useDecodedBuffer(decoded);
  });
}

bindFileInputOnce();
document.addEventListener('DOMContentLoaded', bindFileInputOnce);

/**
 * Downmixes a multi-channel buffer to mono.
 * Note: Available for utility purposes, not used for playback.
 * @param {AudioBuffer} buf - The audio buffer to downmix
 * @returns {Float32Array} Mono audio data
 */
export function downmixToMono(buf) {
  const n = buf.length;
  const chs = buf.numberOfChannels;
  const out = new Float32Array(n);
  for (let ch = 0; ch < chs; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < n; i++) out[i] += data[i] / chs;
  }
  return out;
}

/**
 * Builds a loudness map for the audio buffer using RMS analysis.
 * @param {AudioBuffer} buffer - The audio buffer to analyze
 * @param {number} [win=2048] - Window size for RMS calculation
 * @returns {{rms: Float32Array, win: number, sr: number, len: number}} Loudness map data
 */
export function buildLoudnessMap(buffer, win = 2048){
  const sr = buffer.sampleRate;
  const d  = buffer.getChannelData(0);
  const nb = Math.ceil(d.length / win);
  const rms = new Float32Array(nb);
  for (let b = 0; b < nb; b++) {
    let acc = 0, start = b * win, end = Math.min(start + win, d.length);
    for (let i = start; i < end; i++) acc += d[i] * d[i];
    rms[b] = Math.sqrt(acc / Math.max(1, end - start));
  }
  return { rms, win, sr, len: d.length };
}

// Engine hook: provide cursorParamsRef for SharedArrayBuffer initialization
setEngineHooks({ cursorParamsRef: cursorParams });
