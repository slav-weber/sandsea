import { heightAt } from '../terrain/sdfHeight.js';
import { caveFloorAt } from '../terrain/cave.js';

// Effective surface height a drop should land on at (x,z): the highest of
// terrain, cave floor (when over a mouth), NPC tops and solid-feature tops.
// Vertical-column approximation — cheap and reads correct for falling rain.
function collisionY(x, z, y, params, npcs, solids, cave) {
  let top = heightAt(x, z, params);
  if (cave) {
    const cf = caveFloorAt(x, z, cave, params, y);
    if (cf !== null) top = cf;
  }
  for (let i = 0; i < npcs.length; i++) {
    const n = npcs[i];
    const dx = x - n.x, dz = z - n.z;
    const r = n.r;
    const d2 = dx * dx + dz * dz;
    if (d2 < r * r) {
      const t = n.y + Math.sqrt(r * r - d2);
      if (t > top) top = t;
    }
  }
  for (let i = 0; i < solids.length; i++) {
    const s = solids[i];
    const type = Math.floor(s.w / 100);
    const scale = (s.w - type * 100) / 10;
    const rc = 4.0 * scale;
    const dx = x - s.x, dz = z - s.z;
    if (dx * dx + dz * dz < rc * rc) {
      const t = s.y + 14.0 * scale; // column top
      if (t > top) top = t;
    }
  }
  return top;
}

const DROP_TEX_SIZE = 100;
const MAX_DROPS = DROP_TEX_SIZE * DROP_TEX_SIZE;   // 100×100 = 10000 drops

/**
 * 3D rain particle system. Each drop is a real point in the world with
 * an XYZ position; the renderer projects the drop's last-frame motion
 * trail as a line segment per pixel, with depth occlusion against the
 * scene. Drops fall under gravity + wind, collide with terrain (respawn
 * when below heightAt), and live in a 45m-radius cylinder around the
 * camera — once they drift out, they re-spawn so density stays
 * constant from the camera's POV.
 */
export class RainParticles {
  constructor() {
    this.drops = [];           // active drops, length up to MAX_DROPS
    this.velX = 0;             // current world velocity vector (gravity + wind)
    this.velY = -9.0;
    this.velZ = 0;
    // Pre-allocated GPU buffer sized to the texture (DROP_TEX_SIZE²)
    // so we can upload the whole drop array in one texSubImage2D call.
    this.buffer = new Float32Array(DROP_TEX_SIZE * DROP_TEX_SIZE * 4);
    this.texSize = DROP_TEX_SIZE;

    // Audio: synthesized rain hiss (filtered white noise loop), gain
    // proportional to active drop count.
    this.audioCtx = null;
    this.audioNodes = null;
    this._audioInited = false;
    if (typeof window !== 'undefined') {
      const wake = () => {
        if (this.audioCtx && this.audioCtx.state === 'suspended') {
          this.audioCtx.resume().catch(() => {});
        }
        window.removeEventListener('pointerdown', wake);
        window.removeEventListener('keydown', wake);
        window.removeEventListener('touchstart', wake);
      };
      window.addEventListener('pointerdown', wake);
      window.addEventListener('keydown', wake);
      window.addEventListener('touchstart', wake);
    }
  }

  _initAudio() {
    if (this._audioInited) return;
    this._audioInited = true;
    const C = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null;
    if (!C) return;
    try { this.audioCtx = new C(); } catch { return; }

    const ctx = this.audioCtx;
    const sr = ctx.sampleRate;
    // 6-second noise loop — longer = less audible periodicity.
    const buf = ctx.createBuffer(1, sr * 6, sr);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const source = ctx.createBufferSource();
    source.buffer = buf;
    source.loop = true;

    // Two parallel bandpass paths for a juicier mix:
    //   - High band ~3 kHz (the hiss / shimmer of falling drops)
    //   - Low band ~700 Hz (the body / pitter-patter rumble)
    const bpHi = ctx.createBiquadFilter();
    bpHi.type = 'bandpass'; bpHi.frequency.value = 3000; bpHi.Q.value = 0.8;
    const bpLo = ctx.createBiquadFilter();
    bpLo.type = 'bandpass'; bpLo.frequency.value = 700;  bpLo.Q.value = 0.7;
    // Per-band gains so we can mix them. Heavy on the body for juice.
    const gHi = ctx.createGain(); gHi.gain.value = 0.55;
    const gLo = ctx.createGain(); gLo.gain.value = 0.85;
    // Low shelf adds sub-rumble.
    const ls = ctx.createBiquadFilter();
    ls.type = 'lowshelf'; ls.frequency.value = 300; ls.gain.value = 10;
    // Master gain (modulated by drop count).
    const gain = ctx.createGain(); gain.gain.value = 0;

    source.connect(bpHi).connect(gHi).connect(ls);
    source.connect(bpLo).connect(gLo).connect(ls);
    ls.connect(gain).connect(ctx.destination);
    source.start();
    this.audioNodes = { source, bpHi, bpLo, gHi, gLo, ls, gain };
  }

