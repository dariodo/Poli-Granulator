/**
 * @fileoverview Background "Grain Particles" animation module.
 * 
 * Creates an animated particle system tied to the 3 cursors:
 * - Cursor A -> Layer 0 (green)
 * - Cursor B -> Layer 1 (blue)
 * - Cursor C -> Layer 2 (red)
 * 
 * Each layer has:
 *   grainSize  -> particle size
 *   spread     -> particle speed
 *   density    -> particle count
 * 
 * The .granular-ui element acts as a "wall" that particles cannot pass through.
 * 
 * @module ui/background-animation
 */

// Colors for the 3 cursors (A/B/C)
const LAYER_COLORS = ['#899f8c', '#829aa6', '#a68282'];

// Maximum distance for connecting lines between particles
const LINK_DISTANCE = 80;

// Radius range (in pixels)
const MIN_RADIUS = 1.5;
const MAX_RADIUS = 8.0;

// Growth/decay per frame in normalized units [0-1]
// (equivalent to ~1.2px / 0.2px on a ~6.5px range)
const GROW_PER_FRAME   = 0.25;
const SHRINK_PER_FRAME = 0.05;
const HOLD_FRAMES      = 0;

// Dynamic state for each layer (A/B/C)
// size   -> maximum radius in pixels
// speed  -> velocity multiplier
// count  -> particle count
// Default state for each layer
const DEFAULT_LAYER_STATE = Object.freeze([
  { size: 6, speed: 0.3, count: 400 / 3 },
  { size: 6, speed: 0.3, count: 400 / 3 },
  { size: 6, speed: 0.3, count: 400 / 3 }
]);

// Dynamic state (mutable copy of defaults)
const layerState = [
  { ...DEFAULT_LAYER_STATE[0] },
  { ...DEFAULT_LAYER_STATE[1] },
  { ...DEFAULT_LAYER_STATE[2] }
];


// Particles per layer
const particlesLayers = [[], [], []];
const scratchAll = []; // Buffer to merge layers for drawLinks

let canvas = null;
let ctx = null;

// UI rectangle (wall)
let uiRect = null;

// =========================
// Synth parameter to particle mappings
// =========================

// grainSize slider ~ [0.25, 4]
// Translates to a reasonable max radius on screen [MIN_RADIUS, MAX_RADIUS]
function mapGrainSizeToParticleSize(grainSize) {
  const g = Math.max(0.1, Math.min(8, grainSize || 0));
  const gMin = 0.25;
  const gMax = 4.0;
  const t = Math.max(0, Math.min(1, (g - gMin) / (gMax - gMin)));
  return MIN_RADIUS + t * (MAX_RADIUS - MIN_RADIUS);
}

// spread slider ~ [0, 1]
// Speed (base motion multiplier)
function mapSpreadToSpeed(spread) {
  const s = Math.max(0, Math.min(1, spread || 0));
  const min = 0.1; // very slow
  const max = 0.7; // quite lively
  return min + s * (max - min);
}

// density slider ~ [1, 100]
// Particle count. Original animation had 400 particles.
// Using density * 4 for approximately the same scale.
function mapDensityToCount(density) {
  const d = Math.max(0, density || 0);
  return d * 4;
}

// =========================
// Public API: called from main script
// =========================

export function setLayerParams(cursorIndex, params = {}) {
  const idx = Math.max(0, Math.min(2, cursorIndex | 0));
  const L = layerState[idx];
  const arr = particlesLayers[idx];

  // ---------- GRAIN SIZE ----------
  if ('grainSize' in params && params.grainSize != null) {
    const newSize = mapGrainSizeToParticleSize(params.grainSize);
    if (Math.abs(newSize - L.size) > 1e-3) {
      L.size = newSize;
      // No loop over particles needed:
      // The new size is used directly in draw() and collisions,
      // so the effect is immediate on ALL particles.
    }
  }

  // ---------- SPREAD ----------
  if ('spread' in params && params.spread != null) {
    const newSpeed = mapSpreadToSpeed(params.spread);
    if (Math.abs(newSpeed - L.speed) > 1e-3) {
      L.speed = newSpeed;
      // No loop over particles needed:
      // update() always uses L.speed, so all velocities change immediately.
    }
  }

  // ---------- DENSITY ----------
  if ('density' in params && params.density != null) {
    const newCount = mapDensityToCount(params.density);
    if (Math.abs(newCount - L.count) > 1e-3) {
      L.count = newCount;

      // Immediately update the particle count for this layer (for responsiveness)
      const target = Math.max(0, Math.round(newCount));
      if (arr) {
        while (arr.length < target) {
          arr.push(new Particle(idx));
        }
        while (arr.length > target) {
          arr.pop();
        }
      }
    }
  }
}

