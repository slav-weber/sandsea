import { hash2 } from './noise.js';
import { heightAt } from './sdfHeight.js';

/**
 * Procedural single-cave generator. Produces ONE deep, randomly-branching
 * cave near the spawn point (world origin) as a graph of tapered capsules
 * (round-cone segments). The cave is carved out of the scene by the shader
 * via max(scene, -caveSDF); here we only build the skeleton.
 *
 * Determinism: everything derives from `caveSeed` through a small
 * counter-based RNG built on hash2 — same seed + same gen params ⇒ same cave.
 * The world itself (WORLD_SEED, dune shape) is untouched: the cave only
 * subtracts empty space.
 *
 * The SDF math here (tapered capsule + polynomial smin) is a CPU MIRROR of
 * the GLSL in glPipeline.js — keep the two byte-for-byte equivalent so the
 * floor-collision (CPU) and the rendered walls (GPU) agree.
 */

export const MAX_CAVE_SEGS = 64; // must equal the shader's MAX_CAVE_SEGS
export const CAVE_SMIN_K = 3.0; // smooth-union blend radius (gallery junctions)

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;

// Counter-based RNG: each call hashes (seed, counter++) → [0,1). Stable and
// order-dependent, which is exactly what we want for reproducible growth.
function makeRng(seed) {
  let i = 0;
  return () => hash2((seed | 0) + 1013, (i++ * 2654435761) | 0);
}

// Direction from yaw (around Y, 0→+Z) and pitch (+ up). Matches the camera
// convention used elsewhere so headings read intuitively.
function dirFrom(yaw, pitch) {
  const cp = Math.cos(pitch);
  return { x: cp * Math.sin(yaw), y: Math.sin(pitch), z: cp * Math.cos(yaw) };
}

// --- SDF mirror ------------------------------------------------------------
// Tapered capsule: closest-point distance minus linearly-interpolated radius.
// Not an exact round-cone SDF (slightly conservative on the slant) but cheap,
// well-behaved for carving, and trivially identical between CPU and GLSL.
function taperedCapsule(px, py, pz, ax, ay, az, ar, bx, by, bz, br) {
  const pax = px - ax, pay = py - ay, paz = pz - az;
  const bax = bx - ax, bay = by - ay, baz = bz - az;
  const baLen2 = bax * bax + bay * bay + baz * baz;
  const h = baLen2 > 1e-6
    ? clamp((pax * bax + pay * bay + paz * baz) / baLen2, 0, 1)
    : 0;
  const dx = pax - bax * h, dy = pay - bay * h, dz = paz - baz * h;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) - lerp(ar, br, h);
}

function sminCpu(a, b, k) {
  const hh = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - hh * hh * k * 0.25;
}

/**
 * Signed distance to the cave void at a world point. Negative = inside the
 * hollow, positive = in solid rock. Pass the `cave` object from generateCave.
 */
export function caveSdfCpu(x, y, z, cave) {
  const segs = cave.segments;
  let d = 1e9;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const sd = taperedCapsule(x, y, z, s.ax, s.ay, s.az, s.ar, s.bx, s.by, s.bz, s.br);
    d = sminCpu(d, sd, CAVE_SMIN_K);
  }
  return d;
}

/**
 * Standing floor of the cave below a given column, or null if the player
 * isn't on a walkable cave floor here. Used by game-mode camera collision so
 * walking down the entrance ramp follows the cave floor smoothly.
 *
 * `eyeY` is the camera's current eye height — needed to disambiguate two
 * cases that share a column: standing on SOLID ground that happens to have a
 * buried tunnel far below (must NOT drop in) vs. actually being inside the
 * cave (follow the floor). We only engage the cave floor when the surface is
 * carved open here (a mouth) or the camera is already below the surface.
 */
