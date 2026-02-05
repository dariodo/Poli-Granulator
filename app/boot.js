/**
 * @file boot.js
 * @description Main application orchestration and wiring module.
 * Handles high-level initialization, module connections, and event binding.
 * Sets up the audio engine, transport, UI components, and input handlers.
 */

import { initGranularHotkeys } from './hotkeys.js';

// Existing UI components
import '../ui/master-fader.js';
import { mountKnobs } from '../ui/knobs/knobs.js';
import { resetBackgroundAnimation } from '../ui/background-animation.js';

// Audio engine, session management, and state modules
import { ensureAudio, setEngineHooks, setDbMeterEnabled } from './engine/audio-engine.js';
import { setTransportHooks } from './engine/transport.js';
import { getAudioBuffer } from './session/buffer-session.js';
import { startRecording, stopRecordingAndExport, reflectRecMaxSeconds } from './session/recorder-session.js';
import { micHoldStart, micHoldStop } from './session/mic-session.js';
import { setActiveCursor, getActiveCursor, positions, sendPositions, drawWaveformIfAny, getMaybeSnapToZero, setMaybeSnapToZero } from './state/cursors.js';
import { toggleHoldFor } from './state/hold.js';

// UI modules (transport, overlay, waveform, I/O, mic visualization, input handlers, presets)
import { getPlaySwitchInput, getRecSwitchInput } from '../ui/transport/transport-ui.js';
import { showSplash, hideSplash, labelKnobsFromHotkeys, wireKnobKeycaps, showSplashStatic, setKeycapsVisible } from '../ui/overlay/splash.js';
import { requestWaveformRedraw, drawWaveform } from '../ui/waveform/waveform.js';
import { initIOSplitWiring, adjustIOSplitWidth, calibrateSwitchScale } from '../ui/io/io-split.js';
import { bindTransportSwitches, reflectPlayButtonState } from '../ui/transport/transport-ui.js';
import { initHoldButtonWiring, getHoldButton, setHoldHooks } from './state/hold.js';
import { initKbModule, clearKbMute, setKeyboardHooks } from './input/keyboard-glue.js';
import { initMidiModule } from './input/midi-glue.js';
import { applyPresetSAFE } from './presets/safe.js';

// Register custom CSS properties for animations
if ('registerProperty' in CSS) {
  [
    ['--panel-bg',     '#E74C3C'],
    ['--inset-base',   'hsl(129 7% 43%)'],
    ['--inset-top',    'hsl(129 7% 53%)'],
    ['--inset-bottom', 'hsl(129 7% 63%)']
  ].forEach(([name, initial]) => {
    try { CSS.registerProperty({ name, syntax: '<color>', inherits: true, initialValue: initial }); } catch (e) {}
  });
}

// Limiter UI visualization
const GR_VISUAL_MAX = 12;
function updateLimiterUI(tpDb, grDb) {
  const grFill  = document.getElementById('grFill');
  const tpBox   = document.getElementById('tpBox');
  const tpValue = document.getElementById('tpValue');
  if (!grFill || !tpBox || !tpValue) return;
  let gr = 0;
  if (Number.isFinite(grDb)) gr = Math.max(0, -grDb);
  const hPct = Math.max(0, Math.min(1, gr / GR_VISUAL_MAX)) * 100;
  grFill.style.height = hPct + '%';
  const tp = (tpDb === -Infinity || !Number.isFinite(tpDb)) ? -Infinity : tpDb;
  tpValue.textContent = (tp === -Infinity) ? '−∞' : tp.toFixed(1);
  tpBox.classList.remove('safe', 'warn', 'hot');
  if (tp === -Infinity || tp <= -1.0) tpBox.classList.add('safe');
  else if (tp <= -0.5)                tpBox.classList.add('warn');
  else                                 tpBox.classList.add('hot');
}

// Module connection hooks (wiring only)
setEngineHooks({
  positionsRef: positions,
  onTelemetry: (tpDb, grDb) => updateLimiterUI(tpDb, grDb),
  onPositions: () => requestWaveformRedraw(),
  onRecChunk:  (l, r) => { try { window.__RecorderSessionPushChunk?.(l, r); } catch {} },
  onRecAutostop: () => { try { window.__RecorderSessionAutoStop?.(); } catch {} }
});

// HOLD hooks: activeCursor + clearKbMute (avoids circular dependencies)
setHoldHooks({
  getActiveCursor: () => getActiveCursor(),
  clearKbMute: () => { try { clearKbMute(); } catch {} }
});

// Keyboard hooks for callbacks from other modules
setKeyboardHooks({
  meterEnable: (on) => { try { setDbMeterEnabled(!!on); } catch {} }
});

// Transport hooks: play switch UI updates (avoids direct dependencies)
setTransportHooks({
  setPlaySwitchUI: (on) => {
    try {
      const sw = getPlaySwitchInput();
      if (sw && sw.checked !== !!on) sw.checked = !!on;
    } catch {}
  }
});

// Initialize hotkeys (before knobs initialization)
initGranularHotkeys({
  getPlaySwitchInput,
  getRecSwitchInput,
  setActiveCursor,
  getActiveCursor: () => getActiveCursor(),
  positionsRef: positions,
  sendPositions,
  redrawWaveform: () => { const buf = getAudioBuffer(); if (buf) drawWaveform(buf); },
  startRecording,
  stopRecordingAndExport,
  meterEnable: (on) => { try { setDbMeterEnabled(!!on); } catch {} },
  getMaybeSnapToZero: () => getMaybeSnapToZero(),
  setMaybeSnapToZero: (fn) => { try { setMaybeSnapToZero(fn); } catch {} },

  hasActiveSession: () => !!getAudioBuffer(),
  showInfoOverlay:  (mode) => showSplash(mode),
  hideInfoOverlay:  () => hideSplash(),
  micHoldStart,
  micHoldStop,

  toggleHoldForActive: () => toggleHoldFor(getActiveCursor()),
  getHoldButton: () => getHoldButton()
});

// DOM ready: initialize UI components and bindings
document.addEventListener("DOMContentLoaded", () => {
  reflectPlayButtonState();
  reflectRecMaxSeconds();

  updateLimiterUI(-Infinity, 0);
  try { applyPresetSAFE(); } catch {}

  initIOSplitWiring();
  initHoldButtonWiring();
  adjustIOSplitWidth();
  bindTransportSwitches();
  calibrateSwitchScale(64);

  // Mount parameter knobs
  mountKnobs({ maybeSnapToZero: getMaybeSnapToZero() });

  // Initialize keycaps and overlay
  labelKnobsFromHotkeys();
  wireKnobKeycaps();

  // Initialize input modules (keyboard and MIDI)
  initKbModule();
  initMidiModule();

  // Show initial overlay
  showSplashStatic('idle');

  // Reset background animation
  try { resetBackgroundAnimation?.(); } catch {}

  // Commit initial pitch values
  try { window.__CommitPitchAll?.(); } catch {}
});

// Window resize handler and audio context unlock
window.addEventListener("resize", () => {
  try { requestWaveformRedraw(); } catch {}
  adjustIOSplitWidth();
});

window.addEventListener("click", async () => {
  // Resume audio context on user interaction
  try { await ensureAudio(); } catch {}
}, { once: true });

// Compatibility helper: redraw waveform if buffer is present
export function redrawWaveformCompat(){
  try { drawWaveformIfAny(); } catch {}
}