// Optional, useful for console debugging
export function debugGetLayerState() {
  return JSON.parse(JSON.stringify(layerState));
}

// =========================
// GUI layout helpers (wall)
// =========================

function updateUiRect() {
  const ui = document.querySelector('.granular-ui');
  if (!ui) {
    uiRect = null;
    return;
  }
  const r = ui.getBoundingClientRect();
  uiRect = {
    left: r.left,
    top: r.top,
    right: r.right,
    bottom: r.bottom
  };
}

function pointInsideUi(x, y, radius = 0) {
  if (!uiRect) return false;
  const left   = uiRect.left   - radius;
  const right  = uiRect.right  + radius;
  const top    = uiRect.top    - radius;
  const bottom = uiRect.bottom + radius;
  return x > left && x < right && y > top && y < bottom;
}

// =========================
// Canvas setup
// =========================

function resize() {
  if (!canvas) return;
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  updateUiRect();
}

// =========================
// Random and color utilities
// =========================

function randRange(min, max) {
  return Math.random() * (max - min) + min;
}

function hexToRgba(hex, a) {
  const m = hex.replace('#', '');
  const bigint = parseInt(
    m.length === 3 ? m.split('').map(c => c + c).join('') : m,
    16
  );
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

// =========================
// Particle class (one per layer)
// =========================

class Particle {
  constructor(layerIndex) {
    this.layer = layerIndex | 0;
    this.reset();
  }

  // Current radius (in pixels) based on sizeNorm + layer.size
  getRadius() {
    const cfg = layerState[this.layer];
    const maxSize = Math.max(MIN_RADIUS, cfg.size || MIN_RADIUS);
    return MIN_RADIUS + this.sizeNorm * (maxSize - MIN_RADIUS);
  }

  // Target radius (in pixels) when "full"
  getTargetRadius() {
    const cfg = layerState[this.layer];
    const maxSize = Math.max(MIN_RADIUS, cfg.size || MIN_RADIUS);
    return MIN_RADIUS + this.targetNorm * (maxSize - MIN_RADIUS);
  }

  reset() {
    const cfg = layerState[this.layer];

    // Size: using normalized values [0-1]
    this.sizeNorm   = 0;
    this.targetNorm = Math.random(); // Each has its own "position" in the range

    // Calculate target radius for initial positioning
    const spawnRadius = this.getTargetRadius();

    // Initial position: random OUTSIDE the granular-ui
    let x = 0;
    let y = 0;
    const maxTries = 32;
    for (let i = 0; i < maxTries; i++) {
      x = randRange(0, canvas.width);
      y = randRange(0, canvas.height);
      if (!pointInsideUi(x, y, spawnRadius)) break;
    }
    this.x = x;
    this.y = y;

    // Base direction: normalized vector * random magnitude
    const angle = Math.random() * Math.PI * 2;
    const mag = randRange(0.3, 1.0); // Some variation between particles
    this.dirX = Math.cos(angle) * mag;
    this.dirY = Math.sin(angle) * mag;

    // Color associated with layer / cursor
    this.color = LAYER_COLORS[this.layer] || '#ffffff';
    this.hold = HOLD_FRAMES;
  }

  update() {
    const cfg = layerState[this.layer];

    // Actual velocity = base direction * layer speed
    const speedMul = 1.5 * cfg.speed;
    const vx = this.dirX * speedMul;
    const vy = this.dirY * speedMul;

    this.x += vx;
    this.y += vy;

    // Screen borders: wrap-around
    if (this.x < -10) this.x = canvas.width + 10;
    if (this.x > canvas.width + 10) this.x = -10;
    if (this.y < -10) this.y = canvas.height + 10;
    if (this.y > canvas.height + 10) this.y = -10;

    // Collision with .granular-ui (rectangular wall)
    if (uiRect) {
      const r = this.getRadius();
      const left   = uiRect.left   - r;
      const right  = uiRect.right  + r;
      const top    = uiRect.top    - r;
      const bottom = uiRect.bottom + r;

      const insideX = this.x > left && this.x < right;
      const insideY = this.y > top && this.y < bottom;

      if (insideX && insideY) {
        const dl = Math.abs(this.x - left);
        const dr = Math.abs(this.x - right);
        const dt = Math.abs(this.y - top);
        const db = Math.abs(this.y - bottom);
        const min = Math.min(dl, dr, dt, db);
        const EPS = 0.5;

        // If direction is too small, give a nudge
        const len = Math.hypot(this.dirX, this.dirY);
        if (!len || len < 0.05) {
          const angle = Math.random() * Math.PI * 2;
          const mag = 0.5;
          this.dirX = Math.cos(angle) * mag;
          this.dirY = Math.sin(angle) * mag;
        }

        // Bounce: reflect base direction against the wall
        if (min === dl) {
          this.x = left - EPS;
          this.dirX = -Math.abs(this.dirX || -0.4);
        } else if (min === dr) {
          this.x = right + EPS;
          this.dirX = Math.abs(this.dirX || 0.4);
        } else if (min === dt) {
          this.y = top - EPS;
          this.dirY = -Math.abs(this.dirY || -0.4);
        } else {
          this.y = bottom + EPS;
          this.dirY = Math.abs(this.dirY || 0.4);
        }

        // Small jitter to avoid perfectly repetitive trajectories
        const jitter = 0.05;
        this.dirX += (Math.random() - 0.5) * jitter;
        this.dirY += (Math.random() - 0.5) * jitter;
      }
    }

    // Appearance -> plateau -> disappearance -> respawn
    if (this.sizeNorm < this.targetNorm) {
      this.sizeNorm = Math.min(this.targetNorm, this.sizeNorm + GROW_PER_FRAME);
    } else if (this.hold > 0) {
      this.hold--;
    } else if (this.sizeNorm > 0.05) {
      this.sizeNorm -= SHRINK_PER_FRAME;
    } else {
      this.reset();
    }
  }

  draw(ctx) {
    const radius = this.getRadius();
    if (radius <= 0) return;

    ctx.fillStyle = this.color;
    ctx.beginPath();
    ctx.arc(this.x, this.y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
}

// =========================
// Layer particle management
// =========================

function ensureLayerCounts() {
  for (let layer = 0; layer < 3; layer++) {
    const cfg = layerState[layer];
    const target = Math.max(0, Math.round(cfg.count));
    const arr = particlesLayers[layer];

    while (arr.length < target) {
      arr.push(new Particle(layer));
    }
    while (arr.length > target) {
      arr.pop();
    }
  }
}

function drawLinks(ctx, allParticles) {
  const distMax = LINK_DISTANCE;
  const distMax2 = distMax * distMax;

  for (let i = 0; i < allParticles.length; i++) {
    const p1 = allParticles[i];
    const r1 = p1.getRadius();
    for (let j = i + 1; j < allParticles.length; j++) {
      const p2 = allParticles[j];
      const dx = p1.x - p2.x;
      const dy = p1.y - p2.y;
      const d2 = dx * dx + dy * dy;

      if (d2 < distMax2) {
        const d = Math.sqrt(d2);
        const alpha = 1 - (d / distMax);
        const r2 = p2.getRadius();

        ctx.beginPath();
        ctx.strokeStyle = hexToRgba(p1.color, Math.max(0.18, alpha * 0.6));
        ctx.lineWidth = Math.max(0.8, (r1 + r2) * 0.04);
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
      }
    }
  }
}

// =========================
// Main animation loop
// =========================

function animate() {
  if (!ctx || !canvas) return;

  // Only fillRect, no clearRect (less work)
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ensureLayerCounts();

  // Update and draw per layer
  for (let layer = 0; layer < 3; layer++) {
    const arr = particlesLayers[layer];
    for (let i = 0; i < arr.length; i++) {
      const p = arr[i];
      p.update();
      p.draw(ctx);
    }
  }

  // Lines between all particles, regardless of layer
  scratchAll.length = 0;
  scratchAll.push(
    ...particlesLayers[0],
    ...particlesLayers[1],
    ...particlesLayers[2]
  );
  drawLinks(ctx, scratchAll);

  requestAnimationFrame(animate);
}

// =========================
// Bootstrap
// =========================
function start() {
  canvas = document.getElementById('bgAnim');
  if (!canvas) {
    console.warn('[bg-anim] canvas #bgAnim not found');
    return;
  }
  ctx = canvas.getContext('2d');

  resize();
  window.addEventListener('resize', resize, { passive: true });

  animate();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}

// Complete background reset to initial values
export function resetBackgroundAnimation() {
  for (let i = 0; i < 3; i++) {
    const def = DEFAULT_LAYER_STATE[i];
    const L   = layerState[i];

    // Restore layer parameters
    L.size  = def.size;
    L.speed = def.speed;
    L.count = def.count;

    // Recreate particles for this layer
    const arr = particlesLayers[i];
    arr.length = 0;
    const target = Math.max(0, Math.round(L.count));
    for (let n = 0; n < target; n++) {
      arr.push(new Particle(i));
    }
  }
}
