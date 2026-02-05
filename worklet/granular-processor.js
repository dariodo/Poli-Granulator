/**
 * @file granular-processor.js
 * @description Main granular synthesis AudioWorklet processor.
 *   Implements polyphonic grain generation with multiple cursors (A/B/C),
 *   Poisson-based scheduling, per-cursor filtering, and a peak limiter.
 * 
 * Key features:
 *   - Soft kill for grains (smooth release instead of abrupt cutoff)
 *   - Per-cursor gain smoothing to prevent clicks during parameter changes
 *   - Scheduler backpressure to prevent grain explosion and CPU overload
 *   - Per-block spawn limits as CPU guardrail
 */

import { createHannLUT, envAtFromLUT, equalPowerPan } from "./dsp/windows.js";
import { createLimiter, processLimiter }              from "./dsp/limiter.js";
import { nextIntervalFramesPoisson }                  from "./dsp/scheduler.js";

import { FilterCutoffBank, uiToHz, uiToQ, uiToDrive } from "./dsp/filter-cutoff.js";

// Local utility functions
const clamp   = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const wrap01  = (x) => ((x % 1) + 1) % 1;

class GranularProcessorPro extends AudioWorkletProcessor {
  constructor(options) {
    super();

    // ---- Init base ----
    this.sampleRateOut = options?.processorOptions?.sampleRate || sampleRate;
    this.useSAB = !!options?.processorOptions?.useSAB;

    // Source buffer: stereo-safe (array of channels)
    this.channels = null;
    this.channelCount = 0;
    this.bufferLength = 0;
    this.bufferSampleRate = this.sampleRateOut;

    // Normalized positions for the three cursors
    this.positions = new Float32Array([0.15, 0.50, 0.85]);

    // Fallback parameters (if no SharedArrayBuffer)
    this.paramsA = this._defaultParams();
    this.paramsB = this._defaultParams();
    this.paramsC = this._defaultParams();

    // SharedArrayBuffer for parameters (if available)
    this.paramSAB = null;
    this.paramStride = 15; // default aggiornato: UI moderna usa 15 voci
    this.paramView = null;

    // Independent schedulers per cursor
    this.framesToNextGrainA = 0;
    this.framesToNextGrainB = 0;
    this.framesToNextGrainC = 0;

    // Per-cursor LFO phase
    this.lfoPhaseA = 0;
    this.lfoPhaseB = 0;
    this.lfoPhaseC = 0;

    // Loudness map (optional): { rms(Float32Array), win, sr, len }
    this.loudMap = null;

    // Hann envelope lookup table
    this.envTableSize = 1024;
    this.envLUT = createHannLUT(this.envTableSize);

    // Grain pool (struct-of-arrays for cache efficiency)
    this.MAX_GRAINS = 1024;
    this.g_count = 0;
    this.g_cursor = new Int8Array(this.MAX_GRAINS);
    this.g_phase  = new Float64Array(this.MAX_GRAINS);
    this.g_inc    = new Float32Array(this.MAX_GRAINS);
    this.g_envPos = new Int32Array(this.MAX_GRAINS);
    this.g_envLen = new Int32Array(this.MAX_GRAINS);
    this.g_panL   = new Float32Array(this.MAX_GRAINS);
    this.g_panR   = new Float32Array(this.MAX_GRAINS);
    this.g_gainC  = new Float32Array(this.MAX_GRAINS); // per-grain loudness compensation

    // Playback state
    this.playing = false;

    // Viz throttling (~30 FPS)
    this.vizCounter = 0;
    this.vizIntervalFrames = Math.max(1, Math.floor(this.sampleRateOut / 30));

    // Post limiter
    this.limiter = createLimiter(this.sampleRateOut, {
      lookaheadMs: 3,
      ceiling: 0.98,
      releaseMs: 50,
      masterTrim: 0.80,
      extra: 256
    });

    // Stereo bus for A/B/C cursors (for per-cursor filtering)
    this.busAL = new Float32Array(128); this.busAR = new Float32Array(128);
    this.busBL = new Float32Array(128); this.busBR = new Float32Array(128);
    this.busCL = new Float32Array(128); this.busCR = new Float32Array(128);

    // Filter bank (one filter channel per cursor)
    this.filters = new FilterCutoffBank(this.sampleRateOut, 3, /*tauMs*/25);

    // Polyphonic state: active notes per cursor (relative semitones)
    this.kbNotes = [[], [], []];
    this.kbRR    = [0, 0, 0];

    // Per-cursor gain smoothing (prevents clicks when parameters change)
    this._gainSmooth = [0.5, 0.5, 0.5];  // initialized on first block
    this._gainTarget = [0.5, 0.5, 0.5];
    this._gainTauMs  = 20;               // smoothing time constant (~20 ms)

    // Soft kill on request (for HOLD release to prevent abrupt cutoff)
    this._killPending = [false, false, false];
    this._killTailMs  = 28; // forced tail duration to avoid harsh cuts

    // Scheduler backpressure/guardrail to prevent overload
    this._maxSpawnPerBlock = Math.max(24, Math.floor(32 * (this.sampleRateOut / 48000)));

    // Handle messages from main thread
    this.port.onmessage = (e) => {
      const d = e.data || {};
      switch (d.type) {
        case "setBuffer": {
          // Supports new format (channels[]) and legacy (mono)
          if (Array.isArray(d.channels) && d.channels.length > 0) {
            this.channels = d.channels.map(ab => new Float32Array(ab));
            this.channelCount = this.channels.length;
            this.bufferLength = (d.length >>> 0) || (this.channels[0]?.length | 0);
            this.bufferSampleRate = d.sampleRate || this.sampleRateOut;
          } else if (d.mono) {
            const mono = new Float32Array(d.mono);
            this.channels = [mono];
            this.channelCount = 1;
            this.bufferLength = mono.length | 0;
            this.bufferSampleRate = d.sampleRate || this.sampleRateOut;
          } else {
            this.channels = null; this.channelCount = 0; this.bufferLength = 0;
          }
          break;
        }
        case "setLoudnessMap": {
          const m = d.map;
          if (m && m.rms) {
            this.loudMap = {
              rms: new Float32Array(m.rms),
              win: m.win, sr: m.sr, len: m.len
            };
          }
          break;
        }
        case "setParamsAll": {
          if (d.paramsA) Object.assign(this.paramsA, d.paramsA);
          if (d.paramsB) Object.assign(this.paramsB, d.paramsB);
          if (d.paramsC) Object.assign(this.paramsC, d.paramsC);
          break;
        }
        case "setParamsFor": {
          if (d.cursor === 0 && d.params) Object.assign(this.paramsA, d.params);
          if (d.cursor === 1 && d.params) Object.assign(this.paramsB, d.params);
          if (d.cursor === 2 && d.params) Object.assign(this.paramsC, d.params);
          break;
        }
        case "setParamSAB": {
          if (d.sab) {
            this.paramSAB   = d.sab;
            this.paramStride = d.stride || this.paramStride;
            this.paramView  = new Float32Array(this.paramSAB);
          }
          break;
        }
        case "setPositions": {
          if (Array.isArray(d.positions)) {
            if (d.positions.length >= 2) {
              this.positions[0] = clamp01(d.positions[0]);
              this.positions[1] = clamp01(d.positions[1]);
            }
            if (d.positions.length >= 3) {
              this.positions[2] = clamp01(d.positions[2]);
            }
          }
          break;
        }
        case "setPlaying": {
          this.playing = !!d.value;
          break;
        }
        // ---------- POLY ----------
        case "noteOn":
        case "kbNoteOn":
        case "kbdNoteOn":
        case "keyNoteOn": {
          const c = (d.cursor|0);
          const s = Number(d.semis);
          if (c >= 0 && c <= 2 && Number.isFinite(s)) this._addKbNote(c, Math.round(s));
          break;
        }
        case "noteOff":
        case "kbNoteOff":
        case "kbdNoteOff":
        case "keyNoteOff": {
          const c = (d.cursor|0);
          const s = Number(d.semis);
          if (c >= 0 && c <= 2 && Number.isFinite(s)) this._removeKbNote(c, Math.round(s));
          break;
        }
        case "noteOnAll": {
          const s = Number(d.semis);
          if (Number.isFinite(s)) {
            const ss = Math.round(s);
            this._addKbNote(0, ss); this._addKbNote(1, ss); this._addKbNote(2, ss);
          }
          break;
        }
        case "noteOffAll": {
          const s = Number(d.semis);
          if (Number.isFinite(s)) {
            const ss = Math.round(s);
            this._removeKbNote(0, ss); this._removeKbNote(1, ss); this._removeKbNote(2, ss);
          }
          break;
        }
        // Clear latched notes for cursor
        case "clearKbNotes": {
          const c = (d.cursor|0);
          if (c >= 0 && c <= 2) this._clearKbNotes(c);
          break;
        }
        // Soft kill grains for cursor (avoids abrupt cutoff)
        case "killCursorGrains": {
          const c = (d.cursor|0);
          if (c >= -1 && c <= 2) {
            if (c === -1) {
              this._killPending = [true,true,true];
            } else {
              this._killPending[c] = true;
            }
          }
          break;
        }
        // Handshake
        case "ping": {
          this.port.postMessage({ type: "ready" });
          break;
        }
      }
    };
  }

