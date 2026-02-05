/**
 * @fileoverview Waveform marker rendering and drag handling.
 * Draws position markers (A/B/C) on the waveform canvas and
 * handles pointer-based dragging for cursor positioning.
 *
 * @module ui/waveform/markers
 */

import { setEngineHooks } from '../../app/engine/audio-engine.js';
import { positions, activeCursor, setActiveCursor, sendPositions } from '../../app/state/cursors.js';
import { getAudioBuffer } from '../../app/session/buffer-session.js';
import { drawWaveform } from './waveform.js';

const $ = (id) => document.getElementById(id);
function clamp01(x) { return Math.max(0, Math.min(1, x)); }

// Marker drag state
let dragState = { active:false, armed:false, which:-1, startX:0, startTime:0, pointerId:null };
export const dragLock = [false, false, false];

// Connect dragLock to the engine (prevents position updates from worklet during drag)
setEngineHooks({ dragLockRef: dragLock });

function isMicLive(){
  return !!document.querySelector('.granular-ui')?.classList.contains('mic-live');
}

export function drawMarkers(ctx, canvas){
  if (isMicLive()) return;

  const draggingA = dragState.active && dragState.which === 0;
  const draggingB = dragState.active && dragState.which === 1;
  const draggingC = dragState.active && dragState.which === 2;

  const colors = [
    "hsla(132, 10%, 58%, 1.00)", // A (green)
    "hsla(200, 17%, 58%, 1.00)", // B (blue)
    "hsla(0, 17%, 58%, 1.00)"    // C (red/orange)
  ];
  const labels = ["A","B","C"];
  const drags  = [draggingA, draggingB, draggingC];
  const order = [0,1,2].filter(i => i !== activeCursor).concat(activeCursor);

  for (const i of order) {
    drawMarker(
      ctx, canvas,
      positions[i],
      colors[i],
      labels[i],
      activeCursor === i,
      drags[i]
    );
  }
}

function drawMarker(ctx, canvas, posNorm, color, label, isActive, isDragging) {
  if (isMicLive()) return;

  const dpr   = window.devicePixelRatio || 1;
  const x     = posNorm * canvas.width;
  const baseW = 3 * dpr, activeW = 6 * dpr;

  const idx = (label === 'A' ? 0 : (label === 'B' ? 1 : 2));
  const targetW = (isActive || isDragging) ? activeW : baseW;

  const now        = performance.now();
  const TAU_OPEN_MS  = 160;
  const TAU_CLOSE_MS = 90;
  const DT_CAP     = 16;

  const st = drawMarker.__state || (drawMarker.__state = {
    w: [baseW, baseW, baseW],
    t: [now,   now,   now  ],
    raf: 0
  });

  const dtRaw = now - st.t[idx];
  const dt    = Math.max(0, Math.min(dtRaw, DT_CAP));
  st.t[idx]   = now;

  const isOpening = (targetW > st.w[idx] + 0.01);
  const TAU_MS    = isOpening ? TAU_OPEN_MS : TAU_CLOSE_MS;

  const k = 1 - Math.exp(-dt / TAU_MS);
  st.w[idx] += (targetW - st.w[idx]) * k;

  const lineW = st.w[idx];
  const y0 = lineW / 2, y1 = canvas.height - lineW / 2;

  const prog = Math.max(0, Math.min(1, (lineW - baseW) / (activeW - baseW)));

  // Step 0: Knockout (erase behind marker)
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.lineWidth   = lineW + 2 * dpr;
  ctx.lineCap     = 'round';
  ctx.strokeStyle = 'rgba(0,0,0,0)';
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur  = 0;

  ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
  ctx.restore();

  // Step 1: Glow effect
  if (isActive || isDragging || prog > 0) {
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.shadowColor = color;
    ctx.shadowBlur  = (22 * dpr) * prog;
    ctx.globalAlpha = 0.30 + 0.90 * prog;
    ctx.lineWidth   = lineW;
    ctx.lineCap     = 'round';
    ctx.strokeStyle = color;
    ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
    ctx.restore();
  }

  // Step 2: Central line
  ctx.save();
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur  = 0;
  ctx.lineWidth   = lineW;
  ctx.lineCap     = 'round';
  ctx.strokeStyle = color;
  ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
  ctx.restore();

  // Step 3: Continue animation if needed
  if (Math.abs(st.w[idx] - targetW) > 0.01 && !st.raf) {
    st.raf = requestAnimationFrame(() => {
      st.raf = 0;
      try { const buf = getAudioBuffer(); if (buf) drawWaveform(buf); } catch {}
    });
  }
}

