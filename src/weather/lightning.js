import { heightAt } from '../terrain/sdfHeight.js';

const MAX_BOLT_PTS = 48;
const SPEED_OF_SOUND = 340; // m/s

// Color profiles — picked at random per strike. Real lightning ranges
// from cold blue-white (high temperature) to warm pink-white (lower
// temperature, more dust/moisture). Each profile is the bolt-channel
// colour; the ground light picks up the same hue.
const BOLT_COLOR_PROFILES = [
  [0.92, 0.96, 1.00], // classic cold blue-white
  [0.80, 0.85, 1.00], // deep blue
  [0.95, 0.88, 1.00], // pale purple
  [1.00, 0.92, 0.96], // pink-white
  [1.00, 0.98, 0.80], // warm yellow-white
];

/**
 * Realistic lightning. A LightningGenerator builds bolts with a rich
 * structure (main channel + branches), assigns each strike a colour
 * and a multi-pulse flicker envelope (return-strokes), and schedules
 * a rolling thunder peal series whose count + spread scale with the
 * bolt's path length. Each peal is a separately filtered noise burst
 * — together they sound like real thunder, not one beat.
 */
export class LightningSystem {
  constructor() {
    this.bolts = [];
    this.audioCtx = null;
    this.enabled = true;
    this._tSec = 0;
    if (typeof window !== 'undefined') {
      const wake = () => {
        const ctx = this._ensureAudio();
        if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
        window.removeEventListener('pointerdown', wake);
        window.removeEventListener('keydown', wake);
        window.removeEventListener('touchstart', wake);
      };
      window.addEventListener('pointerdown', wake);
      window.addEventListener('keydown', wake);
      window.addEventListener('touchstart', wake);
    }
  }

  setEnabled(b) { this.enabled = !!b; }

  _ensureAudio() {
    if (this.audioCtx) return this.audioCtx;
    const C = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null;
    if (!C) return null;
    try { this.audioCtx = new C(); } catch { return null; }
    return this.audioCtx;
  }

  /** Manual trigger — fires a bolt right now regardless of cover. */
  fire(camera, cameraY, params) {
    if (!this.enabled) return;
    this._spawnBolt(camera, cameraY, params, /*biasedToFront*/ true);
  }

