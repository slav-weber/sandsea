/**
 * Three named palettes — Noon (classic), Sunset (also used for sunrise),
 * Sandsea-Night. They double as keypoints for the day/night continuum: when
 * the cycle is on, timeOfDay smoothly blends sand and sky stops between
 * them.
 *
 * Colors are sampled from references:
 *  - Noon  : a real daytime sky gradient (deep royal blue zenith → pale
 *            near-white haze at horizon)
 *  - Sunset: dramatic evening / dawn gradient (indigo → magenta → coral →
 *            peach → cream)
 *  - Sandsea-Night: the iconic purple twilight from the 1992 Cryo "Sandsea" —
 *            mauve/violet skies, sand in cool purple tones with warm-pink
 *            highlights
 */

export const SAND_PALETTES = {
  classic: [
    '#1c0e02', '#48280e', '#7e4e1e',
    '#aa743a', '#d09a58', '#e8c078',
    '#f2d590', '#fae6b0',
  ],
  sunset: [
    '#1a0408', '#3b0e1a', '#6e1f24',
    '#a8462a', '#d97a3a', '#f0a85a',
    '#f8c878', '#fce0a0',
  ],
  duneNight: [
    '#1c0e24', '#301a36', '#46284a',
    '#5e3a5e', '#7c5070', '#9a6c84',
    '#b88a98', '#d4a8ae',
  ],
};






// NOTE: all three sky palettes must have the SAME number of stops at the same
// t positions. blendedSkyStops mixes them index by index, so a mismatch silently
// truncates the extra stops and tears the gradient during sunset/night blends.
export const SKY_PALETTES = {
  classic: [
    [0.0, [22, 65, 135]],   // deep royal blue zenith
    [0.2, [48, 100, 165]],
    [0.4, [88, 138, 195]],
    [0.6, [140, 180, 215]],
    [0.8, [190, 215, 230]],
    [1.0, [225, 235, 240]], // pale haze near horizon
  ],
  sunset: [
    [0.0, [44, 18, 100]],   // deep indigo zenith
    [0.2, [86, 26, 117]],
    [0.4, [161, 54, 126]],  // magenta
    [0.6, [218, 116, 117]], // coral
    [0.8, [241, 176, 139]], // peach
    [1.0, [245, 220, 175]], // pale cream horizon
  ],



  duneNight: [
    [0.0, [28, 18, 52]],
    [0.2, [28, 18, 52]],
    [0.4, [28, 18, 52]],
    [0.6, [28, 18, 52]],
    [0.8, [28, 18, 52]],
    [1.0, [28, 18, 52]],
  ],
};

// --- Small color utils ----------------------------------------------------

export function hexRgb(h) {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function mixRgb(a, b, t) {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

// --- Sand ramp ------------------------------------------------------------

export function buildSandRamp(hexStops, n = 64) {
  return buildSandRampFromRgb(hexStops.map(hexRgb), n);
}

function buildSandRampFromRgb(stops, n) {
  const pal = new Uint8ClampedArray(n * 3);
  const m = stops.length - 1;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const seg = Math.min(m - 1, Math.floor(t * m));
    const lt = t * m - seg;
    const c = mixRgb(stops[seg], stops[seg + 1], lt);
    pal[i * 3] = c[0];
    pal[i * 3 + 1] = c[1];
    pal[i * 3 + 2] = c[2];
  }
  return pal;
}

// --- Sky sample -----------------------------------------------------------

export function sampleSkyPalette(stops, t) {
  if (t <= 0) return stops[0][1];
  if (t >= 1) return stops[stops.length - 1][1];
  for (let i = 0; i < stops.length - 1; i++) {
    const s1 = stops[i];
    const s2 = stops[i + 1];
    if (t >= s1[0] && t <= s2[0]) {
      const lt = (t - s1[0]) / (s2[0] - s1[0]);
      return mixRgb(s1[1], s2[1], lt);
    }
  }
  return stops[0][1];
}

// --- Day/night continuum --------------------------------------------------

/**
 * Map timeOfDay ∈ [0..1] to a pair of palette names + interpolation factor.
 * 0    = midnight  (duneNight)
 * 0.25 = sunrise   (sunset palette, the same look)
 * 0.5  = noon      (classic)
 * 0.75 = sunset    (sunset)
 * 1    = midnight  (duneNight) — wraps to 0
 */
// Phase keys aligned to Izmail (45.36°N) at summer solstice. Key
// astronomical events:
//   civil dawn  ≈ 03:46  (t ≈ 0.156)
//   sunrise     ≈ 04:16  (t ≈ 0.178)
//   sunset      ≈ 19:44  (t ≈ 0.822)
//   civil dusk  ≈ 20:14  (t ≈ 0.843)
// Palette segments:
//   night            [0.92..0.13]   full dark (wraps midnight)
//   pre-sunrise glow  (0.13..0.17)   night → sunset palette
//   golden hour AM    [0.17..0.22]   sunset palette holds
//   day transition    (0.22..0.30)   sunset → classic
//   daytime          [0.30..0.70]    classic palette holds
//   day transition   (0.70..0.78)    classic → sunset
//   golden hour PM   [0.78..0.84]    sunset palette holds
//   post-sunset      (0.84..0.92)    sunset → night
const PHASE_KEYS = [
  { t: 0.00, palette: 'duneNight' },
  { t: 0.13, palette: 'duneNight' },  // 03:07
  { t: 0.17, palette: 'sunset' },     // 04:05 pre-sunrise
  { t: 0.22, palette: 'sunset' },     // 05:17 golden hour
  { t: 0.30, palette: 'classic' },    // 07:12 morning daylight
  { t: 0.70, palette: 'classic' },    // 16:48 afternoon daylight
  { t: 0.78, palette: 'sunset' },     // 18:43 golden hour
  { t: 0.84, palette: 'sunset' },     // 20:10 post-sunset
  { t: 0.92, palette: 'duneNight' },  // 22:05 deep twilight
  { t: 1.00, palette: 'duneNight' },
];

function phaseSegment(t) {
  for (let i = 0; i < PHASE_KEYS.length - 1; i++) {
    const a = PHASE_KEYS[i];
    const b = PHASE_KEYS[i + 1];
    if (t >= a.t && t <= b.t) {
      const localT = (t - a.t) / (b.t - a.t);
      const eased = localT * localT * (3 - 2 * localT);
      return { from: a.palette, to: b.palette, blend: eased };
    }
  }
  return { from: 'duneNight', to: 'duneNight', blend: 0 };
}

export function blendedSandStops(t) {
  const { from, to, blend } = phaseSegment(t);
  const a = SAND_PALETTES[from].map(hexRgb);
  const b = SAND_PALETTES[to].map(hexRgb);
  return a.map((s, i) => mixRgb(s, b[i], blend));
}

export function blendedSandRamp(t, n = 64) {
  return buildSandRampFromRgb(blendedSandStops(t), n);
}

export function blendedSkyStops(t) {
  const { from, to, blend } = phaseSegment(t);
  const a = SKY_PALETTES[from];
  const b = SKY_PALETTES[to];
  const n = Math.min(a.length, b.length);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const ta = a[i][0],
      tb = b[i][0];
    out[i] = [ta + (tb - ta) * blend, mixRgb(a[i][1], b[i][1], blend)];
  }
  return out;
}
