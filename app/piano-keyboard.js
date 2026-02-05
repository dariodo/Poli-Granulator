/**
 * @file piano-keyboard.js
 * @description Virtual QWERTY piano keyboard UI component for the granular synthesizer.
 *              Maps computer keyboard keys to musical notes with octave switching.
 *              Supports both new callback-based API and legacy baseline anchoring.
 */

// ------------------------------------------------------------------
// QWERTY Piano with dual modes:
//
// 1) NEW (recommended): uses noteOn/noteOff callbacks to the worklet
//    - without Alt: plays ONLY the active cursor
//    - with Alt:    plays ALL cursors (A+B+C)
//    - if you press Alt WHILE holding a key, that key switches live to "all"
//      (now atomic: OFF single -> ON all, no double notes)
//    - if you RELEASE Alt WHILE holding a key, that key returns to "single"
//    - keyup = noteOff (no latch), piano-like behavior
//
// 2) FALLBACK (compat): if noteOn/off not provided, uses baseline+commit
//    to avoid breaking the app until script.js is updated.
//
// API:
// initPianoKeyboard({
//   // --- NEW API (piano) ---
//   getActiveCursor: () => 0|1|2,
//   noteOn:      (cursorIdx, semis) => void,
//   noteOff:     (cursorIdx, semis) => void,
//   noteOnAll:   (semis) => void,
//   noteOffAll:  (semis) => void,
//   // --- Optional UI ---
//   onOctaveChange?: (oct:number)=>void,
//   pitchKnobEl?: HTMLInputElement,
//
//   // --- FALLBACK legacy (baseline anchoring) ---
//   baselineSemis?: number[3],
//   knobSemis?: number[3],
//   commitPitch?: (idx:number)=>void,
//   commitPitchAll?: ()=>void
// })
//
// Key mapping: A S D F G H J K (white) + W E T Y U (black)
// Octave: Z (-1), X (+1)
// C4 = 0 relative semitones (A=C, W=C#, S=D, E=D#, D=E, ...)

