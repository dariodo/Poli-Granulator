/**
 * @fileoverview Splash screen overlay component.
 * Manages the wave splash overlay, keyboard shortcuts display (keycaps),
 * and the unload/info button wiring.
 *
 * @module ui/overlay/splash
 */

import { setDbMeterEnabled } from '../../app/engine/audio-engine.js';
import { getAudioBuffer } from '../../app/session/buffer-session.js';

const waveSplash   = document.getElementById('waveSplash');
const ioUnloadBtn  = document.getElementById('ioUnloadBtn');
const ioMicBtn     = document.getElementById('ioMicBtn');
const fileInput    = document.getElementById('audioFileInput');

export function setKeycapsVisible(on){
  const root = document.querySelector('.granular-ui');
  if (!root) return;
  root.classList.add('keycaps-inside');
  root.classList.toggle('keycaps-on', !!on);
}

export function labelKnobsFromHotkeys(){
  const tokenToSlider = window.__granularKeyTokenToSlider || {
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
  const labels = window.__granularKeyTokenLabels || {
    Digit1:'1', Digit2:'2', Digit3:'3', Digit4:'4', Digit5:'5',
    Digit6:'6', Digit7:'7', Digit8:'8', Digit9:'9', Digit0:'0', Quote:'’', IGRAVE:'ì'
  };

  document.querySelectorAll('.params .col[data-key]')
    .forEach(col => { col.removeAttribute('data-key'); col.removeAttribute('aria-keyshortcuts'); });

  const order = ['Digit1','Digit2','Digit3','Digit4','Digit5','Digit6','Digit7','Digit8','Digit9','Digit0','Quote','IGRAVE'];

  order.forEach(tok => {
    const sliderId = tokenToSlider[tok];
    if (!sliderId) return;
    const input = document.getElementById(sliderId);
    if (!input) return;
    const col = input.closest('.col') || input.closest('.params .col') || input.parentElement;
    if (!col) return;
    const label = labels[tok] || '';
    col.dataset.key = label;
    col.setAttribute('aria-keyshortcuts', label);
  });
}

export function wireKnobKeycaps(){
  const cols = Array.from(document.querySelectorAll('.params .col[data-key]'));

  if (!window.__keycapsKD__){
    window.__keycapsKD__ = (e) => {
      const k = (e.key || '').toLowerCase();
      const hit = cols.find(c => (c.dataset.key || '').toLowerCase() === k);
      if (hit) hit.classList.add('keycap-pressed');
    };
    window.addEventListener('keydown', window.__keycapsKD__, true);
  }
  if (!window.__keycapsKU__){
    window.__keycapsKU__ = (e) => {
      const k = (e.key || '').toLowerCase();
      const hit = cols.find(c => (c.dataset.key || '').toLowerCase() === k);
      if (hit) hit.classList.remove('keycap-pressed');
    };
    window.addEventListener('keyup', window.__keycapsKU__, true);
  }
}

export function showSplash(mode = 'idle'){
  if (!waveSplash) return;
  waveSplash.dataset.mode = mode;
  waveSplash.classList.add('is-visible');

  if (mode === 'info') {
    labelKnobsFromHotkeys();
    setKeycapsVisible(true);
  } else {
    setKeycapsVisible(false);
  }
}

export function hideSplash(){
  waveSplash?.classList.remove('is-visible');
  setKeycapsVisible(false);
}

export function showSplashStatic(mode = 'idle'){
  if (!waveSplash) return;
  waveSplash.dataset.mode = mode;

  waveSplash.classList.add('no-anim');
  waveSplash.classList.add('is-visible');

  requestAnimationFrame(() => {
    waveSplash.classList.remove('no-anim');
  });
}

function initUnloadButton(){
  const btn = ioUnloadBtn;
  const ws  = waveSplash;
  if (!btn || !ws) return;
  if (btn.__unloadBound) return;
  btn.__unloadBound = true;

  btn.onclick = null;

  const showInfoHold = (e) => {
    e.preventDefault();

    if (!getAudioBuffer()) return;

    ws.dataset.hold = 'mouse-i';
    showSplash('info');
    try { setDbMeterEnabled(false); } catch {}

    const closeOnce = () => {
      if (ws.dataset.hold === 'mouse-i') {
        hideSplash();
        delete ws.dataset.hold;
      }
    };

    window.addEventListener('pointerup',     closeOnce, { once:true, capture:true });
    window.addEventListener('pointercancel', closeOnce, { once:true, capture:true });
    window.addEventListener('blur',          closeOnce, { once:true, capture:true });
    btn.addEventListener('mouseleave',       closeOnce, { once:true, capture:true });
  };

  btn.addEventListener('pointerdown', showInfoHold, { capture:true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initUnloadButton);
} else {
  initUnloadButton();
}

document.addEventListener('DOMContentLoaded', () => { showSplashStatic('idle'); });

fileInput?.addEventListener('change', () => { hideSplash(); });

// FIX overlay: non chiudere su keydown sul MIC, solo pointerdown
ioMicBtn?.addEventListener('pointerdown', hideSplash, { passive: true });
