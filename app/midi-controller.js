/**
 * @file midi-controller.js
 * @description MIDI Controller Layer for external keyboard input using Web MIDI API.
 *              Designed for Arturia MiniLab 3 but works with any MIDI input device.
 *              Converts MIDI notes to relative semitones (C4 = MIDI 60 = 0 semitones)
 *              and routes them to the granular engine via callbacks.
 */

// ------------------------------------------------------------------
// MINI MIDI CONTROLLER LAYER (Arturia MiniLab 3 friendly)
// ------------------------------------------------------------------
// - Uses the Web MIDI API to receive notes from an external keyboard
//   (designed for Arturia MiniLab 3, but works with any MIDI input).
// - Converts MIDI notes to "relative semitones" like piano-keyboard.js:
//     C4 (MIDI 60) = 0 semitones
//     semis = midiNote - 60
// - Routes to your main thread callbacks:
//     noteOn(cursorIdx, semis)
//     noteOff(cursorIdx, semis)
//     (optional) noteOnAll(semis), noteOffAll(semis)
// - By default:
//     - Uses ONLY the keyboard (channel 1) of the MiniLab 3
//       ignores pads on channel 10
//     - Plays on the active cursor (A/B/C) like the QWERTY keyboard
// - No side effects on DSP: this is input only.
//
// USAGE (in your main script):
//
// import { initMidiController } from './ui/midi-controller.js';
//
// const midi = initMidiController({
//   getActiveCursor,                    // () => 0|1|2
//   noteOn:     (cursor, semis) => { /* send kbNoteOn to worklet */ },
//   noteOff:    (cursor, semis) => { /* send kbNoteOff to worklet */ },
//   noteOnAll:  (semis) => { /* optional */ },
//   noteOffAll: (semis) => { /* optional */ },
//   onStatusChange: (status, detail) => {
//     // e.g., update a label "MIDI: connected/disconnected"
//     // status: 'no-webmidi' | 'requesting' | 'ready' | 'ready-no-input'
//     //         'connected' | 'disconnected' | 'error'
//   }
// });
//
// Returned API:
//   midi.dispose()
//   midi.getStatus()
//   midi.getCurrentInput()
//   midi.getMidiAccess()
//   midi.listInputs()
//   midi.setPlayAllCursors(true/false)
//   midi.isPlayAllCursors()
//   midi.reconnect()
// ------------------------------------------------------------------