export function caveFloorAt(x, z, cave, params, eyeY) {
  if (!cave || cave.segments.length === 0) return null;
  // Horizontal early-out: outside the cave footprint there is nothing.
  const b = cave.bounds;
  const ddx = x - b.cx, ddz = z - b.cz;
  if (ddx * ddx + ddz * ddz > (b.r + 2) * (b.r + 2)) return null;

  const surfaceH = heightAt(x, z, params);
  const openHere = caveSdfCpu(x, surfaceH - 0.3, z, cave) < 0; // surface mouth
  const inside = eyeY < surfaceH - 0.2;                        // already underground
  if (!openHere && !inside) return null;

  const bottom = b.bottomY - 2.0;
  const STEP = 0.75;
  // Search from just above the relevant void: the eye (if inside) or the
  // surface (at a mouth). Find the topmost void at/below that, then its floor.
  const scanTop = inside ? Math.min(eyeY, surfaceH) + 1.0 : surfaceH + 0.5;

  let y = scanTop;
  let foundVoid = false;
  for (; y >= bottom; y -= STEP) {
    if (caveSdfCpu(x, y, z, cave) < 0) { foundVoid = true; break; }
  }
  if (!foundVoid) return null;
  for (; y >= bottom; y -= STEP) {
    if (caveSdfCpu(x, y, z, cave) >= 0) return y + STEP * 0.5;
  }
  return bottom;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/**
 * Build the cave. `params` carries terrain params (for surface anchoring) plus
 * the cave knobs: caveSeed, caveDepth(0..1), caveBranching(0..1),
 * caveRadiusMin, caveRadiusMax, caveEntrances(1..4).
 *
 * Returns { segments:[{ax,ay,az,ar, bx,by,bz,br}], bounds, entrances }.
 */
export function generateCave(params) {
  const rng = makeRng(params.caveSeed ?? 1);
  const depth01 = clamp(params.caveDepth ?? 0.5, 0, 1);
  const branchP = lerp(0.06, 0.5, clamp(params.caveBranching ?? 0.4, 0, 1));
  const rMin = clamp(params.caveRadiusMin ?? 3, 1.5, 12);
  const rMax = Math.max(rMin + 0.5, clamp(params.caveRadiusMax ?? 8, 2, 16));
  const entrances = clamp(Math.round(params.caveEntrances ?? 2), 1, 4);

  const maxDepthM = lerp(16, 48, depth01); // how far below the surface it sinks
  const minCover = 3.0; // keep ≥3m of rock above the void (except at mouths)

  const rampSteps = 5;
  // Reserve budget so ramp + main growth + extra-entrance tunnels all fit
  // inside MAX_CAVE_SEGS (the shader's hard cap).
  const entranceReserve = (entrances - 1) * 5;
  const targetSegs = Math.min(
    Math.round(lerp(24, 46, depth01)),
    MAX_CAVE_SEGS - rampSteps - entranceReserve,
  );

  const segments = [];
  const nodes = []; // visited positions, for siting extra entrances
  const entranceList = [];

  const push = (ax, ay, az, ar, bx, by, bz, br) => {
    if (segments.length >= MAX_CAVE_SEGS) return false;
    segments.push({ ax, ay, az, ar, bx, by, bz, br });
    return true;
  };

  // --- Main entrance near spawn (origin) -----------------------------------
  // Biased to the NORTH sector (+Z, straight ahead at spawn) so the cave sits
  // apart from the other spawn landmarks (pond to the east, hill to the SW).
  const a0 = Math.PI / 2 + (rng() - 0.5) * 1.4; // north ±40°
  const dist = 30 + rng() * 18; // 30..48 m from origin
  const ex = Math.cos(a0) * dist;
  const ez = Math.sin(a0) * dist;
  const surfaceH = heightAt(ex, ez, params);
  entranceList.push({ x: ex, y: surfaceH, z: ez });

  // Ramp heads outward (further north, away from spawn) on a gentle descent.
  let yaw = a0 + (rng() - 0.5) * 0.8;
  let pitch = -20 * DEG;
  // Moderate mouth radius (keeps the surface mound small); the centerline
  // sits ~one radius ABOVE the surface so the tunnel FLOOR starts level with
  // the ground — you step onto a ramp that descends smoothly, no lip drop.
  let radius = lerp(rMin, rMax, 0.5);
  let cx = ex, cy = surfaceH + radius * 0.85, cz = ez;

  for (let i = 0; i < rampSteps; i++) {
    const segLen = 9 + rng() * 3;
    const d = dirFrom(yaw, pitch);
    const nx = cx + d.x * segLen;
    const ny = cy + d.y * segLen;
    const nz = cz + d.z * segLen;
    // Widen toward gallery size as we sink below ground.
    const nr = lerp(radius, rMax, 0.5);
    if (!push(cx, cy, cz, radius, nx, ny, nz, nr)) break;
    cx = nx; cy = ny; cz = nz; radius = nr;
    nodes.push({ x: cx, y: cy, z: cz });
    // ease the descent toward horizontal as we reach gallery depth
    pitch = lerp(pitch, -10 * DEG, 0.4);
    yaw += (rng() - 0.5) * 0.4;
  }

  // --- Branching growth ----------------------------------------------------
  // A small stack of growth heads. Each extends a passage with smooth random
  // turns, varying radius (wide galleries ↔ narrow squeezes), and occasional
  // branches. A depth-band bias produces real descents and climbs.
  const heads = [{ x: cx, y: cy, z: cz, yaw, pitch, radius, life: 12 }];

  let guard = 0;
  while (segments.length < targetSegs && guard++ < 6000) {
    if (heads.length === 0) {
      // Frontier emptied before reaching the target length — re-seed a fresh
      // passage from a random already-carved node so the cave keeps growing
      // to its full size with extra interconnections.
      if (nodes.length === 0) break;
      const seed = nodes[Math.floor(rng() * nodes.length)];
      heads.push({
        x: seed.x, y: seed.y, z: seed.z,
        yaw: rng() * TAU, pitch: (rng() - 0.5) * 0.5,
        radius: lerp(rMin, rMax, rng()), life: 5 + Math.floor(rng() * 6),
      });
    }
    const head = heads[heads.length - 1];
    if (head.life <= 0) { heads.pop(); continue; }

    const segLen = 8 + rng() * 6;
    // Smooth random turn.
    head.yaw += (rng() - 0.5) * 1.1;
    head.pitch += (rng() - 0.5) * 0.5;

    // Depth-band bias: stay between surface-minCover and surface-maxDepth.
    const localSurf = heightAt(head.x, head.z, params);
    const ceil = localSurf - minCover;
    const floor = localSurf - maxDepthM;
    if (head.y > ceil) head.pitch -= 0.35; // too shallow → dig down
    else if (head.y < floor) head.pitch += 0.35; // too deep → climb
    head.pitch = clamp(head.pitch, -55 * DEG, 40 * DEG);

    const d = dirFrom(head.yaw, head.pitch);
    const nx = head.x + d.x * segLen;
    let ny = head.y + d.y * segLen;
    const nz = head.z + d.z * segLen;
    // Hard ceiling clamp so a passage never accidentally surfaces mid-run.
    const nSurf = heightAt(nx, nz, params);
    if (ny > nSurf - minCover) ny = nSurf - minCover;

    // Radius random walk, with occasional gallery bulges.
    let nr = clamp(head.radius + (rng() - 0.5) * 3.0, rMin, rMax);
    if (rng() < 0.12) nr = rMax; // gallery
    if (rng() < 0.10) nr = rMin; // squeeze

    if (!push(head.x, head.y, head.z, head.radius, nx, ny, nz, nr)) break;
    head.x = nx; head.y = ny; head.z = nz; head.radius = nr;
    head.life -= 1;
    nodes.push({ x: nx, y: ny, z: nz });

    // Spawn a branch.
    if (rng() < branchP && heads.length < 8 && segments.length < targetSegs - 2) {
      heads.push({
        x: head.x, y: head.y, z: head.z,
        yaw: head.yaw + (rng() < 0.5 ? 1 : -1) * (0.7 + rng() * 0.8),
        pitch: head.pitch + (rng() - 0.5) * 0.6,
        radius: clamp(head.radius * (0.7 + rng() * 0.3), rMin, rMax),
        life: 4 + Math.floor(rng() * 5),
      });
    }
  }

  // --- Extra entrances/exits ----------------------------------------------
  // Raise short rising tunnels from peripheral nodes up to the surface so the
  // cave breathes through several mouths.
  for (let e = 1; e < entrances && nodes.length > 0 && segments.length < MAX_CAVE_SEGS - 4; e++) {
    const pick = nodes[Math.floor(rng() * nodes.length)];
    let hx = pick.x, hy = pick.y, hz = pick.z;
    const eyaw = rng() * TAU;
    const ed = dirFrom(eyaw, 0);
    const r = lerp(rMin, rMax, 0.6);
    for (let i = 0; i < 5; i++) {
      const segLen = 7 + rng() * 3;
      const nx = hx + ed.x * segLen * 0.6;
      const nz = hz + ed.z * segLen * 0.6;
      const surf = heightAt(nx, nz, params);
      // Rise toward the surface; final segment pokes through to open a mouth.
      const ny = Math.min(hy + segLen * 0.7, surf + r * 0.5);
      if (!push(hx, hy, hz, r, nx, ny, nz, r)) break;
      hx = nx; hy = ny; hz = nz;
      if (ny >= surf) { entranceList.push({ x: nx, y: surf, z: nz }); break; }
    }
  }

  // --- Bounds (enclosing sphere) for shader/CPU early-out -----------------
  let minX = 1e9, minY = 1e9, minZ = 1e9, maxX = -1e9, maxY = -1e9, maxZ = -1e9, maxR = 0;
  for (const s of segments) {
    minX = Math.min(minX, s.ax - s.ar, s.bx - s.br);
    minY = Math.min(minY, s.ay - s.ar, s.by - s.br);
    minZ = Math.min(minZ, s.az - s.ar, s.bz - s.br);
    maxX = Math.max(maxX, s.ax + s.ar, s.bx + s.br);
    maxY = Math.max(maxY, s.ay + s.ar, s.by + s.br);
    maxZ = Math.max(maxZ, s.az + s.ar, s.bz + s.br);
    maxR = Math.max(maxR, s.ar, s.br);
  }
  const cxB = (minX + maxX) * 0.5, cyB = (minY + maxY) * 0.5, czB = (minZ + maxZ) * 0.5;
  // Radius = half-diagonal of the AABB + smin slack.
  const r = 0.5 * Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2 + (maxZ - minZ) ** 2) + CAVE_SMIN_K + 1;
  const bounds = { cx: cxB, cy: cyB, cz: czB, r, bottomY: minY };

  return { segments, bounds, entrances: entranceList };
}
