/**
 * @fileoverview Microphone input visualizer waveform.
 * Handles starting and stopping live microphone visualization
 * using the waveform drawing loop.
 *
 * @module ui/mic/mic-visualizer
 */

import { drawWaveform, __setMicAnalyser, __clearMicAnalyser } from '../waveform/waveform.js';
import { getAudioBuffer } from '../../app/session/buffer-session.js';

let rafId = 0;

export async function startMicVisualizerWithAnalyser(analyser){
  if (!analyser) return;
  __setMicAnalyser(analyser);
  document.querySelector('.granular-ui')?.classList.add('mic-live');

  const loop = () => {
    if (!document.querySelector('.granular-ui')?.classList.contains('mic-live')) return;
    drawWaveform(getAudioBuffer());
    rafId = requestAnimationFrame(loop);
  };
  rafId = requestAnimationFrame(loop);
}

export async function stopMicVisualizer(){
  try { cancelAnimationFrame(rafId); } catch {}
  rafId = 0;
  __clearMicAnalyser();
  document.querySelector('.granular-ui')?.classList.remove('mic-live');
  const buf = getAudioBuffer();
  if (buf) drawWaveform(buf);
}
