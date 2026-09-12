import { vnoise } from '../terrain/noise.js';

/**
 * Weather state machine. Drives the renderer's atmospheric uniforms and
 * also computes — CPU-side — the sun's optical transmission through the
 * cloud layer, which the shader uses to dim direct sunlight on the ground.
 *
 * Scale conventions (realistic, to match the rest of the world):
 *   - All speeds in m/s.
 *   - All heights/distances in metres.
 *   - All probabilities per-second.
 *   - cloudCover, rainIntensity, dustIntensity, surfaceWetness in [0..1].
 *
 * Cloud projection mirrors the shader's: ray-direction × cloud altitude
 * gives an XZ point on the cloud shell, sampled with a two-fbm morphing
 * field. Keeping the JS and GLSL implementations identical means the sun
 * visibility we compute here is exactly what the shader would render.
 */
export class WeatherSystem {
  constructor() {
    // 'auto' = simulation drives cover/wind. 'manual' = UI sliders dominate.
    this.mode = 'auto';

    // --- Clouds -------------------------------------------------------
    this.cloudCover      = 0;       // 0 clear, 1 overcast
    this.cloudType       = 0;       // 0 cumulus, 1 stratus, 2 cirrus, 3 storm
    this.cloudAltitudeM  = 3000;    // metres above ground (cumulus base ~2-4km)
    this.cloudThickness  = 300;     // metres
    this.cloudScale      = 900;     // metres per noise unit
    this.cloudMorphSpeed = 0.0008;  // very slow — full shape turnover ~20 min

    // --- Wind ---------------------------------------------------------
    this.windDirX = 1;
    this.windDirZ = 0;
    this.windSpeed = 10;            // m/s — fresh breeze (default)
    this._windAngle = 0;

    // --- Precipitation ------------------------------------------------
    this.rainIntensity  = 0;
    this.lightningProb  = 0;
    this.lightningFlash = 0;

    // --- Dust ---------------------------------------------------------
    this.dustIntensity = 0;

    // --- Surface ------------------------------------------------------
    this.surfaceWetness = 0;

    // --- Derived ------------------------------------------------------
    // stormness: 0..1 — "how leaden are the skies". Derived from cover +
    // rain. Drives sand tint, cloud darkness, lightning probability.
    this.stormness = 0;
    // sunVisibility: 0..1 — optical transmission through the cloud layer
    // along the current sun direction. Computed in updateSunVisibility().
    this.sunVisibility = 1;

    // Internal time accumulator (game-seconds — driven by timeRate so
    // weather evolves at the same pace as the world clock).
    this._tSec = 0;
  }

  /**
   * Advance weather. `dtGameSeconds` is dt scaled by timeRate, so a
   * weather pattern that takes 6 game-hours always takes 6 game-hours,
   * whether we're at 1× or 600× time-rate.
   */
  tick(dtGameSeconds) {
    const dt = dtGameSeconds;
    this._tSec += dt;

    const auto = this.mode !== 'manual';

    if (auto) {
      // --- Cloud cover: weather pattern evolves over hours -----------
      // Two long sin terms (periods ~9h and ~3.3h) plus a slower drift
      // (~36h) — keeps cover changing but on a real-meteorological pace
      // rather than minutes.
      const hourPhase = this._tSec / 3600;
      this.cloudCover = clamp01(
        0.30 + 0.40 * Math.sin(hourPhase * 0.7) + 0.20 * Math.sin(hourPhase * 1.9)
                    + 0.15 * Math.sin(hourPhase * 0.17)
      );

      // --- Wind direction rotates very slowly; speed has gentle gusts.
      this._windAngle += dt * 0.0002;
      this.windDirX = Math.cos(this._windAngle);
      this.windDirZ = Math.sin(this._windAngle);
      this.windSpeed = 8 + 5 * Math.max(0, Math.sin(this._tSec / 1800));
    }
    // In manual mode, cloudCover/wind* are set externally via the UI
    // bridge in main.js — we just don't overwrite them here.

    // --- Rain & wetness -----------------------------------------------
    // In MANUAL mode the user expects their slider settings to apply
    // immediately — snap derived params instead of gradually approaching.
    // In AUTO mode use smooth physical approach so weather feels
    // natural as cover drifts.
    const rainTarget = this.cloudCover > 0.7 ? (this.cloudCover - 0.7) / 0.3 : 0;
    if (auto) {
      this.rainIntensity = approach(this.rainIntensity, rainTarget,
                                    dt * (rainTarget > this.rainIntensity ? 0.05 : 0.1));
    } else {
      this.rainIntensity = rainTarget;
    }

    if (auto) {
      if (this.rainIntensity > 0.05) {
        this.surfaceWetness = approach(this.surfaceWetness, 1,
                                       dt * 0.02 * this.rainIntensity);
      } else {
        const dryRate = 0.001 + (1 - this.cloudCover) * 0.004;
        this.surfaceWetness = approach(this.surfaceWetness, 0, dt * dryRate);
      }
    } else {
      this.surfaceWetness = this.rainIntensity > 0.05 ? 1 : 0;
    }

    // --- Lightning flash decay (kept here for the legacy lightningFlash
    //     field; the visible bolts live in LightningSystem now).
    this.lightningProb = this.rainIntensity > 0.6 ? 0.05 : 0;
    this.lightningFlash = Math.max(0, this.lightningFlash - dt * 8);

    // --- Dust decays unless triggered. Snap in manual.
    if (auto) this.dustIntensity = approach(this.dustIntensity, 0, dt * 0.002);

    // --- Stormness: weighted combo of heavy cover and rain. Always
    // recomputed from CURRENT state so it tracks both modes instantly.
    const heavyCover = Math.max(0, this.cloudCover - 0.7) / 0.3;
    this.stormness = clamp01(0.5 * heavyCover + 0.5 * this.rainIntensity);
  }

