# Poli-Granulator

A real-time **granular synthesizer** web application built with the Web Audio API and AudioWorklet. Poli-Granulator enables users to perform granular synthesis on any audio file or microphone input, with three independent cursors that can sample different regions of the audio simultaneously.

---

## Table of Contents

1. [Overview](#overview)
2. [Features](#features)
3. [Architecture Diagram](#architecture-diagram)
4. [Project Structure](#project-structure)
5. [Module Reference](#module-reference)
   - [Entry Point](#entry-point)
   - [Engine Layer](#engine-layer)
   - [DSP Worklet](#dsp-worklet)
   - [Session Management](#session-management)
   - [State Management](#state-management)
   - [Input Handling](#input-handling)
   - [UI Components](#ui-components)
6. [Granular Synthesis Algorithm](#granular-synthesis-algorithm)
7. [Keyboard Shortcuts](#keyboard-shortcuts)
8. [MIDI Support](#midi-support)
9. [Technical Notes](#technical-notes)
10. [Getting Started](#getting-started)

---

## Overview

Poli-Granulator is a **browser-based granular synthesizer** that implements real-time grain scheduling, per-cursor filtering, and polyphonic MIDI/keyboard input. It uses the modern Web Audio API's `AudioWorklet` for sample-accurate DSP processing on a dedicated audio thread.

**Key technologies:**
- **Web Audio API** — AudioContext, AudioWorkletNode, GainNode
- **AudioWorklet** — Low-latency DSP in a separate thread
- **SharedArrayBuffer (SAB)** — Optional high-performance parameter passing 
- **ES Modules** — Modern JavaScript module system for code organization
- **lamejs** — MP3 encoding for recording export

---

## Features

- **Three independent cursors (A/B/C)** — Each cursor can sample a different position in the audio buffer with its own parameter set
- **Real-time granular synthesis** — Poisson-distributed grain scheduling for natural, non-periodic textures
- **Per-cursor filters** — 12/24 dB lowpass biquad filters with LFO modulation
- **MIDI & QWERTY keyboard** — Polyphonic playback with piano-style key mapping
- **Microphone recording** — Hold-to-record directly into the synth
- **Output recording** — Export output as MP3
- **Loudness compensation** — Per-grain amplitude adjustment based on source RMS
- **Post-limiter** — True-peak limiting using telemetry 
- **Animated background** — Particle system driven by synthesis parameters
- **Responsive UI** — Knobs, faders, waveform display with draggable markers

---

## Architecture Diagram

```
╔═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════╗
║                                                        BROWSER ENVIRONMENT                                                    ║
╠═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════╣
║                                                                                                                               ║
║  ┌─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐  ║
║  │                                                      MAIN THREAD (UI)                                                   │  ║
║  ├─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤  ║
║  │                                                                                                                         │  ║
║  │   index.html ──▶ main.js ──▶ app/boot.js (orchestrator)                                                                 │  ║
║  │                                    │                                                                                    │  ║
║  │                    ┌───────────────┴───────────────────────────────────────────────────────────┐                        │  ║
║  │                    │                         initializes all modules                           │                        │  ║
║  │                    ▼                                                                           ▼                        │  ║
║  │                                                                                                                         │  ║
║  │   ┌───────────────────────┐      ┌───────────────────┐      ┌───────────────────────┐      ┌──────────────────────────┐ │  ║
║  │   │      app/input/       │      │    app/state/     │      │     app/session/      │      │      app/engine/         │ │  ║
║  │   │  (User Interaction)   │      │  (Parameters)     │      │   (Audio I/O)         │      │  (Audio Processing)      │ │  ║
║  │   │                       │      │                   │      │                       │      │                          │ │  ║
║  │   │ ┌───────────────────┐ │      │ ┌───────────────┐ │      │ ┌───────────────────┐ │      │ ┌──────────────────────┐ │ │  ║
║  │   │ │ keyboard-glue     │ │      │ │ cursors.js    │ │      │ │ buffer-session    │ │      │ │ audio-engine         │ │ │  ║
║  │   │ │ • QWERTY keys     │ │      │ │ • positions[] │ │      │ │ • loadFile()      │ │      │ │ • AudioContext       │ │ │  ║
║  │   │ │ • noteOn/Off      │ │─────▶│ │ • activeCursor│ │─────▶│ │ • decodeAudio()   │ │─────▶│ │ • ensureAudio()      │ │ │  ║
║  │   │ └───────────────────┘ │      │ │ • sliderMap   │ │      │ │ • loudnessMap     │ │      │ │ • workletNode        │ │ │  ║
║  │   │ ┌───────────────────┐ │      │ └───────────────┘ │      │ └───────────────────┘ │      │ └──────────────────────┘ │ │  ║
║  │   │ │ midi-glue         │ │      │ ┌───────────────┐ │      │ ┌───────────────────┐ │      │ ┌──────────────────────┐ │ │  ║
║  │   │ │ • Web MIDI API    │ │─────▶│ │ params.js     │ │─────▶│ │ mic-session       │ │─────▶│ │ sab.js               │ │ │  ║
║  │   │ │ • velocity        │ │      │ │ • cursorParams│ │      │ │ • micHoldStart    │ │      │ │ • SharedArrayBuffer  │ │ │  ║
║  │   │ └───────────────────┘ │      │ │ • pitchSemis  │ │      │ │ • micHoldStop     │ │      │ │ • writeParams        │ │ │  ║
║  │   │                       │      │ │ • commitPitch │ │      │ └───────────────────┘ │      │ └──────────────────────┘ │ │  ║
║  │   │                       │      │ └───────────────┘ │      │ ┌───────────────────┐ │      │ ┌──────────────────────┐ │ │  ║
║  │   │                       │      │ ┌───────────────┐ │      │ │ recorder-session  │ │      │ │ transport.js         │ │ │  ║
║  │   │                       │      │ │ hold.js       │ │      │ │ • startRec()      │ │◀─────│ │ • play/pause         │ │ │  ║
║  │   │                       │      │ │ • holdState[] │ │      │ │ • exportMP3()     │ │      │ │ • fadeIn/Out         │ │ │  ║
║  │   │                       │      │ │ • toggleHold  │ │      │ │ • lamejs encode   │ │      │ └──────────────────────┘ │ │  ║
║  │   │                       │      │ └───────────────┘ │      │ └───────────────────┘ │      │                          │ │  ║
║  │   └───────────────────────┘      └───────────────────┘      └───────────────────────┘      └──────────────────────────┘ │  ║
║  │            │                             │                          │                               ▲                   │  ║
║  │            │                             │                          │                               │                   │  ║
║  │            │      reads state            │    buffer/loudness       │      params via SAB           │                   │  ║
║  │            └──────────────────────────▶  └──────────────────────────┴───────────────────────────────┘                   │  ║
║  │                                                                                                     │                   │  ║
║  │   ┌─────────────────────────┐          applies default params to State → Engine                     │                   │  ║
║  │   │      app/presets/       │───────────────────────────────────────────────────────────────────────┘                   │  ║
║  │   │ safe.js                 │                                                                                           │  ║
║  │   │ • applyPresetSAFE       │                                                                                           │  ║
║  │   └─────────────────────────┘                                                                                           │  ║
║  │                                                                                                                         │  ║
║  │   ┌────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐    │  ║
║  │   │                                            UI COMPONENTS (ui/)                                                 │    │  ║
║  │   ├────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤    │  ║
║  │   │                                                                                                                │    │  ║
║  │   │  ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐ ┌───────────────────────┐ │    │  ║
║  │   │  │    waveform/     │ │     knobs/       │ │   transport/     │ │    overlay/      │ │         mic/          │ │    │  ║
║  │   │  │                  │ │                  │ │                  │ │                  │ │                       │ │    │  ║
║  │   │  │ waveform.js      │ │ knobs.js         │ │ transport-ui     │ │ splash.js        │ │ mic-visualizer.js     │ │    │  ║
║  │   │  │ • drawPeaks      │ │ • mountKnobs     │ │ • play/rec btn   │ │ • showSplash     │ │ • analyserNode        │ │    │  ║
║  │   │  │ • Hi-DPI canvas  │ │ • drag/rotate    │ │ • mode switches  │ │ • keycaps UI     │ │ • liveWaveform        │ │    │  ║
║  │   │  │                  │ │ • zeroSnap       │ │                  │ │                  │ │                       │ │    │  ║
║  │   │  │ markers.js       │ │ knobs.css        │ └──────────────────┘ └──────────────────┘ └───────────────────────┘ │    │  ║
║  │   │  │ • A/B/C drag     │ └──────────────────┘                                                                     │    │  ║
║  │   │  └──────────────────┘                                                                                          │    │  ║
║  │   │                                                                                                                │    │  ║
║  │   │  ┌──────────────────┐ ┌──────────────────┐ ┌──────────────────┐ ┌────────────────────────────────────────────┐ │    │  ║
║  │   │  │       io/        │ │  master-fader    │ │   dbmeter.js     │ │           background-animation.js          │ │    │  ║
║  │   │  │ io-split.js      │ │ • volume dB      │ │ • GR/TP bars     │ │ • particle layers A/B/C                    │ │    │  ║
║  │   │  │ • layout mgmt    │ │ • connectGain    │ │ • telemetry      │ │ • grainSize→radius, spread→speed           │ │    │  ║
║  │   │  └──────────────────┘ └──────────────────┘ └──────────────────┘ │ • density→particleCount                    │ │    │  ║
║  │   │                                                                 └────────────────────────────────────────────┘ │    │  ║
║  │   └────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘    │  ║
║  │                                                                                                                         │  ║
║  │   ┌─────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐   │  ║
║  │   │                                        HOTKEYS & CONTROLLERS (app/)                                             │   │  ║
║  │   │  hotkeys.js               piano-keyboard.js              midi-controller.js              mic-capture.js         │   │  ║
║  │   │  • L=load M=mic           • A-K white keys               • Web MIDI API                  • getUserMedia         │   │  ║
║  │   │  • Space=play R=rec       • W,E,T,Y,U black              • noteOn/Off events             • analyserNode         │   │  ║
║  │   │  • ←→ cursor pos          • Z/X octave shift             • CC mapping                    • recorder buffer      │   │  ║
║  │   │  • ↑↓ master vol          • Alt=all cursors              • status callback               • hold-to-record       │   │  ║
║  │   └─────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘   │  ║
║  │                                                                                                                         │  ║
║  └────────────────────────────────────────────────────────────────────────────────────────────────────────────▲────────────┘  ║
║                         │                                                                                     │               ║
║                         │ AudioWorkletNode.port                                                               │               ║
║                         │ ════════════════════════════════════                                                │               ║
║                         │  ┌─────────────────────────────────────────────────────────────────────────────┐    │               ║
║                         │  │                            MESSAGE PROTOCOL                                 │    │               ║
║                         │  │                                                                             │    │               ║
║                         │  │  MAIN → WORKLET:                             WORKLET → MAIN:                │    │               ║
║                         │  │  ─────────────────────────                   ──────────────────────         │    │               ║
║                         │  │  • setBuffer (stereo channels)               • positions (scan feedback)    │    │               ║
║                         │  │  • setParamsAll / setParamsFor               • telemetry (GR, TP)           │    │               ║
║                         │  │  • setPositions (A/B/C)                      • ready (handshake)            │    │               ║
║                         │  │  • setPlaying (true/false)                                                  │    │               ║
║                         │  │  • setParamSAB (SharedArrayBuffer)                                          │    │               ║
║                         │  │  • setLoudnessMap (RMS array)                                               │    │               ║
║                         │  │  • noteOn/noteOff (single cursor)                                           │    │               ║
║                         │  │  • noteOnAll/noteOffAll (all cursors)                                       │    │               ║
║                         │  │  • clearKbNotes / killCursorGrains                                          │    │               ║
║                         │  └─────────────────────────────────────────────────────────────────────────────┘    │               ║
║                         │                                                                                     │               ║
║                         ▼                                                                                     │               ║
║  ┌─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐  ║
║  │                                                   AUDIO WORKLET THREAD                                                  │  ║
║  ├─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤  ║
║  │                                                                                                                         │  ║
║  │   ┌───────────────────────────────────────────────────────────────────────────────────────────────────────────────┐     │  ║
║  │   │                          worklet/granular-processor.js (GranularProcessorPro)                                 │     │  ║
║  │   │                                                                                                               │     │  ║
║  │   │   ┌───────────────────────────────────────────────────────────────────────────────────────────────────────┐   │     │  ║
║  │   │   │                                     GRAIN SYNTHESIS ENGINE                                            │   │     │  ║
║  │   │   │                                                                                                       │   │     │  ║
║  │   │   │  ┌─────────────────────┐    ┌───────────────────────────────────────────────────────────────────┐     │   │     │  ║
║  │   │   │  │    Audio Buffer     │    │                      GRAIN POOL (1024 slots)                      │     │   │     │  ║
║  │   │   │  │ ─────────────────── │    │  ┌──────────────────────────────────────────────────────────────┐ │     │   │     │  ║
║  │   │   │  │ L: Float32Array     │───▶│  │ Struct-of-Arrays:                                            │ │     │   │     │  ║
║  │   │   │  │ R: Float32Array     │    │  │ • active[1024]       - is grain currently playing?           │ │     │   │     │  ║
║  │   │   │  │                     │    │  │ • cursor[1024]       - which cursor (0/1/2)                  │ │     │   │     │  ║
║  │   │   │  │ sampleRate          │    │  │ • srcPos[1024]       - buffer start position                 │ │     │   │     │  ║
║  │   │   │  │ length              │    │  │ • pos[1024]          - current playback position             │ │     │   │     │  ║
║  │   │   │  └─────────────────────┘    │  │ • len[1024]          - grain duration in frames              │ │     │   │     │  ║
║  │   │   │          ▲                  │  │ • age[1024]          - frames elapsed since start            │ │     │   │     │  ║
║  │   │   │          │                  │  │ • rate[1024]         - playback rate (pitch shift)           │ │     │   │     │  ║
║  │   │   │   ┌──────┴──────┐           │  │ • panL/R[1024]       - stereo pan coefficients               │ │     │   │     │  ║
║  │   │   │   │   CURSORS   │           │  │ • gain[1024]         - amplitude (loudness comp)             │ │     │   │     │  ║
║  │   │   │   │   A   B   C │           │  │ • semiOffset[1024]   - MIDI pitch offset                     │ │     │   │     │  ║
║  │   │   │   │   │   │   │ │           │  └──────────────────────────────────────────────────────────────┘ │     │   │     │  ║
║  │   │   │   │   ▼   ▼   ▼ │           │                           │                                       │     │   │     │  ║
║  │   │   │   │  positions  │◀──────────│───────────────────────────┤                                       │     │   │     │  ║
║  │   │   │   │  [0.15,     │           │                           ▼                                       │     │   │     │  ║
║  │   │   │   │   0.50,     │           │  ┌─────────────────────────────────────────────────────┐          │     │   │     │  ║
║  │   │   │   │   0.85]     │           │  │        POISSON SCHEDULER (per cursor)               │          │     │   │     │  ║
║  │   │   │   └─────────────┘           │  │        countdown[3] → nextInterval()                │          │     │   │     │  ║
║  │   │   │                             │  │        exp(-mean * log(1-U))                        │          │     │   │     │  ║
║  │   │   │                             │  │                     │                               │          │     │   │     │  ║
║  │   │   │                             │  │                     ▼ (spawn grain)                 │          │     │   │     │  ║
║  │   │   │                             │  │  ┌─────────────────────────────────────────┐        │          │     │   │     │  ║
║  │   │   │                             │  │  │ GRAIN SPAWNING                          │        │          │     │   │     │  ║
║  │   │   │                             │  │  │ • pos   = cursor ± spread               │        │          │     │   │     │  ║
║  │   │   │                             │  │  │ • len   = attack + release              │        │          │     │   │     │  ║
║  │   │   │                             │  │  │ • rate  = pitch × MIDI semitone         │        │          │     │   │     │  ║
║  │   │   │                             │  │  │ • pan   = equalPower(panValue)          │        │          │     │   │     │  ║
║  │   │   │                             │  │  │ • gain  = loudnessCompensation          │        │          │     │   │     │  ║
║  │   │   │                             │  │  └─────────────────────────────────────────┘        │          │     │   │     │  ║
║  │   │   │                             │  └─────────────────────────────────────────────────────┘          │     │   │     │  ║
║  │   │   │                             └───────────────────────────────────────────────────────────────────┘     │   │     │  ║
║  │   │   │                                                      │                                                │   │     │  ║
║  │   │   │                                                      ▼                                                │   │     │  ║
║  │   │   │   ┌──────────────────────────────────────────────────────────────────────────────────────────────┐    │   │     │  ║
║  │   │   │   │                              GRAIN RENDERING (per audio frame)                               │    │   │     │  ║
║  │   │   │   │                                                                                              │    │   │     │  ║
║  │   │   │   │   for each active grain:                                                                     │    │   │     │  ║
║  │   │   │   │   ┌──────────────────────────────────────────────────────────────────────────────────────┐   │    │   │     │  ║
║  │   │   │   │   │ envelope = hannLUT[ age / length ]           (window function lookup)                │   │    │   │     │  ║
║  │   │   │   │   │ sampleL  = bufferL[ position ]               (linear interpolation)                  │   │    │   │     │  ║
║  │   │   │   │   │ sampleR  = bufferR[ position ]                                                       │   │    │   │     │  ║
║  │   │   │   │   │ outL    += sampleL × envelope × gain × panL                                          │   │    │   │     │  ║
║  │   │   │   │   │ outR    += sampleR × envelope × gain × panR                                          │   │    │   │     │  ║
║  │   │   │   │   │ position += rate                                                                     │   │    │   │     │  ║
║  │   │   │   │   │ age++                                                                                │   │    │   │     │  ║
║  │   │   │   │   └──────────────────────────────────────────────────────────────────────────────────────┘   │    │   │     │  ║
║  │   │   │   └──────────────────────────────────────────────────────────────────────────────────────────────┘    │   │     │  ║
║  │   │   │                                            │                                                          │   │     │  ║
║  │   │   │                                            ▼                                                          │   │     │  ║
║  │   │   │   ┌──────────────────────────────────────────────────────────────────────────────────────────────┐    │   │     │  ║
║  │   │   │   │                            PER-CURSOR FILTER CHANNELS (3×)                                   │    │   │     │  ║
║  │   │   │   │                                                                                              │    │   │     │  ║
║  │   │   │   │   ┌────────────────────────┐    ┌────────────────────────┐    ┌────────────────────────┐     │    │   │     │  ║
║  │   │   │   │   │       CURSOR A         │    │       CURSOR B         │    │       CURSOR C         │     │    │   │     │  ║
║  │   │   │   │   │     FilterChannel      │    │     FilterChannel      │    │     FilterChannel      │     │    │   │     │  ║
║  │   │   │   │   │  ┌──────────────────┐  │    │  ┌──────────────────┐  │    │  ┌──────────────────┐  │     │    │   │     │  ║
║  │   │   │   │   │  │   BiquadLP       │  │    │  │   BiquadLP       │  │    │  │   BiquadLP       │  │     │    │   │     │  ║
║  │   │   │   │   │  │   (RBJ TDF2)     │  │    │  │   (RBJ TDF2)     │  │    │  │   (RBJ TDF2)     │  │     │    │   │     │  ║
║  │   │   │   │   │  │   12/24 dB/oct   │  │    │  │   12/24 dB/oct   │  │    │  │   12/24 dB/oct   │  │     │    │   │     │  ║
║  │   │   │   │   │  └──────────────────┘  │    │  └──────────────────┘  │    │  └──────────────────┘  │     │    │   │     │  ║
║  │   │   │   │   │          ▲             │    │          ▲             │    │          ▲             │     │    │   │     │  ║
║  │   │   │   │   │      LFO ┴ cutoff      │    │      LFO ┴ cutoff      │    │      LFO ┴ cutoff      │     │    │   │     │  ║
║  │   │   │   │   └────────────────────────┘    └────────────────────────┘    └────────────────────────┘     │    │   │     │  ║
║  │   │   │   │              │                          │                          │                         │    │   │     │  ║
║  │   │   │   │              └──────────────────────────┼──────────────────────────┘                         │    │   │     │  ║
║  │   │   │   │                                         ▼ (sum)                                              │    │   │     │  ║
║  │   │   │   └──────────────────────────────────────────────────────────────────────────────────────────────┘    │   │     │  ║
║  │   │   │                                             │                                                         │   │     │  ║
║  │   │   │                                             ▼                                                         │   │     │  ║
║  │   │   │   ┌──────────────────────────────────────────────────────────────────────────────────────────────┐    │   │     │  ║
║  │   │   │   │                                POST-PROCESSING LIMITER                                       │    │   │     │  ║
║  │   │   │   │                                                                                              │    │   │     │  ║
║  │   │   │   │   ┌──────────────────────────────────────────────────────────────────────────────────────┐   │    │   │     │  ║
║  │   │   │   │   │  masterTrim (0.80) → headroom                                                        │   │    │   │     │  ║
║  │   │   │   │   │               │                                                                      │   │    │   │     │  ║
║  │   │   │   │   │               ▼                                                                      │   │    │   │     │  ║
║  │   │   │   │   │  ┌────────────────────────────────────────────────────────────────────────────────┐  │   │    │   │     │  ║
║  │   │   │   │   │  │ LOOK-AHEAD LIMITER (3ms)                                                       │  │   │    │   │     │  ║
║  │   │   │   │   │  │ • Ring buffer delay line                                                       │  │   │    │   │     │  ║
║  │   │   │   │   │  │ • Peak detection with 2× true-peak estimation                                  │  │   │    │   │     │  ║
║  │   │   │   │   │  │ • Gain envelope with release (50ms)                                            │  │   │    │   │     │  ║
║  │   │   │   │   │  │ • Ceiling = 0.98 (-0.18 dBFS)                                                  │  │   │    │   │     │  ║
║  │   │   │   │   │  └────────────────────────────────────────────────────────────────────────────────┘  │   │    │   │     │  ║
║  │   │   │   │   │               │                                                                      │   │    │   │     │  ║
║  │   │   │   │   │               ▼                                                                      │   │    │   │     │  ║
║  │   │   │   │   │           TELEMETRY ──────────────▶ main thread (dbmeter.js)                         │   │    │   │     │  ║
║  │   │   │   │   └──────────────────────────────────────────────────────────────────────────────────────┘   │    │   │     │  ║
║  │   │   │   └──────────────────────────────────────────────────────────────────────────────────────────────┘    │   │     │  ║
║  │   │   └───────────────────────────────────────────────────────────────────────────────────────────────────────┘   │     │  ║
║  │   └───────────────────────────────────────────────────────────────────────────────────────────────────────────────┘     │  ║
║  │                                                           │                                                             │  ║
║  │   ┌───────────────────────────────────────────────────────────────────────────────────────────────────────────────┐     │  ║
║  │   │                                     DSP UTILITY MODULES (worklet/dsp/)                                        │     │  ║
║  │   │                                                                                                               │     │  ║
║  │   │  ┌───────────────────────┐ ┌───────────────────────┐ ┌───────────────────────┐ ┌───────────────────────┐      │     │  ║
║  │   │  │     scheduler.js      │ │      windows.js       │ │   filter-cutoff.js    │ │      limiter.js       │      │     │  ║
║  │   │  │                       │ │                       │ │                       │ │                       │      │     │  ║
║  │   │  │ • Poisson scheduling  │ │ • createHannLUT       │ │ • BiquadLP class      │ │ • createLimiter       │      │     │  ║
║  │   │  │ • expectedOverlaps    │ │ • envAtFromLUT        │ │ • FilterChannel       │ │ • processLimiter      │      │     │  ║
║  │   │  │ • autogainOLA         │ │ • equalPowerPan       │ │ • uiToHz              │ │ • truePeak2x          │      │     │  ║
║  │   │  │                       │ │                       │ │ • LFO modulation      │ │ • toDb                │      │     │  ║
║  │   │  └───────────────────────┘ └───────────────────────┘ └───────────────────────┘ └───────────────────────┘      │     │  ║
║  │   └───────────────────────────────────────────────────────────────────────────────────────────────────────────────┘     │  ║
║  │                                                                                                                         │  ║
║  └─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘  ║
║                                                           │                                                                   ║
║                                                           │ AUDIO SIGNAL (stereo output)                                      ║
║                                                           ▼                                                                   ║
║  ┌─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐  ║
║  │                                            MAIN THREAD AUDIO GRAPH (GainNodes)                                          │  ║
║  ├─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤  ║
║  │                                                                                                                         │  ║
║  │                           ┌────────────────────────────────────────────────────────────────┐                            │  ║
║  │                           │               transportGain (GainNode)                         │                            │  ║
║  │                           │               • Play/pause fade (30ms ramp)                    │                            │  ║
║  │                           │               • Controlled by transport.js                     │                            │  ║
║  │                           └──────────────────────────┬─────────────────────────────────────┘                            │  ║
║  │                                                      │                                                                  │  ║
║  │                                                      ▼                                                                  │  ║
║  │                           ┌────────────────────────────────────────────────────────────────┐                            │  ║
║  │                           │               masterGain (GainNode)                            │                            │  ║
║  │                           │               • Master volume fader (-60 to 0 dB)              │                            │  ║
║  │                           │               • Controlled by master-fader.js                  │                            │  ║
║  │                           └──────────────────────────┬─────────────────────────────────────┘                            │  ║
║  │                                                      │                                                                  │  ║
║  │                                                      ▼                                                                  │  ║
║  │                           ┌────────────────────────────────────────────────────────────────┐                            │  ║
║  │                           │          recorderNode (RecorderProcessor worklet)              │                            │  ║
║  │                           │          • Pass-through stereo (no modification)               │                            │  ║
║  │                           │          • When armed: captures Float32 chunks                 │                            │  ║
║  │                           │          • Messages: rec-start → rec-chunk → stop              │                            │  ║
║  │                           │          • MP3 export via lamejs                               │                            │  ║
║  │                           └──────────────────────────┬─────────────────────────────────────┘                            │  ║
║  │                                                      │                                                                  │  ║
║  │                                                      ▼                                                                  │  ║
║  │                           ┌────────────────────────────────────────────────────────────────┐                            │  ║
║  │                           │              destination (AudioDestinationNode)                │                            │  ║
║  │                           │              • System speakers / audio output                  │                            │  ║
║  │                           └────────────────────────────────────────────────────────────────┘                            │  ║
║  │                                                                                                                         │  ║
║  └─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘  ║
║                                                                                                                               ║
╚═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════╝

LEGEND:
═══════
──────▶  Data flow / function call              ◀────▶  Bidirectional dependency
═══════  Thread boundary                        ───────  Logical grouping
════════ Audio signal flow
```

---

## Project Structure

```
Poli-Granulator/
├── index.html              # Main HTML page
├── main.js                 # Entry point, imports boot.js
├── styles.css              # Global styles
├── package.json            # Project metadata and scripts
├── LICENSE                 # MIT license
├── README.md               # This file
├── .gitignore              # Git ignore rules
│
├── app/                    # Application logic
│   ├── boot.js             # Orchestration, hooks wiring, DOMContentLoaded
│   ├── hotkeys.js          # Keyboard shortcut handling
│   ├── mic-capture.js      # Microphone recording API
│   ├── midi-controller.js  # Web MIDI API wrapper
│   ├── piano-keyboard.js   # QWERTY piano keyboard
│   │
│   ├── engine/             # Audio engine
│   │   ├── audio-engine.js   # AudioContext, worklet loading, graph wiring
│   │   ├── sab.js            # SharedArrayBuffer parameter management
│   │   └── transport.js      # Play/pause, transport gain control
│   │
│   ├── imput/              # Input handling
│   │   ├── keyboard-glue.js # QWERTY 
│   │   └── midi-glue.js     # MIDI 
│   │
│   ├── presets/            # Preset system
│   │   └── safe.js         # Default preset
│   │
│   ├── session/            # Session management
│   │   ├── buffer-session.js    # Audio file loading/decoding
│   │   ├── mic-session.js       # Microphone recording session
│   │   └── recorder-session.js  # Output recording + MP3 export
│   │
│   └── state/              # Application state
│       ├── cursors.js        # Cursor positions, active cursor, UI sync
│       ├── hold.js           # Hold button state per cursor
│       └── params.js         # Per-cursor synthesis parameters
│
├── ui/                     # UI components
│   ├── background-animation.js  # Particle animation
│   ├── dbmeter.js               # dB meter display
│   ├── master-fader.js          # Master volume fader
│   ├── tri-switch.js            # A/B/C selector switch
│   │
│   ├── io/
│   │   └── io-split.js         # I/O panel layout
│   │
│   ├── knobs/
│   │   ├── knobs.js            # Knob component mounting
│   │   └── knobs.css           # Knob styles
│   │
│   ├── mic/
│   │   └── mic-visualizer.js   # Live microphone waveform
│   │
│   ├── overlay/
│   │   └── splash.js           # Info overlay, keycaps
│   │
│   ├── transport/
│   │   └── transport-ui.js     # Play/Rec switches, button bindings
│   │
│   └── waveform/
│       ├── waveform.js         # Waveform rendering, peaks cache
│       └── makers.js           # Cursor markers, dragging
│
├── worklet/                # AudioWorklet processors
│   ├── granular-processor.js   # Main granular synthesis engine
│   ├── recorder-processor.js   # Pass-through recorder
│   │
│   └── dsp/                # DSP utility modules
│       ├── filter-cutoff.js    # Biquad LP filter with LFO
│       ├── limiter.js          # Look-ahead peak limiter
│       ├── scheduler.js        # Poisson grain scheduling
│       └── windows.js          # Hann LUT, panning utilities
│
└── assets/                 # Static assets
    ├── audio/              # Sample audio files
    ├── fonts/              # Custom fonts
    └── icons/              # UI icons
```

---

## Module Reference

### Entry Point

#### `main.js`
```javascript
import './app/boot.js';
```
A thin entry point that simply imports `boot.js` to start the application.

---

### Engine Layer

#### `app/engine/audio-engine.js`
The core audio engine that creates and manages the Web Audio graph.

**Key exports:**
| Function | Description |
|----------|-------------|
| `ensureAudio()` | Initialization of AudioContext, loads worklets, wires graph |
| `getAudioCtx()` | Returns the AudioContext instance |
| `getWorkletNode()` | Returns the granular processor AudioWorkletNode |
| `getRecorderNode()` | Returns the recorder processor AudioWorkletNode |
| `getMasterGain()` | Returns the master GainNode |
| `getTransportGain()` | Returns the transport (play/pause) GainNode |
| `setEngineHooks(partial)` | Configures callback hooks for module communication |
| `waitForWorkletReady()` | Returns Promise that resolves when worklet is ready |
| `setDbMeterEnabled(on)` | Enable/disable dB meter updates |

**Audio Graph Structure:**
```
workletNode → transportGain → masterGain → recorderNode → destination
```

**Message Types (worklet → main):**
- `positions` — Updated cursor positions from scan speed
- `telemetry` — Limiter metrics 
- `ready` — Worklet initialization complete

---

#### `app/engine/sab.js`
Optional SharedArrayBuffer-based parameter passing for high performance.

**Key exports:**
| Export | Description |
|--------|-------------|
| `hasSAB` | Boolean indicating if SAB is available |
| `CURSOR_STRIDE` | Number of parameters per cursor (15) |
| `getSabView()` | Returns Float32Array view of the shared buffer |
| `getSabParams()` | Returns the SharedArrayBuffer |
| `writeParamsToSAB(idx, params)` | Write cursor parameters to SAB |
| `initSAB(workletNode, cursorParams)` | Initialize SAB and send to worklet |

**SAB Layout (per cursor, 15 floats):**
```
[attack, release, density, spread, pan, pitch, cutoff, lfoFreq, lfoDepth, 
 scanSpeed, gain, grainSize, qNorm, driveNorm, slopeSel]
```

---

#### `app/engine/transport.js`
Transport control (play/pause) with smooth fade.

**Key exports:**
| Function | Description |
|----------|-------------|
| `isPlaying` | Current play state |
| `setPlayingState(on)` | Set play state |
| `pauseSynthWithFade(ms)` | Fade out and pause |
| `restoreTransportGain()` | Restore gain to 1.0 |
| `setTransportHooks(partial)` | Configure UI callbacks |

---

### DSP Worklet

#### `worklet/granular-processor.js`
The main granular synthesis engine running in the AudioWorklet thread.

**Class: `GranularProcessorPro`**

**Grain Pool Structure (Struct-of-Arrays, 1024 slots):**
```javascript
{
  active: Uint8Array(1024),      // Is grain active?
  cursor: Uint8Array(1024),      // Which cursor (0/1/2)
  srcPos: Uint32Array(1024),     // Start position in buffer
  pos: Float32Array(1024),       // Current fractional position
  len: Uint32Array(1024),        // Grain length in frames
  age: Uint32Array(1024),        // Current age (frames elapsed)
  rate: Float32Array(1024),      // Playback rate (pitch)
  panL: Float32Array(1024),      // Left pan coefficient
  panR: Float32Array(1024),      // Right pan coefficient
  gain: Float32Array(1024),      // Per-grain gain
  semiOffset: Float32Array(1024) // Semitone offset (MIDI)
}
```

**Message Types (main → worklet):**
| Type | Description |
|------|-------------|
| `setBuffer` | Load audio buffer |
| `setParamsAll` | Set all cursor parameters |
| `setParamsFor` | Set parameters for one cursor |
| `setPositions` | Set cursor positions (normalized 0–1) |
| `setPlaying` | Start/stop grain generation |
| `setParamSAB` | Attach SharedArrayBuffer for params |
| `setLoudnessMap` | Set RMS loudness map for compensation |
| `noteOn/noteOff` | Single cursor note on/off |
| `noteOnAll/noteOffAll` | All cursors note on/off |
| `clearKbNotes` | Clear keyboard notes for cursor |
| `killCursorGrains` | Kill all grains for cursor |

**Algorithm Highlights:**
1. **Poisson scheduling** — Non-periodic grain spawning using exponential inter-arrival times
2. **Hann envelope LUT** — Pre-computed 1024-sample Hann window for efficient envelope lookup
3. **Per-grain loudness compensation** — Adjusts grain amplitude based on source RMS
4. **MIDI polyphony** — Up to 16 simultaneous keyboard notes per cursor
5. **Per-cursor filters** — Biquad lowpass with LFO modulation
6. **Post-limiter** — 3ms look-ahead true-peak limiting

---

#### `worklet/recorder-processor.js`
Simple pass-through processor that captures audio chunks for recording.

**Features:**
- Stereo pass-through (no audio modification)
- Chunk capture when recording is armed
- Auto-stop when max frames reached
- Messages: `rec-start`, `rec-stop`, `rec-chunk`, `rec-autostop`

---

#### `worklet/dsp/scheduler.js`
Grain scheduling utilities.

**Exports:**
| Function | Description |
|----------|-------------|
| `nextIntervalFramesPoisson(sr, density)` | Exponential inter-arrival time |
| `nextIntervalFramesUniformJitter(sr, density, jitter)` | Uniform with jitter |
| `expectedOverlaps(density, attack, release)` | Estimate overlap count |
| `autogainFromOLA(density, attack, release, curve)` | OLA-aware gain compensation |

---

#### `worklet/dsp/windows.js`
Windowing and panning utilities.

**Exports:**
| Function | Description |
|----------|-------------|
| `createHannLUT(size)` | Pre-compute Hann window table |
| `envAtFromLUT(pos, len, lut)` | Lookup envelope value with interpolation |
| `equalPowerPan(pan)` | Returns `{L, R}` gain coefficients |
| `lerp(a, b, t)` | Linear interpolation |

---

#### `worklet/dsp/filter-cutoff.js`
Biquad lowpass filter with LFO modulation.

**Classes:**
- `BiquadLP` — RBJ-formula biquad lowpass (TDF2), stereo
- `FilterChannel` — Filter wrapper with drive, 12/24 dB slope, smoothing

**Utilities:**
| Function | Description |
|----------|-------------|
| `uiToHz(t, min, max)` | Map normalized value to Hz (log scale) |
| `uiToQ(t, min, max)` | Map normalized value to Q (log scale) |
| `uiToDrive(t, min, max)` | Map normalized value to drive amount |

---

#### `worklet/dsp/limiter.js`
Look-ahead peak limiter with true-peak estimation.

**Exports:**
| Function | Description |
|----------|-------------|
| `createLimiter(sr, opts)` | Create limiter state object |
| `processLimiter(state, outL, outR)` | Apply limiting in-place |
| `truePeak2x(l, r)` | Estimate true-peak via 2× linear upsample |
| `toDb(x)` | Convert linear to dBFS |

**Limiter Options:**
```javascript
{
  lookaheadMs: 3,    // Look-ahead time
  ceiling: 0.98,     // Maximum output level
  releaseMs: 50,     // Gain release time
  masterTrim: 0.80   // Pre-limiter trim (headroom)
}
```

---

### Session Management

#### `app/session/buffer-session.js`
Audio file loading and decoding.

**Exports:**
| Function | Description |
|----------|-------------|
| `getAudioBuffer()` | Get the current decoded AudioBuffer |
| `useDecodedBuffer(buf)` | Load decoded buffer into synth |
| `downmixToMono(buf)` | Utility to downmix to mono |
| `buildLoudnessMap(buf, win)` | Build RMS loudness map |

**Flow:**
1. User selects file via `<input type="file">`
2. File is decoded with `decodeAudioData()`
3. Stereo channels sent to worklet via `setBuffer` message
4. Loudness map computed and sent to worklet
5. Waveform redrawn

---

#### `app/session/mic-session.js`
Microphone recording session management.

**Exports:**
| Function | Description |
|----------|-------------|
| `micHoldStart()` | Start microphone recording (hold mode) |
| `micHoldStop()` | Stop recording and load buffer |
| `getMicCtrl()` | Get current mic controller |
| `MIC_MAX_SECONDS` | Maximum recording duration (600s) |

---

#### `app/session/recorder-session.js`
Output recording and MP3 export.

**Exports:**
| Function | Description |
|----------|-------------|
| `startRecording()` | Start capturing output |
| `stopRecordingAndExport()` | Stop and download MP3 |
| `getIsRecording()` | Check recording state |
| `setRecorderHooks(partial)` | Configure UI callbacks |

**Flow:**
1. `rec-start` message sent to recorder worklet
2. Worklet sends `rec-chunk` messages with L/R Float32Arrays
3. On stop, chunks concatenated and encoded to MP3 via lamejs
4. MP3 blob downloaded as file

---

### State Management

#### `app/state/cursors.js`
Cursor position and active cursor management.

**Exports:**
| Export | Description |
|--------|-------------|
| `positions` | Array `[0.15, 0.50, 0.85]` — normalized positions |
| `activeCursor` | Current active cursor index (0/1/2) |
| `getActiveCursor()` | Get active cursor |
| `setActiveCursor(n, source)` | Set active cursor |
| `sendPositions()` | Send positions to worklet |
| `sendAllCursorParams()` | Send all params to worklet |
| `applyCursorToUI(idx)` | Sync UI sliders to cursor params |

**Slider Map:**
The module maintains a mapping from slider element IDs to parameter keys:
```javascript
{
  attackRange: 'attack',
  releaseRange: 'release',
  densityRange: 'density',
  spreadRange: 'spread',
  panRange: 'pan',
  pitchRange: 'pitch',
  filterCutoffRange: 'cutoff',
  filterQRange: 'qNorm',
  filterDriveRange: 'driveNorm',
  filterSlopeSelect: 'slopeSel',
  lfoFreqRange: 'lfoFreq',
  lfoDepthRange: 'lfoDepth',
  scanSpeedRange: 'scanSpeed',
  gainRange: 'gain',
  grainSizeRange: 'grainSize'
}
```

---

#### `app/state/params.js`
Per-cursor synthesis parameters.

**Exports:**
| Export | Description |
|--------|-------------|
| `cursorParams` | Array of 3 parameter objects |
| `NOMINAL` | Default parameter values |
| `pitchKnobSemis` | Pitch knob values in semitones |
| `pitchBaselineSemis` | Pitch baseline for keyboard |
| `commitPitch(idx)` | Calculate and send pitch rate |
| `commitPitchAll()` | Commit pitch for all cursors |

**Parameter Object:**
```javascript
{
  attack: 0.5,      // Grain attack (seconds)
  release: 0.5,     // Grain release (seconds)
  density: 30,      // Grains per second
  spread: 0.1,      // Random position offset
  pan: 0,           // Stereo pan (-1 to +1)
  pitch: 1.0,       // Playback rate
  cutoff: 5000,     // Filter cutoff (Hz)
  qNorm: 0.2,       // Filter Q (normalized)
  driveNorm: 0.0,   // Filter drive (normalized)
  slopeSel: 0,      // Filter slope (0=12dB, 1=24dB)
  lfoFreq: 1,       // LFO frequency (Hz)
  lfoDepth: 0.2,    // LFO depth (normalized)
  scanSpeed: 0,     // Cursor scan speed
  gain: 0,          // Cursor gain (dB)
  grainSize: 1.0    // Grain size multiplier
}
```

---

#### `app/state/hold.js`
HOLD button state management.

**Exports:**
| Export | Description |
|--------|-------------|
| `holdState` | Array `[false, false, false]` per cursor |
| `toggleHoldFor(idx)` | Toggle hold for cursor |
| `updateHoldUI()` | Update button visual state |
| `initHoldButtonWiring()` | Bind click handler |
| `setHoldHooks(partial)` | Configure callbacks |
| `getHoldButton()` | Get hold button element |

When HOLD is active, `noteOff` messages are suppressed, causing notes to sustain until HOLD is released.

---

### Input Handling

#### `app/input/keyboard-glue.js`
Bridge between QWERTY keyboard and granular engine.

**Key Logic:**
- Tracks held notes per cursor
- Optional `SOLO_MODE` (play just one cursor at a time when play state is off)
- Integrates with `holdState` for sustained notes

**Exports:**
| Function | Description |
|----------|-------------|
| `initKbModule()` | Initialize keyboard module |
| `clearKbMute()` | Clear solo mute state |
| `kbNoteOnSingle(cursor, semis)` | Note on for single cursor |
| `kbNoteOffSingle(cursor, semis)` | Note off for single cursor |
| `kbNoteOnAll(semis)` | Note on for all cursors |
| `kbNoteOffAll(semis)` | Note off for all cursors |

---

#### `app/input/midi-glue.js`
Bridge between Web MIDI API and granular engine.

**Exports:**
| Function | Description |
|----------|-------------|
| `initMidiModule()` | Initialize MIDI controller |
| `getMidiCtrl()` | Get MIDI controller instance |

Uses the same `kbNoteOn/Off` functions as keyboard-glue.

---

### UI Components

#### `ui/waveform/waveform.js`
Waveform canvas rendering.

**Features:**
- Hi-DPI canvas support
- Peaks cache for efficient redraws
- Live microphone visualization mode
- Redraw scheduler (1 per frame)

**Exports:**
| Function | Description |
|----------|-------------|
| `drawWaveform(buffer)` | Draw waveform from AudioBuffer |
| `resizeWaveformCanvas()` | Handle canvas resize |
| `resetWaveformCache()` | Clear peaks cache |
| `rebuildPeaksIfNeeded(buffer)` | Rebuild peaks if dimensions changed |
| `requestWaveformRedraw()` | Schedule redraw on next frame |

---

#### `ui/waveform/markers.js`
Cursor markers with dragging support.

**Features:**
- Animated marker width on selection
- Drag-to-position with hit testing
- Drag lock to prevent worklet updates during drag

---

#### `ui/knobs/knobs.js`
Rotary knob component mounting.

**API:**
```javascript
mountKnobs({
  root: document,
  sliderSelector: '.params .col input.param-slider',
  zeroSnapIds: new Set(['scanSpeedRange', 'panRange', 'pitchRange']),
  maybeSnapToZero: (el) => { /* snap near zero */ }
})
```

**Features:**
- Injects "inset/chamfer" skin over `<input type="range">`
- Drag interaction on knob face
- Zero-mark click to snap to center

---

#### `ui/background-animation.js`
Particle animation driven by synthesis parameters.

**Layer Mapping:**
- Layer 0 (green) → Cursor A
- Layer 1 (blue) → Cursor B  
- Layer 2 (red) → Cursor C

**Parameter Mapping:**
| Synth Param | Particle Effect |
|-------------|-----------------|
| `grainSize` | Particle radius |
| `spread`    | Particle speed  |
| `density`   | Particle count  |

---

## Granular Synthesis Algorithm

### Grain Lifecycle

1. **Scheduling**: Poisson process determines next spawn time
   ```javascript
   nextInterval = -mean * Math.log(1 - Math.random())
   ```

2. **Spawn**: New grain allocated with:
   - Position: cursor position ± spread × random
   - Length: attack + release frames
   - Rate: pitch × (optional MIDI offset)
   - Pan: equal-power coefficients
   - Gain: base gain × loudness compensation

3. **Synthesis**: For each frame in grain:
   ```javascript
   envelope = hannLUT[age / length]  // Hann window
   sample = buffer[position]          // Linear interpolation
   output += sample * envelope * gain * panCoeff
   position += rate                   // Advance by pitch rate
   age++
   ```

4. **Filter**: Per-cursor biquad lowpass applied to summed grains

5. **Limit**: Post-processing limiter prevents clipping

### Loudness Compensation

Pre-computed RMS map allows per-grain amplitude adjustment:
```javascript
rmsAtPosition = loudnessMap[Math.floor(position / windowSize)]
compensation = 1 / Math.max(0.01, rmsAtPosition)
grainGain = baseGain * compensation * autogainFromOLA(...)
```

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Space` | Play/Pause |
| `R` | Start/Stop recording |
| `←` / `→` | Move active cursor position |
| `↑` / `↓` | Master volume |
| `Backspace` | Reset active cursor parameters |
| `M` (hold) | Record from microphone |
| `Q` | Switch active cursor |
| `I` (hold) | Show info overlay |
| `P` | Toggle HOLD for active cursor |
| `L` | Load audio file |
| `1`–`0`, `,`, `ì` | Select parameter + `←`/`→` to adjust |

### Piano Keyboard

| Keys | Notes |
|------|-------|
| `A S D F G H J K` | White keys (C to C) |
| `W E T Y U` | Black keys |
| `Z` | Octave down |
| `X` | Octave up |
| `Alt` + note | Play on all cursors |

---

## MIDI Support

Poli-Granulator supports Web MIDI input:
- Note On/Off → Grain triggering
- Velocity → Grain amplitude
- Pitch bend → Real-time pitch offset (optional)

MIDI notes are routed to the active cursor, or all cursors with modifier.

---

## Technical Notes

### SharedArrayBuffer

For best performance, serve with these headers for cross-origin isolation:
```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

When SAB is available, parameters are written directly to shared memory and read by the worklet without message passing.

### Performance Considerations

- **MAX_GRAINS = 1024**: Hard limit on simultaneous grains
- **Block size = 128**: Standard AudioWorklet quantum
- **Hann LUT size = 1024**: Pre-computed for efficient envelope lookup
- **Telemetry interval**: Every 16 blocks (48ms at 44.1kHz)

### Browser Compatibility

- Chrome/Edge 66+ (full support)
- Firefox 76+ (AudioWorklet support)
- Safari 14.1+ (AudioWorklet support)

---

## Getting Started

### Try it Online

The easiest way to use Poli-Granulator — no installation required!

**[🎹 Launch Poli-Granulator](https://dariodo.github.io/Poli-Granulator/)**

Just click the link above and start experimenting in your browser.

### Run Locally

If you prefer to run the project locally or want to modify the code:

1. Clone the repository:
   ```bash
   git clone https://github.com/dariodo/Poli-Granulator.git
   cd Poli-Granulator
   ```

2. Install the dev server (once):
   ```bash
   npm install -g serve
   ```

3. Start the local server:
   ```bash
   npm run dev
   ```

4. Open your browser to `http://localhost:3000`

5. To stop the server, press `Ctrl + C` in the terminal.

### Quick Start

1. Click **LOAD** to import an audio file (or use the mic)
   - Some sample audio files are included in the `assets/audio/` folder — feel free to try them!
   - You can also upload any audio file you like (WAV, MP3, OGG, etc.)
2. Press **PLAY** or use keyboard keys (A, S, D, etc.) to trigger grains
3. Adjust **Size**, **Density**, **Spread** knobs to shape the sound
4. Drag the colored markers on the waveform to change cursor positions

---

## Credits

Developed for the **ACTAM (Advanced Coding Tools and Methodologies)** course at Politecnico di Milano.

---

## License

MIT License — See LICENSE file for details.

---

## Team

- Dario Sorce - dario.sorce@mail.polimi.it
- Carlo Becherucci - carlo.becherucci@mail.polimi.it