  // Parameter helpers
  _defaultParams() {
    return {
      attack: 0.10, release: 0.10, density: 10, spread: 0.10,
      pan: 0.0, pitch: 1.0, cutoff: 5000, lfoFreq: 1.0, lfoDepth: 0.2,
      scanSpeed: 0.00, gain: 0.5, grainSize: 1.0,
      // UI-normalized aggiuntivi
      qNorm: 0.2,
      driveNorm: 0.0,
      slopeSel: 0
    };
  }

  _readParams() {
    if (!this.paramView) return [this.paramsA, this.paramsB, this.paramsC];

    const S = this.paramStride | 0;
    const v = this.paramView;

    const readOne = (base, fallback) => {
      const get = (i, fb) => {
        const idx = base + i;
        const val = v[idx];
        return Number.isFinite(val) ? val : fb;
      };
      const p = {
        attack:   get(0,  fallback.attack),
        release:  get(1,  fallback.release),
        density:  get(2,  fallback.density),
        spread:   get(3,  fallback.spread),
        pan:      get(4,  fallback.pan),
        pitch:    get(5,  fallback.pitch),
        cutoff:   get(6,  fallback.cutoff),
        lfoFreq:  get(7,  fallback.lfoFreq),
        lfoDepth: get(8,  fallback.lfoDepth),
        scanSpeed:get(9,  fallback.scanSpeed),
        gain:     get(10, fallback.gain),
        grainSize:get(11, fallback.grainSize),
      };
      if (S >= 15) {
        p.qNorm     = get(12, fallback.qNorm);
        p.driveNorm = get(13, fallback.driveNorm);
        p.slopeSel  = get(14, fallback.slopeSel);
      } else {
        p.qNorm     = (fallback.qNorm     ?? 0.2);
        p.driveNorm = (fallback.driveNorm ?? 0.0);
        p.slopeSel  = (fallback.slopeSel  ?? 0);
      }
      return p;
    };

    const a = readOne(0*S, this.paramsA);
    const b = readOne(1*S, this.paramsB);
    const c = readOne(2*S, this.paramsC);
    return [a, b, c];
  }