  /**
   * Update sun visibility from cloud field. Call once per frame *after*
   * the sun position is set. `realT` is the renderer's `uTime` (real
   * seconds since boot) so the JS sample matches the shader's exactly.
   * `eyeX`, `eyeZ` are camera position.
   */
  updateSunVisibility(sunDir, realT, eyeX, eyeZ) {
    if (this.cloudCover < 0.005 || sunDir[1] <= 0.05) {
      this.sunVisibility = 1;
      return;
    }
    const dy = Math.max(sunDir[1], 0.10);
    const t = Math.min((this.cloudAltitudeM - 0) / dy, 35000);
    const hitX = eyeX + sunDir[0] * t;
    const hitZ = eyeZ + sunDir[2] * t;
    const d = cloudField(hitX, hitZ, realT, this);
    const c = clamp01(this.cloudCover);
    const baseThresh = lerp(0.95, 0.05, c);
    const regAmp = 4 * c * (1 - c) * 0.55;
    // Mirror shader: regional bias contributes only for mid-range cover.
    // Skip the actual regional sample on CPU — close enough for HUD purposes.
    const threshold = baseThresh; // approximate; HUD-only
    const a = smoothstep(threshold - 0.06, threshold + 0.06, d);
    this.sunVisibility = 1 - a * 0.92;
  }

  /** Programmatic trigger for a dust storm. */
  startDustStorm(targetIntensity = 0.8) {
    this._dustTarget = targetIntensity;
  }
}

// ---------------------------------------------------------------------------
// Cloud field — must match the GLSL `cloudField` in glPipeline.js exactly.
// ---------------------------------------------------------------------------

// fbm with rotation between octaves — mirrors the GLSL exactly so the
// CPU-side sample is identical to the rendered value.
function fbm2d(x, z) {
  let v = 0, amp = 0.5;
  let px = x, pz = z;
  // 37° rotation matrix in floats
  const r00 = 0.8, r01 = -0.6, r10 = 0.6, r11 = 0.8;
  for (let i = 0; i < 6; i++) {
    v += vnoise(px, pz) * amp;
    const nx = (r00 * px + r01 * pz) * 2.07;
    const nz = (r10 * px + r11 * pz) * 2.07;
    px = nx; pz = nz;
    amp *= 0.5;
  }
  return v;
}

function domainWarp(x, z) {
  const wx  = vnoise(x * 0.7  +  5.2, z * 0.7  +  1.3);
  const wz  = vnoise(x * 0.7  +  3.9, z * 0.7  + 11.7);
  const wx2 = vnoise(x * 1.3  + 17.1, z * 1.3  +  3.5);
  const wz2 = vnoise(x * 1.3  +  2.4, z * 1.3  + 23.8);
  return [
    x + (wx  - 0.5) * 2.4 + (wx2 - 0.5) * 0.9,
    z + (wz  - 0.5) * 2.4 + (wz2 - 0.5) * 0.9,
  ];
}

function cloudField(worldX, worldZ, realT, w) {
  const driftX = w.windDirX * w.windSpeed * realT / w.cloudScale;
  const driftZ = w.windDirZ * w.windSpeed * realT / w.cloudScale;
  const u1x = worldX / w.cloudScale + driftX;
  const u1z = worldZ / w.cloudScale + driftZ;
  const u2x = u1x * 1.4 + w.windDirZ * w.windSpeed * realT * 0.7 / w.cloudScale;
  const u2z = u1z * 1.4 - w.windDirX * w.windSpeed * realT * 0.7 / w.cloudScale;
  const morph = realT * w.cloudMorphSpeed * 0.3;
  const [p1x, p1z] = domainWarp(u1x + morph, u1z);
  const [p2x, p2z] = domainWarp(u2x, u2z - morph);
  return 0.58 * fbm2d(p1x, p1z) + 0.42 * fbm2d(p2x, p2z);
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function lerp(a, b, t) {
  return a + (b - a) * t;
}
function smoothstep(a, b, x) {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}
function approach(value, target, rate) {
  if (value < target) return Math.min(target, value + rate);
  if (value > target) return Math.max(target, value - rate);
  return value;
}
