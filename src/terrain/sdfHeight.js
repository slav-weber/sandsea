import { hash2, vnoise } from './noise.js';

const TAU = Math.PI * 2;

/**
 * CPU mirror of the GLSL `heightAt` in glPipeline.js. Bit-equivalent at every
 * query point — same hashes, same dune bell math, same base undulation, same
 * canyon carve. Use for game logic that needs to know "what height is the
 * ground at (x, z)?" — NPC walking, collision, spawn placement, etc.
 *
 * `params` is the same object the shader's uniforms come from: cellSize,
 * emptyRate, duneLengthMin/Max, duneHeightMin/Max, seed.
 */
// Handcrafted spawn landmarks — CPU mirror of spawnFeatures() in the GLSL
// heightAt (src/render/glPipeline.js). MUST stay byte-identical (same
// constants, same math) or collision (CPU) drifts from the rendered ground.
const PIT_CX = 40, // pond — east
  PIT_CZ = -6,
  PIT_R = 13,
  PIT_DEPTH = 5.5;
const HILL_CX = -34, // hill+overhang — south-west
  HILL_CZ = -24,
  HILL_R = 22,
  HILL_H = 14;

export function spawnFeatures(x, z) {
  let d = 0;
  const rp = Math.hypot(x - PIT_CX, z - PIT_CZ) / PIT_R;
  if (rp < 1) { const b = 1 - rp * rp; d -= PIT_DEPTH * b * b; }
  const rh = Math.hypot(x - HILL_CX, z - HILL_CZ) / HILL_R;
  if (rh < 1) { const b = 1 - rh * rh; d += HILL_H * b * b; }
  return d;
}

// World-space position of the spawn hill top (for anchoring the overhang).
export const SPAWN_HILL = { x: HILL_CX, z: HILL_CZ };

export function heightAt(x, z, params) {
  const CS = params.cellSize;
  const emptyT = params.emptyRate / 100;
  const lMin = Math.min(params.duneLengthMin, params.duneLengthMax);
  const lMax = Math.max(params.duneLengthMin, params.duneLengthMax);
  const lRange = lMax - lMin;
  const hMin = Math.min(params.duneHeightMin, params.duneHeightMax);
  const hMax = Math.max(params.duneHeightMin, params.duneHeightMax);
  const hRange = hMax - hMin;
  const seedOff = params.seed * 17;

  const range = Math.ceil((lMax * 1.05) / CS) + 1;
  const ccxC = Math.floor(x / CS);
  const cczC = Math.floor(z / CS);

  let h = 0;
  for (let dz = -range; dz <= range; dz++) {
    const ccz = cczC + dz;
    for (let dx = -range; dx <= range; dx++) {
      const ccx = ccxC + dx;
      const r6 = hash2(ccx + 37 + seedOff, ccz + 41);
      if (r6 < emptyT) continue;
      const r1 = hash2(ccx + seedOff, ccz);
      const r2 = hash2(ccx + 7 + seedOff, ccz + 7);
      const r3 = hash2(ccx + 13 + seedOff, ccz + 17);
      const r4 = hash2(ccx + 19 + seedOff, ccz + 23);
      const r5 = hash2(ccx + 29 + seedOff, ccz + 31);
      const dCx = ccx * CS + r1 * CS;
      const dCz = ccz * CS + r2 * CS;
      const ang = r3 * TAU;
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      const len = lMin + r4 * lRange;
      const wid = (lMin + r5 * lRange) * 0.7;
      const amp = hMin + r6 * hRange;
      const asym = 0.4 + r4 * 0.6;
      const rdx = x - dCx;
      const rdz = z - dCz;
      const lrx = rdx * ca + rdz * sa;
      const lrz = -rdx * sa + rdz * ca;
      const nx = lrx / len;
      const nz = lrz / wid;
      const r2s = nx * nx + nz * nz;
      if (r2s >= 1) continue;
      let bell = 1 - r2s;
      bell = bell * bell * bell;
      if (nx > 0) {
        const drop = 1 - nx * (1 + asym);
        if (drop <= 0) continue;
        bell *= drop;
      }
      h += bell * amp;
    }
  }

  const ground =
    (Math.sin(x * 0.003) * 0.3 +
      Math.sin(z * 0.0025) * 0.3 +
      Math.sin((x + z) * 0.0017) * 0.2) *
    4;
  const ripple = (vnoise(x * 0.15, z * 0.12) - 0.5) * 1.5;

  const canyonN = vnoise(x * 0.0012, z * 0.0012);
  const canyonMask = Math.pow(Math.max(0, canyonN - 0.65), 1.5);
  const canyon = canyonMask * 25;

  return h + ground + ripple - canyon + spawnFeatures(x, z);
}

export function terrainParamsFromStore(store) {
  const s = store.get();
  return {
    cellSize: s.cellSize,
    emptyRate: s.emptyRate,
    duneLengthMin: s.duneLengthMin,
    duneLengthMax: s.duneLengthMax,
    duneHeightMin: s.duneHeightMin,
    duneHeightMax: s.duneHeightMax,
    seed: s.seed,
  };
}