export function initPianoKeyboard(opts = {}) {
  // --- new options ---
  const {
    getActiveCursor,
    noteOn, noteOff,
    noteOnAll, noteOffAll,
    onOctaveChange = null,
    pitchKnobEl = null,
    // --- fallback legacy ---
    baselineSemis, knobSemis,
    commitPitch, commitPitchAll
  } = opts;

  // ---------- State ----------
  const state = {
    octave: 4,
    minOct: 1,
    maxOct: 7,
    downCodes: new Set(),     // prevents auto-repeat
    modeByCode: new Map(),    // 'all' | 'single'
    cursorByCode: new Map(),  // code -> cursor in 'single'
    semisByCode: new Map(),   // code -> semis
    altDown: false,
    lastNoteName: null
  };

  // ---------- Utilities ----------
  const isEditable = (el) => {
    if (!el) return false;
    if (el.isContentEditable) return true;
    const tag = (el.tagName || '').toUpperCase();
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') {
      const t = (el.type || '').toLowerCase();
      return ['text','search','url','tel','email','password','number'].includes(t);
    }
    return false;
  };

  // code -> offset in the chromatic scale of the current octave (C = 0)
  const NOTE = new Map([
    ['KeyA',  0],  // C
    ['KeyW',  1],  // C#
    ['KeyS',  2],  // D
    ['KeyE',  3],  // D#
    ['KeyD',  4],  // E
    ['KeyF',  5],  // F
    ['KeyT',  6],  // F#
    ['KeyG',  7],  // G
    ['KeyY',  8],  // G#
    ['KeyH',  9],  // A
    ['KeyU', 10],  // A#
    ['KeyJ', 11],  // B
    ['KeyK', 12],  // C (octave +1)
  ]);

  const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);

  function semisForCode(code) {
    if (!NOTE.has(code)) return null;
    const rel = NOTE.get(code);
    return (state.octave - 4) * 12 + rel; // relative semitones to C4=0
  }

  function noteNameFromSemisRel(semis) {
    const names = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    const absFromC0 = 48 + semis; // C4=48 relative to C0
    const n = ((absFromC0 % 12) + 12) % 12;
    const oct = Math.floor(absFromC0 / 12);
    return `${names[n]}${oct}`;
  }

  function setKnobLabelAnchor(name) {
    if (!pitchKnobEl) return;
    pitchKnobEl.setAttribute('data-anchor', name);
    pitchKnobEl.setAttribute('aria-label', `Pitch (anchored to ${name})`);
  }

  // ===== FALLBACK: anchor the baselines (old behavior) =====
  function fallbackApplyAnchor(semisTarget, toAll) {
    if (!baselineSemis || !knobSemis || !commitPitch) return;
    if (toAll) {
      for (let i = 0; i < 3; i++) {
        baselineSemis[i] = semisTarget - (knobSemis[i] || 0);
        commitPitch(i);
      }
      if (typeof commitPitchAll === 'function') commitPitchAll();
    } else {
      const idx = typeof getActiveCursor === 'function' ? (getActiveCursor() | 0) : 0;
      baselineSemis[idx] = semisTarget - (knobSemis[idx] || 0);
      commitPitch(idx);
    }
  }

  // --- Helper to emulate "ALL" if noteOnAll/noteOffAll don't exist ---
  function emulateAllOn(semis) {
    if (typeof noteOn === 'function') for (let i = 0; i < 3; i++) noteOn(i, semis);
  }
  function emulateAllOff(semis) {
    if (typeof noteOff === 'function') for (let i = 0; i < 3; i++) noteOff(i, semis);
  }

  // ====== Event Handlers ======
  function onKeyDown(e) {
    // ALT pressed: upgrade live SINGLE -> ALL (atomic)
    if ((e.code === 'AltLeft' || e.code === 'AltRight') && !state.altDown) {
      state.altDown = true;

      if (state.downCodes.size > 0) {
        for (const code of state.downCodes) {
          if (state.modeByCode.get(code) === 'single') {
            const semis = state.semisByCode.get(code);
            const cur   = state.cursorByCode.get(code);
            if (semis != null) {
              e.preventDefault(); e.stopPropagation();
              // Turn off SINGLE
              if (typeof noteOff === 'function' && cur != null) {
                noteOff(cur, semis);
              }
              // Turn on ALL (real or emulated)
              if (typeof noteOnAll === 'function') {
                noteOnAll(semis);
              } else {
                emulateAllOn(semis);
              }
              state.modeByCode.set(code, 'all');
              state.cursorByCode.delete(code);
            }
          }
        }
      }
      return; // Don't treat Alt as a note
    }

    if (isEditable(e.target)) return;

    const c = e.code;

    // Octave Z / X (no autorepeat)
    if ((c === 'KeyZ' || c === 'KeyX') && !state.downCodes.has(c)) {
      state.downCodes.add(c);
      e.preventDefault(); e.stopPropagation();
      if (c === 'KeyZ') state.octave = clamp(state.octave - 1, state.minOct, state.maxOct);
      if (c === 'KeyX') state.octave = clamp(state.octave + 1, state.minOct, state.maxOct);
      onOctaveChange && onOctaveChange(state.octave);
      setKnobLabelAnchor(`Oct ${state.octave}`);
      return;
    }

    // Notes
    if (!NOTE.has(c)) return;
    if (state.downCodes.has(c)) return; // prevent autorepeat
    state.downCodes.add(c);

    const semis = semisForCode(c);
    if (semis == null) return;

    e.preventDefault(); e.stopPropagation();

    // label UI
    state.lastNoteName = noteNameFromSemisRel(semis);
    setKnobLabelAnchor(state.lastNoteName);
    state.semisByCode.set(c, semis);

    const wantAll = !!(state.altDown || e.altKey);

    // NEW API -> momentary piano
    if (typeof noteOn === 'function' || typeof noteOnAll === 'function') {
      if (wantAll) {
        state.modeByCode.set(c, 'all');
        if (typeof noteOnAll === 'function') noteOnAll(semis);
        else emulateAllOn(semis);
      } else {
        state.modeByCode.set(c, 'single');
        const cur = typeof getActiveCursor === 'function' ? (getActiveCursor() | 0) : 0;
        state.cursorByCode.set(c, cur);
        noteOn?.(cur, semis);
      }
      return;
    }

    // FALLBACK legacy (anchoring)
    fallbackApplyAnchor(semis, wantAll);
  }

  function onKeyUp(e) {
    const c = e.code;

    // ALT released: downgrade live ALL -> SINGLE (active cursor only)
    if (c === 'AltLeft' || c === 'AltRight') {
      if (state.altDown) {
        state.altDown = false;
        if (typeof noteOn === 'function') {
          const cur = typeof getActiveCursor === 'function' ? (getActiveCursor() | 0) : 0;
          for (const code of state.downCodes) {
            if (state.modeByCode.get(code) === 'all') {
              const semis = state.semisByCode.get(code);
              if (semis != null) {
                e.preventDefault(); e.stopPropagation();
                // Turn off ALL and turn on SINGLE on active cursor
                if (typeof noteOffAll === 'function') noteOffAll(semis);
                else emulateAllOff(semis);
                noteOn(cur, semis);
                state.modeByCode.set(code, 'single');
                state.cursorByCode.set(code, cur);
              }
            }
          }
        }
      }
      return; // Done handling Alt
    }

    if (!state.downCodes.has(c)) return;
    state.downCodes.delete(c);

    // Release Z/X
    if (c === 'KeyZ' || c === 'KeyX') {
      e.preventDefault(); e.stopPropagation();
      return;
    }

    if (!NOTE.has(c)) return;

    // NEW API: turn off the note
    if (typeof noteOff === 'function' || typeof noteOffAll === 'function') {
      e.preventDefault(); e.stopPropagation();
      const semis = state.semisByCode.get(c);
      const mode  = state.modeByCode.get(c);
      if (semis != null) {
        if (mode === 'all') {
          if (typeof noteOffAll === 'function') noteOffAll(semis);
          else emulateAllOff(semis);
        } else {
          const cur = state.cursorByCode.get(c);
          if (cur != null) noteOff?.(cur, semis);
        }
      }
      state.modeByCode.delete(c);
      state.cursorByCode.delete(c);
      state.semisByCode.delete(c);
    }
    // In FALLBACK we do nothing on keyup (anchoring remains)
  }

  // --- PATCH: panic to avoid stuck notes on focus loss ---
  function panicAllNotes() {
    for (const code of [...state.downCodes]) {
      const semis = state.semisByCode.get(code);
      const mode  = state.modeByCode.get(code);
      if (semis != null) {
        if (mode === 'all') {
          if (typeof noteOffAll === 'function') noteOffAll(semis);
          else emulateAllOff(semis);
        } else {
          const cur = state.cursorByCode.get(code);
          if (typeof noteOff === 'function' && cur != null) noteOff(cur, semis);
        }
      }
    }
    state.downCodes.clear();
    state.modeByCode.clear();
    state.cursorByCode.clear();
    state.semisByCode.clear();
  }

  function onVisChange() {
    if (document.visibilityState === 'hidden') panicAllNotes();
  }

  // Bind global (capture for reliability)
  document.addEventListener('keydown', onKeyDown, { capture: true });
  document.addEventListener('keyup',   onKeyUp,   { capture: true });
  window.addEventListener('blur', panicAllNotes, { capture: true });
  document.addEventListener('visibilitychange', onVisChange, { capture: true });

  return {
    dispose() {
      document.removeEventListener('keydown', onKeyDown, { capture: true });
      document.removeEventListener('keyup',   onKeyUp,   { capture: true });
      window.removeEventListener('blur', panicAllNotes, { capture: true });
      document.removeEventListener('visibilitychange', onVisChange, { capture: true });
      state.downCodes.clear();
      state.modeByCode.clear();
      state.cursorByCode.clear();
      state.semisByCode.clear();
      state.altDown = false;
    },
    getOctave() { return state.octave; },
    setOctave(o) {
      state.octave = clamp((o|0), state.minOct, state.maxOct);
      onOctaveChange && onOctaveChange(state.octave);
    },
    getLastNote() { return state.lastNoteName; }
  };
}
