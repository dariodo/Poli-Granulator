/**
 * @file audio-engine.js
 * @description Core audio engine managing AudioContext, AudioWorklet nodes,
 *              master gain, and real-time communication with the granular processor.
 * @module app/engine/audio-engine
 */

import { mountDbMeter } from '../../ui/dbmeter.js';
import { hasSAB, initSAB } from './sab.js';

let audioCtx;
let masterGain;
let transportGain = null;
let workletNode;
let recorderNode;

let dbMeterCtrl = null;

// Worklet handshake state
let workletReadyPromise = null;
let resolveWorkletReady = null;

// Hooks configured by the boot module
const hooks = {
  positionsRef: null,
  dragLockRef: null,
  onPositions: null,
  onTelemetry: null,
  onReady: null,
  onRecChunk: null,
  onRecAutostop: null,
  cursorParamsRef: null,
  sendAllCursorParams: null
};

export function setEngineHooks(partial = {}){
  Object.assign(hooks, partial);
}

export function getAudioCtx(){ return audioCtx; }
export function getMasterGain(){ return masterGain; }
export function getTransportGain(){ return transportGain; }
export function getWorkletNode(){ return workletNode; }
export function getRecorderNode(){ return recorderNode; }
export function getDbMeterCtrl(){ return dbMeterCtrl; }

export function setDbMeterEnabled(on){
  try { dbMeterCtrl?.setEnabled?.(!!on); } catch {}
}

function clamp01(x) { return Math.max(0, Math.min(1, x)); }

export async function waitForWorkletReady() {
  if (workletReadyPromise) return workletReadyPromise;
  workletReadyPromise = new Promise((res) => { resolveWorkletReady = res; });
  try { workletNode?.port.postMessage({ type: "ping" }); } catch {}
  return workletReadyPromise;
}

export async function ensureAudio() {
  if (audioCtx) return;

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  transportGain = audioCtx.createGain();
  transportGain.gain.value = 1.0;

  masterGain = audioCtx.createGain();
  masterGain.gain.value = 1.0;

  // Load the granular processor worklet
  await audioCtx.audioWorklet.addModule("worklet/granular-processor.js");
  workletNode = new AudioWorkletNode(audioCtx, "granular-processor-pro", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: { sampleRate: audioCtx.sampleRate, useSAB: hasSAB }
  });

  await audioCtx.audioWorklet.addModule("worklet/recorder-processor.js");
  recorderNode = new AudioWorkletNode(audioCtx, "recorder-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: "explicit",
    channelInterpretation: "speakers"
  });

  workletNode.connect(transportGain);
  try { masterGain.disconnect(); } catch {}
  transportGain.connect(masterGain);
  masterGain.connect(recorderNode);
  recorderNode.connect(audioCtx.destination);

  try { window.MasterFader?.connectGainNode?.(masterGain, audioCtx); } catch (e) { console.warn('[MasterFader] connectGainNode error:', e); }
  try { if (!dbMeterCtrl) dbMeterCtrl = mountDbMeter({ audioCtx, tapNode: masterGain }); } catch (e) { console.warn('[dbmeter] mount error:', e); }

  workletNode.port.onmessage = (e) => {
    const d = e.data || {};
    if (d.type === "positions" && Array.isArray(d.positions)) {
      const pos = hooks.positionsRef;
      if (pos) {
        const n = Math.min(3, d.positions.length);
        const lock = hooks.dragLockRef;
        for (let i = 0; i < n; i++) {
          if (!lock || !lock[i]) pos[i] = clamp01(d.positions[i]);
        }
      }
      try { hooks.onPositions?.(); } catch {}
      return;
    }
    if (d.type === "telemetry") { try { hooks.onTelemetry?.(d.tpDb, d.grDb); } catch {} return; }
    if (d.type === "ready") {
      if (resolveWorkletReady) { resolveWorkletReady(); resolveWorkletReady = null; }
      try { hooks.onReady?.(); } catch {}
      return;
    }
  };

  if (hasSAB) {
    try { initSAB(workletNode, hooks.cursorParamsRef); } catch {}
  } else {
    try { hooks.sendAllCursorParams?.(); } catch {}
  }

  recorderNode.port.onmessage = (e) => {
    const d = e.data || {};
    if (d.type === 'rec-chunk') { try { hooks.onRecChunk?.(d.l, d.r); } catch {} }
    else if (d.type === 'rec-autostop') { try { hooks.onRecAutostop?.(); } catch {} }
  };

  try { workletNode.port.postMessage({ type: "setPlaying", value: false }); } catch {}

  // Send initial cursor positions to the worklet
  try {
    if (hooks.positionsRef) {
      workletNode?.port.postMessage({ type: "setPositions", positions: hooks.positionsRef });
    }
  } catch {}
}
