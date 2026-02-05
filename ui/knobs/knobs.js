/**
 * @fileoverview Rotary knob UI components for parameter control.
 * Mounts the "Inset/Chamfer" skin over existing <input.param-slider> elements
 * and handles rotation display + horizontal drag interaction.
 * No side effects on the audio engine.
 *
 * @module ui/knobs/knobs
 *
 * DOM structure injected per knob:
 *   .knob-face
 *     .inset
 *       .chamfer
 *         .face
 *           .arrow
 *           .inner
 *
 * Rotation is controlled via CSS var --rot (set on .knob-face); CSS rotates .face.
 */

export function mountKnobs({
  root = document,
  sliderSelector = '.params .col input.param-slider',
  // i controlli "centrati" (magnete → centro corsa)
  zeroSnapIds = new Set(['scanSpeedRange','panRange','pitchRange']),
  maybeSnapToZero = null
} = {}) {
  const cols = root.querySelectorAll('.params .col');

  cols.forEach(col => {
    const range = col.querySelector(sliderSelector);
    if (!range || range.classList.contains('keep-slider')) return;

    // Create the knob face if not present
    let knobFace = col.querySelector('.knob-face');
    if (!knobFace) {
      knobFace = document.createElement('div');
      knobFace.className = 'knob-face';
      col.insertBefore(knobFace, col.firstChild);
    }

    // Inject the "Inset/Chamfer" skin only if missing (idempotent)
    ensureSkinStructure(knobFace);

    // Zero-mark for centered controls (compatible with new skin)
    // Stays as a child of .col, so it does NOT interfere with drag on .knob-face
    if (zeroSnapIds.has(range.id)) {
      let z = col.querySelector('.zero-mark');
      if (!z) {
        z = document.createElement('div');
        z.className = 'zero-mark';
        col.appendChild(z);
      }

      // Magnetic snap: click resets to center position
      z.setAttribute('role', 'button');
      z.setAttribute('tabindex', '0');
      z.setAttribute('aria-label', 'Reset to center');

      const snapToCenter = (ev) => {
        ev.preventDefault();
        // Arithmetic center of the range (e.g. -1..+1 -> 0)
        const min = parseFloat(range.min || 0);
        const max = parseFloat(range.max || 0);
        const center = (min + max) / 2;

        // Set the UI value
        range.value = String(center);

        // Optional: extra snapping on user side (pan/pitch/scan)
        if (maybeSnapToZero) {
          try { maybeSnapToZero(range); } catch {}
        }

        // Dispatch events as if it were input/drag
        range.dispatchEvent(new Event('input',  { bubbles: true }));
        range.dispatchEvent(new Event('change', { bubbles: true }));
      };

      z.addEventListener('click', snapToCenter);
      z.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') snapToCenter(e);
      });
    }

    // Update rotation based on the current value
    const updateFace = () => {
      const min = parseFloat(range.min || 0);
      const max = parseFloat(range.max || 100);
      const val = parseFloat(range.value);
      const t   = (val - min) / (max - min);
      // Aesthetic mapping: 270 degree sweep, starting at -90 degrees (12 o'clock)
      const deg = -90 + t * 270;
      knobFace.style.setProperty('--rot', deg + 'deg');
    };

    // Initial update
    updateFace();

    // On slider value change (mouse, keyboard, programmatic)
    range.addEventListener('input',  () => {
      if (maybeSnapToZero && zeroSnapIds.has(range.id)) {
        maybeSnapToZero(range);
      }
      updateFace();
    });
    range.addEventListener('change', updateFace);

    // Horizontal drag on the knob face (container)
    knobFace.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { knobFace.setPointerCapture(e.pointerId); } catch {}
      const startX    = e.clientX;
      const min       = parseFloat(range.min || 0);
      const max       = parseFloat(range.max || 100);
      const startVal  = parseFloat(range.value);
      const scale     = (max - min) / 280; // Larger denominator = finer control

      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        let v = startVal + dx * scale;
        v = Math.max(min, Math.min(max, v));
        range.value = v;

        if (maybeSnapToZero && zeroSnapIds.has(range.id)) {
          maybeSnapToZero(range);
        }

        range.dispatchEvent(new Event('input',  { bubbles:true }));
        range.dispatchEvent(new Event('change', { bubbles:true }));
      };

      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        try { knobFace.releasePointerCapture(e.pointerId); } catch {}
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  });

  // Utility to manually refresh rotation for a knob by ID
  function refresh(id) {
    const el = root.getElementById ? root.getElementById(id) : document.getElementById(id);
    if (!el) return;
    const col = el.closest('.col');
    const knobFace = col && col.querySelector('.knob-face');
    if (!knobFace) return;

    const min = parseFloat(el.min || 0);
    const max = parseFloat(el.max || 100);
    const val = parseFloat(el.value);
    const t   = (val - min) / (max - min);
    const deg = -90 + t * 270;

    knobFace.style.setProperty('--rot', deg + 'deg');
  }

  return { refresh };
}

/* ----------------------------------------
   Helpers
---------------------------------------- */
function ensureSkinStructure(knobFace){
  // Avoid double mounting
  if (knobFace.querySelector(':scope > .inset')) return;

  const inset   = document.createElement('div');
  const chamfer = document.createElement('div');
  const face    = document.createElement('div');
  const arrow   = document.createElement('div');
  const inner   = document.createElement('div');

  inset.className   = 'inset';
  chamfer.className = 'chamfer';
  face.className    = 'face';
  arrow.className   = 'arrow';
  inner.className   = 'inner';

  face.appendChild(arrow);
  face.appendChild(inner);
  chamfer.appendChild(face);
  inset.appendChild(chamfer);
  knobFace.appendChild(inset);
}
