/**
 * @file filter-cutoff.js
 * @description Filter cutoff bank for per-cursor lowpass filtering.
 *   Includes UI-to-Hz/Q/drive mapping, TDF2 biquad lowpass implementation,
 *   per-channel drive/slope (12/24 dB), and per-block parameter smoothing.
 */

'use strict';

/* ---------- Utils & Mapping ---------- */
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
export const uiToHz = (t, min=20, max=12000) => min * Math.pow(max/min, clamp(t,0,1));
export const uiToQ  = (t, min=0.3, max=12)  => min * Math.pow(max/min, clamp(t,0,1));
export const uiToDrive = (t, min=1, max=10) => min + (max-min)*clamp(t,0,1);

// Optional: octave shift mapping for envelope/LFO: fc * 2^(amount * x)
const octShift = (fc, amountOct, x01) => fc * Math.pow(2, amountOct * clamp(x01,0,1));

/* ---------- Biquad LP (RBJ cookbook) TDF2, stereo ---------- */
export class BiquadLP {
  constructor(fs){
    this.fs = fs;
    this.b0=this.b1=this.b2=this.a1=this.a2=0;
    this.z1L=0; this.z2L=0; this.z1R=0; this.z2R=0;
    this._fc = 1000; this._q = 0.707;
    this._recalc();
  }
  setCoeffs(fc, q){
    this._fc = clamp(fc, 15, this.fs*0.45);
    this._q  = Math.max(0.25, q);
    this._recalc();
  }
  _recalc(){
    const fs=this.fs, fc=this._fc, q=this._q;
    const w0 = 2*Math.PI*fc/fs;
    const c = Math.cos(w0), s = Math.sin(w0);
    const alpha = s/(2*q);
    const b0 = (1-c)/2, b1 = 1-c, b2 = (1-c)/2;
    const a0 = 1+alpha, a1 = -2*c, a2 = 1-alpha;
    this.b0=b0/a0; this.b1=b1/a0; this.b2=b2/a0; this.a1=a1/a0; this.a2=a2/a0;
  }
  // Write to output buffers (no accumulation)
  processTo(inL,inR,outL,outR){
    let z1L=this.z1L, z2L=this.z2L, z1R=this.z1R, z2R=this.z2R;
    const b0=this.b0,b1=this.b1,b2=this.b2,a1=this.a1,a2=this.a2;
    const n = inL.length;
    for (let i=0;i<n;i++){
      const xL = inL[i] + 1e-24; // anti-denormals
      const yL = b0*xL + z1L; z1L = b1*xL - a1*yL + z2L; z2L = b2*xL - a2*yL; outL[i] = yL;
      const xR = inR[i] + 1e-24;
      const yR = b0*xR + z1R; z1R = b1*xR - a1*yR + z2R; z2R = b2*xR - a2*yR; outR[i] = yR;
    }
    this.z1L=z1L; this.z2L=z2L; this.z1R=z1R; this.z2R=z2R;
  }
  // Accumulate to output buffers
  processAdd(inL,inR,outL,outR){
    let z1L=this.z1L, z2L=this.z2L, z1R=this.z1R, z2R=this.z2R;
    const b0=this.b0,b1=this.b1,b2=this.b2,a1=this.a1,a2=this.a2;
    const n = inL.length;
    for (let i=0;i<n;i++){
      const xL = inL[i] + 1e-24;
      const yL = b0*xL + z1L; z1L = b1*xL - a1*yL + z2L; z2L = b2*xL - a2*yL; outL[i] += yL;
      const xR = inR[i] + 1e-24;
      const yR = b0*xR + z1R; z1R = b1*xR - a1*yR + z2R; z2R = b2*xR - a2*yR; outR[i] += yR;
    }
    this.z1L=z1L; this.z2L=z2L; this.z1R=z1R; this.z2R=z2R;
  }
}