  // Polyphonic helpers
  _addKbNote(cursor, semis) {
    const arr = this.kbNotes[cursor];
    for (let i = 0; i < arr.length; i++) if (arr[i] === semis) return;
    arr.push(semis);
    if (this.kbRR[cursor] > 1e9) this.kbRR[cursor] = this.kbRR[cursor] % Math.max(1, arr.length);
  }
  _removeKbNote(cursor, semis) {
    const arr = this.kbNotes[cursor];
    const i = arr.indexOf(semis);
    if (i >= 0) arr.splice(i, 1);
    if (arr.length === 0) this.kbRR[cursor] = 0;
    else this.kbRR[cursor] = this.kbRR[cursor] % arr.length;
  }
  _clearKbNotes(cursor) {
    const arr = this.kbNotes[cursor];
    if (!arr) return;
    arr.length = 0;
    this.kbRR[cursor] = 0;
  }
  _nextKbSemis(cursor) {
    const arr = this.kbNotes[cursor];
    const n = arr.length;
    if (n === 0) return null;
    const idx = this.kbRR[cursor] % n;
    this.kbRR[cursor] = (this.kbRR[cursor] + 1) % (n === 0 ? 1 : n);
    return arr[idx];
  }
  _hasKbNotesAny() { return (this.kbNotes[0].length + this.kbNotes[1].length + this.kbNotes[2].length) > 0; }
  _cursorHasKb(i) { return this.kbNotes[i]?.length > 0; }