  _updateAudio(activeCount) {
    if (activeCount > 0 && !this._audioInited) this._initAudio();
    if (!this.audioNodes || !this.audioCtx) return;
    // Perceptual loudness ∝ sqrt(N). Cap 0.55 — louder than before
    // (was 0.3), a richer look, still under clip.
    const t = Math.min(1, Math.sqrt(activeCount / MAX_DROPS));
    const target = t * 0.55 * (this.effectsVolume ?? 1);
    const now = this.audioCtx.currentTime;
    this.audioNodes.gain.gain.setTargetAtTime(target, now, 0.4);
    // Crossfade band mix with intensity: drizzle has more hiss, heavy
    // rain has more body. Also slide filter centres.
    this.audioNodes.gHi.gain.setTargetAtTime(0.35 + 0.4 * (1 - t), now, 0.6);
    this.audioNodes.gLo.gain.setTargetAtTime(0.55 + 0.6 * t,      now, 0.6);
    this.audioNodes.bpHi.frequency.setTargetAtTime(2700 + 1200 * (1 - t), now, 1.0);
    this.audioNodes.bpLo.frequency.setTargetAtTime(550  +  400 * t,       now, 1.0);
  }

  tick(weather, camera, cameraY, params, dtRealSec, options = {}) {
    const intensity = weather.rainIntensity;
    const radius = options.radius ?? 150;
    const height = options.height ?? 200;
    const speed  = options.speed  ?? 1;
    const maxCount = Math.min(MAX_DROPS, Math.max(0, options.maxCount ?? MAX_DROPS));
    const npcs = options.npcs ?? [];
    const solids = options.solids ?? [];
    const cave = options.cave ?? null;
    if (intensity < 0.02) {
      this.drops.length = 0;
      this._updateAudio(0);
      return;
    }

    this.velX = weather.windDirX * weather.windSpeed * 0.7;
    this.velZ = weather.windDirZ * weather.windSpeed * 0.7;
    // Base fall speed 60 m/s × user multiplier. Real terminal velocity
    // is 9 m/s but at our low render resolution that reads as drifting.
    // 60 m/s sells visually as proper rain; the slider lets you push
    // it to a 600 m/s monsoon at 10×.
    this.velY = -60.0 * speed;
    this._baseVy = this.velY;

    this._spawnRadius = radius;
    this._spawnHeight = height;
    // Spawn-centre biased upwind so drops drift TOWARD the camera —
    // otherwise wind blows the field downwind and all visible rain
    // ends up on one side. Look-ahead scales with spawn height so the
    // drift sweeps the full column during the drop's lifetime.
    const fallTimeApprox = Math.max(2.0, height / Math.abs(this.velY));
    this._spawnBiasX = -this.velX * fallTimeApprox * 0.5;
    this._spawnBiasZ = -this.velZ * fallTimeApprox * 0.5;

    // Active count = user max × intensity (capped). Intensity from
    // weather sim still gates whether rain is on at all (≥2%).
    const target = Math.floor(intensity * maxCount);
    while (this.drops.length < target) {
      this.drops.push(this._spawn(camera, cameraY, params));
    }
    while (this.drops.length > target) {
      this.drops.pop();
    }

    const cx = camera.x, cz = camera.z;
    const farSq = (radius * 1.8) * (radius * 1.8);
    for (let i = 0; i < this.drops.length; i++) {
      const d = this.drops[i];
      // Per-drop velocity update. Bouncing drops have their own vy
      // (decaying upward → downward under gravity); non-bouncing
      // drops just track the global fall speed.
      if (d.bouncing) {
        d.vy -= 30 * dtRealSec;
        d.bounceTime -= dtRealSec;
        if (d.bounceTime <= 0) {
          this._reset(d, camera, cameraY, params);
          continue;
        }
      } else {
        // Each drop keeps its OWN vy (set at spawn with ±15% scatter
        // relative to this.velY). Update vy whenever speed slider
        // changes so user-driven changes propagate, but preserve the
        // per-drop jitter ratio.
        const ratio = d.vyBase != null ? (d.vyBase / (this._baseVy || -60)) : 1.0;
        d.vy = this.velY * ratio;
        d.vyBase = d.vy;
      }
      d.x += this.velX * dtRealSec;
      d.y += d.vy * dtRealSec;
      d.z += this.velZ * dtRealSec;

      const groundY = collisionY(d.x, d.z, d.y, params, npcs, solids, cave);
      const dxc = d.x - cx, dzc = d.z - cz;
      const outOfBounds = (dxc * dxc + dzc * dzc) > farSq || d.y > cameraY + height + 60;
      if (outOfBounds) {
        this._reset(d, camera, cameraY, params);
        continue;
      }
      if (d.y < groundY && !d.bouncing) {
        // Reached ground. 50/50: clean respawn vs small bounce.
        if (Math.random() < 0.5) {
          this._reset(d, camera, cameraY, params);
        } else {
          d.y = groundY + 0.05;
          d.vy = 3.5 + Math.random() * 2.5;   // bounce up 3.5-6 m/s
          d.bouncing = true;
          d.bounceTime = 0.30 + Math.random() * 0.15; // 300-450 ms
        }
      }
    }

    this._updateAudio(this.drops.length);
  }

