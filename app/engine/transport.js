/**
 * @file transport.js
 * @description Play/pause transport controls with smooth gain fading
 *              to prevent audio clicks during state transitions.
 * @module app/engine/transport
 */

import { getAudioCtx, getTransportGain, getWorkletNode } from './audio-engine.js';

export let isPlaying = false;

const transportHooks = {
  setPlaySwitchUI: null
};

export function setTransportHooks(partial = {}){
  Object.assign(transportHooks, partial);
}

export async function pauseSynthWithFade(ms = 180) {
  try {
    const audioCtx = getAudioCtx();
    const transportGain = getTransportGain();
    if (!audioCtx || !transportGain) return;
    const now = audioCtx.currentTime;
    transportGain.gain.cancelScheduledValues(now);
    const tc = Math.max(0.005, (ms / 1000) / 3);
    transportGain.gain.setTargetAtTime(0, now, tc);
    await new Promise(r => setTimeout(r, ms + 50));
  } finally {
    isPlaying = false;
    try { getWorkletNode()?.port.postMessage({ type: "setPlaying", value: false }); } catch {}
    try { transportHooks.setPlaySwitchUI?.(false); } catch {}
  }
}

export function restoreTransportGain() {
  const audioCtx = getAudioCtx();
  const transportGain = getTransportGain();
  if (!audioCtx || !transportGain) return;
  const now = audioCtx.currentTime + 0.0005;
  transportGain.gain.cancelScheduledValues(now);
  transportGain.gain.setValueAtTime(1.0, now);
}

export function setPlayingState(on){
  isPlaying = !!on;
}
