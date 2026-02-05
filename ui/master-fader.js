/**
 * @fileoverview Master Fader UI component.
 * 
 * Provides a master volume fader with pure linear gain (v -> gain = v).
 * - v=0 => gain=0 (hard mute), v=1 => gain=1 (unity)
 * - Easing (attack > release) for smooth feel
 * - Mouse/touch drag, keyboard, and ARIA support
 * 
 * API: window.MasterFader.{init, setLinear, setDb, getLinear, getDb, connectGainNode}
 * 
 * @module ui/master-fader
 */

(() => {
  'use strict';

  const clamp = (x, min, max) => Math.min(max, Math.max(min, x));
  const lerp  = (a, b, t) => a + (b - a) * t;

  /** dB helpers **/
  const dbToGain = (db) => (db <= -100 ? 0 : Math.pow(10, db / 20));
  const gainToDb = (gain) => (gain <= 0 ? -Infinity : 20 * Math.log10(gain));

  // Easing (same as snippet)
  const ATTACK = 20;
  const RELEASE = 20;

  function createFader({
    faderEl,
    thumbEl,
    // initial: percentage (0..1) or dB; if both passed, initialLinear wins
    initialLinear = null,
    initialDb = null,
    // audio integration
    audioCtx = null,
    gainNode = null,
    // optional callback on change (linear 0..1, db, gain)
    onChange = null,
  } = {}){
    if (!faderEl || !thumbEl) {
      console.warn('[MasterFader] Elements not found:', { faderEl, thumbEl });
    }

    // ===== UI state (0..1) - top=max =====
    let value = 0.6;
    if (initialLinear != null) {
      value = clamp(initialLinear, 0, 1);
    } else if (thumbEl && thumbEl.getAttribute('aria-valuenow')) {
      value = clamp(parseInt(thumbEl.getAttribute('aria-valuenow'), 10) / 100, 0, 1);
    } else if (initialDb != null) {
      // in linear gain: v = gain
      value = clamp(dbToGain(initialDb), 0, 1);
    }
    let target = value;

    // ===== Audio refs =====
    let ctx = audioCtx || (window.AudioContextRef || window.audioContext || null);
    let masterGain = gainNode || (window.MasterGainNode || null);

    // ===== Internals =====
    let lastT = performance.now();
    let rafId = null;
    let dragging = false;
    let lastNotified = -1;

    function slotPaddingPx(rect){
      // match .slot { top:6%; bottom:6% } in styles
      const pad = rect.height * 0.115;
      return { padTop: pad, padBot: pad + rect.height * 0.015 };
    }

    function positionThumb(v){
      if (!thumbEl || !faderEl) return;
      const r = faderEl.getBoundingClientRect();
      const { padTop, padBot } = slotPaddingPx(r);
      const usable = r.height - padTop - padBot;
      const yLocal = padTop + (1 - v) * usable; // 0 bottom, 1 top
      thumbEl.style.top = `${yLocal}px`;

      // ARIA: display dB calculated from linear gain
      const g = clamp(v, 0, 1);
      const db = gainToDb(g);
      thumbEl.setAttribute('aria-valuenow', Math.round(v * 100));
      thumbEl.setAttribute('aria-valuetext', Number.isFinite(db) ? `${db.toFixed(1)} dB` : '−∞ dB');
    }

    function setTargetFromPageY(pageY){
      if (!faderEl) return;
      const r = faderEl.getBoundingClientRect();
      const { padTop, padBot } = slotPaddingPx(r);
      const usable = r.height - padTop - padBot;
      let y = pageY - r.top - padTop;
      y = clamp(y, 0, usable);
      target = 1 - (y / usable); // min at bottom, max at top
    }

    function applyToAudio(v){
      if (!masterGain) return;
      // Pure linear gain
      const g = clamp(v, 0, 1);
      if (ctx && typeof masterGain.gain?.setTargetAtTime === 'function'){
        masterGain.gain.setTargetAtTime(g, ctx.currentTime, 0.01);
      } else {
        masterGain.gain.value = g;
      }
    }

    function notify(v){
      const g  = clamp(v, 0, 1);
      const db = gainToDb(g);
      if (Math.abs(v - lastNotified) < 0.002) return; // reduce chatter
      lastNotified = v;

      if (faderEl) {
        faderEl.dispatchEvent(new CustomEvent('mastervolumechange', {
          bubbles: true,
          detail: { linear: v, db, gain: g }
        }));
      }
      if (typeof onChange === 'function'){
        onChange({ linear: v, db, gain: g });
      }
    }

    function loop(t){
      const dt = Math.max(0.001, (t - lastT) / 1000);
      lastT = t;
      const k = (target > value) ? ATTACK : RELEASE;
      value += (target - value) * Math.min(1, k * dt);

      positionThumb(value);
      applyToAudio(value);
      notify(value);

      rafId = requestAnimationFrame(loop);
    }

    // ====== Interaction ======
    const onPointerDown = (e) => {
      e.preventDefault();
      dragging = true;
      thumbEl?.focus?.();
      if (e.pointerId != null && thumbEl?.setPointerCapture) {
        try { thumbEl.setPointerCapture(e.pointerId); } catch {}
      }
      setTargetFromPageY(e.pageY ?? (e.touches ? e.touches[0].pageY : 0));
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
    };
    const onPointerMove = (e) => {
      if (!dragging) return;
      if (!e.isPrimary && e.pointerType === 'touch') return;
      setTargetFromPageY(e.pageY ?? (e.touches ? e.touches[0].pageY : 0));
    };
    const onPointerUp = () => {
      dragging = false;
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };

    // Touch (iOS Safari)
    const onTouchStart = (e) => {
      e.preventDefault();
      dragging = true;
      thumbEl?.focus?.();
      const t = e.touches[0];
      setTargetFromPageY(t.pageY);
      window.addEventListener('touchmove', onTouchMove, { passive: false });
      window.addEventListener('touchend', onTouchEnd);
    };
    const onTouchMove = (e) => {
      if (!dragging) return;
      const t = e.touches[0];
      setTargetFromPageY(t.pageY);
      e.preventDefault();
    };
    const onTouchEnd = () => {
      dragging = false;
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
    };

    // Keyboard
    const onKeyDown = (e) => {
      const fine = 0.01;
      const coarse = 0.05;
      const page = 0.1;
      let handled = true;
      switch (e.key){
        case 'ArrowUp':   target = clamp(target + (e.shiftKey ? coarse : fine), 0, 1); break;
        case 'ArrowDown': target = clamp(target - (e.shiftKey ? coarse : fine), 0, 1); break;
        case 'PageUp':    target = clamp(target + page, 0, 1); break;
        case 'PageDown':  target = clamp(target - page, 0, 1); break;
        case 'Home':      target = 0; break;  // MUTE
        case 'End':       target = 1; break;
        default: handled = false;
      }
      if (handled) e.preventDefault();
    };

    // Resize -> realign thumb
    const onResize = () => positionThumb(value);

    // Bind
    if (faderEl){
      faderEl.addEventListener('pointerdown', onPointerDown);
      faderEl.addEventListener('touchstart', onTouchStart, { passive: false });
    }
    if (thumbEl){
      thumbEl.addEventListener('pointerdown', onPointerDown);
      thumbEl.addEventListener('touchstart', onTouchStart, { passive: false });
      thumbEl.addEventListener('keydown', onKeyDown);
      // ARIA base
      thumbEl.setAttribute('role', 'slider');
      thumbEl.setAttribute('aria-orientation', 'vertical');
      thumbEl.setAttribute('aria-valuemin', '0');
      thumbEl.setAttribute('aria-valuemax', '100');
      if (!thumbEl.getAttribute('aria-label')) {
        thumbEl.setAttribute('aria-label', 'Master Volume');
      }
    }
    window.addEventListener('resize', onResize);

    // Startup
    positionThumb(value);
    applyToAudio(value);
    notify(value);
    rafId = requestAnimationFrame(loop);

    // Public API for this instance
    return {
      /** Linear value 0..1 (UI, top=max) */
      setLinear(v){ target = clamp(v, 0, 1); },
      getLinear(){ return value; },
      /** Set in dB (accepts -Infinity for mute) */
      setDb(db){
        if (!Number.isFinite(db)) { target = 0; return; } // -Infinity => mute
        const g = clamp(dbToGain(db), 0, 1);
        target = g; // in linear gain: v = gain
      },
      getDb(){
        const g = clamp(value, 0, 1);
        return gainToDb(g);
      },
      /** Connect (or reconnect) an external GainNode */
      connectGainNode(node, ctxRef = null){
        masterGain = node || masterGain;
        ctx = ctxRef || ctx;
        applyToAudio(value);
      },
      /** Destroy: cleanup listeners/RAF (for SPA use) */
      destroy(){
        cancelAnimationFrame(rafId);
        if (faderEl){
          faderEl.removeEventListener('pointerdown', onPointerDown);
          faderEl.removeEventListener('touchstart', onTouchStart);
        }
        if (thumbEl){
          thumbEl.removeEventListener('pointerdown', onPointerDown);
          thumbEl.removeEventListener('touchstart', onTouchStart);
          thumbEl.removeEventListener('keydown', onKeyDown);
        }
        window.removeEventListener('resize', onResize);
      }
    };
  }

  // ====== Simple bootstrap ======
  let singleton = null;

  function init(opts = {}){
    const faderEl = opts.faderEl || document.getElementById(opts.faderId || 'masterFader');
    const thumbEl = opts.thumbEl || document.getElementById(opts.thumbId || 'masterThumb');
    const instance = createFader({
      faderEl,
      thumbEl,
      initialLinear: opts.initialLinear ?? null,
      initialDb: opts.initialDb ?? null,
      audioCtx: opts.audioCtx ?? null,
      gainNode: opts.gainNode ?? null,
      onChange: opts.onChange ?? null,
    });
    return instance;
  }

  // Auto bootstrap on DOM ready (se gli elementi esistono)
  document.addEventListener('DOMContentLoaded', () => {
    const faderEl = document.getElementById('masterFader');
    const thumbEl = document.getElementById('masterThumb');
    if (faderEl && thumbEl){
      singleton = init({ faderEl, thumbEl });
      window.MasterFader = {
        ...singleton,
        init,
        connectGainNode: (...args) => singleton.connectGainNode(...args),
        setLinear: (v) => singleton.setLinear(v),
        setDb: (db) => singleton.setDb(db),
        getLinear: () => singleton.getLinear(),
        getDb: () => singleton.getDb(),
      };
    } else {
      window.MasterFader = { init };
    }
  });

})();
