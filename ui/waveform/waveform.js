/**
 * @fileoverview Waveform display canvas component.
 * Handles waveform rendering, peaks caching, scheduled redraws,
 * and microphone overlay visualization.
 *
 * @module ui/waveform/waveform
 */

import { drawMarkers, initMarkerDragging } from './markers.js';

// Waveform peaks cache
let waveformPeaks = null;
let peaksForWidth = 0;
let peaksBufferRef = null;

// Last drawn buffer (for requestWaveformRedraw)
let __lastBuffer = null;

// Mic viz state (come nel main)
let micViz = { active:false, analyser:null, data:null, rafId:0 };
const MIC_VIZ_COLOR = 'rgba(255, 255, 255, 0.7)';

const $ = (id) => document.getElementById(id);

// ----------------------------------------
// Hi-DPI Canvas Helpers
// ----------------------------------------
export function resizeWaveformCanvas(){
  const canvas = $("waveformCanvas");
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.floor(rect.width  * dpr));
  const h = Math.max(1, Math.floor(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width  = w;
    canvas.height = h;
  }
}

export function resetWaveformCache(){
  waveformPeaks = null;
  peaksForWidth = 0;
  peaksBufferRef = null;
}

export function rebuildPeaksIfNeeded(buffer = null){
  const buf = buffer || __lastBuffer;
  if (!buf) return;
  resizeWaveformCanvas();
  const canvas = $("waveformCanvas");
  if (!canvas) return;
  if (peaksForWidth !== canvas.width || peaksBufferRef !== buf) {
    waveformPeaks   = buildPeaks(buf.getChannelData(0), canvas.width);
    peaksForWidth   = canvas.width;
    peaksBufferRef  = buf;
  }
}

// ----------------------------------------
// Redraw Scheduler (one per frame)
// ----------------------------------------
let __waveformRedrawScheduled = false;
export function requestWaveformRedraw() {
  if (__waveformRedrawScheduled) return;
  __waveformRedrawScheduled = true;
  requestAnimationFrame(() => {
    __waveformRedrawScheduled = false;
    try {
      if (__lastBuffer) drawWaveform(__lastBuffer);
    } catch (e) {
      console.warn('[waveform] redraw error:', e);
    }
  });
}

// ----------------------------------------
// Microphone Visualization Controls (used by ui/mic/mic-visualizer.js)
// ----------------------------------------
export function __setMicAnalyser(analyser){
  if (!analyser) return;
  micViz.active   = true;
  micViz.analyser = analyser;
  micViz.data     = new Float32Array(analyser.fftSize);
}
export function __clearMicAnalyser(){
  micViz.active   = false;
  micViz.analyser = null;
  micViz.data     = null;
}
export function __isMicActive(){ return !!micViz.active; }

// ----------------------------------------
// Draw Waveform
// ----------------------------------------
export function drawWaveform(buffer) {
  const canvas = $("waveformCanvas");
  if (!canvas) return;

  // Live microphone visualization
  if (micViz.active && micViz.analyser) {
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    resizeWaveformCanvas();
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const A = micViz.analyser;
    if (!micViz.data || micViz.data.length !== A.fftSize) micViz.data = new Float32Array(A.fftSize);
    A.getFloatTimeDomainData(micViz.data);
    ctx.lineWidth = Math.max(1, 1.5 * dpr);
    ctx.strokeStyle = MIC_VIZ_COLOR;
    ctx.beginPath();
    const mid = H / 2;
    for (let i = 0; i < micViz.data.length; i++) {
      const x = (i / (micViz.data.length - 1)) * (W - 1) + 0.5;
      const y = mid + micViz.data[i] * (H * 0.44);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    return;
  }

  if (!buffer) return;
  __lastBuffer = buffer;

  rebuildPeaksIfNeeded(buffer);

  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const data = buffer.getChannelData(0);
  const amp  = canvas.height / 2;

  if (waveformPeaks && peaksForWidth === canvas.width && peaksBufferRef === buffer){
    ctx.beginPath();
    for (let x = 0; x < canvas.width; x++){
      const min = waveformPeaks[x*2];
      const max = waveformPeaks[x*2+1];
      ctx.moveTo(x + 0.5, (1 + min) * amp);
      ctx.lineTo(x + 0.5, (1 + max) * amp);
    }
    ctx.strokeStyle = "rgba(255, 255, 255, 0.7)";
    ctx.lineWidth = 1 * dpr;
    ctx.stroke();
  } else {
    const W = canvas.width;
    ctx.beginPath();
    for (let x = 0; x < W; x++) {
      let start = Math.floor(x * data.length / W);
      let end   = Math.floor((x + 1) * data.length / W);
      if (end <= start) end = Math.min(start + 1, data.length);
      let min =  1.0, max = -1.0;
      for (let j = start; j < end; j++) {
        const v = data[j];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      if (start >= data.length) { min = 0; max = 0; }
      ctx.moveTo(x + 0.5, (1 + min) * amp);
      ctx.lineTo(x + 0.5, (1 + max) * amp);
    }
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 1 * dpr;
    ctx.stroke();
    waveformPeaks  = null;
    peaksForWidth  = canvas.width;
    peaksBufferRef = buffer;
  }

  // Draw position markers (A/B/C) with drag support
  drawMarkers(ctx, canvas);
}

// ----------------------------------------
// Peaks Builder
// ----------------------------------------
function buildPeaks(floatData, columns){
  const len = floatData.length | 0;
  const W = Math.max(1, columns | 0);
  const out = new Float32Array(W * 2);
  for (let x = 0; x < W; x++){
    let start = Math.floor(x * len / W);
    let end   = Math.floor((x + 1) * len / W);
    if (end <= start) end = Math.min(start + 1, len);
    let min =  1.0, max = -1.0;
    for (let i = start; i < end; i++){
      const v = floatData[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (start >= len) { min = 0; max = 0; }
    out[x*2] = min; out[x*2+1] = max;
  }
  return out;
}

// Initialize marker dragging
initMarkerDragging();
