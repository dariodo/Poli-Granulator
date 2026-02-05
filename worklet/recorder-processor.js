/**
 * @file recorder-processor.js
 * @description AudioWorklet processor for stereo audio recording.
 *   Implements pass-through of audio while capturing L/R chunks for export.
 *   Designed as a transparent node in the audio chain.
 */

class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.maxFrames = 0; // 0 = no limit
    this.frames = 0;

    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (d.type === 'rec-start') {
        this.recording = true;
        this.frames = 0;
        this.maxFrames = (d.maxFrames | 0) > 0 ? (d.maxFrames | 0) : 0;
      } else if (d.type === 'rec-stop') {
        this.recording = false;
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0] || [];
    const output = outputs[0] || [];
    const inL = input[0] || new Float32Array(128);
    const inR = input[1] || inL;
    const outL = output[0] || new Float32Array(inL.length);
    const outR = output[1] || outL;

    // Pass-through
    for (let i = 0; i < inL.length; i++) {
      outL[i] = inL[i];
      outR[i] = inR[i];
    }

    // Capture (if armed)
    if (!this.recording) return true;

    const N = inL.length;
    const remain = this.maxFrames ? Math.max(0, this.maxFrames - this.frames) : N;
    if (this.maxFrames && remain <= 0) {
      this.recording = false;
      this.port.postMessage({ type: 'rec-autostop' });
      return true;
    }
    const take = this.maxFrames ? Math.min(N, remain) : N;

    const srcL = (take === N) ? inL : inL.subarray(0, take);
    const srcR = (take === N) ? inR : inR.subarray(0, take);

    const copyL = new Float32Array(srcL);
    const copyR = new Float32Array(srcR);

    this.port.postMessage(
      { type: 'rec-chunk', l: copyL, r: copyR },
      [copyL.buffer, copyR.buffer]
    );

    this.frames += take;

    if (this.maxFrames && this.frames >= this.maxFrames) {
      this.recording = false;
      this.port.postMessage({ type: 'rec-autostop' });
    }

    return true;
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
