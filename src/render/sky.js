import { SKY_PALETTES, sampleSkyPalette } from '../config/palettes.js';
import { hash2 } from '../terrain/noise.js';

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/**
 * Build a small RGB lookup table for the sky gradient. Indexed by band
 * (0 = zenith, skyBands = horizon), so per-pixel bayer dithering can pick
 * between adjacent bands without re-sampling the palette spline.
 */
export function buildSkyLUT(skyBands, params = {}) {
  const { paletteName, stops: explicitStops } = params;
  const stops = explicitStops ?? SKY_PALETTES[paletteName] ?? SKY_PALETTES.classic;
  const lut = new Array(skyBands + 1);
  for (let i = 0; i <= skyBands; i++) {
    lut[i] = sampleSkyPalette(stops, i / skyBands);
  }
  return lut;
}

/**
 * Paint the sky every frame. The gradient now spans the full visible sky:
 * `t` goes from 0 at the top of the screen (zenith) to 1 at the horizon line.
 * That means looking up gives you a long, smooth zenith→horizon transition;
 * looking forward gives you the compressed strip near the horizon — both
 * "feel like sky" without static striping at the top.
 *
 * Stars (when night) are world-anchored at pixel resolution: hash key uses
 * `(camera.yaw·focal + screen_x_offset, effHorizon − y)`, so rotating the
 * camera scrolls past different stars rather than dragging the same set.
 */
export function renderSky(data, width, height, lut, params) {
  const { camera, effHorizon, skyHeight, skyBands, starsEnabled, nightLevel } = params;

  const lutLast = lut[lut.length - 1];
  // Gradient thickness is fixed at `skyHeight` pixels regardless of pitch.
  // Above the strip → pure zenith; below the horizon → horizon color (will be
  // overpainted by terrain). That keeps the sky's physical scale constant
  // when the camera tilts — no perceptual "stretching".
  const safeSkyH = Math.max(1, skyHeight);

  for (let y = 0; y < height; y++) {
    let t;
    if (effHorizon <= 0 || y >= effHorizon) {
      t = 1;
    } else {
      const dy = effHorizon - y;
      if (dy >= safeSkyH) {
        t = 0;
      } else {
        t = 1 - dy / safeSkyH;
      }
    }
    const bandFloat = t * skyBands;
    const bandIdx = Math.floor(bandFloat);
    const bandFrac = bandFloat - bandIdx;

    for (let x = 0; x < width; x++) {
      const bayerVal = BAYER[(y & 3) * 4 + (x & 3)] / 16;
      const eff = bandFrac > bayerVal ? bandIdx + 1 : bandIdx;
      const c = lut[eff] ?? lutLast;
      const i = (y * width + x) * 4;
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = 255;
    }
  }

  if (starsEnabled && nightLevel > 0.01 && effHorizon > 0) {
    addStars(data, width, height, camera, effHorizon, nightLevel, params.timeOfDay);
  }
}

/**
 * Star field on a real celestial sphere.
 *
 * Each star sits at a fixed CELESTIAL direction (a unit vector on the sphere
 * that doesn't move with time). The sphere rotates once per day around a
 * tilted POLAR AXIS, carrying both sun and stars along the same great-circle
 * arcs (rise east → climb → cross meridian → set west). For a pixel showing
 * world direction W at time t, the celestial direction is
 *
 *   C = R_polar(-2π·t) · W
 *
 * Hash C → is there a star at that celestial direction?
 *
 * Polar axis is tilted 55° above the −Z (north) horizon. With observer
 * "latitude" 55°, a star on the celestial equator reaches max altitude
 * 90° − 55° = 35° at meridian — same as the sun's max elev — so sun and
 * stars trace identical arcs.
 *
 * Per-frame we build the combined matrix M = R_polar(-2π·t) · R_camera_yaw
 * and apply it once per pixel to (ndcX, ndcY, 1). That's ~9 mults + sqrt +
 * one hash call per pixel — cheap enough for full-screen night.
 */
