/**
 * @file mic-capture.js
 * @description Microphone capture utilities for hold-to-record functionality.
 * Uses the recorder-processor AudioWorklet for real-time audio capture.
 * Features:
 * - Stream and node caching (reuse between sessions)
 * - No monitor output (gain=0) to prevent feedback
 * - L/R concatenation to mono with -3dB mix
 * - Returns an AudioBuffer ready for the synth
 * - Exposes an AnalyserNode for live waveform visualization
 */

let cached = {
  stream: null,
  source: null,
  gainZero: null,
  micRecorderNode: null,
  analyser: null,
  ctx: null
};

let active = {
  recording: false,
  chunksL: [],
  chunksR: [],
  pendingStopResolver: null
};

// Utils
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
function concatFloat32(chunks) {
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

function teardownInternal() {
  try { cached.source?.disconnect(); } catch {}
  try { cached.micRecorderNode?.disconnect(); } catch {}
  try { cached.gainZero?.disconnect(); } catch {}
  // Don't close the stream (preserve permissions), but you can call teardownMic() if needed
  cached = { stream: cached.stream, source: null, gainZero: null, micRecorderNode: null, analyser: null, ctx: null };
}

export async function ensureMicReady(audioCtx) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Microphone not available on this browser.');
  }
  if (cached.ctx && cached.ctx !== audioCtx) {
    // Context changed, reset connections
    teardownInternal();
  }
  cached.ctx = audioCtx;

  // Get microphone stream
  if (!cached.stream) {
    try {
      cached.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        video: false
      });
    } catch (err) {
      throw new Error('Permission denied or no microphone: ' + (err?.message || err));
    }
  }

  // Create audio nodes
  if (!cached.source) {
    cached.source = cached.ctx.createMediaStreamSource(cached.stream);
  }
  if (!cached.micRecorderNode) {
    // The recorder-processor module is loaded by main (ensureAudio)
    cached.micRecorderNode = new AudioWorkletNode(cached.ctx, 'recorder-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers'
    });
  }
  if (!cached.gainZero) {
    cached.gainZero = cached.ctx.createGain();
    cached.gainZero.gain.value = 0.0; // Muted to prevent feedback
  }
  if (!cached.analyser) {
    const an = cached.ctx.createAnalyser();
    an.fftSize = 2048;
    an.smoothingTimeConstant = 0.0;
    cached.analyser = an;
  }

  // Idempotent reconnections
  try { cached.source.disconnect(); } catch {}
  try { cached.micRecorderNode.disconnect(); } catch {}
  cached.source.connect(cached.micRecorderNode);
  cached.micRecorderNode.connect(cached.gainZero);
  cached.gainZero.connect(cached.ctx.destination);
  try { cached.source.connect(cached.analyser); } catch {}

  return true;
}

/**
 * Starts hold-to-record recording.
 * @param {Object} options - Configuration options
 * @param {AudioContext} options.audioCtx - The audio context to use
 * @param {number} [options.maxSeconds=120] - Maximum recording duration in seconds
 * @param {Function} [options.onStart] - Callback when recording starts
 * @returns {Object} Control object with:
 *   - stop(): Promise<AudioBuffer|null> - Stops recording and returns the buffer
 *   - analyser: AnalyserNode - For reading live time-domain samples
 */
export async function startHoldRecording({ audioCtx, maxSeconds = 120, onStart } = {}) {
  await ensureMicReady(audioCtx);

  // Reset active recording state
  active.recording = true;
  active.chunksL = [];
  active.chunksR = [];
  active.pendingStopResolver = null;

  const sr = audioCtx.sampleRate;
  const maxFrames = Math.max(1, Math.floor(maxSeconds * sr));

  // Handle messages from the worklet
  cached.micRecorderNode.port.onmessage = (e) => {
    const d = e.data || {};
    if (d.type === 'rec-chunk') {
      if (d.l) active.chunksL.push(d.l);
      if (d.r) active.chunksR.push(d.r);
    } else if (d.type === 'rec-autostop') {
      // Automatic stop (max duration reached)
      if (active.recording) {
        active.recording = false;
        // Complete pending promise (if present)
        if (typeof active.pendingStopResolver === 'function') {
          const res = active.pendingStopResolver;
          active.pendingStopResolver = null;
          // Build the buffer and resolve
          res(finalizeToBuffer(cached.ctx));
        }
      }
    }
  };

  // Arm the recording
  cached.micRecorderNode.port.postMessage({ type: 'rec-start', maxFrames });
  if (typeof onStart === 'function') {
    try { onStart(); } catch {}
  }

  // Control object for the caller
  return {
    analyser: cached.analyser,
    stop: () => new Promise((resolve) => {
      if (!active.recording) {
        // Already stopped: return buffer from accumulated chunks anyway
        resolve(finalizeToBuffer(cached.ctx));
        return;
      }
      active.recording = false;
      // Ask worklet to stop
      try { cached.micRecorderNode.port.postMessage({ type: 'rec-stop' }); } catch {}
      // Will resolve when queued messages are drained
      active.pendingStopResolver = resolve;
      // Safety net: if no more chunks arrive, terminate shortly
      setTimeout(() => {
        if (active.pendingStopResolver) {
          const res = active.pendingStopResolver;
          active.pendingStopResolver = null;
          res(finalizeToBuffer(cached.ctx));
        }
      }, 50);
    })
  };
}

function finalizeToBuffer(ctx) {
  // Concatenate chunks
  const L = concatFloat32(active.chunksL);
  const R = concatFloat32(active.chunksR);

  // Clean up active state
  active.chunksL = [];
  active.chunksR = [];
  active.pendingStopResolver = null;

  const N = Math.min(L.length || 0, R.length || 0);
  if (!N) return null;

  // Downmix to mono
  const mono = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    // Mix at approximately -3dB
    mono[i] = 0.5 * (L[i] + R[i]);
  }

  // Create mono AudioBuffer with the context's sample rate
  const abuf = ctx.createBuffer(1, N, ctx.sampleRate);
  abuf.copyToChannel(mono, 0, 0);
  return abuf;
}

/** Optional: fully release the microphone stream */
export async function teardownMic() {
  try {
    if (cached.stream) {
      for (const t of cached.stream.getTracks?.() || []) {
        try { t.stop(); } catch {}
      }
    }
  } catch {}
  cached.stream = null;
  teardownInternal();
}
