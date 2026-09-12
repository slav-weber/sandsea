/**
 * Pixel-art sun in the style of the 1992 Cryo "Sandsea" — a single solid disc
 * with crisp pixel edges (no anti-aliasing) and a stepped halo. Position is
 * world-anchored: projected through the camera's yaw/pitch each frame, so
 * the sun moves correctly across the sky as you look around.
 *
 * the desert has one sun (Canopus / Alpha Carinae in Herbert's canon), so we
 * draw exactly one.
 */

// Disc size in canvas pixels. On the 320×180 framebuffer this is ~5% of
// width — visible but not oppressive. Gets sharpened by image-rendering:
// pixelated when the canvas is scaled up.
const CORE_R = 8;
const HALO_R = 18;

// Ring widths for the stepped halo. Each "step" is 1..2 px wide and gets a
// quantized opacity, so the halo reads as concentric bands instead of a
// smooth gradient — that's what makes it look pixel-art.
const HALO_STEP_W = 2;

/**
 * Smooth-step the sun's core color through the day. Disc is one solid color
 * (no per-pixel gradient inside it) — the color CHANGES through the cycle.
 */
function sunCoreColor(elev) {
  // Stops by elevation (-y of sun direction)
  //   ≥ 0.6 : noon-white
  //   ≈ 0.3 : golden yellow
  //   ≈ 0.08: deep orange (low sun)
  //   ≤ 0.0 : sunset red (about to set)
  const stops = [
    { e: 0.6, c: [255, 248, 210] },
    { e: 0.3, c: [255, 222, 130] },
    { e: 0.08, c: [255, 158, 70] },
    { e: 0.0, c: [232, 96, 56] },
  ];
  return sampleStops(stops, elev);
}

function haloColor(elev) {
  const stops = [
    { e: 0.6, c: [255, 230, 160] },
    { e: 0.3, c: [255, 180, 90] },
    { e: 0.08, c: [240, 120, 60] },
    { e: 0.0, c: [200, 70, 40] },
  ];
  return sampleStops(stops, elev);
}

function sampleStops(stops, elev) {
  if (elev >= stops[0].e) return stops[0].c;
  if (elev <= stops[stops.length - 1].e) return stops[stops.length - 1].c;
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i],
      b = stops[i + 1];
    if (elev <= a.e && elev >= b.e) {
      const t = (a.e - elev) / (a.e - b.e);
      return [a.c[0] + (b.c[0] - a.c[0]) * t, a.c[1] + (b.c[1] - a.c[1]) * t, a.c[2] + (b.c[2] - a.c[2]) * t];
    }
  }
  return stops[0].c;
}

export function drawSun(data, width, height, camera, sun, effHorizon) {
  // Below horizon (and a small margin so it visibly sets and rises).
  if (sun.dir[1] <= -0.08) return;

  const sinY = Math.sin(camera.yaw);
  const cosY = Math.cos(camera.yaw);

  // Sun direction → camera-local space (inverse yaw rotation around Y).
  const sxL = sun.dir[0] * cosY - sun.dir[2] * sinY;
  const syL = sun.dir[1];
  const szL = sun.dir[0] * sinY + sun.dir[2] * cosY;

  // Behind camera (or grazing).
  if (szL <= 0.05) return;

  // Pinhole projection. Round to integer so the disc snaps to whole pixels
  // — that's what makes the edge crisp and prevents shimmering jitter.
  const sx = Math.round((sxL / szL) * camera.focal + width / 2);
  const sy = Math.round(effHorizon - (syL / szL) * camera.focal);

  const elev = sun.dir[1];
  const [cr, cg, cb] = sunCoreColor(elev);
  const [hr, hg, hb] = haloColor(elev);

  // Fade halo while the sun is hanging right at the horizon — keeps the
  // disc visible but cleans up the glow during sunrise/sunset transitions.
  const haloIntensity = elev < 0.0 ? Math.max(0, (elev + 0.08) / 0.08) : 1;

  const yMin = Math.max(0, sy - HALO_R);
  const yMax = Math.min(height - 1, sy + HALO_R);
  const xMin = Math.max(0, sx - HALO_R);
  const xMax = Math.min(width - 1, sx + HALO_R);
  if (yMin > yMax || xMin > xMax) return;

  const coreR2 = CORE_R * CORE_R;
  const haloR2 = HALO_R * HALO_R;

  for (let py = yMin; py <= yMax; py++) {
    const dy = py - sy;
    const dy2 = dy * dy;
    for (let px = xMin; px <= xMax; px++) {
      const dx = px - sx;
      const d2 = dx * dx + dy2;
      if (d2 > haloR2) continue;

      const i = (py * width + px) * 4;

      if (d2 <= coreR2) {
        // Solid disc — no anti-aliasing, no per-pixel gradient
        data[i] = cr;
        data[i + 1] = cg;
        data[i + 2] = cb;
        continue;
      }

      // Stepped halo: quantize distance into discrete rings and assign a
      // fixed alpha per ring.
      const d = Math.sqrt(d2);
      const step = Math.floor((d - CORE_R) / HALO_STEP_W);
      const maxSteps = Math.ceil((HALO_R - CORE_R) / HALO_STEP_W);
      const a = ((maxSteps - step) / maxSteps) * 0.55 * haloIntensity;
      if (a <= 0) continue;

      const keep = 1 - a;
      data[i] = Math.min(255, data[i] * keep + hr * a);
      data[i + 1] = Math.min(255, data[i + 1] * keep + hg * a);
      data[i + 2] = Math.min(255, data[i + 2] * keep + hb * a);
    }
  }
}