export function initMidiController(options = {}) {
  // Singleton guard (like hotkeys): reuse same instance if already initialized
  if (typeof window !== 'undefined' && window.__granularMidiController_v1) {
    return window.__granularMidiController_v1.api;
  }

  const {
    getActiveCursor = () => 0,
    noteOn,
    noteOff,
    noteOnAll,
    noteOffAll,
    // If true: MIDI notes play on ALL cursors (via noteOnAll / emulation)
    playAllCursors = false,
    // Optional callback for status updates (UI)
    onStatusChange,
    onError,
    // Preferred input names for keyboard (MiniLab 3 typically has one of these)
    preferredInputNames = ['minilab 3', 'arturia minilab 3'],
    // Keyboard channel:
    //   null  -> auto: uses all channels except 10 (MiniLab pads, ch10 => index 9)
    //   0..15 -> filters on that channel
    keyboardChannel = null
  } = options;

  const state = {
    midiAccess: null,
    input: null,
    notes: new Map(),  // numeric key -> { semis, mode, cursor, velocity }
    status: 'idle',
    playAll: !!playAllCursors,
    destroyed: false
  };

  const supportsWebMIDI =
    typeof navigator !== 'undefined' &&
    navigator &&
    typeof navigator.requestMIDIAccess === 'function';

  // ------- base helpers -------

  const clampCursor = (i) => {
    let n = (i | 0);
    if (!Number.isFinite(n)) n = 0;
    if (n < 0) n = 0;
    if (n > 2) n = 2;
    return n;
  };

  const safeGetActiveCursor = () => {
    try {
      const v = typeof getActiveCursor === 'function' ? getActiveCursor() : 0;
      return clampCursor(v);
    } catch {
      return 0;
    }
  };

  function emitStatus(kind, detail) {
    state.status = kind;
    if (typeof onStatusChange === 'function') {
      try { onStatusChange(kind, detail || {}); } catch {} // don't crash
    }
  }

  function emitError(err) {
    if (state.destroyed) return;
    if (typeof onError === 'function') {
      try { onError(err); } catch {}
    } else if (typeof console !== 'undefined' && console.warn) {
      console.warn('[midi-controller]', err);
    }
  }

  const noteKey = (channel, note) => ((channel & 0x0f) << 8) | (note & 0x7f);

  // ------- send notes to your engine -------

  function allOn(semis) {
    if (!Number.isFinite(semis)) return;
    if (typeof noteOnAll === 'function') {
      try { noteOnAll(semis); } catch (err) { emitError(err); }
      return;
    }
    if (typeof noteOn === 'function') {
      for (let c = 0; c < 3; c++) {
        try { noteOn(c, semis); } catch (err) { emitError(err); }
      }
    }
  }

  function allOff(semis) {
    if (!Number.isFinite(semis)) return;
    if (typeof noteOffAll === 'function') {
      try { noteOffAll(semis); } catch (err) { emitError(err); }
      return;
    }
    if (typeof noteOff === 'function') {
      for (let c = 0; c < 3; c++) {
        try { noteOff(c, semis); } catch (err) { emitError(err); }
      }
    }
  }

  function singleOn(cursor, semis) {
    if (!Number.isFinite(semis)) return;
    if (typeof noteOn !== 'function') return;
    try { noteOn(cursor, semis); } catch (err) { emitError(err); }
  }

  function singleOff(cursor, semis) {
    if (!Number.isFinite(semis)) return;
    if (typeof noteOff !== 'function') return;
    try { noteOff(cursor, semis); } catch (err) { emitError(err); }
  }

  // ------- MIDI handlers -------

  function handleNoteOn(channel, midiNote, velocity) {
    const key = noteKey(channel, midiNote);
    const existing = state.notes.get(key);
    if (existing) {
      // Turn off any "stuck" note before re-triggering
      if (existing.mode === 'all') {
        allOff(existing.semis);
      } else if (existing.mode === 'single' && existing.cursor != null) {
        singleOff(existing.cursor, existing.semis);
      }
      state.notes.delete(key);
    }

    const semis = midiNote - 60; // C4 (60) = 0
    const mode = state.playAll ? 'all' : 'single';
    let cursor = null;

    if (mode === 'all') {
      allOn(semis);
    } else {
      cursor = safeGetActiveCursor();
      singleOn(cursor, semis);
    }

    state.notes.set(key, {
      semis,
      mode,
      cursor,
      velocity: velocity || 0
    });
  }

  function handleNoteOff(channel, midiNote /*, velocity */) {
    const key = noteKey(channel, midiNote);
    const info = state.notes.get(key);
    if (!info) return;

    state.notes.delete(key);

    if (info.mode === 'all') {
      allOff(info.semis);
    } else if (info.mode === 'single' && info.cursor != null) {
      singleOff(info.cursor, info.semis);
    }
  }

  function handleMidiMessage(ev) {
    const data = ev.data;
    if (!data || data.length < 2) return;

    const statusByte = data[0];
    const data1 = data[1];
    const data2 = data[2] || 0;

    const status = statusByte & 0xf0;
    const channel = statusByte & 0x0f; // 0..15 => MIDI ch 1..16

    // Filter keyboard channel
    if (keyboardChannel != null) {
      if (channel !== (keyboardChannel | 0)) return;
    } else {
      // "MiniLab-friendly" mode:
      // ignore channel 10 (default pads -> index 9)
      if (channel === 9) return;
    }

    switch (status) {
      case 0x90: // Note On
        if (data2 > 0) {
          handleNoteOn(channel, data1, data2);
        } else {
          // Note On with velocity 0 = Note Off
          handleNoteOff(channel, data1, data2);
        }
        break;
      case 0x80: // Note Off
        handleNoteOff(channel, data1, data2);
        break;
      default:
        // Future: could handle pitch-bend, mod wheel, CC, etc.
        break;
    }
  }

  // ------- MIDI port selection / management -------

  function findBestInput(midiAccess) {
    const inputs = Array.from(midiAccess.inputs.values());
    if (!inputs.length) return null;

    const preferred = preferredInputNames
      .filter(Boolean)
      .map((s) => String(s).toLowerCase());

    // 1) Try to find an input with a name containing "MiniLab 3", etc.
    for (const inp of inputs) {
      const name = (inp.name || '').toLowerCase();
      if (preferred.some((p) => name.includes(p))) {
        return inp;
      }
    }
    // 2) Fallback: first available
    return inputs[0];
  }

  function bindInput(input) {
    if (!input) return;

    // If it's already the same port, do nothing
    if (state.input && state.input.id === input.id) return;

    unbindInput();

    state.input = input;
    try {
      input.addEventListener('midimessage', handleMidiMessage);
    } catch {
      // Older Safari versions didn't support addEventListener -> fallback to onmidimessage
      input.onmidimessage = handleMidiMessage;
    }

    emitStatus('connected', {
      id: input.id,
      name: input.name,
      manufacturer: input.manufacturer,
      state: input.state,
      connection: input.connection
    });
  }

  function unbindInput() {
    if (!state.input) return;
    try {
      state.input.removeEventListener('midimessage', handleMidiMessage);
    } catch {}
    try {
      state.input.onmidimessage = null;
    } catch {}
    state.input = null;
  }

  function handleStateChange(ev) {
    const port = ev.port;
    if (!port || port.type !== 'input') return;

    // Input connected later: try to use it
    if (port.state === 'connected') {
      if (!state.input) {
        selectInput(); // chooses the best available port
      }
      return;
    }

    // Input disconnected: if it's the one in use, unbind and try fallback
    if (port.state === 'disconnected') {
      if (state.input && port.id === state.input.id) {
        unbindInput();
        emitStatus('disconnected', {
          id: port.id,
          name: port.name
        });
        // Try to reconnect another port if one exists
        selectInput();
      }
    }
  }

  function selectInput() {
    if (!state.midiAccess) return;
    const next = findBestInput(state.midiAccess);
    if (!next) {
      unbindInput();
      emitStatus('ready-no-input', { inputs: [] });
      return;
    }
    bindInput(next);
  }

  function setupMidi() {
    if (!supportsWebMIDI) {
      emitStatus('no-webmidi', {
        message: 'Web MIDI not supported (requires Chrome / Edge / secure context).'
      });
      return;
    }

    emitStatus('requesting');

    navigator.requestMIDIAccess({ sysex: false })
      .then((midiAccess) => {
        if (state.destroyed) {
          // If destroyed in the meantime, do nothing
          return;
        }
        state.midiAccess = midiAccess;
        try {
          midiAccess.addEventListener('statechange', handleStateChange);
        } catch {
          // Older implementations: ignore, not critical
        }

        const inputsMeta = Array.from(midiAccess.inputs.values()).map((inp) => ({
          id: inp.id,
          name: inp.name,
          manufacturer: inp.manufacturer,
          state: inp.state,
          connection: inp.connection
        }));

        emitStatus('ready', { inputs: inputsMeta });

        selectInput();
      })
      .catch((err) => {
        emitError(err);
        emitStatus('error', { message: String(err && err.message || err) });
      });
  }

  // ------- Public API -------

  const api = {
    dispose() {
      state.destroyed = true;
      state.notes.clear();
      unbindInput();
      if (state.midiAccess) {
        try {
          state.midiAccess.removeEventListener('statechange', handleStateChange);
        } catch {}
      }
    },
    getStatus() {
      return state.status;
    },
    getCurrentInput() {
      return state.input || null;
    },
    getMidiAccess() {
      return state.midiAccess || null;
    },
    listInputs() {
      if (!state.midiAccess) return [];
      return Array.from(state.midiAccess.inputs.values()).map((inp) => ({
        id: inp.id,
        name: inp.name,
        manufacturer: inp.manufacturer,
        state: inp.state,
        connection: inp.connection
      }));
    },
    // Enable/disable "ALL cursors" mode
    setPlayAllCursors(on) {
      state.playAll = !!on;
    },
    isPlayAllCursors() {
      return !!state.playAll;
    },
    // Force a new input selection (e.g., after changing something in the MCC)
    reconnect() {
      if (!state.midiAccess) return;
      selectInput();
    }
  };

  if (typeof window !== 'undefined') {
    window.__granularMidiController_v1 = { api };
  }

  // Immediate bootstrap
  setupMidi();

  return api;
}
