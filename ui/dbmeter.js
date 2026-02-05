/**
 * @fileoverview Stereo dB Meter component.
 * 
 * Displays a 9-LED meter per channel (4 green, 3 amber, 2 red).
 * - Taps post-master (or wherever a stereo signal passes)
 * - When setEnabled(false): stops the RAF loop, turns off LEDs, resets state
 * - When setEnabled(true): restarts the RAF loop
 * 
 * Expected HTML structure:
 * <div class="dbmeters" id="dbMeters">
 *   <ol class="meter" id="meterL"> <li class="led" ... x9> </ol>
 *   <ol class="meter" id="meterR"> <li class="led" ... x9> </ol>
 * </div>
 * 
 * @module ui/dbmeter
 */

export function mountDbMeter({ audioCtx, tapNode, fftSize = 2048 } = {}) {
  const root   = document.getElementById('dbMeters');
  const meterL = document.getElementById('meterL');
  const meterR = document.getElementById('meterR');

  if (!audioCtx || !tapNode || !root || !meterL || !meterR) {
    console.warn('[dbmeter] mount skipped: missing audioCtx/tapNode or DOM');
    return {
      disconnect(){},
      setEnabled(){},
      analyserL:null,
      analyserR:null,
      isMounted:false
    };
  }

  // LED refs (HTML provided: list from top to bottom)
  const ledsLTop = Array.from(meterL.querySelectorAll('.led'));
  const ledsRTop = Array.from(meterR.querySelectorAll('.led'));
  const ledsL = [...ledsLTop].reverse(); // bottom -> top
  const ledsR = [...ledsRTop].reverse(); // bottom -> top

  // Helper: turn off all LEDs
  function clearLEDs(){
    ledsL.forEach(el => el.classList.remove('on'));
    ledsR.forEach(el => el.classList.remove('on'));
  }

  // Thresholds (bottom->top) for 9 LEDs: 4 green, 3 amber, 2 red (RMS dBFS approx)
  const DB_THRESHOLDS = [-48, -42, -36, -30,  -24, -18, -12,  -6,  -3];

  // Analysis node: splitter -> analyser L/R (in parallel, doesn't alter audio)
  const splitter  = audioCtx.createChannelSplitter(2);
  const analyserL = audioCtx.createAnalyser();
  const analyserR = audioCtx.createAnalyser();
  analyserL.fftSize = fftSize;
  analyserR.fftSize = fftSize;
  analyserL.smoothingTimeConstant = 0.0;
  analyserR.smoothingTimeConstant = 0.0;

  tapNode.connect(splitter);
  splitter.connect(analyserL, 0);
  splitter.connect(analyserR, 1);

  // Reusable buffers
  let bufL = new Float32Array(analyserL.fftSize);
  let bufR = new Float32Array(analyserR.fftSize);

  // Ballistics (attack / release on dB values)
  let smL = -Infinity, smR = -Infinity;
  const riseCoef = 0.90;  // attack (0..1, higher = faster rise)
  const fallCoef = 0.15;  // release (0..1, higher = faster fall)

  // Loop state
  let rafId = 0;
  let enabled = true; // starts enabled

  function rmsToDb(rms){ return rms > 0 ? 20 * Math.log10(rms) : -Infinity; }

  function updateMeter(db, ledsBottomUp){
    const n = Math.min(DB_THRESHOLDS.length, ledsBottomUp.length);
    for (let i = 0; i < n; i++) {
      ledsBottomUp[i].classList.toggle('on', db >= DB_THRESHOLDS[i]);
    }
    // Extra LEDs (if present) turned off
    for (let i = n; i < ledsBottomUp.length; i++) {
      ledsBottomUp[i].classList.remove('on');
    }
  }

  function frame() {
    // If disabled, don't run and don't reschedule
    if (!enabled) return;

    // Ensure buffers match current fftSize
    if (bufL.length !== analyserL.fftSize) bufL = new Float32Array(analyserL.fftSize);
    if (bufR.length !== analyserR.fftSize) bufR = new Float32Array(analyserR.fftSize);

    analyserL.getFloatTimeDomainData(bufL);
    analyserR.getFloatTimeDomainData(bufR);

    // RMS -> dB per channel
    let sum = 0;
    for (let i = 0; i < bufL.length; i++){ const s = bufL[i]; sum += s*s; }
    let dbL = rmsToDb(Math.sqrt(sum / bufL.length));

    sum = 0;
    for (let i = 0; i < bufR.length; i++){ const s = bufR[i]; sum += s*s; }
    let dbR = rmsToDb(Math.sqrt(sum / bufR.length));

    // Ballistics
    if (!Number.isFinite(smL)) smL = dbL;
    if (!Number.isFinite(smR)) smR = dbR;
    smL += (dbL - smL) * (dbL > smL ? riseCoef : fallCoef);
    smR += (dbR - smR) * (dbR > smR ? riseCoef : fallCoef);

    updateMeter(smL, ledsL);
    updateMeter(smR, ledsR);

    rafId = requestAnimationFrame(frame);
  }

  // Initial start
  rafId = requestAnimationFrame(frame);

  function setEnabled(v){
    const want = !!v;
    if (want === enabled) return;
    enabled = want;

    if (!enabled){
      // Stop loop, reset state and turn off LEDs
      if (rafId) { try { cancelAnimationFrame(rafId); } catch {} rafId = 0; }
      smL = smR = -Infinity;
      clearLEDs();
    } else {
      // Restart loop if not already started
      if (!rafId) rafId = requestAnimationFrame(frame);
    }
  }

  function disconnect() {
    try { cancelAnimationFrame(rafId); } catch {}
    rafId = 0;
    enabled = false;
    smL = smR = -Infinity;
    clearLEDs();
    try { splitter.disconnect(); } catch {}
    try { tapNode.disconnect(splitter); } catch {}
  }

  return {
    disconnect,
    setEnabled,
    analyserL,
    analyserR,
    isMounted: true
  };
}