  tick(dtGameSeconds, { cloudCover, camera, cameraY, params }) {
    this._tSec += dtGameSeconds;
    if (this.enabled && cloudCover >= 0.70) {
      const intensity = (cloudCover - 0.70) / 0.30;
      const probPerSec = intensity * 0.10;
      if (Math.random() < probPerSec * dtGameSeconds) {
        this._spawnBolt(camera, cameraY, params, /*biasedToFront*/ true);
      }
    }
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      b.age += dtGameSeconds;
      if (b.age >= b.duration) this.bolts.splice(i, 1);
    }
  }

  _spawnBolt(camera, cameraY, params, biasedToFront = false) {
    // Strike position around camera. Biased version samples within ±90°
    // of camera's forward direction. Yaw convention: yaw=0 looks +Z;
    // +yaw turns toward +X. World azimuth (from +X CCW) = π/2 - yaw.
    let ang;
    if (biasedToFront) {
      const fwd = Math.PI / 2 - camera.yaw;
      ang = fwd + (Math.random() - 0.5) * Math.PI;
    } else {
      ang = Math.random() * Math.PI * 2;
    }
    const distH = 200 + Math.random() * 700;
    const tx = camera.x + Math.cos(ang) * distH;
    const tz = camera.z + Math.sin(ang) * distH;
    const ty = heightAt(tx, tz, params);

    const cloudY = 1800 + Math.random() * 900;
    const cloudJitter = 250;
    const cx = tx + (Math.random() - 0.5) * cloudJitter;
    const cz = tz + (Math.random() - 0.5) * cloudJitter;

    const bolt = LightningGenerator.build([cx, cloudY, cz], [tx, ty, tz]);

    if (this.bolts.length >= 2) this.bolts.shift();
    this.bolts.push(bolt);

    // Distance to camera (eye-to-strike) drives thunder timing/volume.
    const dx = tx - camera.x;
    const dy = ty - cameraY;
    const dz = tz - camera.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    this._scheduleThunder(dist, bolt);
  }

  _scheduleThunder(distance, bolt) {
    const ctx = this._ensureAudio();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});

    // Peals: 3-5 sequential booms over ~3-8 seconds. Each peal
    // comes from a different segment of the lightning channel —
    // closer segments arrive first, farther ones later.
    const baseDelay = distance / SPEED_OF_SOUND;
    const numPeals = 3 + ((bolt.strength * 3) | 0);
    const rumbleSpread = 2 + bolt.strength * 5;

    for (let i = 0; i < numPeals; i++) {
      const dt = (i / numPeals) * rumbleSpread + Math.random() * 0.3;
      const peakOffset = (i === 0) ? 1.0 : (0.7 - 0.12 * i + Math.random() * 0.2);
      const localDist = distance * (0.9 + i * 0.08); // far peals come from farther channel
      setTimeout(
        () => this._playThunderPeal(localDist, peakOffset, i === 0),
        (baseDelay + dt) * 1000
      );
    }
  }

  _playThunderPeal(distance, strengthMul, isCrack) {
    const ctx = this.audioCtx;
    if (!ctx || ctx.state !== 'running') return;

    const dur = isCrack ? 0.8 + Math.random() * 0.4
                         : 1.5 + Math.random() * 1.5;
    const sampleRate = ctx.sampleRate;
    const len = Math.floor(dur * sampleRate);
    const buf = ctx.createBuffer(1, len, sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    const noise = ctx.createBufferSource();
    noise.buffer = buf;

    // First peal (the "crack") keeps more high frequencies.
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    const baseFreq = isCrack
      ? Math.max(150, Math.min(4500, 6000 / Math.max(1, distance / 80)))
      : Math.max(80,  Math.min(1200, 2000 / Math.max(1, distance / 80)));
    lp.frequency.value = baseFreq;
    lp.Q.value = isCrack ? 1.2 : 0.7;

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 35;

    // Envelope. Louder peak overall (up to 1.4) — user asked for more
    // volume. WebAudio clamps internally at the destination so this is
    // safe.
    const gain = ctx.createGain();
    const attack = isCrack ? 0.01 : 0.05 + distance / 8000;
    const peak = Math.min(1.4, 22000 / Math.max(100, distance * distance)) * strengthMul * (this.effectsVolume ?? 1);
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(peak, ctx.currentTime + attack);
    gain.gain.exponentialRampToValueAtTime(0.0005, ctx.currentTime + dur);

    noise.connect(hp).connect(lp).connect(gain).connect(ctx.destination);
    noise.start();
    noise.stop(ctx.currentTime + dur);
  }

  /** Project active bolt to screen-space + compute current intensity. */
  toRenderData(camera, cameraY, W, H) {
    if (this.bolts.length === 0) return null;
    const b = this.bolts[this.bolts.length - 1];

    // Multi-pulse intensity: stacked exponential decays from each pulse.
    let intensity = 0;
    for (const p of b.pulses) {
      if (b.age >= p.t) {
        intensity += p.peak * Math.exp(-(b.age - p.t) * 22);
      }
    }
    intensity = Math.min(1, intensity);

    // Project bolt geometry. To keep it simple we flatten the
    // main path and branches into one array; branches are separated
    // from the main path by an "invalid" (w=0) point so the shader's
    // segment-drawer skips the gap.
    const projected = [];
    const cy = Math.cos(camera.yaw), sy = Math.sin(camera.yaw);
    const cp = Math.cos(camera.pitch), sp = Math.sin(camera.pitch);
    const project = (p) => {
      const px = p[0] - camera.x;
      const py = p[1] - cameraY;
      const pz = p[2] - camera.z;
      const x1 = px * cy - pz * sy;
      const z1 = px * sy + pz * cy;
      const y2 = py * cp - z1 * sp;
      const z2 = py * sp + z1 * cp;
      if (z2 <= 0.5) return [0, 0, 0, 0];
      const sx = (x1 / z2) * camera.focal + W / 2;
      const sy_p = (y2 / z2) * camera.focal + H / 2;
      return [sx, sy_p, z2, 1];
    };

    const paths = [b.points, ...b.branches];
    for (const path of paths) {
      if (projected.length > 0) projected.push([0, 0, 0, 0]); // separator
      for (const p of path) {
        if (projected.length >= MAX_BOLT_PTS) break;
        projected.push(project(p));
      }
      if (projected.length >= MAX_BOLT_PTS) break;
    }

    return {
      points: projected,
      lightPos: b.lightPos,
      intensity,
      color: b.color,
    };
  }
}

// ---------------------------------------------------------------------------
// Bolt generator — encapsulates the random construction so different
// bolt "personalities" can be swapped in later without touching the system.
// ---------------------------------------------------------------------------