function hitWhichMarker(e){
  const canvas = $("waveformCanvas");
  const rect = canvas.getBoundingClientRect();
  const xCss = e.clientX - rect.left;
  const xs = [positions[0] * rect.width, positions[1] * rect.width, positions[2] * rect.width];
  const base = 6;
  const tol = [
    (activeCursor === 0 ? base + 2 : base),
    (activeCursor === 1 ? base + 2 : base),
    (activeCursor === 2 ? base + 2 : base)
  ];
  const d = xs.map((xx, i) => Math.abs(xCss - xx));
  const hits = d.map((dist, i) => dist <= tol[i]);
  const indices = [0,1,2].filter(i => hits[i]);
  if (indices.length === 0) return -1;
  if (indices.length === 1) return indices[0];
  let best = indices[0], bestD = d[best];
  for (const i of indices) { if (d[i] < bestD) { best = i; bestD = d[i]; } }
  return best;
}

export function initMarkerDragging(){
  const canvas = $("waveformCanvas");
  if (!canvas) return;

  try { canvas.style.touchAction = 'none'; } catch {}

  const SLOP_PX = 1;
  let pointerId = null;

  const onPointerDown = (e) => {
    if (!getAudioBuffer() || isMicLive()) return;

    const which = hitWhichMarker(e);
    if (which === -1) return;

    dragState = {
      active:   false,
      armed:    true,
      which,
      startX:   e.clientX,
      startTime: performance.now(),
      pointerId: e.pointerId
    };

    dragLock[which] = true;
    setActiveCursor(which);

    try { canvas.setPointerCapture(e.pointerId); } catch {}
    pointerId = e.pointerId;

    const buf = getAudioBuffer();
    if (buf) requestAnimationFrame(() => drawWaveform(buf));
  };

  const onPointerMove = (e) => {
    if (dragState.which < 0) {
      const whichHover = hitWhichMarker(e);
      canvas.style.cursor = (whichHover === -1 || isMicLive()) ? "default" : "col-resize";
      return;
    }

    const rect = canvas.getBoundingClientRect();
    const xNorm = clamp01((e.clientX - rect.left) / rect.width);

    if (!dragState.active) {
      const dx = Math.abs(e.clientX - dragState.startX);
      if (dx >= SLOP_PX) {
        dragState.active = true;
        dragState.armed  = false;
        positions[dragState.which] = xNorm;
        sendPositions();
        const buf1 = getAudioBuffer();
        if (buf1) requestAnimationFrame(() => drawWaveform(buf1));
      }
      return;
    }

    positions[dragState.which] = xNorm;
    sendPositions();
    const buf2 = getAudioBuffer();
    if (buf2) drawWaveform(buf2);
  };

  const onPointerUp = (e) => {
    if (dragState.which >= 0) dragLock[dragState.which] = false;

    try { canvas.releasePointerCapture(pointerId ?? e.pointerId); } catch {}
    pointerId = null;

    dragState = { active:false, armed:false, which:-1, startX:0, startTime:0, pointerId:null };
    canvas.style.cursor = "default";
    const buf = getAudioBuffer();
    if (buf) requestAnimationFrame(() => drawWaveform(buf));
  };

  const onPointerCancel = onPointerUp;

  canvas.addEventListener("pointerdown",   onPointerDown);
  canvas.addEventListener("pointermove",   onPointerMove);
  canvas.addEventListener("pointerup",     onPointerUp);
  canvas.addEventListener("pointercancel", onPointerCancel);
}
