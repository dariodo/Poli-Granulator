/**
 * @module app/input/midi-glue
 * @description MIDI input binding to the audio engine.
 * Wraps the MIDI controller initialization and connects MIDI note events
 * to the keyboard note handlers for unified input processing.
 */

import { initMidiController } from '../midi-controller.js';
import { getActiveCursor } from '../state/cursors.js';
import { kbNoteOnSingle, kbNoteOffSingle, kbNoteOnAll, kbNoteOffAll } from './keyboard-glue.js';

let midiCtrl = null;

export function initMidiModule() {
  try {
    midiCtrl = initMidiController({
      getActiveCursor: () => getActiveCursor(),
      noteOn: kbNoteOnSingle,
      noteOff: kbNoteOffSingle,
      noteOnAll: kbNoteOnAll,
      noteOffAll: kbNoteOffAll,
      onStatusChange: (status, detail) => {
        // console.log('[MIDI]', status, detail);
      },
      onError: (err) => {
        console.warn('[MIDI] error:', err);
      }
    });
  } catch (err) {
    console.warn('[MIDI] init error:', err);
  }
  return midiCtrl;
}

export function getMidiCtrl(){ return midiCtrl; }
