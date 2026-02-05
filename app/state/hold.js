/**
 * @module app/state/hold
 * @description Note hold state management for the granular synthesizer.
 * Manages the hold/sustain state for each cursor, allowing notes to be
 * latched and sustained even after key release.
 */

import { getWorkletNode } from '../engine/audio-engine.js';

export const holdState = [false, false, false];

// Debounce guard to prevent rapid hold toggle spam (via keyboard or click)
const HOLD_TOGGLE_DEBOUNCE_MS = 150;
let __holdToggleBusy = false;

const holdHooks = {
  getActiveCursor: () => 0,
  clearKbMute: () => {},
  getHoldButton: () => (__getHoldBtn())
};

export function setHoldHooks(partial = {}){ Object.assign(holdHooks, partial); }

// Helper to get the hold button element from DOM
function __getHoldBtn(){
  return document.getElementById('ioHoldBtn')
      || document.querySelector('.io-hold');
}

// Use the hook if it returns a valid element, otherwise fallback to local helper
export function getHoldButton(){
  // Guard: avoid calling the hook if it would call us back (circular)
  const hookFn = holdHooks.getHoldButton;
  if (hookFn && hookFn !== getHoldButton) {
    const result = hookFn();
    if (result) return result;
  }
  return __getHoldBtn();
}

export function updateHoldUI(){
  const btn = getHoldButton();
  if (!btn) return;
  const cur = holdHooks.getActiveCursor();
  const on = !!holdState[cur];
  btn.classList.toggle('is-on', on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
}

export async function toggleHoldFor(cursorIdx){
  if (__holdToggleBusy) return;
  __holdToggleBusy = true;
  setTimeout(() => { __holdToggleBusy = false; }, HOLD_TOGGLE_DEBOUNCE_MS);

  const next = !holdState[cursorIdx];
  holdState[cursorIdx] = next;
  updateHoldUI();

  if (next) {
    try { holdHooks.clearKbMute?.(); } catch {}
  } else {
    try {
      getWorkletNode()?.port.postMessage({ type: 'clearKbNotes', cursor: cursorIdx });
    } catch {}
  }
}

export function initHoldButtonWiring(){
  const btn = getHoldButton();
  if (!btn) return;
  btn.addEventListener('click', () => toggleHoldFor(holdHooks.getActiveCursor()));
  updateHoldUI();
}