const LightningGenerator = {
  build(start, end) {
    // Main channel via 4 levels of midpoint displacement → 17 points
    // of fractally self-similar jaggedness, the same algorithm used in
    // every serious VFX lightning system.
    const totalLen = vlen(vsub(end, start));
    const main = fractalPath(start, end, /*levels*/ 4, /*initialDisp*/ totalLen * 0.10);

    // 1-2 branches forking off mid-points of the main channel. Each
    // branch is itself a fractal sub-path (3 levels → 9 points). Branch
    // direction biases roughly along the main flow but with strong
    // sideways deviation so it reads as a fork, not a continuation.
    const branches = [];
    const branchCount = 1 + ((Math.random() * 2) | 0);
    const overallDir = vnorm(vsub(end, start));
    for (let b = 0; b < branchCount; b++) {
      // Fork from somewhere in the upper-middle portion of the main
      // path (matches reality — lightning forks high, not at the tip).
      const i = 3 + ((Math.random() * (main.length - 8)) | 0);
      const from = main[i];
      // Branch direction: continue along overall flow but with strong
      // perpendicular deviation. randomPerpendicular gives a unit vector
      // perpendicular to overallDir; mix with overall for the actual dir.
      const perp = randomPerpendicular(overallDir);
      const branchDir = vnorm(vadd(vscale(overallDir, 0.55),
                                   vscale(perp, 0.9 + Math.random() * 0.6)));
      const branchLen = totalLen * (0.25 + Math.random() * 0.30);
      const to = vadd(from, vscale(branchDir, branchLen));
      const path = fractalPath(from, to, /*levels*/ 3, branchLen * 0.18);
      branches.push(path);
    }

    const colorIdx = (Math.random() * BOLT_COLOR_PROFILES.length) | 0;
    const color = BOLT_COLOR_PROFILES[colorIdx];
    const strength = Math.min(1, totalLen / 3000);

    // 2-4 return strokes (real lightning flickers).
    const pulseCount = 2 + ((Math.random() * 2) | 0);
    const pulses = [];
    let t = 0;
    for (let i = 0; i < pulseCount; i++) {
      pulses.push({ t, peak: 1.0 - i * 0.18 });
      t += 0.04 + Math.random() * 0.10;
    }
    const duration = t + 0.22;

    const lightPos = [...main[(main.length / 2) | 0]];

    return { points: main, branches, color, strength, pulses, lightPos, age: 0, duration };
  },
};

/**
 * Midpoint-displacement fractal path. Each iteration inserts a new
 * point at the midpoint of every existing segment, displaced
 * perpendicularly by a random amount whose amplitude halves each level.
 * The result is a self-similar fractal with statistically natural
 * Brownian shape — exactly how lightning channels look.
 *
 * Levels n → 2^n + 1 points. levels=4 gives 17 points.
 */
function fractalPath(start, end, levels, initialDisp) {
  let pts = [start, end];
  let disp = initialDisp;
  for (let lvl = 0; lvl < levels; lvl++) {
    const next = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const mid = vlerp(a, b, 0.5);
      const dir = vnorm(vsub(b, a));
      const perp = randomPerpendicular(dir);
      const offset = vscale(perp, (Math.random() - 0.5) * 2 * disp);
      next.push(vadd(mid, offset));
      next.push(b);
    }
    pts = next;
    disp *= 0.5; // halve each iteration → Brownian-like noise
  }
  return pts;
}

/** Returns a random unit vector perpendicular to `dir` (3D). */
function randomPerpendicular(dir) {
  // Pick a vector not parallel to dir.
  const up = Math.abs(dir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const p1 = vnorm(vcross(dir, up));
  const p2 = vcross(dir, p1);
  const a = Math.random() * Math.PI * 2;
  return vadd(vscale(p1, Math.cos(a)), vscale(p2, Math.sin(a)));
}

function vsub(a, b)   { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
function vadd(a, b)   { return [a[0]+b[0], a[1]+b[1], a[2]+b[2]]; }
function vscale(a, s) { return [a[0]*s, a[1]*s, a[2]*s]; }
function vlerp(a, b, t) { return [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t]; }
function vlen(v)      { return Math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]); }
function vnorm(v)     { const l = vlen(v); return l > 1e-6 ? vscale(v, 1/l) : [0,1,0]; }
function vcross(a, b) {
  return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
}
