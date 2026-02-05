/**
 * @fileoverview Input/Output split panel functionality.
 * 
 * Provides wiring for the I/O split UI including:
 * - Load button functionality for audio file input
 * - Microphone button with hold-to-record behavior
 * - Width adjustment based on reset button dimensions
 * - Switch scale calibration for consistent UI sizing
 * 
 * @module ui/io/io-split
 */

import { micHoldStart, micHoldStop } from '../../app/session/mic-session.js';

const $ = (id) => document.getElementById(id);

export function initIOSplitWiring(){
  const loadBtn = $('ioLoadBtn');
  const micBtn  = $('ioMicBtn');
  const fileIn  = $('audioFileInput');

  if (loadBtn && !loadBtn.__ioLoadBound) {
    loadBtn.__ioLoadBound = true;
    loadBtn.addEventListener('click', () => { fileIn?.click(); });
  }

  if (micBtn && !micBtn.__ioMicBound) {
    micBtn.__ioMicBound = true;

    const stopMicIfActive = async () => {
      await micHoldStop();
    };

    micBtn.addEventListener('pointerdown', async (e) => {
      try { micBtn.setPointerCapture?.(e.pointerId); } catch {}
      await micHoldStart();
    });

    micBtn.addEventListener('pointerup', stopMicIfActive);
    micBtn.addEventListener('pointercancel', stopMicIfActive);
    micBtn.addEventListener('mouseleave', (e) => { if (e.buttons === 1) stopMicIfActive(); });
    window.addEventListener('blur', stopMicIfActive);
  }
}

export function adjustIOSplitWidth(){
  const split = $('ioSplit');
  const reset = $('stopButton');
  if (!split || !reset) return;

  const halves = split.querySelectorAll('.io-half');
  const n = halves.length > 0 ? halves.length : 3;

  const w = reset.getBoundingClientRect().width;
  if (w > 0) {
    const factor = n + 0.1;
    split.style.width = Math.round(w * factor) + 'px';
  }
}

export function calibrateSwitchScale(targetHeightPx = 64){
  const scale = Math.max(0.1, Math.min(1.0, targetHeightPx / 195));
  document.documentElement.style.setProperty('--switch-scale', String(scale));
}