const STAR_POLAR_LAT = (55 * Math.PI) / 180;
const STAR_POLAR_Y = Math.sin(STAR_POLAR_LAT); // 0.819
const STAR_POLAR_Z = -Math.cos(STAR_POLAR_LAT); // −0.574 (toward "north", -Z)

function addStars(data, width, height, camera, effHorizon, nightLevel, timeOfDay) {
  const focal = camera.focal;
  const halfW = width >> 1;
  const baseIntensity = Math.min(1, nightLevel) * 110;
  // Hash quantisation at pixel resolution so each canvas pixel is one star slot.
  const Q = Math.round(focal);

  // --- Celestial un-rotation matrix R_polar(-2π·t) ------------------------
  // Rodrigues' formula for axis (pX, pY, pZ), angle tAng.
  const pX = 0;
  const pY = STAR_POLAR_Y;
  const pZ = STAR_POLAR_Z;
  const tAng = -(timeOfDay || 0) * Math.PI * 2;
  const cosT = Math.cos(tAng);
  const sinT = Math.sin(tAng);
  const oneMC = 1 - cosT;
  const r00 = cosT + pX * pX * oneMC;
  const r01 = pX * pY * oneMC - pZ * sinT;
  const r02 = pX * pZ * oneMC + pY * sinT;
  const r10 = pY * pX * oneMC + pZ * sinT;
  const r11 = cosT + pY * pY * oneMC;
  const r12 = pY * pZ * oneMC - pX * sinT;
  const r20 = pZ * pX * oneMC - pY * sinT;
  const r21 = pZ * pY * oneMC + pX * sinT;
  const r22 = cosT + pZ * pZ * oneMC;

  // --- Combined matrix M = R_polar(-t) · R_yaw -----------------------------
  // R_yaw rotates the camera-space ray into world space first; then R_polar
  // un-rotates the celestial sphere. Pre-computing the product avoids doing
  // both rotations per pixel.
  const cyaw = Math.cos(camera.yaw);
  const syaw = Math.sin(camera.yaw);
  const M00 = r00 * cyaw - r02 * syaw;
  const M01 = r01;
  const M02 = r00 * syaw + r02 * cyaw;
  const M10 = r10 * cyaw - r12 * syaw;
  const M11 = r11;
  const M12 = r10 * syaw + r12 * cyaw;
  const M20 = r20 * cyaw - r22 * syaw;
  const M21 = r21;
  const M22 = r20 * syaw + r22 * cyaw;

  const maxY = Math.min(height, Math.ceil(effHorizon));
  for (let y = 0; y < maxY; y++) {
    const dy = effHorizon - y;
    if (dy <= 0) continue;
    const atmFade = Math.min(1, dy / 22);
    if (atmFade < 0.08) continue;
    const ndcY = dy / focal;

    for (let x = 0; x < width; x++) {
      const ndcX = (x - halfW) / focal;
      // Apply combined matrix to camera-space ray (ndcX, ndcY, 1)
      const vx = M00 * ndcX + M01 * ndcY + M02;
      const vy = M10 * ndcX + M11 * ndcY + M12;
      const vz = M20 * ndcX + M21 * ndcY + M22;
      // Normalize to unit vector (so the hash is invariant to ray length)
      const invL = 1 / Math.sqrt(vx * vx + vy * vy + vz * vz);
      const aQ = (vx * invL * Q) | 0;
      const bQ = (vy * invL * Q) | 0;
      const cQ = (vz * invL * Q) | 0;
      // Pack 3 quantised components into a 2-arg hash
      const h = hash2(aQ + cQ * 1009, bQ);
      if (h < 0.996) continue;

      const star = (h - 0.996) / 0.004;
      const brightness = baseIntensity * star * atmFade;
      const i = (y * width + x) * 4;
      data[i] = Math.min(255, data[i] + brightness);
      data[i + 1] = Math.min(255, data[i + 1] + brightness * 0.97);
      data[i + 2] = Math.min(255, data[i + 2] + brightness * 0.93);
    }
  }
}
