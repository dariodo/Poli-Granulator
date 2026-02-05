/**
 * @file hotkeys.js
 * @description Keyboard shortcuts handler for the granular synthesizer.
 * Manages key bindings for playback, recording, parameter control, cursor navigation,
 * and UI interactions. Supports hold-to-activate behaviors and debounced toggles.
 * 
 * Key bindings:
 * - Space: Play/Pause toggle
 * - L: Load audio file (press effect on keydown, opens picker on keyup)
 * - M: Microphone HOLD (keydown = start, keyup = stop)
 * - R: Recording toggle
 * - I: Info overlay HOLD (disables metering while visible)
 * - P: Per-cursor HOLD toggle (debounced on keyup)
 * - Q/Shift+Q: Switch active cursor (next/previous)
 * - Backspace: Reset (immediate on keydown)
 * - Arrow keys: Navigate/adjust parameters
 * - Number keys 1-0: Select parameter knobs
 */

export function initGranularHotkeys({
  getPlaySwitchInput,
  getRecSwitchInput,
  setActiveCursor,
  getActiveCursor,
  positionsRef,
  sendPositions,
  redrawWaveform,
  startRecording,
  stopRecordingAndExport,
  meterEnable,
  getMaybeSnapToZero,
  setMaybeSnapToZero,

  hasActiveSession,
  showInfoOverlay,
  hideInfoOverlay,
  micHoldStart,
  micHoldStop
} = {}) {

  // Singleton guard (reuse existing instance if already initialized)
  if (window.__granularHotkeys_v18) return window.__granularHotkeys_v18.api;

  // Base utility functions
  const isEditable = (el) => {
    if (!el) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName?.toUpperCase();
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') {
      const t = (el.type || '').toLowerCase();
      return ['text','search','url','tel','email','password','number','file'].includes(t);
    }
    return false;
  };
  const noMods = (e) => !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const meterOn  = () => { try { meterEnable?.(true);  } catch {} };
  const meterOff = () => { try { meterEnable?.(false); } catch {} };

  // DOM element queries
  const getLoadBtn  = () =>
    document.getElementById('ioLoadBtn') ||
    document.getElementById('loadBtn')   ||
    document.querySelector('[data-action="load"]');

  const getMicBtn   = () =>
    document.getElementById('ioMicBtn')  ||
    document.getElementById('micBtn')    ||
    document.getElementById('btnMic')    ||
    document.querySelector('[data-action="mic"]');

  const getResetBtn = () =>
    document.getElementById('stopButton') ||
    document.getElementById('ioResetBtn') ||
    document.getElementById('resetBtn')   ||
    document.querySelector('[data-action="reset"],[data-role="reset"],[aria-label="Reset"],button[title="Reset"]');

  const getFileInput = () => document.getElementById('audioFileInput');

  const getInfoBtn = () =>
    document.getElementById('ioInfoBtn') ||
    document.getElementById('infoBtn')   ||
    document.querySelector('[data-action="info"]') ||
    document.querySelector('.io-round-btn.io-unload');

  // HOLD button getter
  const getHoldBtn = () =>
    document.getElementById('ioHoldBtn') ||
    document.getElementById('holdBtn')   ||
    document.querySelector('[data-action="hold"]');

  // Press effect helper (visual feedback for keyboard actions)
  const PressFX = (() => {
    const pressed = new Set();
    const apply  = (el) => { if (el && !pressed.has(el)) { el.classList.add('kbd-press'); pressed.add(el); } };
    const remove = (el) => { if (el && pressed.has(el))  { el.classList.remove('kbd-press'); pressed.delete(el); } };
    const removeAll = () => { pressed.forEach(el => el?.classList?.remove('kbd-press')); pressed.clear(); };
    // Global cleanup handlers
    window.addEventListener('blur', removeAll, true);
    document.addEventListener('visibilitychange', () => { if (document.hidden) removeAll(); });
    return { apply, remove, removeAll };
  })();

  // Action handlers
  const clickEl = (el) => { if (!el) return false; try { el.click?.(); el.dispatchEvent?.(new Event('click',{bubbles:true})); return true; } catch { return false; } };

  function clickResetAndReturnEl() {
    const el = getResetBtn();
    if (el) { clickEl(el); return el; }
    const fns = ['resetAll','onReset','doReset','handleReset','resetApp','reset'];
    for (const name of fns) { const fn = window[name]; if (typeof fn === 'function') { try { fn(); } catch {} break; } }
    window.dispatchEvent(new CustomEvent('granular:reset'));
    return el;
  }

  // Open file picker - uses showPicker if available, otherwise click()
  function openLoadPicker() {
    const fileIn = getFileInput();
    if (!fileIn) return;
    try {
      if (typeof fileIn.showPicker === 'function') fileIn.showPicker();
      else fileIn.click();
    } catch {
      try { fileIn.click(); } catch {}
    }
  }

  // Master fader and slider control logic
  const getMaster = () =>
    window.MasterFader?.getLinear?.() ??
    (document.getElementById('masterFader') ? Number(document.getElementById('masterFader').value) : null);

  const setMaster = (v) => {
    v = clamp01(v);
    if (window.MasterFader?.setLinear) { window.MasterFader.setLinear(v); return; }
    const r = document.getElementById('masterFader');
    if (r) {
      if (!r.step || r.step === '1') r.step = 'any';
      r.value = v;
      r.dispatchEvent(new Event('input', { bubbles:true }));
    }
  };

  const SLIDER_IDS = [
    'attackRange','grainSizeRange','pitchRange','filterCutoffRange','spreadRange',
    'panRange','releaseRange','densityRange','lfoFreqRange','lfoDepthRange',
    'scanSpeedRange','gainRange','filterQRange','filterDriveRange'
  ];
  const SNAP_BYPASS_IDS = new Set(['pitchRange','panRange','scanSpeedRange']);
  const getSlider = (id) => document.getElementById(id);

  (function ensureFloatSteps(){
    const doIt = () => { for (const id of SLIDER_IDS) { const el = getSlider(id); if (el && (!el.step || el.step === '1')) el.step = 'any'; } };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', doIt, { once:true });
    else setTimeout(doIt, 0);
  })();

  // Patch "snap to zero" during keyboard adjustment: bypass on pitch/pan/scan
  try {
    if (typeof getMaybeSnapToZero === 'function' && typeof setMaybeSnapToZero === 'function') {
      const __origMaybeSnap = getMaybeSnapToZero();
      let __kbParamAdjusting = false;
      window.__setKbParamAdjusting = (on) => { __kbParamAdjusting = !!on; };
      const patched = function(el) {
        if (__kbParamAdjusting && el && SNAP_BYPASS_IDS.has(el.id)) return;
        return __origMaybeSnap?.(el);
      };
      setMaybeSnapToZero(patched);
      window.addEventListener('pagehide', () => { try { setMaybeSnapToZero(__origMaybeSnap); } catch {} });
    }
  } catch {}

  // Parameter key mapping (numeric badge keys)
  const tokenToSlider = {
    Digit1:'attackRange', 
    Digit2:'releaseRange', 
    Digit3:'grainSizeRange', 
    Digit4:'densityRange',
    Digit5:'spreadRange', 
    Digit6:'scanSpeedRange', 
    Digit7:'lfoFreqRange', 
    Digit8:'lfoDepthRange',
    Digit9:'pitchRange', 
    Digit0:'filterCutoffRange', 
    Quote:'panRange', 
    IGRAVE:'gainRange'
  };
  const tokenLabels = {
    Digit1:'1', Digit2:'2', Digit3:'3', Digit4:'4', Digit5:'5',
    Digit6:'6', Digit7:'7', Digit8:'8', Digit9:'9', Digit0:'0',
    Quote:'’', IGRAVE:'ì'
  };
  window.__granularKeyTokenToSlider = tokenToSlider;
  window.__granularKeyTokenLabels   = tokenLabels;

  // Key recognition for Quote and special keys on Italian keyboard layout
  const learnedCodeToToken = new Map(); // es. { "Quote"->"Quote", "IntlBackslash"->"IGRAVE" }
  const paramCodeToToken = new Map();
  const getParamToken = (e) => {
    const c = e.code || '';
    if (learnedCodeToToken.has(c)) return learnedCodeToToken.get(c);
    if (tokenToSlider[c]) return c;
    if (/^Numpad[0-9]$/.test(c)) {
      const mapped = 'Digit' + c.slice(6);
      if (tokenToSlider[mapped]) return mapped;
    }
    const keyLower = (e.key || '').toLowerCase();

    if ((e.key === "'" || e.key === '’') && !e.shiftKey && !e.altKey) {
      if (c) learnedCodeToToken.set(c, 'Quote');
      return 'Quote';
    }
    if (keyLower === 'ì' && !e.shiftKey && !e.altKey) {
      if (c) learnedCodeToToken.set(c, 'IGRAVE');
      return 'IGRAVE';
    }
    if (['IntlBackslash','BracketLeft','BracketRight','Backslash','Backquote'].includes(c)) {
      if (e.key === 'Dead' || !['[',']','\\','`'].includes(keyLower)) {
        learnedCodeToToken.set(c, 'IGRAVE');
        return 'IGRAVE';
      }
    }
    if (c === 'Quote') {
      learnedCodeToToken.set(c, 'Quote');
      return 'Quote';
    }
    return null;
  };

  const HOLD_HZ = 25;
  const hold = { left:false, right:false, up:false, down:false, raf:0, lastT:0 };
  const mods = { shift:false, alt:false };
  const paramMode = { stack: [], downSet: new Set(), activeId: null, lastTouch: 0 };

  const pushParamToken = (tok, code) => {
    if (!tok) return;
    if (!paramMode.downSet.has(tok)) {
      paramMode.downSet.add(tok);
      const i = paramMode.stack.indexOf(tok);
      if (i >= 0) paramMode.stack.splice(i, 1);
      paramMode.stack.push(tok);
      paramMode.activeId = tokenToSlider[tok] || null;
      paramMode.lastTouch = performance.now();
    }
    if (code) paramCodeToToken.set(code, tok);
  };
  const releaseParamToken = (tok) => {
    if (!tok) return;
    if (paramMode.downSet.delete(tok)) paramMode.lastTouch = performance.now();
    const i = paramMode.stack.indexOf(tok);
    if (i >= 0) paramMode.stack.splice(i, 1);
    const last = paramMode.stack[paramMode.stack.length - 1];
    paramMode.activeId = last ? (tokenToSlider[last] || null) : null;
  };
  const maybeAutoExitParam = () => {
    if (!paramMode.activeId) return;
    const idle = performance.now() - paramMode.lastTouch;
    if (paramMode.downSet.size === 0 && !mods.alt && idle > 150) paramMode.activeId = null;
  };

  const adjustSliderNormalized = (id, normDelta) => {
    const el = document.getElementById(id);
    if (!el) return;
    let min = parseFloat(el.min); if (!isFinite(min)) min = 0;
    let max = parseFloat(el.max); if (!isFinite(max)) max = 1;
    let v   = parseFloat(el.value); if (!isFinite(v)) v = min;
    v += (max - min) * normDelta;
    v = Math.min(max, Math.max(min, v));
    el.valueAsNumber = v;
    if (Math.abs((el.valueAsNumber ?? parseFloat(el.value)) - v) > 1e-9) { el.step = 'any'; el.valueAsNumber = v; }
    const bypass = SNAP_BYPASS_IDS.has(id);
    if (bypass && typeof window.__setKbParamAdjusting === 'function') window.__setKbParamAdjusting(true);
    try {
      el.dispatchEvent(new Event('input',  { bubbles:true }));
      el.dispatchEvent(new Event('change', { bubbles:true }));
    } finally {
      if (bypass && typeof window.__setKbParamAdjusting === 'function') window.__setKbParamAdjusting(false);
    }
  };

  const nudgeCursor = (delta) => {
    if (!Array.isArray(positionsRef)) return;
    const idx = typeof getActiveCursor === 'function' ? getActiveCursor() : 0;
    positionsRef[idx] = clamp01((positionsRef[idx] ?? 0) + delta);
    sendPositions?.();
    redrawWaveform?.();
  };

  // Keydown state flags and debounce
  const downFlags = { L:false, M:false, Backspace:false, P:false };
  window.__keyI_isDown = false;

  // Guard for "P" key (prevents double toggles and freeze on key repeat)
  const PToggleGuard = {
    lastTs: 0,
    minGapMs: 140,
    arming: false
  };

  // Guard for MIC (prevents double start/stop when browser generates repeated events)
  const MicGuard = {
    busy: false,
    setBusy(on){ this.busy = !!on; },
    async safely(fn){
      if (this.busy) return;
      this.busy = true;
      try { await fn(); } finally { this.busy = false; }
    }
  };

  // Key event handlers
  const onKeyDown = (e) => {
    if (isEditable(e.target)) return;

    if (e.key === 'Shift') mods.shift = true;
    if (e.key === 'Alt')   mods.alt   = true;

    // Parameter holding (keys 1-0, quote, special chars)
    if (!e.metaKey && !e.ctrlKey) {
      const tok = getParamToken(e);
      if (tok) { e.preventDefault(); pushParamToken(tok, e.code); return; }
    }

    // Space key: Play/Pause toggle
    if ((e.key === ' ' || e.code === 'Space') && !e.repeat && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      const sw = typeof getPlaySwitchInput === 'function' ? getPlaySwitchInput() : null;
      if (sw) { sw.checked = !sw.checked; sw.dispatchEvent(new Event('change', { bubbles:true })); }
      else document.getElementById('playButton')?.click();
      meterOn();
      return;
    }

    // I key: overlay (HOLD behavior)
    if ((e.key || '').toLowerCase() === 'i' && noMods(e)) {
      if (typeof hasActiveSession === 'function' && !hasActiveSession()) return;
      if (window.__keyI_isDown) return;
      e.preventDefault();
      window.__keyI_isDown = true;

      const infoBtn = getInfoBtn();
      if (infoBtn) PressFX.apply(infoBtn);

      const ws = document.getElementById('waveSplash');
      if (ws && ws.dataset.hold !== 'key-i') {
        ws.dataset.hold = 'key-i';
        showInfoOverlay?.('info');
      }
      meterOff();
      return;
    }

    // L key: press effect on keydown (file picker opens on keyup)
    if ((e.key || '').toLowerCase() === 'l' && !e.repeat && noMods(e)) {
      e.preventDefault();
      if (!downFlags.L) {
        downFlags.L = true;
        const btn = getLoadBtn();
        if (btn) PressFX.apply(btn);
      }
      meterOn();
      return;
    }

    // R key: Recording toggle
    if ((e.key || '').toLowerCase() === 'r' && !e.repeat && noMods(e)) {
      e.preventDefault();
      const recSW = typeof getRecSwitchInput === 'function' ? getRecSwitchInput() : null;
      if (recSW) { recSW.checked = !recSW.checked; recSW.dispatchEvent(new Event('change', { bubbles:true })); }
      else if (typeof startRecording === 'function' && typeof stopRecordingAndExport === 'function') {
        (window.__isRecordingFlag = !window.__isRecordingFlag)
          ? startRecording?.()
          : stopRecordingAndExport?.();
      }
      meterOn();
      return;
    }

    // M key: MIC (HOLD) - keydown = press effect + start hold (with guard)
    if ((e.key || '').toLowerCase() === 'm' && noMods(e)) {
      if (downFlags.M) return;
      e.preventDefault();
      const mic = getMicBtn();
      downFlags.M = true;

      hideInfoOverlay?.();  // Close overlay if recording starts

      if (mic && !mic.classList.contains('is-armed') && !mic.classList.contains('is-recording')) {
        PressFX.apply(mic);
      }
      // Prevent re-entry while mic flow starts
      MicGuard.safely(async () => {
        try { await micHoldStart?.(); } catch {}
      });
      meterOn();
      return;
    }

    // Q / Shift+Q: switch cursor (previous/next)
    if ((e.key || '').toLowerCase() === 'q' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      const dir  = e.shiftKey ? -1 : +1;
      const cur  = typeof getActiveCursor === 'function' ? getActiveCursor() : 0;
      const next = (cur + dir + 3) % 3;
      setActiveCursor?.(next);
      return;
    }

    // P key: HOLD (keydown = press effect, keyup = debounced toggle)
    if ((e.key || '').toLowerCase() === 'p' && !e.repeat && noMods(e)) {
      e.preventDefault();
      if (!downFlags.P) {
        downFlags.P = true;
        PToggleGuard.arming = true; // Arm the toggle for keyup
        const btn = getHoldBtn();
        if (btn) PressFX.apply(btn);
      }
      return;
    }

    // Arrow keys
    const keyIsLeft  = (e.key === 'ArrowLeft'  || e.key === 'Left'  || e.keyCode === 37);
    const keyIsRight = (e.key === 'ArrowRight' || e.key === 'Right' || e.keyCode === 39);
    const keyIsUp    = (e.key === 'ArrowUp'    || e.key === 'Up'    || e.keyCode === 38);
    const keyIsDown  = (e.key === 'ArrowDown'  || e.key === 'Down'  || e.keyCode === 40);

    if ((keyIsLeft || keyIsRight) && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      maybeAutoExitParam();
      if (keyIsLeft)  hold.left  = true;
      if (keyIsRight) hold.right = true;
      startHoldLoop();
      return;
    }
    if ((keyIsUp || keyIsDown) && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      if (keyIsUp)   hold.up   = true;
      if (keyIsDown) hold.down = true;
      startHoldLoop();
      return;
    }

    // Backspace → RESET (keydown = azione + press FX)
    if ((e.key === 'Backspace' || e.keyCode === 8) && noMods(e)) {
      e.preventDefault();
      if (!downFlags.Backspace) {
        downFlags.Backspace = true;
        const btn = getResetBtn();
        if (btn) PressFX.apply(btn);
      }
      const used = clickResetAndReturnEl();
      if (!getResetBtn() && used) PressFX.apply(used);
      return;
    }
  };

  const onKeyUp = (e) => {
    if (e.key === 'Shift') mods.shift = false;
    if (e.key === 'Alt')   { mods.alt = false; setTimeout(() => { maybeAutoExitParam(); }, 0); }

    if (paramCodeToToken.has(e.code)) {
      const tok = paramCodeToToken.get(e.code);
      paramCodeToToken.delete(e.code);
      releaseParamToken(tok);
    } else {
      const tok2 = getParamToken(e);
      if (tok2) releaseParamToken(tok2);
    }

    const keyIsLeft  = (e.key === 'ArrowLeft'  || e.key === 'Left'  || e.keyCode === 37);
    const keyIsRight = (e.key === 'ArrowRight' || e.key === 'Right' || e.keyCode === 39);
    const keyIsUp    = (e.key === 'ArrowUp'    || e.key === 'Up'    || e.keyCode === 38);
    const keyIsDown  = (e.key === 'ArrowDown'  || e.key === 'Down'  || e.keyCode === 40);

    if (keyIsLeft)  { hold.left  = false; if (!hold.right && !hold.up && !hold.down) stopHoldLoop(); }
    if (keyIsRight) { hold.right = false; if (!hold.left  && !hold.up && !hold.down) stopHoldLoop(); }
    if (keyIsUp)    { hold.up    = false; if (!hold.down && !hold.left && !hold.right) stopHoldLoop(); }
    if (keyIsDown)  { hold.down  = false; if (!hold.up   && !hold.left && !hold.right) stopHoldLoop(); }

    // M key: end hold + remove press effect (with guard)
    if ((e.key || '').toLowerCase() === 'm' && noMods(e)) {
      const mic = getMicBtn();
      PressFX.remove(mic);
      downFlags.M = false;
      MicGuard.safely(async () => {
        try { await micHoldStop?.(); } catch {}
      });
      return;
    }

    // L key release: remove press effect and OPEN file picker
    if ((e.key || '').toLowerCase() === 'l' && noMods(e)) {
      const btn = getLoadBtn();
      PressFX.remove(btn);
      if (downFlags.L) {
        downFlags.L = false;
        // Schedule in rAF to avoid conflicts with browser key handling
        requestAnimationFrame(() => openLoadPicker());
        meterOn();
      }
      return;
    }

    // P key release: remove press effect and debounced HOLD toggle
    if ((e.key || '').toLowerCase() === 'p' && noMods(e)) {
      const btn = getHoldBtn();
      PressFX.remove(btn);

      if (downFlags.P) {
        downFlags.P = false;

        // Anti-freeze debounce: ignore keyup events too close together
        const now = performance.now();
        const tooSoon = (now - PToggleGuard.lastTs) < PToggleGuard.minGapMs;
        PToggleGuard.lastTs = now;

        if (PToggleGuard.arming && !tooSoon && btn) {
          PToggleGuard.arming = false;
          // Execute click in microtask to prevent re-entrancy in synchronized handlers
          Promise.resolve().then(() => clickEl(btn));
        } else {
          // Reset arming anyway
          PToggleGuard.arming = false;
        }
      }
      return;
    }

    // Backspace: remove press effect
    if ((e.key === 'Backspace' || e.keyCode === 8) && noMods(e)) {
      const btn = getResetBtn();
      PressFX.remove(btn);
      downFlags.Backspace = false;
      return;
    }

    // I key: close overlay hold
    if ((e.key || '').toLowerCase() === 'i' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      const ws = document.getElementById('waveSplash');
      if (ws && ws.dataset.hold === 'key-i') {
        delete ws.dataset.hold;
        hideInfoOverlay?.();
      }
      const infoBtn = getInfoBtn();
      if (infoBtn) PressFX.remove(infoBtn);
      window.__keyI_isDown = false;
      return;
    }
  };

  // Arrow key hold loop
  function stopHoldLoop(){ if (hold.raf) cancelAnimationFrame(hold.raf); hold.raf = 0; hold.lastT = 0; }
  function startHoldLoop(){
    if (hold.raf) return;
    hold.lastT = performance.now();
    const loop = () => {
      if (!hold.left && !hold.right && !hold.up && !hold.down) { stopHoldLoop(); return; }
      const now = performance.now();
      const dt  = Math.max(0, Math.min(0.050, (now - hold.lastT) / 1000)); // Clamp dt for stability
      hold.lastT = now;

      const dirH = hold.left === hold.right ? 0 : (hold.left ? -1 : +1);
      if (dirH !== 0) {
        const baseH = mods.alt ? 0.001 : 0.005;
        const stepPerSecH = baseH * (mods.shift ? 4 : 1) * HOLD_HZ;
        const normStepH   = stepPerSecH * dt * dirH;
        if (paramMode.activeId) adjustSliderNormalized(paramMode.activeId, normStepH);
        else nudgeCursor(normStepH);
      }

      const dirV = hold.up === hold.down ? 0 : (hold.up ? +1 : -1);
      if (dirV !== 0) {
        const cur = getMaster();
        if (cur != null) {
          const baseV = mods.alt ? 0.01 : 0.03;
          const stepPerSecV = baseV * (mods.shift ? 4 : 1) * HOLD_HZ;
          const stepV = stepPerSecV * dt * dirV;
          setMaster(cur + stepV);
        }
      }
      hold.raf = requestAnimationFrame(loop);
    };
    hold.raf = requestAnimationFrame(loop);
  }

  // attach
  document.addEventListener('keydown', onKeyDown, { capture:true });
  document.addEventListener('keyup',   onKeyUp,   { capture:true });

  // Enable metering when play/rec starts or file is loaded
  const PLAY_SW_SEL = '#playSwitch input, .switch.switch--play input';
  const REC_SW_SEL  = '#recSwitch input, .switch.switch--rec input';
  const changeHandler = (ev) => {
    const t = ev.target;
    if (!t) return;
    if (t.matches?.(PLAY_SW_SEL) && t.checked) meterOn();
    else if (t.matches?.(REC_SW_SEL) && t.checked) meterOn();
    else if (t.id === 'audioFileInput' && t.files && t.files.length) meterOn();
  };
  document.addEventListener('change', changeHandler, true);
  ['#ioMicBtn','#micBtn','#btnMic','[data-action="mic"]'].forEach(sel => {
    const b = document.querySelector(sel);
    if (b) b.addEventListener('pointerdown', meterOn, { capture:true });
  });

  // Cleanup on unload/hard blur
  const destroy = () => {
    try {
      document.removeEventListener('keydown', onKeyDown, { capture:true });
      document.removeEventListener('keyup',   onKeyUp,   { capture:true });
      document.removeEventListener('change',  changeHandler, true);
    } catch {}
    PressFX.removeAll();
    try { delete window.__setKbParamAdjusting; } catch {}
  };

  const api = { destroy, version: 'v18' };
  window.__granularHotkeys_v18 = { api };
  return api;
}