/* ---------- Filter channel with drive + 12/24 dB + smoothing ---------- */
class FilterChannel {
  constructor(fs, tauMs=25){
    this.fs = fs;
    this.stage1 = new BiquadLP(fs);
    this.stage2 = new BiquadLP(fs);
    this.stages = 1;          // 1=12dB, 2=24dB
    this.drive = 1;           // 1 = off
    this.tauMs = tauMs;       // parameter smoothing time
    this.fcT=1000; this.qT=0.707;
    this.fcS=1000; this.qS=0.707;
    this.tmpL = new Float32Array(128);
    this.tmpR = new Float32Array(128);
  }
  setTargets({hz, q, stages=1, drive=1, tauMs}){
    this.fcT = clamp(hz, 15, this.fs*0.45);
    this.qT  = Math.max(0.25, q);
    this.stages = stages|0;
    this.drive  = Math.max(1, drive);
    if (tauMs != null) this.tauMs = Math.max(1, tauMs|0);
  }
  _ensureTmp(n){
    if (this.tmpL.length !== n){
      this.tmpL = new Float32Array(n);
      this.tmpR = new Float32Array(n);
    }
  }
  process(busL, busR, outL, outR){
    const n = busL.length, fs=this.fs;
    this._ensureTmp(n);

    // Per-block parameter smoothing
    const a = Math.exp(-(n/fs) / (this.tauMs/1000));
    this.fcS = this.fcS*a + this.fcT*(1-a);
    this.qS  = this.qS *a + this.qT *(1-a);

    // coeff update
    this.stage1.setCoeffs(this.fcS, this.qS);
    if (this.stages>1) this.stage2.setCoeffs(this.fcS, this.qS);

    // pre-drive
    if (this.drive>1){
      const d = this.drive;
      for (let i=0;i<n;i++){ busL[i] = Math.tanh(busL[i]*d); busR[i] = Math.tanh(busR[i]*d); }
    }

    if (this.stages === 1){
      // 12 dB: accumulate directly to output
      this.stage1.processAdd(busL, busR, outL, outR);
    } else {
      // 24 dB: stage1 -> tmp, stage2 -> accumulate to output
      this.stage1.processTo(busL, busR, this.tmpL, this.tmpR);
      this.stage2.processAdd(this.tmpL, this.tmpR, outL, outR);
    }
  }
}

/* ---------- N-channel bank (A/B/C) ---------- */
export class FilterCutoffBank {
  constructor(fs, channels=3, tauMs=25){
    this.fs = fs;
    this.channels = new Array(channels).fill(0).map(()=>new FilterChannel(fs, tauMs));
  }
  // idx: 0..N-1
  setChannelTargets(idx, opts){ this.channels[idx].setTargets(opts); }
  // buses: array of objects {L:Float32Array, R:Float32Array}
  processFromBuses(buses, outL, outR){
    // Does not zero out: caller is expected to accumulate other buses/processing
    for (let i=0;i<this.channels.length && i<buses.length;i++){
      this.channels[i].process(buses[i].L, buses[i].R, outL, outR);
    }
  }
}

/* ---------- (Optional) modulation helper ---------- */
// Computes effective cutoff applying LFO/env/key-tracking in a simple but musical way.
export function computeEffectiveCutoff(baseHz, {lfo=-1, lfoDepth=0, env=0, envOct=0, keySemis=0, keyTrack=0}={}){
  // lfo in [-1,1] -> maps to +/- depth as percentage of frequency (subtle)
  const lfoMul = 1 + clamp(lfoDepth,0,1) * clamp(lfo, -1, 1) * 0.8;
  const envMul = Math.pow(2, clamp(envOct, -6, 6) * clamp(env,0,1));           // in octaves
  const keyMul = Math.pow(2, (clamp(keyTrack,0,1) * keySemis) / 12);           // key-tracking
  return clamp(baseHz * lfoMul * envMul * keyMul, 15, 0.45*sampleRate); // sampleRate from global scope
}
