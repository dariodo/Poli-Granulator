/**
 * @file recorder-session.js
 * @description Audio recording session management for capturing and exporting audio.
 *              Handles start/stop recording, timer display, and MP3 export.
 * @module app/session/recorder-session
 */

import { ensureAudio, getAudioCtx, getRecorderNode } from '../engine/audio-engine.js';

let isRecording = false;
let recChunksL = [];
let recChunksR = [];
let recStartTime = 0;
let recTimerId = null;

const REC_MAX_SECONDS = 600;

export function getIsRecording(){ return isRecording; }

// Hook UI (setRecSwitchUI arriva da ui/transport/transport-ui.js)
const recorderHooks = {
  setRecSwitchUI: null
};
export function setRecorderHooks(partial = {}){ Object.assign(recorderHooks, partial); }

export function reflectRecMaxSeconds(){
  const els = document.querySelectorAll(".time-display");
  els.forEach(el => el.textContent = formatTimePair(0, REC_MAX_SECONDS));
}

/**
 * Binds the record button click handler.
 * Only binds once to prevent duplicate event listeners.
 */
function bindRecBtnOnce(){
  const recBtn = document.getElementById("recBtn");
  if (!recBtn || recBtn.__recBound) return;
  recBtn.__recBound = true;

  recBtn.addEventListener("click", async () => {
    if (!isRecording) { await startRecording(); try { recorderHooks.setRecSwitchUI?.(true); } catch {} }
    else { stopRecordingAndExport(); try { recorderHooks.setRecSwitchUI?.(false); } catch {} }
  });
}

bindRecBtnOnce();
document.addEventListener('DOMContentLoaded', bindRecBtnOnce);

/**
 * Starts audio recording.
 * Initializes the recorder worklet and begins capturing audio chunks.
 */
export async function startRecording() {
  await ensureAudio();
  const audioCtx = getAudioCtx();
  if (audioCtx.state === "suspended") { try { await audioCtx.resume(); } catch {} }
  recChunksL = []; recChunksR = []; isRecording = true;
  setRecVisual(true); try { recorderHooks.setRecSwitchUI?.(true); } catch {}
  startRecTimer();

  const maxFrames = Math.round(REC_MAX_SECONDS * audioCtx.sampleRate);
  try { getRecorderNode()?.port.postMessage({ type: 'rec-start', maxFrames }); } catch {}
}

export function stopRecordingAndExport() {
  if (!isRecording) { try { recorderHooks.setRecSwitchUI?.(false); } catch {} return; }
  isRecording = false;
  try { getRecorderNode()?.port.postMessage({ type: 'rec-stop' }); } catch {}
  setRecVisual(false); try { recorderHooks.setRecSwitchUI?.(false); } catch {}
  stopRecTimer();

  const audioCtx = getAudioCtx();
  const L = concatFloat32(recChunksL);
  const R = concatFloat32(recChunksR);
  if (L.length === 0 || R.length === 0) return;

  const blob = encodeMp3Stereo(L, R, audioCtx.sampleRate, 192);
  const ts = new Date().toISOString().replace(/[:.]/g,'-');
  downloadBlob(blob, `granular-rec-${ts}.mp3`);
  recChunksL = recChunksR = [];
}

function setRecVisual(stateOn) {
  const btn = document.querySelector(".btn-rec");
  if (btn) btn.classList.toggle("recording", !!stateOn);
  try { recorderHooks.setRecSwitchUI?.(!!stateOn); } catch {}
}

function formatTimePair(currSec, totalSec){
  const curM = Math.floor(currSec / 60);
  const curS = Math.floor(currSec % 60);
  const totM = Math.floor(totalSec / 60);
  const totS = Math.floor(totalSec % 60);
  return `${curM}:${String(curS).padStart(2,'0')}/${totM}:${String(totS).padStart(2,'0')}`;
}

function startRecTimer() {
  const timerEls = document.querySelectorAll(".time-display");
  const audioCtx = getAudioCtx();
  recStartTime = audioCtx.currentTime;
  timerEls.forEach(el => el.textContent = formatTimePair(0, REC_MAX_SECONDS));
  clearInterval(recTimerId);
  recTimerId = setInterval(() => {
    const t = Math.min(audioCtx.currentTime - recStartTime, REC_MAX_SECONDS);
    const remaining = REC_MAX_SECONDS - t;
    const shown = remaining < 0.1 ? REC_MAX_SECONDS : t;
    timerEls.forEach(el => el.textContent = formatTimePair(shown, REC_MAX_SECONDS));
  }, 100);
}
function stopRecTimer() { clearInterval(recTimerId); recTimerId = null; }

function floatTo16bitPCM(float32) {
  const out = new Int16Array(float32.length);
  for (let i=0;i<float32.length;i++){
    let s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = (s < 0 ? s * 0x8000 : s * 0x7FFF) | 0;
  }
  return out;
}
function concatFloat32(chunks) {
  const total = chunks.reduce((a,b)=>a + b.length, 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}
function encodeMp3Stereo(floatL, floatR, sampleRate, kbps = 128) {
  const left  = floatTo16bitPCM(floatL);
  const right = floatTo16bitPCM(floatR);
  const mp3enc = new lamejs.Mp3Encoder(2, sampleRate, kbps);
  const block = 1152;
  let mp3Data = [];
  for (let i = 0; i < left.length; i += block) {
    const leftChunk  = left.subarray(i, i + block);
    const rightChunk = right.subarray(i, i + block);
    const enc = mp3enc.encodeBuffer(leftChunk, rightChunk);
    if (enc.length) mp3Data.push(enc);
  }
  const end = mp3enc.flush();
  if (end.length) mp3Data.push(end);
  return new Blob(mp3Data, { type: 'audio/mpeg' });
}
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
}

// Bridge functions for engine hooks (chunk accumulation and auto-stop)
export function __pushRecChunk(l, r){
  recChunksL.push(l);
  recChunksR.push(r);
}
export function __autoStop(){
  stopRecordingAndExport();
}

// Exposed on window to avoid circular dependencies
window.__RecorderSessionPushChunk = __pushRecChunk;
window.__RecorderSessionAutoStop  = __autoStop;