  // DSP helpers
  _advancePositions(frames, pA, pB, pC) {
    const dt = frames / this.sampleRateOut;
    let A = this.positions[0] + (pA.scanSpeed || 0) * dt;
    let B = this.positions[1] + (pB.scanSpeed || 0) * dt;
    let C = this.positions[2] + (pC.scanSpeed || 0) * dt;
    this.positions[0] = wrap01(A);
    this.positions[1] = wrap01(B);
    this.positions[2] = wrap01(C);
  }
  _overlaps(params) {
    const S = (params.grainSize || 1);
    const dur = Math.max(0.002, ((params.attack || 0) + (params.release || 0)) * S);
    return Math.max(1, (params.density || 1) * dur);
  }

  // Per-channel interpolation with wrapping on buffer length
  _interpCh(ch, x) {
    const buf = (this.channels && this.channels[ch]) || (this.channels && this.channels[0]);
    const len = this.bufferLength | 0;
    if (!buf || len <= 0) return 0;
    let i0 = x | 0;
    let frac = x - i0;
    if (i0 >= len) {
      i0 -= len * ((i0 / len) | 0);
    } else if (i0 < 0) {
      i0 += len * (((-i0) / len + 1) | 0);
    }
    let i1 = i0 + 1; if (i1 >= len) i1 = 0;
    const s0 = buf[i0];
    const s1 = buf[i1];
    return s0 + (s1 - s0) * frac;
  }

  _loudnessAtIndex(sampleIndex) {
    const m = this.loudMap;
    if (!m || !m.rms || m.rms.length === 0) return 1;
    const b = Math.max(0, Math.min(m.rms.length - 1, Math.floor(sampleIndex / m.win)));
    return Math.max(1e-4, m.rms[b]); // floor to avoid extreme compression
  }

  _spawnGrain(cursorIndex, params) {
    if (!this.playing && !this._cursorHasKb(cursorIndex)) return;
    if (!this.channels || this.bufferLength === 0) return;
    if (this.g_count >= this.MAX_GRAINS) return;

    const S = (params.grainSize || 1);
    const durSec = Math.max(0.002, ((params.attack || 0) + (params.release || 0)) * S);
    const envFrames = Math.max(1, Math.floor(durSec * this.sampleRateOut));

    const bufDurSec = this.bufferLength / this.bufferSampleRate;
    const baseSec = this.positions[cursorIndex] * bufDurSec;
    const spr = Math.max(0, params.spread || 0);
    const offsetSec = spr > 0 ? (Math.random() * 2 - 1) * spr : 0;
    let startSec = baseSec + offsetSec;
    if (startSec < 0) startSec = 0;
    if (startSec > bufDurSec - durSec) startSec = Math.max(0, bufDurSec - durSec);
    const startIndex = startSec * this.bufferSampleRate;

    // Effective pitch calculation
    const baseRate = Math.max(0.01, params.pitch || 1);
    const semis = this._nextKbSemis(cursorIndex);
    const noteMult = (semis == null) ? 1 : Math.pow(2, semis / 12);
    const rate = baseRate * noteMult;

    const inc  = rate * (this.bufferSampleRate / this.sampleRateOut);

    const { L: panL, R: panR } = equalPowerPan(params.pan || 0);

    const local = this._loudnessAtIndex(startIndex);
    const target = 0.12;
    const gamma  = 0.6;
    const loudComp = Math.pow(target / local, gamma);

    const idx = this.g_count++;
    this.g_cursor[idx] = cursorIndex;
    this.g_phase[idx]  = startIndex;
    this.g_inc[idx]    = inc;
    this.g_envPos[idx] = 0;
    this.g_envLen[idx] = envFrames;
    this.g_panL[idx]   = panL;
    this.g_panR[idx]   = panR;
    this.g_gainC[idx]  = loudComp;
  }

