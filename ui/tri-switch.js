/**
 * @fileoverview Three-position slide switch component (A/B/C) with spring physics.
 * 
 * Drop-in component for .slide-switch3 already in CSS.
 * - Input: click on rail, drag, keyboard (Arrow, Home/End, PageUp/Down)
 * - ARIA: role="slider", aria-valuenow (0..2), aria-valuetext ("A"/"B"/"C" or custom data-*)
 * - API: initTriSwitch3(el, { value=0, onChange })
 *        -> controller: { value, setValue(i, announce=true), destroy() }
 * 
 * Required DOM structure:
 * <button class="slide-switch3" ...>
 *   <span class="rail"></span>
 *   <span class="thumb"></span>
 * </button>
 * (if rail/thumb are missing, they will be created)
 * 
 * Note: CSS uses --steps:2 and --step = travel/steps; we set --pos (0..2, float).
 * 
 * @module ui/tri-switch
 */

export function initTriSwitch3(el, { value = 0, onChange = null } = {}) {
  if (!el) throw new Error('[tri-switch] element not found');

  // ====== Spring parameters (tuned for "physical" and precise snapping) ======
  // Stiffness (k) and damping (d) differ for center position (less bounce)
  const SPRING = {
    k: 0.22, d: 0.18,              // outer positions (0 and 2)
    mid: { k: 0.22, d: 0.4 },     // center (1) -> more dampened
    kickMax: 0.35,                 // maximum "throw" impulse
    maxSteps: 300
  };
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ====== State ======
  let pos = clampIndex(toInt(getAttr(el, 'aria-valuenow'), value)); // 0..2 (float during drag/anim)
  let target = nearestStop(pos);                                    // 0|1|2
  let v = 0;                                                        // velocity "indices per frame"
  let raf = 0;
  let dragging = null;

  // ====== Fail-safe DOM (if rail/thumb missing, create them) ======
  ensurePart(el, 'span.rail', 'rail');
  ensurePart(el, 'span.thumb', 'thumb');

  // ====== ARIA bootstrap ======
  el.setAttribute('role', el.getAttribute('role') || 'slider');
  el.setAttribute('aria-orientation', el.getAttribute('aria-orientation') || 'horizontal');
  el.setAttribute('aria-valuemin', '0');
  el.setAttribute('aria-valuemax', '2');
  applyVisual(pos, false);
  setAria(el, nearestStop(pos));

  // ====== Event wiring ======
  el.addEventListener('click', onClick);
  el.addEventListener('keydown', onKey);
  el.addEventListener('pointerdown', onPointerDown);

  // ====== API controller ======
  function setValue(i, announce = true) {
    const next = clampIndex(i);
    const before = nearestStop(pos);
    target = next;

    if (REDUCED) {
      stopAnim();
      pos = next;
      applyVisual(pos, true);
      setAria(el, next);
      if (announce) emit(before, next);
      return;
    }

    // Softer directional kick toward center
    const delta = next - pos;
    const dir = Math.sign(delta || (next === 1 ? 0.0001 : 0)); // avoid 0 when already aligned
    const kick = dir * Math.min(SPRING.kickMax, Math.abs(delta) * 0.25) * (next === 1 ? 0.55 : 1);
    springTo(next, kick, () => {
      setAria(el, next);
      if (announce) emit(before, next);
    });
  }

  function destroy() {
    stopAnim();
    try { el.removeEventListener('click', onClick); } catch {}
    try { el.removeEventListener('keydown', onKey); } catch {}
    try { el.removeEventListener('pointerdown', onPointerDown); } catch {}
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
  }

  Object.defineProperty(el, 'value', {
    get() { return nearestStop(pos); },
    set(v) { setValue(v, true); }
  });
  el.setValue = setValue; // easy compatibility
  const ctrl = { get value(){ return nearestStop(pos); }, setValue, destroy };

  // ====== Handlers ======
  function onClick(e) {
    if (dragging) return; // end-drag click should not fire
    const { stepPx, pad } = measure(el);
    const rect = el.getBoundingClientRect();
    const x = clamp(e.clientX - rect.left - pad, 0, stepPx * 2);
    const idx = nearestStop(x / stepPx);
    setValue(idx, true);
  }

  function onKey(e) {
    const k = e.key;
    const cur = nearestStop(pos);
    let next = cur;
    switch (k) {
      case ' ': case 'Enter': next = (cur + 1) % 3; break;
      case 'ArrowRight': case 'ArrowUp': case 'PageUp': next = Math.min(2, cur + 1); break;
      case 'ArrowLeft':  case 'ArrowDown': case 'PageDown': next = Math.max(0, cur - 1); break;
      case 'Home': next = 0; break;
      case 'End':  next = 2; break;
      default: return;
    }
    e.preventDefault();
    setValue(next, true);
  }

  function onPointerDown(e) {
    e.preventDefault();
    el.setPointerCapture?.(e.pointerId);
    stopAnim();
    const lay = measure(el);
    const startPos = pos;
    dragging = {
      id: e.pointerId,
      startX: e.clientX,
      startPos,
      lastX: e.clientX,
      lastT: performance.now(),
      v: 0,
      lay
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
  }

  function onPointerMove(e) {
    if (!dragging || e.pointerId !== dragging.id) return;
    const { stepPx } = dragging.lay;
    const dx = e.clientX - dragging.startX;
    const p = dragging.startPos + (dx / Math.max(1, stepPx));
    pos = clampFloat(p);
    applyVisual(pos, true);

    // velocity (indici/ms → indici/frame approx.)
    const now = performance.now();
    const dt = Math.max(1, now - dragging.lastT);
    dragging.v = (e.clientX - dragging.lastX) / dt / Math.max(1, stepPx);
    dragging.lastX = e.clientX;
    dragging.lastT = now;

    setAria(el, nearestStop(pos));
  }

  function onPointerUp(e) {
    if (!dragging || e.pointerId !== dragging.id) return;
    el.releasePointerCapture?.(e.pointerId);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);

    const before = nearestStop(pos);
    // bias (small "throw" toward v direction)
    const bias = dragging.v * 120; // ~120ms lookahead
    const t = nearestStop(pos + bias);
    dragging = null;

    if (REDUCED) {
      pos = t; applyVisual(pos, true); setAria(el, t); emit(before, t);
      return;
    }
    // Kick proportional to velocity (dampened for center)
    const v0 = (dragging?.v || 0) * 60 * (t === 1 ? 0.40 : 1);
    springTo(t, v0, () => { setAria(el, t); emit(before, t); });
  }

  // ====== Spring engine ======
  function springTo(tgt, v0, onDone) {
    stopAnim();
    target = clampIndex(tgt);
    v = v0 || 0;

    let steps = 0;
    const { k, d } = (target === 1) ? SPRING.mid : SPRING;

    const step = () => {
      steps++;
      // F = k * (x_target - x)
      const force = (target - pos) * k;
      v = (v + force) * (1 - d);
      pos += v;

      // "Arrival" conditions
      const closeMid = (target === 1 && Math.abs(pos - 1) < 0.002);
      const closeMin = (target === 0 && pos < 0.001);
      const closeMax = (target === 2 && pos > 1.999);

      if (closeMid || closeMin || closeMax || steps > SPRING.maxSteps) {
        pos = target;
        applyVisual(pos, true);
        stopAnim();
        onDone && onDone();
        return;
      }
      applyVisual(pos, true);
      setAria(el, nearestStop(pos));
      raf = requestAnimationFrame(step);
    };

    raf = requestAnimationFrame(step);
  }

  // ====== Visual/ARIA/Emit ======
  function applyVisual(p, animated) {
    el.style.setProperty('--pos', String(clampFloat(p)));
    if (!animated) {
      el.classList.add('no-anim');
      requestAnimationFrame(() => el.classList.remove('no-anim'));
    }
  }

  function setAria(node, idx) {
    node.setAttribute('aria-valuenow', String(idx));
    node.setAttribute('aria-valuetext', valueTextFor(node, idx));
  }

  function emit(beforeIdx, nowIdx) {
    const text = valueTextFor(el, nowIdx);
    el.dispatchEvent(new CustomEvent('input',  { bubbles: true, detail: { value: nowIdx, text } }));
    if (beforeIdx !== nowIdx) {
      el.dispatchEvent(new CustomEvent('change', { bubbles: true, detail: { value: nowIdx, text } }));
    }
    if (typeof onChange === 'function') {
      try { onChange({ value: nowIdx, text }); } catch {}
    }
  }

  // ====== Utils ======
  function measure(node) {
    const cs = getComputedStyle(node);
    const w = node.clientWidth || parseFloat(cs.width) || 96;
    const pad = parseCssNumber(cs.getPropertyValue('--pad'), 2);
    const thumb = parseCssNumber(cs.getPropertyValue('--thumb'), 30);
    const travel = Math.max(1, w - thumb - pad * 2);
    const stepPx = travel / 2; // 3 posizioni ⇒ 2 step
    return { width: w, pad, thumb, travel, stepPx };
  }
  function valueTextFor(node, i) {
    const map = {
      0: node.dataset?.valuetextLeft   || node.getAttribute('data-valuetext-left')   || 'A',
      1: node.dataset?.valuetextCenter || node.getAttribute('data-valuetext-center') || 'B',
      2: node.dataset?.valuetextRight  || node.getAttribute('data-valuetext-right')  || 'C',
    };
    return map[i] ?? String(i);
  }
  function ensurePart(root, sel, className) {
    if (!root.querySelector(sel)) {
      const el = document.createElement('span');
      el.className = className;
      root.appendChild(el);
    }
  }
  function stopAnim(){ if (raf) cancelAnimationFrame(raf); raf = 0; }
  function clampIndex(i){ return Math.max(0, Math.min(2, Math.round(i))); }
  function nearestStop(p){ return Math.max(0, Math.min(2, Math.round(p))); }
  function clampFloat(p){ return p < 0 ? 0 : (p > 2 ? 2 : p); }
  function toInt(v, fallback=0){ const n = Number(v); return Number.isFinite(n) ? Math.round(n) : fallback|0; }
  function getAttr(n, k){ const v = n.getAttribute(k); return v == null ? undefined : v; }
  function parseCssNumber(str, fallback){
    if (str == null) return fallback;
    const n = parseFloat(String(str).trim());
    return Number.isFinite(n) ? n : fallback;
  }

  // ====== Consistent initial state ======
  // Use .setValue to initialize (so it generates the "soft" animation if needed)
  setTimeout(() => setValue(value, false), 0);

  return ctrl;
}