  _spawn(camera, cameraY, params) {
    // Per-drop fall speed gets ±15% scatter so cycles desync over
    // multiple bounces — without it every drop with the same vy
    // hits the ground at the same time and respawns in a wave.
    const speedJitter = 0.85 + Math.random() * 0.30;
    const d = {
      x: 0, y: 0, z: 0,
      vy: (this._baseVy ?? -60) * speedJitter,
      vyBase: (this._baseVy ?? -60) * speedJitter,
      bouncing: false,
      bounceTime: 0,
    };
    // Initial placement uses a RANDOM altitude across the spawn band so
    // the freshly created population isn't a synchronous front. Once a
    // drop hits the ground it respawns at the top edge via _reset; the
    // speed scatter keeps later cycles from synchronizing too.
    const r = this._spawnRadius ?? 150;
    const h = this._spawnHeight ?? 200;
    const ang = Math.random() * Math.PI * 2;
    const rr = Math.sqrt(Math.random()) * r;
    const bx = this._spawnBiasX ?? 0;
    const bz = this._spawnBiasZ ?? 0;
    d.x = camera.x + bx + Math.cos(ang) * rr;
    d.z = camera.z + bz + Math.sin(ang) * rr;
    const groundY = heightAt(d.x, d.z, params);
    const minY = Math.max(cameraY + 3, groundY + 3);
    d.y = minY + Math.random() * h;
    return d;
  }

  // Place a drop at the TOP of the spawn band. Every drop has the
  // same vertical fall distance, so every drop has the same visible
  // lifecycle — speed appears uniform across the field. Tiny ±1m
  // jitter only so the spawn line isn't a perfect plane.
  _reset(d, camera, cameraY, params) {
    const r = this._spawnRadius ?? 150;
    const h = this._spawnHeight ?? 200;
    const ang = Math.random() * Math.PI * 2;
    const rr = Math.sqrt(Math.random()) * r;
    const bx = this._spawnBiasX ?? 0;
    const bz = this._spawnBiasZ ?? 0;
    d.x = camera.x + bx + Math.cos(ang) * rr;
    d.z = camera.z + bz + Math.sin(ang) * rr;
    const groundY = heightAt(d.x, d.z, params);
    const minY = Math.max(cameraY + 3, groundY + 3);
    d.y = minY + h + (Math.random() - 0.5) * 2;
    d.bouncing = false;
    d.bounceTime = 0;
    // Re-pick a per-drop speed jitter on respawn so cycles diverge
    // over time. Without this, even initially-staggered drops would
    // re-converge after a few cycles.
    const speedJitter = 0.85 + Math.random() * 0.30;
    d.vy = (this._baseVy ?? -60) * speedJitter;
    d.vyBase = d.vy;
  }

  /**
   * Pack drops into the GPU buffer. xyz = position, w = per-drop
   * vertical velocity (used by the shader to direct each drop's
   * motion-blur trail — bouncing drops have a different vy from
   * normal falling drops, so they need an individual trail).
   */
  packBuffer() {
    const n = this.drops.length;
    for (let i = 0; i < n; i++) {
      const d = this.drops[i];
      this.buffer[i * 4]     = d.x;
      this.buffer[i * 4 + 1] = d.y;
      this.buffer[i * 4 + 2] = d.z;
      this.buffer[i * 4 + 3] = d.vy;
    }
    for (let i = n * 4; i < this.buffer.length; i++) this.buffer[i] = 0;
    return n;
  }

  get velocity() {
    return [this.velX, this.velY, this.velZ];
  }
}

export const MAX_RAIN_DROPS = MAX_DROPS;
export const RAIN_TEX_SIZE = DROP_TEX_SIZE;