  // --- bus helpers ---
  _ensureBusSize(n){
    if (this.busAL.length !== n){
      this.busAL = new Float32Array(n); this.busAR = new Float32Array(n);
      this.busBL = new Float32Array(n); this.busBR = new Float32Array(n);
      this.busCL = new Float32Array(n); this.busCR = new Float32Array(n);
    } else {
      this.busAL.fill(0); this.busAR.fill(0);
      this.busBL.fill(0); this.busBR.fill(0);
      this.busCL.fill(0); this.busCR.fill(0);
    }
  }

  // Backpressure factor based on active grain count
  _spawnBudgetFactor() {
    const n = this.g_count;
    const M = this.MAX_GRAINS;
    if (n >= 0.95 * M) return 0.0;  // full stop
    if (n >= 0.85 * M) return 0.20; // drastically reduce
    if (n >= 0.70 * M) return 0.40;
    if (n >= 0.50 * M) return 0.65;
    return 1.0;
  }

  // ===== Render =====
  process(inputs, outputs) {
    const out0 = outputs[0];
    if (!out0 || out0.length < 2) return true;
    const outL = out0[0];
    const outR = out0[1];
    const frames = outL.length;

    // Clear output & bus
    for (let i = 0; i < frames; i++) { outL[i] = 0; outR[i] = 0; }
    this._ensureBusSize(frames);

    const [pA, pB, pC] = this._readParams();

    // Initialize gain smoothing on first run
    if (!Number.isFinite(this._gainSmooth[0])) this._gainSmooth = [pA.gain ?? 0.5, pB.gain ?? 0.5, pC.gain ?? 0.5];
    this._gainTarget[0] = (pA.gain ?? 0.5);
    this._gainTarget[1] = (pB.gain ?? 0.5);
    this._gainTarget[2] = (pC.gain ?? 0.5);

    // Advance cursor positions (they move even when Play is OFF)
    this._advancePositions(frames, pA, pB, pC);

    // Visualize positions (also when notes are active while Play is OFF)
    this.vizCounter += frames;
    const doViz = this.vizCounter >= this.vizIntervalFrames;
    if (doViz) this.vizCounter = 0;

    const hasKb = this._hasKbNotesAny();
    if (doViz && (this.playing || hasKb)) {
      this.port.postMessage({ type: "positions", positions: [this.positions[0], this.positions[1], this.positions[2]] });
    }

    // Audio gate
    const haveGrains = (this.g_count > 0);
    if ((!this.playing && !hasKb && !haveGrains) || !this.channels || this.bufferLength === 0) {
      return true;
    }

    // LFO phase advance
    const secondsBlock = frames / this.sampleRateOut;
    const dphiA = 2 * Math.PI * Math.max(0, pA.lfoFreq || 0) * secondsBlock;
    const dphiB = 2 * Math.PI * Math.max(0, pB.lfoFreq || 0) * secondsBlock;
    const dphiC = 2 * Math.PI * Math.max(0, pC.lfoFreq || 0) * secondsBlock;
    this.lfoPhaseA += dphiA;
    this.lfoPhaseB += dphiB;
    this.lfoPhaseC += dphiC;
    if (this.lfoPhaseA > 1e12) this.lfoPhaseA -= 1e12;
    if (this.lfoPhaseB > 1e12) this.lfoPhaseB -= 1e12;
    if (this.lfoPhaseC > 1e12) this.lfoPhaseC -= 1e12;

    // No overlap compensation - let the limiter handle peaks naturally
    // This makes the synth feel more natural: more density/size = more volume
    const compA = 1.0;
    const compB = 1.0;
    const compC = 1.0;

    // Per-cursor gain smoothing (once per block)
    const kGain = 1 - Math.exp(-(frames / this.sampleRateOut) / (this._gainTauMs / 1000));
    for (let i = 0; i < 3; i++) {
      this._gainSmooth[i] += (this._gainTarget[i] - this._gainSmooth[i]) * kGain;
    }
    const gainA = Math.max(0, this._gainSmooth[0] * compA);
    const gainB = Math.max(0, this._gainSmooth[1] * compB);
    const gainC = Math.max(0, this._gainSmooth[2] * compC);

    // Poisson scheduling per cursor with backpressure/spawn limit
    const kbA = this._cursorHasKb(0);
    const kbB = this._cursorHasKb(1);
    const kbC = this._cursorHasKb(2);

    const budget = this._spawnBudgetFactor();

    const schedOne = (p, framesToNext, cursorIdx) => {
      let spawned = 0;
      const density = Math.max(0, p.density || 0);
      const effDen  = density * budget;
      if (effDen <= 0) {
        // no new grains, but keep the timer moving to avoid accumulation
        return Math.max(0, framesToNext - frames);
      }

      const nextInt = () => {
        // protection: minimum density to avoid near-zero steps
        const d = Math.max(0.1, effDen);
        return nextIntervalFramesPoisson(this.sampleRateOut, d);
      };

      if (framesToNext <= 0) framesToNext = nextInt();
      if (framesToNext <= frames) {
        this._spawnGrain(cursorIdx, p); spawned++;
        let acc = framesToNext + nextInt();
        // limit spawns per block per cursor
        while (acc <= frames && spawned < this._maxSpawnPerBlock) {
          this._spawnGrain(cursorIdx, p); spawned++;
          acc += nextInt();
        }
        return acc - frames;
      } else {
        return framesToNext - frames;
      }
    };

    if (this.playing || kbA) this.framesToNextGrainA = schedOne(pA, this.framesToNextGrainA, 0);
    else this.framesToNextGrainA = Math.max(0, this.framesToNextGrainA - frames);

    if (this.playing || kbB) this.framesToNextGrainB = schedOne(pB, this.framesToNextGrainB, 1);
    else this.framesToNextGrainB = Math.max(0, this.framesToNextGrainB - frames);

    if (this.playing || kbC) this.framesToNextGrainC = schedOne(pC, this.framesToNextGrainC, 2);
    else this.framesToNextGrainC = Math.max(0, this.framesToNextGrainC - frames);

    // Grain synthesis -> sum to bus A/B/C

    // If a soft kill was requested, shorten grains of that cursor to a small tail
    const tailFrames = Math.max(1, Math.floor((this._killTailMs / 1000) * this.sampleRateOut));
    if (this._killPending[0] || this._killPending[1] || this._killPending[2]) {
      for (let g = this.g_count - 1; g >= 0; g--) {
        const c = this.g_cursor[g];
        if (this._killPending[c]) {
          // limita la lunghezza del grano: envPos + tailFrames
          const newLen = Math.min(this.g_envLen[g], this.g_envPos[g] + tailFrames);
          this.g_envLen[g] = newLen;
        }
      }
    }

    // Reset kill flags when no more grains remain for that cursor
    if (this._killPending[0] || this._killPending[1] || this._killPending[2]) {
      let hasA = false, hasB = false, hasC = false;
      for (let g = this.g_count - 1; g >= 0; g--) {
        const c = this.g_cursor[g];
        if (c === 0) hasA = true;
        else if (c === 1) hasB = true;
        else if (c === 2) hasC = true;
        if (hasA && hasB && hasC) break;
      }
      if (!hasA) this._killPending[0] = false;
      if (!hasB) this._killPending[1] = false;
      if (!hasC) this._killPending[2] = false;
    }

    for (let g = this.g_count - 1; g >= 0; g--) {
      const envPos = this.g_envPos[g];
      const envLen = this.g_envLen[g];
      const N = Math.min(envLen - envPos, frames);
      if (N <= 0) { this._killGrainSwap(g); continue; }

      let ph   = this.g_phase[g];
      const inc  = this.g_inc[g];
      const panL = this.g_panL[g], panR = this.g_panR[g];
      const localComp = this.g_gainC[g];
      const which = this.g_cursor[g];
      const baseGain = (which === 0 ? gainA : (which === 1 ? gainB : gainC));
      const gcur = baseGain * localComp;

      let pos = envPos;
      // Bus shortcuts
      let BL, BR;
      if (which === 0) { BL = this.busAL; BR = this.busAR; }
      else if (which === 1) { BL = this.busBL; BR = this.busBR; }
      else { BL = this.busCL; BR = this.busCR; }

      for (let i = 0; i < N; i++) {
        const env = envAtFromLUT(pos, envLen, this.envLUT);

        // Read from source channels (no downmix)
        const sL = this._interpCh(0, ph) * env;
        const sR = this._interpCh(1, ph) * env;

        // Pan come "balance" sul pair stereo
        const Ldry = sL * panL * gcur;
        const Rdry = sR * panR * gcur;

        BL[i] += Ldry;
        BR[i] += Rdry;

        ph  += inc;
        pos++;
      }

      this.g_phase[g]   = ph;
      this.g_envPos[g] += N;

      if (this.g_envPos[g] >= envLen) {
        this._killGrainSwap(g);
      }
    }

    // Filter targets (per channel A/B/C) + LFO on cutoff
    const mapCut = (val) => {
      const f = Number(val);
      if (!Number.isFinite(f)) return 2000;
      if (f <= 1.5) return uiToHz(clamp01(f), 20, 18000);
      return clamp(f, 20, 0.45 * this.sampleRateOut);
    };

    const deriveQ = (p) => {
      if (Number.isFinite(p.q)) return Math.max(0.25, p.q);
      const norm = (p.qNorm ?? p.reson ?? p.resonance ?? 0.2);
      return uiToQ(clamp01(norm), 0.3, 12);
    };
    const deriveDrive = (p) => {
      const norm = (p.driveNorm ?? p.drive ?? 0.0);
      return uiToDrive(clamp01(norm), 1, 10);
    };
    const deriveStages = (p) => {
      const v = p.slopeSel ?? p.slp ?? p.slope;
      if (v == null) return 1;
      if (v === 24 || v >= 18) return 2;
      if (v === 12) return 1;
      return (Number(v) >= 0.5) ? 2 : 1; // 0/1 normalized
    };

    const A_base = mapCut(pA.cutoff);
    const B_base = mapCut(pB.cutoff);
    const C_base = mapCut(pC.cutoff);
    const A_fc = clamp(A_base * (1 + clamp01(pA.lfoDepth) * Math.sin(this.lfoPhaseA)), 20, 0.45*this.sampleRateOut);
    const B_fc = clamp(B_base * (1 + clamp01(pB.lfoDepth) * Math.sin(this.lfoPhaseB)), 20, 0.45*this.sampleRateOut);
    const C_fc = clamp(C_base * (1 + clamp01(pC.lfoDepth) * Math.sin(this.lfoPhaseC)), 20, 0.45*this.sampleRateOut);

    this.filters.setChannelTargets(0, { hz: A_fc, q: deriveQ(pA), stages: deriveStages(pA), drive: deriveDrive(pA), tauMs:25 });
    this.filters.setChannelTargets(1, { hz: B_fc, q: deriveQ(pB), stages: deriveStages(pB), drive: deriveDrive(pB), tauMs:25 });
    this.filters.setChannelTargets(2, { hz: C_fc, q: deriveQ(pC), stages: deriveStages(pC), drive: deriveDrive(pC), tauMs:25 });

    // Filter bus A/B/C -> sum to outL/outR
    this.filters.processFromBuses(
      [
        { L: this.busAL, R: this.busAR },
        { L: this.busBL, R: this.busBR },
        { L: this.busCL, R: this.busCR }
      ],
      outL, outR
    );

    // Post limiter
    const { tpDb, grDb } = processLimiter(this.limiter, outL, outR);

    if (doViz) {
      this.port.postMessage({ type: "telemetry", tpDb, grDb });
    }

    return true;
  }

  _killGrainSwap(idx) {
    const last = --this.g_count;
    if (idx === last) return;
    this.g_cursor[idx] = this.g_cursor[last];
    this.g_phase[idx]  = this.g_phase[last];
    this.g_inc[idx]    = this.g_inc[last];
    this.g_envPos[idx] = this.g_envPos[last];
    this.g_envLen[idx] = this.g_envLen[last];
    this.g_panL[idx]   = this.g_panL[last];
    this.g_panR[idx]   = this.g_panR[last];
    this.g_gainC[idx]  = this.g_gainC[last];
  }
}

registerProcessor("granular-processor-pro", GranularProcessorPro);
