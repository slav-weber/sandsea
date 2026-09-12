import { hash2 } from './noise.js';
import { heightAt } from './sdfHeight.js';

/**
 * Procedurally-placed 3D solid features (arches, overhanging rocks) that
 * compose with the heightfield via min() in the scene SDF. Placement is
 * grid-cell based + hashed by seed so it's stable across frames and
 * regenerates when seed changes.
 *
 * Each feature is uploaded to the shader as a vec4 (xyz=anchor position,
 * w=scale). Type is encoded in the integer part of w·10 for now; the shader
 * dispatches on it.
 *
 * Anchored to ground via heightAt — the CPU mirror of the GLSL heightfield
 * — so features sit ON the terrain instead of floating or burying.
 */

const CELL = 220;          // feature grid cell size in world units
const WINDOW_R = 380;      // radius around camera to consider
const CHANCE = 0.07;       // per-cell probability of a feature
const MAX_FEATURES = 16;   // matches MAX_SOLIDS in the shader

// Types — keep in sync with the shader's type dispatch.
const TYPE_ARCH  = 0;
const TYPE_SPIRE = 1;

const CAVE_CELL = 280;
const CAVE_CHANCE = 0.10;
const CAVE_WINDOW_R = 320;
const MAX_CAVES = 8;

/**
 * Cave volumes — sphere primitives carved out of the scene. Placed on a
 * grid similar to solids; each cave is anchored slightly INTO a dune so
 * its top half pokes out as a visible entrance.
 */
export function listVisibleCaves(camera, params) {
  const seedOff = params.seed * 17 + 7777;
  const ccxC = Math.floor(camera.x / CAVE_CELL);
  const cczC = Math.floor(camera.z / CAVE_CELL);
  const range = Math.ceil(CAVE_WINDOW_R / CAVE_CELL) + 1;

  const out = [];
  const r2max = CAVE_WINDOW_R * CAVE_WINDOW_R;

  for (let dz = -range; dz <= range && out.length < MAX_CAVES; dz++) {
    for (let dx = -range; dx <= range && out.length < MAX_CAVES; dx++) {
      const ccx = ccxC + dx;
      const ccz = cczC + dz;
      const r0 = hash2(ccx + 51 + seedOff, ccz + 89);
      if (r0 < 1 - CAVE_CHANCE) continue;

      const r1 = hash2(ccx + 211 + seedOff, ccz + 313);
      const r2 = hash2(ccx + 419 + seedOff, ccz + 521);
      const r3 = hash2(ccx + 619 + seedOff, ccz + 727);

      const x = ccx * CAVE_CELL + r1 * CAVE_CELL;
      const z = ccz * CAVE_CELL + r2 * CAVE_CELL;

      const ddx = x - camera.x;
      const ddz = z - camera.z;
      if (ddx * ddx + ddz * ddz > r2max) continue;

      const groundH = heightAt(x, z, params);
      // Only place a cave if the ground here is meaningfully above lowland —
      // a cave in flat sand isn't a cave, it's a pit.
      if (groundH < 4) continue;

      const radius = 6 + r3 * 6; // 6..12
      // Center the cave 1.5 below the surface so the top half pokes out
      // as a visible entrance opening.
      const y = groundH - radius * 0.5;
      out.push({ x, y, z, w: radius });
    }
  }
  return out;
}

export function listVisibleSolids(camera, params) {
  const seedOff = params.seed * 17;
  const ccxC = Math.floor(camera.x / CELL);
  const cczC = Math.floor(camera.z / CELL);
  const range = Math.ceil(WINDOW_R / CELL) + 1;

  const out = [];
  const r2max = WINDOW_R * WINDOW_R;

  for (let dz = -range; dz <= range && out.length < MAX_FEATURES; dz++) {
    for (let dx = -range; dx <= range && out.length < MAX_FEATURES; dx++) {
      const ccx = ccxC + dx;
      const ccz = cczC + dz;
      // Occupancy gate.
      const r0 = hash2(ccx + 211 + seedOff, ccz + 313);
      if (r0 < 1 - CHANCE) continue;

      // Position within cell + properties.
      const r1 = hash2(ccx + 401 + seedOff, ccz + 503);
      const r2 = hash2(ccx + 601 + seedOff, ccz + 701);
      const r3 = hash2(ccx + 809 + seedOff, ccz + 907);
      const r4 = hash2(ccx + 1009 + seedOff, ccz + 1103);
      const r5 = hash2(ccx + 1213 + seedOff, ccz + 1307);

      const x = ccx * CELL + r1 * CELL;
      const z = ccz * CELL + r2 * CELL;

      const ddx = x - camera.x;
      const ddz = z - camera.z;
      if (ddx * ddx + ddz * ddz > r2max) continue;

      const type  = r3 < 0.6 ? TYPE_ARCH : TYPE_SPIRE;
      const scale = 0.7 + r4 * 0.8;
      // Rotation angle in [0, 2π) — only meaningful for arches but cheap to
      // store for everyone. Pass through a separate vec4 component.
      const rot   = r5 * Math.PI * 2;

      const groundH = heightAt(x, z, params);
      const y = groundH;

      // w packs type (×100) + scale (×10, fractional).
      const packed = type * 100 + scale * 10;
      out.push({ x, y, z, w: packed, rot });
    }
  }
  return out;
}
