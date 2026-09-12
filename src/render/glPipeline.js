import {
  SAND_PALETTES,
  SKY_PALETTES,
  blendedSkyStops,
  buildSandRamp,
  blendedSandRamp,
} from '../config/palettes.js';

/**
 * GPU SDF raymarch renderer. Mirrors the public surface of RenderPipeline
 * (render / invalidateSky / invalidateSand / setNightLevel) so it drops
 * into main.js without touching the rest of the app.
 *
 * M1 scope: bootstraps WebGL2, palette LUT textures, full-screen quad,
 * sphere-traced placeholder heightfield + sky gradient + palette quant.
 * Subsequent milestones port real dunes/sun/shadows/caves into the shader.
 */

const SAND_N = 64;
const SKY_N = 64;

const EMPTY_WEATHER = Object.freeze({
  cloudCover: 0,
  rainIntensity: 0,
  surfaceWetness: 0,
  dustIntensity: 0,
  lightningFlash: 0,
  stormness: 0,
  sunVisibility: 1,
  cloudAltitudeM: 3000,
  cloudScale: 800,
  cloudMorphSpeed: 0.04,
  windDirX: 1,
  windDirZ: 0,
  windSpeed: 0,
});

const VERT_SRC = `#version 300 es
in vec2 aPos;
void main() {
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

const FRAG_SRC = `#version 300 es
precision highp float;
precision highp int;
out vec4 fragColor;

uniform vec2  uRes;
uniform vec3  uEye;
uniform float uYaw;
uniform float uPitch;
uniform float uTanHalfFov;
uniform float uFocal;
uniform vec3  uSunDir;
uniform sampler2D uSandPal;
uniform sampler2D uSkyPal;
uniform float uSkyBands;
uniform float uSkyHeight;
uniform float uTime;

// Sandsea field params (mirror src/state/defaults.js + UI sliders)
uniform float uCellSize;
uniform float uEmptyRate;
uniform float uDuneLengthMin;
uniform float uDuneLengthMax;
uniform float uDuneHeightMin;
uniform float uDuneHeightMax;
uniform int   uSeed;

// Stars
uniform float uNightLevel;
uniform float uStarsEnabled;
uniform mat3  uPolarMat;

// Sun disc (projected on CPU each frame). Radius is computed from camera
// focal length and the real solar angular diameter (0.53°) so the disc
// is in correct angular scale at any FOV.
uniform vec2  uSunScreen;
uniform float uSunVisible;
uniform vec3  uSunCore;
uniform vec3  uSunHalo;
uniform float uSunHaloAlpha;
uniform float uSunCoreR;   // pixels
uniform float uSunHaloR;   // pixels

// Weather uniforms. Clouds rendered as a 2D fbm layer projected onto a
// cylindrical sky shell at uCloudAltitude metres; alpha-composited over
// the sky and sun. Sun visibility through clouds is computed CPU-side
// (one sample at the sun's screen direction) and passed as uSunVisibility
// — drives both directional light dimming and ambient brightening.
uniform float uCloudCover;
uniform float uRainIntensity;
uniform float uWetness;
uniform float uDustIntensity;
uniform float uLightning;
uniform float uStormness;
uniform float uSunVisibility;
uniform float uCloudAltitude;    // metres
uniform float uCloudScale;       // metres per noise unit
uniform float uCloudMorphSpeed;
uniform vec2  uCloudWind;        // metres/s, drift of noise field
uniform float uFog;              // 0..1 distance-fog intensity

// Lightning bolt — projected to screen on CPU. Each vec4 is
// (sx, sy, depth, valid). Up to MAX_BOLT_PTS in a single bolt
// (main channel + branches separated by invalid points).
#define MAX_BOLT_PTS 48
uniform int   uBoltCount;
uniform vec4  uBolt2D[MAX_BOLT_PTS];
uniform vec3  uBoltLight;        // world-space midpoint of bolt
uniform float uBoltIntensity;    // 0 = no bolt, 1 = peak flash
uniform vec3  uBoltColor;        // bolt channel + light tint

// Rain — true 3D particle system. Drops delivered via a 100×100
// RGBA32F texture = 10000 max drops, far beyond what a uniform array
// could hold. Each texel = one drop (xyz position, w = per-drop vy).
#define RAIN_TEX_SIZE 100
#define MAX_RAIN_DROPS 10000
uniform int   uRainDropCount;
uniform sampler2D uRainDropsTex;
uniform vec3  uRainVelocity;
uniform vec3  uRainColor;
uniform float uRainAlpha;
uniform float uRainLengthMul;
uniform float uRainWidthMul;
// Kept as an unused leftover so we don't churn the uniform layout.
uniform float uRainWindX;

vec4 fetchRainDrop(int i) {
  int x = i - (i / RAIN_TEX_SIZE) * RAIN_TEX_SIZE;
  int y = i / RAIN_TEX_SIZE;
  return texelFetch(uRainDropsTex, ivec2(x, y), 0);
}

// NPCs — sphere primitives. xyz = world position, w = radius.
// Animated on CPU each frame; up to MAX_NPCS visible at once.
#define MAX_NPCS 16
uniform int   uNpcCount;
uniform vec4  uNpcs[MAX_NPCS];
uniform vec3  uNpcColor;

// Solid 3D features (arches, overhanging rocks) — anchored to terrain on
// CPU, queried as true 3D SDF here. Combined with heightfield via min(),
// giving overhangs/arches that the heightfield alone can't express.
// xyz = anchor position; w packs type + scale (see solids.js).
#define MAX_SOLIDS 16
uniform int   uSolidCount;
uniform vec4  uSolids[MAX_SOLIDS];
uniform float uSolidRot[MAX_SOLIDS];
uniform vec3  uSolidColor;

// Editor-placed objects — proxy primitives (box / sphere / capsule) folded into
// solidSDF so they trace, shade and occlude exactly like procedural solids, but
// with a per-instance colour. xyz = ground anchor, w = scale; kind picks proxy.
#define MAX_PLACE 24
uniform int   uPlaceCount;
uniform vec4  uPlace[MAX_PLACE];
uniform float uPlaceKind[MAX_PLACE];
uniform vec3  uPlaceColor[MAX_PLACE];
uniform float uSpawnPlateauY;   // heightfield height at the spawn hill top (CPU)

// Cave carved into the scene via subtraction (max(scene, -caveSDF)).
// A single branching cave near spawn, represented as a graph of tapered
// capsules (round-cone segments) smooth-min unioned. uCaveSegA/B are the
// segment endpoints (xyz + radius). uCaveBounds is the bounding sphere
// (xyz + radius) used as an early-out so the rest of the world skips the
// capsule loop entirely. Mirrors src/terrain/cave.js.
#define MAX_CAVE_SEGS 64
uniform int   uCaveSegCount;
uniform vec4  uCaveSegA[MAX_CAVE_SEGS];
uniform vec4  uCaveSegB[MAX_CAVE_SEGS];
uniform vec4  uCaveBounds;        // xyz = center, w = radius
uniform vec3  uCaveColor;         // rock wall albedo

// Camera light ("flashlight"). uLightMode: 0=off, 1=cone, 2=soft omni,
// 3=cone+soft. Lets the player see inside the unlit cave.
uniform int   uLightMode;
uniform float uLightRange;        // metres — soft falloff distance
uniform vec3  uLightColor;

// --- Interactive effects (driven from main.js) ---------------------------
uniform float uHeatHaze;          // 0..1 — sand mirage / shimmer strength
// Echolocation ping: an expanding shell of light from uEchoOrigin.
uniform vec3  uEchoOrigin;
uniform float uEchoAge;           // seconds since ping; <0 = inactive
// Thrown glow orbs — point lights resting in the world.
#define MAX_ORBS 8
uniform int   uOrbCount;
uniform vec4  uOrbs[MAX_ORBS];    // xyz = position, w = radius
uniform vec3  uOrbColor;
// Cave sense: x-ray glow revealing the cave through rock.
uniform float uCaveSense;         // 0 or 1
// Sandsea resonance: an expanding ripple across the heightfield.
uniform vec2  uResonOrigin;
uniform float uResonAge;          // seconds since trigger; <0 = inactive

// Cutscene hero — a small capsule humanoid traced only while the intro plays.
// uHeroVisible gates the whole pass to zero cost during normal gameplay.
uniform float uHeroVisible;       // 0 or 1
uniform vec3  uHeroPos;           // feet position (world)
uniform float uHeroYaw;           // facing, radians
uniform float uHeroPhase;         // walk-cycle phase, radians
uniform float uHeroFall;          // 0 = upright/walking .. 1 = collapsed
uniform vec3  uHeroColor;         // cloak albedo


const float AMBIENT     = 0.125;
const float DIRECTIONAL = 0.75;
const float MAX_DIST    = 4000.0;
const int   MAX_STEPS   = 192;
const float TAU         = 6.28318530718;

// ---------------------------------------------------------------------------
// Noise — bit-exact port of src/terrain/noise.js
// ---------------------------------------------------------------------------

float hash2(int xi, int zi) {
  // JS does ((x|0)*A + (z|0)*B) | 0 — that's signed-i32 wrap-around, which
  // matches uint32 multiply/add/xor exactly for the bits we read at the end.
  uint x = uint(xi);
  uint z = uint(zi);
  uint n = x * 374761393u + z * 668265263u;
  n = (n ^ (n >> 13u)) * 1274126177u;
  n = n ^ (n >> 16u);
  return float(n & 65535u) / 65535.0;
}

float vnoise(vec2 p) {
  int ix = int(floor(p.x));
  int iz = int(floor(p.y));
  float fx = p.x - float(ix);
  float fz = p.y - float(iz);
  float h00 = hash2(ix,     iz);
  float h10 = hash2(ix + 1, iz);
  float h01 = hash2(ix,     iz + 1);
  float h11 = hash2(ix + 1, iz + 1);
  float sx = fx * fx * (3.0 - 2.0 * fx);
  float sz = fz * fz * (3.0 - 2.0 * fz);
  float a = h00 + (h10 - h00) * sx;
  float b = h01 + (h11 - h01) * sx;
  return a + (b - a) * sz;
}

// ---------------------------------------------------------------------------
// Sandsea height field — transposed bakeChunk
// ---------------------------------------------------------------------------

// Handcrafted spawn landmarks — fixed height deltas near the origin. Pure
// radial math (no hashing) so the CPU mirror in terrain/sdfHeight.js stays
// trivially identical. Single-valued, so they live in the heightfield:
//   • PIT  — a smooth waterless bowl (a future pond).
//   • HILL — a smooth dome you can walk up; its overhang lip is a separate
//            solid (spawnOverhangSDF), since an overhang is multi-valued.
// Keep these constants in sync with src/terrain/cave.js? No — with
// src/terrain/sdfHeight.js spawnFeatures().
const vec2  PIT_C   = vec2(40.0, -6.0);   // pond — east
const float PIT_R   = 13.0;
const float PIT_DEPTH = 5.5;
const vec2  HILL_C  = vec2(-34.0, -24.0); // hill+overhang — south-west
const float HILL_R  = 22.0;
const float HILL_H  = 14.0;

float spawnFeatures(vec2 p) {
  float d = 0.0;
  float rp = length(p - PIT_C) / PIT_R;
  if (rp < 1.0) { float b = 1.0 - rp * rp; d -= PIT_DEPTH * b * b; }
  float rh = length(p - HILL_C) / HILL_R;
  if (rh < 1.0) { float b = 1.0 - rh * rh; d += HILL_H * b * b; }
  return d;
}

// Sandsea resonance — a transient ripple expanding from uResonOrigin. A sine
// oscillation inside a Gaussian band that travels outward, decaying in time
// and distance. Visual only (heightfield perturbation); collision drift over
// its ~3 s life is negligible.
float resonance(vec2 p) {
  if (uResonAge < 0.0) return 0.0;
  float dist = length(p - uResonOrigin);
  float front = uResonAge * 30.0;          // wavefront speed (m/s)
  float band = dist - front;
  float env = exp(-band * band / 70.0);    // ~±8 m ring around the front
  float decay = exp(-uResonAge * 0.6) * exp(-dist * 0.010);
  return sin(band * 0.55) * env * decay * 3.0;
}

float heightAt(vec2 p) {
  float CS     = uCellSize;
  float emptyT = uEmptyRate / 100.0;
  float lMin   = min(uDuneLengthMin, uDuneLengthMax);
  float lMax   = max(uDuneLengthMin, uDuneLengthMax);
  float lRange = lMax - lMin;
  float hMin   = min(uDuneHeightMin, uDuneHeightMax);
  float hMax   = max(uDuneHeightMin, uDuneHeightMax);
  float hRange = hMax - hMin;
  int   seedOff = uSeed * 17;

  // Cell of the query point + how many neighbour cells to sweep.
  int range = int(ceil(lMax * 1.05 / CS)) + 1;
  int ccxC  = int(floor(p.x / CS));
  int cczC  = int(floor(p.y / CS));

  float h = 0.0;
  for (int dz = -range; dz <= range; dz++) {
    int ccz = cczC + dz;
    for (int dx = -range; dx <= range; dx++) {
      int ccx = ccxC + dx;

      // Cell occupancy gate (matches r6 < emptyT in bakeChunk).
      float r6 = hash2(ccx + 37 + seedOff, ccz + 41);
      if (r6 < emptyT) continue;

      float r1 = hash2(ccx +  0 + seedOff, ccz +  0);
      float r2 = hash2(ccx +  7 + seedOff, ccz +  7);
      float r3 = hash2(ccx + 13 + seedOff, ccz + 17);
      float r4 = hash2(ccx + 19 + seedOff, ccz + 23);
      float r5 = hash2(ccx + 29 + seedOff, ccz + 31);

      float dCx   = float(ccx) * CS + r1 * CS;
      float dCz   = float(ccz) * CS + r2 * CS;
      float ang   = r3 * TAU;
      float ca    = cos(ang);
      float sa    = sin(ang);
      float len   = lMin + r4 * lRange;
      float wid   = (lMin + r5 * lRange) * 0.7;
      float amp   = hMin + r6 * hRange;
      float asym  = 0.4 + r4 * 0.6;

      // World offset → sea-local frame.
      float rdx = p.x - dCx;
      float rdz = p.y - dCz;
      float lrx =  rdx * ca + rdz * sa;
      float lrz = -rdx * sa + rdz * ca;
      float nx  = lrx / len;
      float nz  = lrz / wid;
      float r2s = nx * nx + nz * nz;
      if (r2s >= 1.0) continue;

      float bell = 1.0 - r2s;
      bell = bell * bell * bell;
      if (nx > 0.0) {
        float drop = 1.0 - nx * (1.0 + asym);
        if (drop <= 0.0) continue;
        bell *= drop;
      }
      h += bell * amp;
    }
  }

  // Base undulation + ripple — matches the final loop of bakeChunk.
  float ground = (sin(p.x * 0.003)  * 0.3
                + sin(p.y * 0.0025) * 0.3
                + sin((p.x + p.y) * 0.0017) * 0.2) * 4.0;
  float ripple = (vnoise(vec2(p.x * 0.15, p.y * 0.12)) - 0.5) * 1.5;

  // M5: canyons — sparse, deep valleys carved by squared sparse noise.
  // pow(max(0, n - 0.65), 1.5) gives a thin set of "canyon ridges" in the
  // noise field; subtract amplitude*mask to dig downward where they live.
  // This adds heightfield-compatible canyons (not true overhangs/caves —
  // those need a real 3D SDF and are scheduled for a follow-up milestone).
  float canyonN    = vnoise(vec2(p.x * 0.0012, p.y * 0.0012));
  float canyonMask = pow(max(0.0, canyonN - 0.65), 1.5);
  float canyon     = canyonMask * 25.0;

  return h + ground + ripple - canyon + spawnFeatures(p) + resonance(p);
}

// "Vertical" signed distance — positive above surface, negative below.
// Used by normalAt for finite-difference normals where it doesn't matter.
float map(vec3 p) {
  return p.y - heightAt(p.xz);
}

vec3 normalAt(vec3 p, float t) {
  // Scale epsilon with distance so far hits don't aliase against per-step
  // jitter, near hits stay sharp.
  float e = max(0.5, t * 0.002);
  vec2 k = vec2(e, 0.0);
  return normalize(vec3(
    map(p + k.xyy) - map(p - k.xyy),
    map(p + k.yxy) - map(p - k.yxy),
    map(p + k.yyx) - map(p - k.yyx)
  ));
}

// ---------------------------------------------------------------------------
// M7: 3D solid features (arches, overhanging rocks). True SDFs combined
// with the heightfield via min() in the scene tracer. Each feature stores
// position (xyz) and a packed type+scale (w).
// ---------------------------------------------------------------------------

float archSDF(vec3 q, float scale) {
  // Torus, axis along Z (you walk through east-west). Major radius R, tube
  // radius r. Bottom of torus touches ground (anchor.y = ground level, so
  // shift up by R so the donut sits on the dune).
  float R = 12.0 * scale;
  float r = 3.0  * scale;
  q.y -= R;
  return length(vec2(length(q.xy) - R, q.z)) - r;
}

float spireSDF(vec3 q, float scale) {
  // Vertically-stretched ellipsoid wider at top than base — natural
  // overhang. Bottom touches ground (anchor.y = ground).
  float H = 14.0 * scale;
  float Rb = 2.5 * scale;
  float Rt = 5.5 * scale;
  q.y -= H * 0.5;
  // Taper radius by height fraction (0 at top? no — wider at top).
  float yn = clamp(q.y / (H * 0.5), -1.0, 1.0);   // -1 bottom, +1 top
  float R = mix(Rb, Rt, yn * 0.5 + 0.5);
  vec2 d = vec2(length(q.xz) - R, abs(q.y) - H * 0.5);
  return min(max(d.x, d.y), 0.0) + length(max(d, 0.0));
}

float sdRoundBox(vec3 p, vec3 b, float r) {
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}

// Spawn landmark: an overhanging rock shelf jutting out from the hill toward
// the origin. The hill's smooth dome (in heightAt) is the walkable ramp; this
// slab is the overhanging rock you can shelter under. Anchored to the hill
// plateau height (uSpawnPlateauY) so it sits at the top edge. GPU-only — the
// player walks under it; collision uses the heightfield + cave only.
float spawnOverhangSDF(vec3 p) {
  // Slab centre between the hill (-34,-24) and origin, near the plateau top,
  // jutting toward spawn so you can shelter under it.
  vec3 c = vec3(-22.0, uSpawnPlateauY - 1.5, -15.0);
  vec3 q = p - c;
  // Tilt the shelf slightly downward toward the origin for a natural lean.
  const float ca = 0.966, sa = 0.259; // ~15°
  q = vec3(q.x * ca - q.y * sa, q.x * sa + q.y * ca, q.z);
  return sdRoundBox(q, vec3(6.5, 1.4, 6.5), 1.3);
}

float solidProcSDF(vec3 p) {
  float d = spawnOverhangSDF(p);
  for (int i = 0; i < MAX_SOLIDS; i++) {
    if (i >= uSolidCount) break;
    vec4 sol = uSolids[i];
    vec3 q = p - sol.xyz;
    // Rotate around Y so each arch can face a different direction.
    float a = uSolidRot[i];
    float ca = cos(a), sa = sin(a);
    q = vec3(q.x * ca - q.z * sa, q.y, q.x * sa + q.z * ca);
    int   type  = int(sol.w / 100.0);
    float scale = (sol.w - float(type) * 100.0) / 10.0;
    float di = (type == 0) ? archSDF(q, scale) : spireSDF(q, scale);
    d = min(d, di);
  }
  return d;
}

// One editor-placement proxy in local space (q = world - ground anchor). kind:
// 0 = standing slab/obelisk (box), 1 = orb (sphere), 2 = upright figure (capsule).
float placeProxy(vec3 q, float kind, float sc) {
  if (kind < 0.5) {
    vec3 b = vec3(0.5, 1.3, 0.5) * sc;
    q.y -= b.y;                         // base sits on the ground anchor
    return sdRoundBox(q, b, 0.1 * sc);
  } else if (kind < 1.5) {
    float r = 0.8 * sc;
    q.y -= r;
    return length(q) - r;
  }
  // Upright capsule: segment from y=r up to y≈1.7·sc, radius r (inlined so this
  // stays above taperedCapsule's definition).
  float r = 0.42 * sc;
  vec3 a = vec3(0.0, r, 0.0);
  vec3 ba = vec3(0.0, max(1.7 * sc - r, 0.01), 0.0);
  vec3 pa = q - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - r;
}

float placeSDF(vec3 p) {
  float d = 1e10;
  for (int i = 0; i < MAX_PLACE; i++) {
    if (i >= uPlaceCount) break;
    vec4 pl = uPlace[i];
    d = min(d, placeProxy(p - pl.xyz, uPlaceKind[i], max(pl.w, 0.05)));
  }
  return d;
}

// Nearest placement distance at p, plus its colour via an out-param. One loop
// serves both the "is this hit a placement?" test and the colour pick in
// shading, instead of evaluating placeSDF and then a second colour loop.
float placeNearest(vec3 p, out vec3 col) {
  float best = 1e10;
  col = uSolidColor;
  for (int i = 0; i < MAX_PLACE; i++) {
    if (i >= uPlaceCount) break;
    vec4 pl = uPlace[i];
    float di = placeProxy(p - pl.xyz, uPlaceKind[i], max(pl.w, 0.05));
    if (di < best) { best = di; col = uPlaceColor[i]; }
  }
  return best;
}

// Combined solid field: procedural features ∪ editor placements. trace() and
// solidNormal() use this, so placements occlude and shade exactly like solids.
float solidSDF(vec3 p) {
  return min(solidProcSDF(p), placeSDF(p));
}

// Cave SMIN blend radius — must equal CAVE_SMIN_K in src/terrain/cave.js.
const float CAVE_SMIN_K = 3.0;

// Polynomial smooth-min — rounds the junctions between capsules into smooth
// gallery intersections instead of hard creases.
float sminCave(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

// Tapered capsule (round-cone) SDF: distance to the segment minus its
// linearly-interpolated radius. Identical to taperedCapsule() in cave.js.
float taperedCapsule(vec3 p, vec3 a, float ra, vec3 b, float rb) {
  vec3 pa = p - a, ba = b - a;
  float baLen2 = max(dot(ba, ba), 1e-6);
  float h = clamp(dot(pa, ba) / baLen2, 0.0, 1.0);
  return length(pa - ba * h) - mix(ra, rb, h);
}

// Cave SDF: smooth union of all capsule segments. Negative inside the
// hollow, positive in solid rock. A bounding-sphere early-out makes the
// rest of the world skip the whole capsule loop — the cave is single and
// localized, so this is nearly free everywhere else.
float caveSDF(vec3 p) {
  if (uCaveSegCount <= 0) return 1e10;
  float bd = length(p - uCaveBounds.xyz) - uCaveBounds.w;
  if (bd > 4.0) return bd; // far outside the cave — no capsule math needed
  float d = 1e10;
  for (int i = 0; i < MAX_CAVE_SEGS; i++) {
    if (i >= uCaveSegCount) break;
    vec4 a = uCaveSegA[i];
    vec4 b = uCaveSegB[i];
    d = sminCave(d, taperedCapsule(p, a.xyz, a.w, b.xyz, b.w), CAVE_SMIN_K);
  }
  return d;
}

// Gradient of caveSDF — points OUT of the void into rock. The visible wall
// face (toward the hollow) is therefore -caveNormal. Finite differences.
vec3 caveNormal(vec3 p) {
  const float e = 0.08;
  vec2 k = vec2(e, 0.0);
  return normalize(vec3(
    caveSDF(p + k.xyy) - caveSDF(p - k.xyy),
    caveSDF(p + k.yxy) - caveSDF(p - k.yxy),
    caveSDF(p + k.yyx) - caveSDF(p - k.yyx)
  ));
}

// Does a ray from p along dir escape the cave into open sky before being
// blocked by rock? 1.0 = light gets through (this point sees out a mouth),
// 0.0 = blocked. Sphere-traces the void; at the boundary, rock (below the
// dune surface) blocks while open air lets daylight in. Drives sun shafts
// and skylight leaking into the cave so it isn't a flat black hole.
float caveEscape(vec3 p, vec3 dir) {
  float t = 0.0;
  for (int j = 0; j < 32; j++) {
    vec3 q = p + dir * t;
    float dc = caveSDF(q);
    if (dc >= 0.0) {
      return (q.y - heightAt(q.xz) <= 0.0) ? 0.0 : 1.0;
    }
    t += -dc + 0.3;
    if (t > 220.0) break;
  }
  return 1.0;
}

vec3 solidNormal(vec3 p) {
  const float e = 0.05;
  vec2 k = vec2(e, 0.0);
  return normalize(vec3(
    solidSDF(p + k.xyy) - solidSDF(p - k.xyy),
    solidSDF(p + k.yxy) - solidSDF(p - k.yxy),
    solidSDF(p + k.yyx) - solidSDF(p - k.yyx)
  ));
}

// Heightfield raymarch. Three combined pieces that together kill both
// the "floating dunes" and the "vanishing distant terrain" artifacts:
//
//  1. Adaptive local Lipschitz. The "safe" sphere-trace step is
//        step = v / (|rd.y| + L·|rd.xz|)
//     where L bounds |∇h|. A fixed pessimistic L=2.5 makes flat-lowland
//     descent exponential and never converges. Instead we learn L from
//     the slope OBSERVED in the previous step (h change / lateral move)
//     and bias slightly upward for safety. Over flat ground L→0.3 and
//     steps are huge; as we approach a dune flank L→real, steps shrink.
//
//  2. Lateral-distance cap. The step is also bounded so we never advance
//     more than ~one sea-width laterally per step — otherwise we'd skip
//     over thin ridges (the cause of "floating dune tops"). The cap grows
//     with distance because far details are sub-pixel anyway.
//
//  3. Linear interp at the surface crossing. When v flips negative
//     between two consecutive samples, we don't need a tight hit
//     threshold — interpolate where v=0 between the bracket. Sub-step
//     accuracy at any step size.
// March through the cave hollow by sphere-tracing -caveSDF until the void
// boundary, then classify what's on the far side:
//   hitType 4 = rock wall, 2 = solid feature, 0 = open mouth (resume exterior),
//   -1 = ran off into the distance (miss). Returns the t where it stopped.
float marchVoid(vec3 ro, vec3 rd, float t0, out int hitType) {
  float t = t0;
  for (int j = 0; j < 56; j++) {
    vec3 q = ro + rd * t;
    float dc = caveSDF(q);
    if (dc >= 0.0) {
      // Left the hollow. Rock (below heightfield / inside a solid) → wall;
      // otherwise we punched out through a mouth into open air.
      float v = q.y - heightAt(q.xz);
      if (v <= 0.0)            { hitType = 4; return t; }
      if (solidSDF(q) <= 0.01) { hitType = 2; return t; }
      hitType = 0; return t;
    }
    t += -dc + 0.12; // sphere-trace toward the nearest wall
    if (t > MAX_DIST) { hitType = -1; return t; }
  }
  hitType = 4; return t;
}

// Hybrid scene trace: heightfield (directional safe-step) + 3D solid SDFs
// (true sphere-trace distance) + cave hollow (subtracted void). Returns
// t > 0 on hit (with hitType encoded), -1 on miss.
//
// hitType encoding:
//   1 = heightfield (ground)
//   2 = solid feature (arch/overhang)
//   3 = (legacy) cave back wall — no longer produced
//   4 = cave wall (interior rock face)
float trace(vec3 ro, vec3 rd, out int hitType) {
  hitType = 0;
  float maxH = max(uDuneHeightMin, uDuneHeightMax) + 30.0; // +slack for spires
  float t = 1.0;
  if (ro.y > maxH) {
    if (rd.y >= 0.0) return -1.0;
    t = max(t, (ro.y - maxH) / -rd.y);
  }

  // Origin inside the cave hollow (camera walked/flew in): don't report the
  // surrounding dune as a hit — traverse the void to its wall or a mouth.
  if (caveSDF(ro) < 0.0) {
    int ht;
    float vt = marchVoid(ro, rd, 0.05, ht);
    if (ht != 0) { hitType = ht; return ht < 0 ? -1.0 : vt; }
    t = vt; // exited a mouth into open air — continue exterior trace
  }

  const float L_MAX   = 2.5;
  const float L_FLOOR = 0.3;
  float lateral = max(length(rd.xz), 0.001);

  vec3  p = ro + rd * t;
  float v = p.y - heightAt(p.xz);
  float ds = solidSDF(p);

  if (v <= 0.0)  { hitType = 1; return t; }
  if (ds <= 0.01){ hitType = 2; return t; }

  float localL = L_FLOOR;

  for (int i = 0; i < MAX_STEPS; i++) {
    if (p.y > maxH && rd.y > 0.0) return -1.0;

    float denom = max(abs(rd.y) + localL * lateral, 0.05);
    float stepH = v / denom;
    float stepS = ds; // true SDF — sphere trace safe step.

    float step = min(stepH, stepS);
    step = max(step, 0.5 + t * 0.015);
    // Lateral cap is purely a heightfield-thin-feature safety; doesn't
    // help solids (they're isotropic SDFs), but it doesn't hurt either.
    float latCap = 5.0 + t * 0.02;
    step = min(step, latCap / lateral);

    float nt = t + step;
    if (nt > MAX_DIST) return -1.0;

    vec3  np = ro + rd * nt;
    float nv = np.y - heightAt(np.xz);
    float nds = solidSDF(np);

    // Solid hit: linear-interp the SDF zero crossing.
    if (nds <= 0.01) {
      hitType = 2;
      if (ds - nds > 1e-4) return t + step * ds / (ds - nds);
      return nt;
    }
    // Heightfield crossing. Evaluate the cave at the ACTUAL surface crossing
    // (interpolated) — not at the overshot sample np, which the big
    // directional steps can push several metres underground and falsely read
    // as "inside the void", x-raying the cave through solid ground above a
    // buried tunnel. Only a crossing that is itself carved (a mouth) dives in.
    if (nv <= 0.0) {
      float tHit = t + step * v / (v - nv);
      vec3  pHit = ro + rd * tHit;
      if (caveSDF(pHit) < 0.0) {
        int ht;
        float vt = marchVoid(ro, rd, tHit, ht);
        if (ht != 0) { hitType = ht; return ht < 0 ? -1.0 : vt; }
        // Punched back out into open air through a mouth — resume exterior.
        t = vt;
        p = ro + rd * t;
        v = p.y - heightAt(p.xz);
        ds = solidSDF(p);
        continue;
      }
      hitType = 1;
      return tHit;
    }

    // Update localL from observed heightfield slope.
    float dh = abs(step * rd.y - nv + v);
    float observedL = dh / max(step * lateral, 0.001);
    localL = clamp(observedL * 2.0, L_FLOOR, L_MAX);

    t = nt;
    p = np;
    v = nv;
    ds = nds;
  }
  return -1.0;
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

vec3 computeRayDir() {
  vec2 frag = gl_FragCoord.xy;
  // ndc scaled to camera FOV (horizontal). Vertical follows from aspect
  // — same units-per-pixel as horizontal, matching CPU pinhole projection.
  float ndcX = ((frag.x - uRes.x * 0.5) / uRes.x) * 2.0 * uTanHalfFov;
  float ndcY = ((frag.y - uRes.y * 0.5) / uRes.x) * 2.0 * uTanHalfFov;

  // Camera-local: +Z forward, +X right, +Y up.
  vec3 d = normalize(vec3(ndcX, ndcY, 1.0));

  // Pitch around X axis (positive pitch tilts UP — rotates +Z toward +Y).
  float cp = cos(uPitch), sp = sin(uPitch);
  d = vec3(d.x, d.y * cp + d.z * sp, -d.y * sp + d.z * cp);

  // Yaw around Y axis (matches CPU convention: yaw=0 → +Z, yaw=+π/2 → +X).
  float cy = cos(uYaw), sy = sin(uYaw);
  d = vec3(d.x * cy + d.z * sy, d.y, -d.x * sy + d.z * cy);

  return d;
}

// ---------------------------------------------------------------------------
// Shading
// ---------------------------------------------------------------------------

// Procedural color-patch tint for the sand. Multiplies the lit sand
// color by a slowly-varying noise-driven RGB shift so the dune surface
// reads as a mosaic of patches in nearby view (mineral variations,
// dust pockets, ripple shadows) instead of a single uniform colour.
// Patches are large (~80m) and the multiplier range is narrow (~0.85
// to ~1.10) so the colour shifts read as natural sand variation, not
// painted-on stains.
vec3 sandPatchTint(vec2 worldXZ) {
  float n1 = vnoise(worldXZ * 0.012);
  float n2 = vnoise(worldXZ * 0.022 + vec2(13.7, 5.3));
  float n3 = vnoise(worldXZ * 0.040 + vec2(31.5, 22.1));
  // Four palette tints relative to neutral.
  vec3 t1 = vec3(1.00, 1.00, 1.00);   // neutral
  vec3 t2 = vec3(1.08, 1.00, 0.92);   // warm yellow patch
  vec3 t3 = vec3(0.93, 0.96, 1.04);   // cooler grey patch
  vec3 t4 = vec3(1.05, 0.93, 0.88);   // dusty reddish patch
  vec3 tint = mix(t1, t2, smoothstep(0.40, 0.75, n1));
  tint = mix(tint, t3, smoothstep(0.45, 0.80, n2) * 0.7);
  tint = mix(tint, t4, smoothstep(0.50, 0.85, n3) * 0.5);
  return tint;
}

vec3 sandColor(float lit) {
  return texture(uSandPal, vec2(clamp(lit, 0.0, 0.999), 0.5)).rgb;
}

// ---------------------------------------------------------------------------
// Sky: same banded gradient + 4×4 Bayer dither as CPU. Mapping from ray
// direction to "pixels above horizon" matches CPU pinhole (focal*tan(elev))
// so the gradient thickness stays the same in screen units.
// ---------------------------------------------------------------------------

float bayer4(vec2 frag) {
  const float B[16] = float[16](
    0.0/16.0,  8.0/16.0,  2.0/16.0, 10.0/16.0,
   12.0/16.0,  4.0/16.0, 14.0/16.0,  6.0/16.0,
    3.0/16.0, 11.0/16.0,  1.0/16.0,  9.0/16.0,
   15.0/16.0,  7.0/16.0, 13.0/16.0,  5.0/16.0
  );
  ivec2 q = ivec2(mod(frag, 4.0));
  return B[q.y * 4 + q.x];
}

float skyT(vec3 rd) {
  float horiz = length(rd.xz);
  float tanElev = rd.y / max(horiz, 1e-6);
  float dyPixels = tanElev * uFocal;
  float t = 1.0 - dyPixels / max(uSkyHeight, 1.0);
  return clamp(t, 0.0, 1.0);
}

vec3 skyColor(vec3 rd, float t) {
  float bf = t * uSkyBands;
  float bi = floor(bf);
  float frac = bf - bi;
  float chosen = (frac > bayer4(gl_FragCoord.xy)) ? bi + 1.0 : bi;
  float u = clamp(chosen / uSkyBands, 0.0, 1.0);
  return texture(uSkyPal, vec2(u, 0.5)).rgb;
}

// ---------------------------------------------------------------------------
// Stars — celestial sphere rotated by polar axis (matrix supplied by CPU)
// ---------------------------------------------------------------------------

vec3 starOverlay(vec3 rd) {
  if (uStarsEnabled < 0.5) return vec3(0.0);
  if (uNightLevel < 0.01) return vec3(0.0);

  float horiz = length(rd.xz);
  float tanElev = rd.y / max(horiz, 1e-6);
  if (tanElev <= 0.0) return vec3(0.0);
  float dyPixels = tanElev * uFocal;
  float atmFade = clamp(dyPixels / 22.0, 0.0, 1.0);
  if (atmFade < 0.08) return vec3(0.0);

  // Rotate world ray into celestial frame and normalize.
  vec3 cel = normalize(uPolarMat * rd);

  // Hash-quantise at pixel resolution. CPU uses Q = round(focal); int() in
  // GLSL truncates toward zero, matching JS |0 — so the bit pattern fed to
  // hash2 is identical for the same world ray.
  float Q = uFocal;
  int aQ = int(cel.x * Q);
  int bQ = int(cel.y * Q);
  int cQ = int(cel.z * Q);

  float h = hash2(aQ + cQ * 1009, bQ);
  if (h < 0.996) return vec3(0.0);

  float starAmt = (h - 0.996) / 0.004;
  float bright  = uNightLevel * starAmt * atmFade * (110.0 / 255.0);
  return vec3(bright, bright * 0.97, bright * 0.93);
}

// ---------------------------------------------------------------------------
// M4: Soft shadow — march from surface toward sun, track min(k·v/t) for
// penumbra estimation. Same adaptive Lipschitz idea as the main trace so
// we don't get false occlusion on grazing low-sun rays over flat ground.
// ---------------------------------------------------------------------------

float softShadow(vec3 ro, vec3 sd) {
  if (sd.y < 0.05) return 1.0; // sun at/below horizon — no directional anyway

  const float k = 16.0;
  const int   SHADOW_STEPS = 28;
  const float SHADOW_MAX_T = 500.0;

  float maxH = max(uDuneHeightMin, uDuneHeightMax) + 30.0;
  float lateral = max(length(sd.xz), 0.001);

  float res = 1.0;
  float t   = 0.5;
  float localL = 0.5;

  for (int i = 0; i < SHADOW_STEPS; i++) {
    vec3 p = ro + sd * t;
    if (p.y > maxH) break;

    float v  = p.y - heightAt(p.xz);
    float ds = solidSDF(p);
    float occ = min(v, ds);
    if (occ < 0.01) return 0.0;

    res = min(res, k * occ / t);

    float denom = max(sd.y + localL * lateral, 0.05);
    float stepH = v / denom;
    float step  = min(stepH, ds);
    step = max(step, 0.5 + t * 0.03);
    step = min(step, 8.0 + t * 0.05);
    t += step;
    if (t > SHADOW_MAX_T) break;

    // Update local L from observed heightfield slope this step.
    vec3 np = ro + sd * t;
    float nv = np.y - heightAt(np.xz);
    float dh = abs(step * sd.y - nv + v);
    float obsL = dh / max(step * lateral, 0.001);
    localL = clamp(obsL * 2.0, 0.3, 2.5);
  }
  return clamp(res, 0.0, 1.0);
}

// ---------------------------------------------------------------------------
// M4: AO — sample heightfield at small offsets along surface normal.
// If terrain is closer than expected, accumulate occlusion. IQ-style.
// ---------------------------------------------------------------------------

float calcAO(vec3 p, vec3 n) {
  float occ = 0.0;
  float sca = 1.0;
  for (int i = 0; i < 5; i++) {
    float h = 0.5 + 1.5 * float(i);
    vec3 q = p + n * h;
    float v = q.y - heightAt(q.xz);
    occ += max(0.0, h - max(v, 0.0)) * sca;
    sca *= 0.6;
  }
  return clamp(1.0 - 0.35 * occ, 0.0, 1.0);
}

// ---------------------------------------------------------------------------
// M6: NPC tracing — closed-form ray vs sphere for each NPC. Cheap enough
// to brute-force MAX_NPCS per pixel; per-instance bounding tests would
// only matter at 50+ NPCs.
// ---------------------------------------------------------------------------

struct NpcHit { float t; int idx; vec3 normal; };

NpcHit traceNpcs(vec3 ro, vec3 rd, float maxT) {
  NpcHit hit;
  hit.t = -1.0;
  hit.idx = -1;
  hit.normal = vec3(0.0, 1.0, 0.0);
  for (int i = 0; i < MAX_NPCS; i++) {
    if (i >= uNpcCount) break;
    vec3  c = uNpcs[i].xyz;
    float r = uNpcs[i].w;
    vec3 oc = ro - c;
    float b = dot(oc, rd);
    float cc = dot(oc, oc) - r * r;
    float disc = b * b - cc;
    if (disc < 0.0) continue;
    float ti = -b - sqrt(disc);
    if (ti < 0.5 || ti > maxT) continue;
    if (hit.t < 0.0 || ti < hit.t) {
      hit.t = ti;
      hit.idx = i;
      hit.normal = normalize((ro + rd * ti) - c);
    }
  }
  return hit;
}

// ---------------------------------------------------------------------------
// Cutscene hero — a ~1.7 m humanoid built from capsule segments, animated by
// uniforms (walk swing from uHeroPhase, forward collapse from uHeroFall). Only
// traced when uHeroVisible == 1, so it costs nothing during gameplay.
// ---------------------------------------------------------------------------

float sdSeg(vec3 p, vec3 a, vec3 b, float r) {
  vec3 pa = p - a;
  vec3 ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - r;
}

float heroSDF(vec3 wp) {
  // World → hero-local: translate to feet, rotate so the figure faces +z.
  vec3 d = wp - uHeroPos;
  float c = cos(-uHeroYaw), s = sin(-uHeroYaw);
  vec3 q = vec3(c * d.x - s * d.z, d.y, s * d.x + c * d.z);

  // Collapse: tilt the whole body forward about the hips as uHeroFall → 1.
  float ang = uHeroFall * 1.45;
  vec3 r = q - vec3(0.0, 0.9, 0.0);
  float cc = cos(ang), ss = sin(ang);
  r = vec3(r.x, cc * r.y - ss * r.z, ss * r.y + cc * r.z);
  q = r + vec3(0.0, 0.9, 0.0);

  // Walk swing — legs/arms swing fore-aft, opposite phase. Stops when fallen.
  float sw = sin(uHeroPhase) * (1.0 - uHeroFall);

  // Legs (hip → foot), thighs slightly thicker than calves via mid radius.
  vec3 hipL = vec3(-0.13, 0.92, 0.0);
  vec3 hipR = vec3(0.13, 0.92, 0.0);
  vec3 footL = vec3(-0.13, 0.02, sw * 0.42);
  vec3 footR = vec3(0.13, 0.02, -sw * 0.42);
  float legs = min(sdSeg(q, hipL, footL, 0.105), sdSeg(q, hipR, footR, 0.105));

  // Torso + a little shoulder breadth.
  float torso = sdSeg(q, vec3(0.0, 0.88, 0.0), vec3(0.0, 1.46, 0.0), 0.17);

  // Head.
  float head = length(q - vec3(0.0, 1.63, 0.0)) - 0.13;

  // Arms (shoulder → hand), swing opposite the legs.
  vec3 shL = vec3(-0.2, 1.42, 0.0);
  vec3 shR = vec3(0.2, 1.42, 0.0);
  vec3 handL = vec3(-0.23, 0.95, -sw * 0.38);
  vec3 handR = vec3(0.23, 0.95, sw * 0.38);
  float arms = min(sdSeg(q, shL, handL, 0.072), sdSeg(q, shR, handR, 0.072));

  return min(min(legs, torso), min(head, arms));
}

struct HeroHit { float t; vec3 normal; };

HeroHit traceHero(vec3 ro, vec3 rd, float maxT) {
  HeroHit hh;
  hh.t = -1.0;
  hh.normal = vec3(0.0, 1.0, 0.0);
  if (uHeroVisible < 0.5) return hh;

  // Bounding sphere around the figure (centre ~1 m up, generous radius to
  // cover the fallen pose stretched along the ground).
  vec3 bc = uHeroPos + vec3(0.0, 0.95, 0.0);
  vec3 oc = ro - bc;
  float br = 2.4;
  float b = dot(oc, rd);
  float disc = b * b - (dot(oc, oc) - br * br);
  if (disc < 0.0) return hh;
  float tEnter = max(-b - sqrt(disc), 0.1);
  float tExit = -b + sqrt(disc);
  if (tEnter > maxT) return hh;

  float t = tEnter;
  for (int i = 0; i < 48; i++) {
    if (t > maxT || t > tExit) break;
    vec3 p = ro + rd * t;
    float dist = heroSDF(p);
    if (dist < 0.004) {
      vec2 e = vec2(0.012, 0.0);
      hh.normal = normalize(vec3(
        heroSDF(p + e.xyy) - heroSDF(p - e.xyy),
        heroSDF(p + e.yxy) - heroSDF(p - e.yxy),
        heroSDF(p + e.yyx) - heroSDF(p - e.yyx)));
      hh.t = t;
      return hh;
    }
    t += max(dist, 0.005);
  }
  return hh;
}

// ---------------------------------------------------------------------------
// Clouds: 2D fbm field projected onto a cylindrical sky shell at
// uCloudAltitude metres. Two fbm samples at different frequencies summed
// for richness. Wind drift advances the sample point linearly so clouds
// "come from somewhere" (drift across the sky) instead of pulsing in
// place. A separate low-frequency regional field modulates the threshold
// so coverage is non-uniform — patches of clear / scattered / dense.
// ---------------------------------------------------------------------------

float fbm2d(vec2 p) {
  float v = 0.0;
  float amp = 0.5;
  // Per-octave rotation + non-integer frequency multiplier. The rotation
  // prevents axis-aligned grid resonance (visible as recognizable
  // recurring shapes) and the irrational 2.07 scale stops the lattice
  // from re-aligning across octaves.
  const mat2 ROT = mat2(0.8, -0.6, 0.6, 0.8); // ~37° rotation
  for (int i = 0; i < 6; i++) {
    v += vnoise(p) * amp;
    p = ROT * p * 2.07;
    amp *= 0.5;
  }
  return v;
}

// Billowy fbm — the puffy "cotton ball" cumulus base. Each octave is a tent
// 1-|2n-1| that peaks where the noise crosses its mid value, giving rounded
// convex lumps with crisp valleys between them (the gaps between puffs)
// instead of the smooth wash fbm2d produces. Normalized to ~[0,1] with mean
// ~0.5 so it shares fbm2d's distribution and the threshold/coverage tuning
// downstream stays valid.
float billowFbm(vec2 p) {
  float v = 0.0;
  float amp = 0.5;
  float tot = 0.0;
  const mat2 ROT = mat2(0.8, -0.6, 0.6, 0.8);
  for (int i = 0; i < 5; i++) {
    float n = vnoise(p);
    v += (1.0 - abs(2.0 * n - 1.0)) * amp;
    tot += amp;
    p = ROT * p * 2.07;
    amp *= 0.5;
  }
  return v / tot;
}

// Domain warp — distort the sample point by a low-cost noise lookup so
// large-scale patterns don't tile or repeat visibly. Kept GENTLE and
// low-frequency on purpose: a strong/high-frequency warp drags the field
// into long wispy tendrils ("cigarette smoke"); a small low-freq nudge only
// shifts whole lumps around so they stay rounded and non-repeating.
// mt is the morph phase. It animates the warp's INTERNAL noise lookup, so the
// bounded (about +-0.35) displacement evolves over time and cloud shapes
// billow / change IN PLACE. It deliberately does NOT translate the base point
// p, so morphing never moves the clouds across the sky (that is wind's job).
vec2 domainWarp(vec2 p, float mt) {
  float wx = vnoise(p * 0.45 + vec2( 5.2,        1.3 + mt));
  float wz = vnoise(p * 0.45 + vec2( 3.9 + mt,  11.7));
  return p + vec2((wx - 0.5) * 0.7, (wz - 0.5) * 0.7);
}

// Wind-drifted UV. time is in seconds; expected to be game-time so the
// drift rate scales with the player's time-rate.
vec2 cloudUV(vec2 hit, float time) {
  vec2 drift = uCloudWind * time / uCloudScale;
  return hit / uCloudScale + drift;
}

// Combined cloud field with domain warp for unique non-repeating shapes
// and linear morph for slow evolution. The domain warp shifts each
// lookup by a perpendicular noise field — same fbm with same hashes
// produces wildly different visible shapes because nearby pixels sample
// from far-apart locations in noise-space.
float cloudField(vec2 hit, float time) {
  vec2 uv1 = cloudUV(hit, time);
  vec2 uv2 = uv1 * 1.4 + vec2(0.7 * uCloudWind.y, -0.7 * uCloudWind.x) * time / uCloudScale;
  // Morph = in-place shape evolution (animates the warp), NOT movement.
  // Cloud travel across the sky comes ONLY from the wind drift in cloudUV,
  // so morph speed and fly speed are fully decoupled.
  float mt = time * uCloudMorphSpeed;
  vec2 p1 = domainWarp(uv1, mt);
  vec2 p2 = domainWarp(uv2, mt * 0.8);
  // Puffy cumulus: billow is the rounded "cotton lump" base; a touch of
  // smooth fbm keeps lumps cohesive (not pure cauliflower static), and the
  // second, lower-frequency sample groups the puffs into larger cloud
  // clusters with clear sky between them.
  float puff   = billowFbm(p1 * 1.25);
  float cohere = fbm2d(p1);
  float lump   = mix(cohere, puff, 0.62);
  float group  = fbm2d(p2);
  return lump * 0.72 + group * 0.28;
}

// Regional coverage variation. Very low frequency noise — feature size
// ~10-20 km — so the sky has patches of "more clouds" and "fewer clouds"
// instead of uniformly-distributed cumulus. Also drifts with wind, so
// these patches move across the sky rather than sit in place.
float regionalCover(vec2 hit, float time) {
  vec2 regUV = hit * 0.00007 - uCloudWind * time * 0.000003;
  return fbm2d(regUV) - 0.5; // ∈ ~[-0.4..0.4]
}

// Project a ray direction or sun direction onto the cloud shell.
// originXZ is where the ray starts (camera for sky, hit-point for ground
// shadow). originY is its Y. dir is the unit direction. dir.y is clamped
// to a minimum so adjacent low-elevation rays don't blow up — kills
// horizon streak artifacts.
vec2 cloudProject(vec2 originXZ, float originY, vec3 dir) {
  float dy = max(dir.y, 0.10);
  float t = (uCloudAltitude - originY) / dy;
  t = min(t, 35000.0);
  return originXZ + dir.xz * t;
}

struct CloudSample { float alpha; float density; float threshold; };

// Map cloudCover to a threshold curve. Tuned so:
//   cover=0  → 0.95 (no fbm value can cross it — genuinely clear sky)
//   cover=1  → 0.05 (almost every fbm value crosses — solid overcast)
float cloudThreshold(float cover) {
  float c = clamp(cover, 0.0, 1.0);
  return mix(0.95, 0.05, c);
}

// Regional bias amplitude: a bell curve over cover. Strongest in the
// middle (so patches of more/less cloudy live side-by-side), zero at
// the extremes (so 0% is truly clear and 100% is truly overcast — no
// gaps from regional dropping the threshold below 0 or rising it above
// 1 at the endpoints).
float regionalAmplitude(float c) {
  return 4.0 * c * (1.0 - c) * 0.55;
}

CloudSample sampleCumulus(vec3 rd, float time) {
  CloudSample s;
  s.alpha = 0.0;
  s.density = 0.0;
  s.threshold = 1.0;
  if (uCloudCover < 0.005) return s;
  // Allow clouds right down to the horizon line — the angular projection
  // + horizon-haze blending in main() handles the visual wrap.
  if (rd.y <= 0.0) return s;

  vec2 hit = cloudProject(uEye.xz, uEye.y, rd);
  float d = cloudField(hit, time);
  s.density = d;

  float c = clamp(uCloudCover, 0.0, 1.0);
  float reg = regionalCover(hit, time);
  s.threshold = cloudThreshold(c) + reg * regionalAmplitude(c);

  float softness = 0.06;
  float a = smoothstep(s.threshold - softness, s.threshold + softness, d);

  // Wide soft fade from just below horizon up to ~14° / ~26° (depending
  // on cover). This both kills the residual horizon-aliasing smear AND
  // makes clouds smoothly converge into the haze line instead of being
  // chopped off — the eye reads it as the cloud layer curving away
  // behind the horizon dome.
  float fadeEnd = mix(0.45, 0.25, c);
  float horizonFade = smoothstep(-0.02, fadeEnd, rd.y);
  s.alpha = a * horizonFade;
  return s;
}

// Cloud colour. One coherent growth model — "thickness" of the cloud at
// this pixel is (density - threshold). Where the cloud is thinnest (just
// poking above threshold) it's WHITE — fresh, transmissive, freshly
// formed. As it thickens toward the dense core it darkens to grey
// (Beer-Lambert: thick cloud absorbs light).
//
// This works at any coverage:
//   - 0%:   no clouds.
//   - 10%:  only the densest noise spikes pass threshold; thickness
//           there is tiny → those clouds are white/light.
//   - 50%:  cloud bodies are larger; their cores have thickness ~0.4 →
//           central grey, with lighter rims as new growth.
//   - 100%: nearly every pixel is cloud; thickness ranges full → dark
//           cores everywhere with lighter strips where the field thins
//           ("younger" cloud patches inside the overcast blanket).
// Tones anchor to skyTint so clouds match the current atmosphere.
vec3 cloudColor(vec3 rd, float density, float threshold, vec3 skyTint) {
  float sunAlign = max(0.0, dot(normalize(rd), uSunDir));
  float dayness  = clamp(uSunDir.y * 1.4 + 0.2, 0.0, 1.0);

  vec3 bright = mix(skyTint, vec3(0.97, 0.96, 0.93), 0.72);   // near-white
  vec3 shade  = skyTint * mix(0.20, 0.45, dayness);            // dark grey

  // Thickness: how far into the cloud body we are.
  // 0 → on the edge (just above threshold) → white.
  // 1 → deep dense core → dark grey.
  // Fixed 0.7 span maps the full fbm density range cleanly.
  float thickness = clamp((density - threshold) / 0.7, 0.0, 1.0);
  vec3 base = mix(bright, shade, thickness);

  // Silver lining — sun-aligned glow only at the very edge.
  float edge   = 1.0 - thickness;
  float skyLum = max(skyTint.r, max(skyTint.g, skyTint.b));
  base += pow(sunAlign, 22.0) * 0.55 * edge * skyLum;

  // Storm parameter on top — pulls toward leaden grey regardless of
  // the growth gradient.
  vec3 storm = skyTint * 0.15 + vec3(0.04, 0.05, 0.07);
  base = mix(base, storm, clamp(uStormness, 0.0, 1.0) * 0.85);

  return base;
}

// Per-ground-pixel sun visibility through clouds. Each lit point on the
// terrain checks whether a cloud is between it and the sun — gives real
// drifting cloud shadows on the dunes, instead of a single global dim.
float groundCloudShadow(vec3 p, float time) {
  if (uSunDir.y <= 0.05) return 1.0;
  if (uCloudCover < 0.005) return 1.0;
  vec2 hit = cloudProject(p.xz, p.y, uSunDir);
  float d = cloudField(hit, time);
  float c = clamp(uCloudCover, 0.0, 1.0);
  float reg = regionalCover(hit, time);
  float threshold = cloudThreshold(c) + reg * regionalAmplitude(c);
  float a = smoothstep(threshold - 0.06, threshold + 0.06, d);
  return 1.0 - a * 0.92;
}

// Weather-modulated sky color. At full cloud cover the sky becomes the
// overcast tone OUTRIGHT (mix factor = cover, linear) — including the
// horizon stripe, which previously stayed brighter because the modulation
// was capped at 0.85. Overcast tone is sun-elevation-aware so it's
// near-black at night, soft cool grey at noon.
vec3 applyWeatherToSky(vec3 base) {
  vec3 col = base;
  float dayness = clamp(uSunDir.y * 1.4 + 0.2, 0.0, 1.0);
  vec3 overcast = mix(vec3(0.04, 0.05, 0.08), vec3(0.55, 0.58, 0.62), dayness);
  col = mix(col, overcast, clamp(uCloudCover, 0.0, 1.0));
  col = mix(col, col * vec3(0.38, 0.43, 0.55), clamp(uStormness, 0.0, 1.0) * 0.75);
  col = mix(col, vec3(0.85, 0.55, 0.30), clamp(uDustIntensity, 0.0, 1.0) * 0.85);
  return col;
}

// ---------------------------------------------------------------------------
// Sun disc — solid pixel core + stepped halo rings (constants match sun.js)
// ---------------------------------------------------------------------------

vec3 sunOverlay(vec3 baseCol) {
  if (uSunVisible < 0.5) return baseCol;
  vec2 d = gl_FragCoord.xy - uSunScreen;
  float dist = length(d);

  // Geometric sun disc at real angular size (~0.53° → 1-2 px at default
  // FOV/resolution). That's all the sun "really" is.
  if (dist <= uSunCoreR) return uSunCore;

  // Atmospheric bloom + eye/camera glare. This is what makes the sun look
  // like the sun in photos and to the naked eye — a soft, much larger halo
  // around the tiny geometric core. Quadratic falloff approximates the
  // bright Mie-scattering ring you actually see around the sun.
  if (dist > uSunHaloR) return baseCol;
  float t = (dist - uSunCoreR) / max(uSunHaloR - uSunCoreR, 0.001);
  float a = pow(1.0 - t, 2.0) * uSunHaloAlpha;
  return mix(baseCol, uSunHalo, a * 0.75);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

vec3 applyHaze(vec3 col, float t) {
  // Distance-fog. Range varies with uFog:
  //   fog=0   → haze starts at 60 m, fully thick at ~2.4 km (subtle).
  //   fog=1   → haze starts at 2 m, fully thick at ~12 m (visibility
  //             collapses to a few metres — proper white-out).
  // Mix amount also ramps up with fog so at fog=1 the world is
  // completely replaced by the haze colour past the fog-end distance.
  float hazeStart = mix(60.0, 2.0, uFog);
  float hazeEnd   = mix(2460.0, 12.0, uFog);
  float haze = clamp((t - hazeStart) / max(hazeEnd - hazeStart, 0.5), 0.0, 1.0);
  vec3 horizonCol = applyWeatherToSky(texture(uSkyPal, vec2(0.999, 0.5)).rgb);
  vec3 dustCol = vec3(0.85, 0.55, 0.30);
  horizonCol = mix(horizonCol, dustCol, uDustIntensity * 0.7);
  float maxHaze = mix(0.55, 1.00, uFog);
  float hazeAmt = haze * maxHaze + uDustIntensity * 0.25;
  return mix(col, horizonCol, clamp(hazeAmt, 0.0, 1.0));
}

vec3 applyWetness(vec3 col) {
  // Wet sand absorbs more light → darker + slightly more saturated.
  // Real effect: sand reflectance drops from ~0.4 dry to ~0.2 wet.
  float w = clamp(uWetness, 0.0, 1.0);
  return col * (1.0 - 0.45 * w);
}

// Diffuse-sky (skylight) level — SINGLE SOURCE OF TRUTH for how much ambient
// the (overcast) sky dome contributes. Used by BOTH the open surface and the
// cave interior so the two stay in lock-step: a cave mouth gets the same sky
// radiance the desert does (scaled by how much sky it sees), never more.
float skylightLevel() {
  return mix(0.0, 0.18, smoothstep(0.4, 1.0, uCloudCover));
}

// ---------------------------------------------------------------------------
// Rain — world-anchored angular streaks with scene-depth occlusion.
//
// The streak pattern is generated in (azimuth, elevation) space of the
// WORLD ray direction. When the camera rotates, the same drops in the
// world stay in their angular positions — rain doesn't slide with the
// camera frame.
//
// Three "depth layers" at conceptual distances 5m / 20m / 60m. Each
// layer is independently gated by the pixel's scene depth (sceneT):
// if a solid scene point is closer than the layer's depth, that layer
// is suppressed at this pixel — the rain doesn't fly through the
// object. Slanted rain (mat2 rotation by wind angle) makes streaks
// lean with the wind; the rotation naturally lets near-camera drops
// reach pixels slightly tucked under an object's lower edge depending
// on the slant angle.
//
// This is the standard cheap pixel-art rain optimisation: noise-driven
// world-anchored pattern + depth gate. No per-drop physics, no
// uniform-array bandwidth, but reads as real rain.
// ---------------------------------------------------------------------------

// Closest approach of ray (ro, rd) to segment AB. Returns dist, ray
// parameter t (rayT), and segment parameter s (segS) — 0 at A (head),
// 1 at B (tail). Struct return — avoids the out-parameter compile
// issues some drivers hit.
struct RaySegHit { float dist; float rayT; float segS; };

RaySegHit raySegDist(vec3 ro, vec3 rd, vec3 A, vec3 B) {
  vec3 D = B - A;
  vec3 R = ro - A;
  float a = dot(rd, rd);
  float b = dot(rd, D);
  float c = dot(D, D);
  float d = dot(rd, R);
  float e = dot(D, R);
  float det = a * c - b * b;
  float s, t;
  if (det > 1e-6) {
    s = clamp((b * d - a * e) / -det, 0.0, 1.0);
    t = (b * s - d) / a;
  } else {
    s = 0.5;
    t = max(0.0, -d / a);
  }
  t = max(t, 0.0);
  vec3 onRay = ro + rd * t;
  vec3 onSeg = A + D * s;
  RaySegHit h;
  h.dist = length(onRay - onSeg);
  h.rayT = t;
  h.segS = s;
  return h;
}

// Iterate every active drop. For each:
//   - Broad-phase: skip drops behind camera / past sceneT / way off ray.
//   - Narrow: ray-vs-segment distance to the motion-blur trail.
//   - Streak width is DISTANCE-SCALED so on screen every drop reads as
//     ~2px wide, no matter how close or far — proper rain look at any
//     range instead of fat blob near, invisible far.
// Trail length 0.18 s × 16 m/s = ≈2.9 m streak, projects to visible
// long line on screen — sells motion blur even with low frame velocity.
float rainParticles(vec3 ro, vec3 rd, float sceneT) {
  if (uRainDropCount <= 0) return 0.0;
  float maxT = sceneT > 0.0 ? sceneT : 1e9;
  float r = 0.0;
  for (int i = 0; i < MAX_RAIN_DROPS; i++) {
    if (i >= uRainDropCount) break;
    vec4 drop = fetchRainDrop(i);
    vec3 head = drop.xyz;
    float dropVy = drop.w;
    vec3 trail = vec3(uRainVelocity.x, dropVy, uRainVelocity.z) * (0.18 * uRainLengthMul);
    vec3 off = head - ro;
    float tproj = dot(off, rd);
    if (tproj < 0.5 || tproj > maxT) continue;
    float perpSq = dot(off, off) - tproj * tproj;
    // Broad-phase radius scales with distance — streak width grows
    // linearly with t, so cull window must too.
    float maxPerp = 0.10 + tproj * 0.008;
    if (perpSq > maxPerp * maxPerp * 4.0) continue;
    // Constant world-space motion-blur trail. Projected to screen the
    // trail length is world_trail * focal / distance — so close drops
    // automatically get LONG streaks (they're moving fast on screen)
    // and far drops get short streaks. That's the physically correct
    // perspective; trying to "decouple" speed from distance produced
    // the opposite-of-real-life "drops slow down near the ground" bug.
    vec3 tail = head - trail;
    RaySegHit h = raySegDist(ro, rd, head, tail);
    if (h.rayT > maxT) continue;
    float threshold = max(0.06, h.rayT * 0.005) * uRainWidthMul;
    if (h.dist < threshold) {
      float widthFade = smoothstep(threshold, 0.0, h.dist);
      // Head-to-tail gradient: bottom 30% (head, segS small) fully
      // opaque, top 70% (toward tail) fades from 1 → 0.
      float lenFade = (h.segS < 0.30)
        ? 1.0
        : 1.0 - (h.segS - 0.30) / 0.70;
      r = max(r, widthFade * lenFade);
    }
  }
  return r;
}

// Approximate shadow cast on the ground by overhead NPCs and solid
// features. Real per-pixel shadow rays toward each object are
// expensive; instead we drop a soft "blob" — a smooth darkening
// circle on the ground beneath each object, fading with height
// difference. Cheap and reads like a real ground-contact shadow.
float objectGroundShadow(vec3 p) {
  float shadow = 1.0;
  // NPCs.
  for (int i = 0; i < MAX_NPCS; i++) {
    if (i >= uNpcCount) break;
    vec3 c = uNpcs[i].xyz;
    float r = uNpcs[i].w;
    if (c.y < p.y) continue;
    float dxz = length(p.xz - c.xz);
    float reach = r * 2.4;
    float strength = smoothstep(reach, r * 0.5, dxz);
    float heightFade = exp(-(c.y - p.y) / max(r * 8.0, 1.0));
    shadow *= 1.0 - 0.33 * strength * heightFade;
  }
  // Solids (arches / spires). Larger radius — they have visible footprints.
  for (int i = 0; i < MAX_SOLIDS; i++) {
    if (i >= uSolidCount) break;
    vec4 sol = uSolids[i];
    float scale = (sol.w - float(int(sol.w / 100.0)) * 100.0) / 10.0;
    vec3 c = sol.xyz;
    // Use a heuristic radius based on scale.
    float r = 10.0 * scale;
    if (c.y + r < p.y) continue;
    float dxz = length(p.xz - c.xz);
    float reach = r * 1.5;
    float strength = smoothstep(reach, r * 0.4, dxz);
    float heightFade = exp(-(c.y + r - p.y) / max(r * 6.0, 1.0));
    shadow *= 1.0 - 0.27 * strength * heightFade;
  }
  return clamp(shadow, 0.0, 1.0);
}

// Point-light contribution from an active bolt: midpoint of the bolt
// path acts as a cool-white light source illuminating the terrain from
// its world position. Inverse-square falloff with a small floor.
vec3 boltGroundLight(vec3 p, vec3 n) {
  if (uBoltIntensity <= 0.001) return vec3(0.0);
  vec3 toLight = uBoltLight - p;
  float d = length(toLight);
  vec3 dir = toLight / max(d, 0.001);
  float ndl = max(0.0, dot(n, dir));
  float falloff = 1.0 / (1.0 + 0.0001 * d * d);
  return uBoltColor * uBoltIntensity * ndl * falloff * 70.0;
}

// Draw the lightning bolt by computing the closest screen distance from
// this fragment to any of the bolt's projected line segments. Within a
// few pixels the bolt is solid bright; outside, a soft glow.
vec3 boltOverlay(vec3 col, vec3 rd, float sceneT) {
  if (uBoltIntensity <= 0.001 || uBoltCount < 2) return col;
  vec2 frag = gl_FragCoord.xy;
  float minD = 1e10;
  float boltDepth = 1e9; // camera-forward depth of the nearest channel point
  for (int i = 0; i < MAX_BOLT_PTS - 1; i++) {
    if (i + 1 >= uBoltCount) break;
    vec4 a = uBolt2D[i];
    vec4 b = uBolt2D[i + 1];
    if (a.w < 0.5 || b.w < 0.5) continue;
    vec2 d = b.xy - a.xy;
    float len = length(d);
    if (len < 0.5) continue;
    vec2 dir = d / len;
    float s = clamp(dot(frag - a.xy, dir), 0.0, len);
    vec2 closest = a.xy + dir * s;
    float dd = length(frag - closest);
    if (dd < minD) {
      minD = dd;
      boltDepth = mix(a.z, b.z, s / len); // a.z/b.z = camera-forward depth
    }
  }
  // Depth occlusion: a surface in front of the bolt hides it. sceneT is the
  // ray distance; convert to camera-forward depth to compare with boltDepth.
  if (sceneT > 0.0) {
    vec3 fwd = vec3(cos(uPitch) * sin(uYaw), sin(uPitch), cos(uPitch) * cos(uYaw));
    float sceneDepth = sceneT * max(dot(rd, fwd), 0.05);
    if (sceneDepth < boltDepth) return col;
  }
  float core = smoothstep(1.8, 0.0, minD);
  float glow = smoothstep(8.0, 1.8, minD) * 0.45;
  float alpha = (core + glow) * uBoltIntensity;
  return mix(col, uBoltColor, clamp(alpha, 0.0, 1.0));
}

// Camera-mounted light ("flashlight"). Inverse-square-ish falloff over
// uLightRange. Two stackable components selected by uLightMode:
//   soft  (2,3) — gentle omni fill so nearby surfaces read in the dark;
//   cone  (1,3) — bright focused beam along the camera's forward axis.
// This is what makes the unlit cave interior visible.
vec3 cameraLight(vec3 p, vec3 n) {
  if (uLightMode <= 0) return vec3(0.0);
  vec3 toEye = uEye - p;
  float d = length(toEye);
  vec3 dir = toEye / max(d, 0.001);          // surface → eye
  float k = d / max(uLightRange, 1.0);
  float atten = 1.0 / (1.0 + k * k);
  vec3 c = vec3(0.0);

  if (uLightMode == 2 || uLightMode == 3) {
    // Wrap-diffuse so faces angled away from the camera aren't pure black.
    float ndl = clamp(dot(n, dir) * 0.5 + 0.5, 0.0, 1.0);
    c += uLightColor * ndl * atten * 0.85;
  }
  if (uLightMode == 1 || uLightMode == 3) {
    vec3 fwd = vec3(cos(uPitch) * sin(uYaw), sin(uPitch), cos(uPitch) * cos(uYaw));
    float ca = dot(fwd, -dir);               // align beam with view axis
    float cone = smoothstep(0.86, 0.96, ca); // ~30°→16° soft-edged cone
    float ndl = max(dot(n, dir), 0.0);
    c += uLightColor * cone * (ndl * 0.8 + 0.2) * atten * 1.9;
  }
  return c;
}

// --- Interactive effects ---------------------------------------------------

// Echolocation: expanding shell of cool light from the ping origin. A thin
// bright band passes over surfaces as the wavefront sweeps out, fading with
// age. Additive — reveals geometry in the dark like sonar.
vec3 echoGlow(vec3 p) {
  if (uEchoAge < 0.0) return vec3(0.0);
  float R = uEchoAge * 26.0;                       // wavefront radius (m/s)
  float band = abs(length(p - uEchoOrigin) - R);
  float ring = smoothstep(3.5, 0.0, band);         // ~3.5 m thick shell
  float life = exp(-uEchoAge * 0.5);               // fade over ~2 s
  return vec3(0.45, 0.85, 1.0) * ring * life * 1.7;
}

// Thrown glow orbs as point lights on a surface (inverse-square falloff).
vec3 orbLight(vec3 p, vec3 n) {
  vec3 c = vec3(0.0);
  for (int i = 0; i < MAX_ORBS; i++) {
    if (i >= uOrbCount) break;
    vec3 to = uOrbs[i].xyz - p;
    float d = length(to);
    vec3 dir = to / max(d, 0.001);
    float ndl = max(dot(n, dir), 0.0) * 0.7 + 0.3; // wrap fill
    float atten = 1.0 / (1.0 + 0.06 * d * d);
    c += uOrbColor * ndl * atten;
  }
  return c * 6.0;
}

// Draw the orbs themselves: emissive balls with a soft halo, depth-tested
// against the scene so they sit in the world.
vec3 orbOverlay(vec3 col, vec3 ro, vec3 rd, float sceneT) {
  float maxT = sceneT > 0.0 ? sceneT : 1e9;
  for (int i = 0; i < MAX_ORBS; i++) {
    if (i >= uOrbCount) break;
    vec3 oc = uOrbs[i].xyz;
    float r = uOrbs[i].w;
    vec3 to = oc - ro;
    float tca = dot(to, rd);
    if (tca < 0.0 || tca > maxT) continue;
    float d = sqrt(max(dot(to, to) - tca * tca, 0.0));
    if (d < r) {
      col = mix(col, uOrbColor * 3.0, 0.92);       // bright emissive core
    } else {
      col += uOrbColor * smoothstep(r * 5.0, r, d) * 0.6; // halo
    }
  }
  return col;
}

// Cave sense: probe behind a surface hit along the view ray for cave void;
// returns 0..1 proximity glow so caves "show through" the rock when active.
float caveSenseGlow(vec3 p, vec3 rd) {
  if (uCaveSense < 0.5 || uCaveSegCount <= 0) return 0.0;
  float t = 1.0;
  for (int i = 0; i < 24; i++) {
    float dc = caveSDF(p + rd * t);
    if (dc < 0.0) return clamp(1.0 - t / 45.0, 0.0, 1.0);
    t += max(dc, 1.0);
    if (t > 45.0) break;
  }
  return 0.0;
}

// 3-octave value-noise fbm — organic, non-repeating field for the heat haze.
float hazeFbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) {
    v += vnoise(p) * a;
    p = p * 2.13 + vec2(1.7, 9.3);
    a *= 0.5;
  }
  return v; // ~[0,1], mean ~0.5
}

// Heat haze: refract the view ray with a turbulent, rising shimmer. Real
// mirage is invisible up close and builds with distance (refraction
// accumulates along the path), so amplitude is GATED BY DISTANCE: ~0 for rays
// hitting the sand near your feet, ramping to full toward the horizon
// (distance = cheap analytic ray-to-ground estimate, no second trace). The
// displacement comes from fbm noise (not plain sines) so the pattern reads as
// natural turbulent air rather than regular waves. Domain is world-anchored
// (rd) and scrolls upward over time — hot air rising.
vec3 applyHeatHaze(vec3 rd) {
  if (uHeatHaze <= 0.001) return rd;
  float lowness = smoothstep(0.30, -0.05, rd.y);   // only low/horizon rays
  if (lowness <= 0.0) return rd;
  // Distance to the sea-base plane along this ray (large for horizon rays).
  float tEst = rd.y < -0.001 ? uEye.y / (-rd.y) : 400.0;
  float distGate = smoothstep(15.0, 150.0, tEst);  // 0 near the camera → 1 far
  float amp = uHeatHaze * 0.05 * lowness * distGate;
  if (amp <= 0.0) return rd;
  // World-anchored, seam-free domain: fine vertical detail (rising bands),
  // coarser horizontal. rise = upward scroll over time.
  float rise = uTime * 1.5;
  vec2 base = vec2(rd.x * 7.0 + rd.z * 3.3, rd.y * 16.0 - rise);
  float nx = hazeFbm(base) - 0.5;
  float ny = hazeFbm(base * 1.27 + vec2(37.0, 5.0)) - 0.5;   // decorrelated
  rd.x += nx * amp;
  rd.y += ny * amp * 1.3;
  return normalize(rd);
}

// ===========================================================================
// QUEST CAVE — authored two-room honeycomb hollow, lit by glowing roots.
// All geometry is hardcoded (it's an authored set, not procedural). The hollow
// is carved from solid rock; the camera lives inside it, so we sphere-march the
// rock boundary from the inside. Kept entirely separate from the surface world.
// ===========================================================================

// Layout (world coords). Rooms are squashed ellipsoids; a flat floor slab cuts
// them off at QFLOOR so the player has level ground (CPU mirror walks on it).
const float QFLOOR = -32.0;
const vec3  QROOM_A = vec3(0.0, -28.5, 6.0);   // start room
const vec3  QROOM_B = vec3(0.0, -28.5, -16.0); // goo-hole room
const float QRAD_A = 7.0;
const float QRAD_B = 8.0;

float qsmin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

// Hollow union (negative inside the open space, before the floor cut).
float qCellsSDF(vec3 p) {
  float a = length((p - QROOM_A) / vec3(1.25, 1.0, 1.25)) - QRAD_A;
  float b = length((p - QROOM_B) / vec3(1.3, 1.0, 1.3)) - QRAD_B;
  // Corridor joining the two rooms, a touch above the floor.
  vec3 ca = vec3(0.0, QFLOOR + 2.4, QROOM_A.z - 2.0);
  vec3 cb = vec3(0.0, QFLOOR + 2.4, QROOM_B.z + 2.0);
  float c = sdSeg(p, ca, cb, 3.0);
  float d = qsmin(a, b, 3.5);
  return qsmin(d, c, 2.5);
}

// Open region: inside a cell AND above the floor slab. <0 = open air.
float qOpenSDF(vec3 p) {
  return max(qCellsSDF(p), QFLOOR - p.y);
}

// Glowing root tendrils hanging from the ceilings into both rooms.
float qRootSDF(vec3 p) {
  float d = 1e9;
  d = min(d, sdSeg(p, QROOM_A + vec3(-3.4, 6.5, 2.2), QROOM_A + vec3(-3.0, 0.6, 2.6), 0.16));
  d = min(d, sdSeg(p, QROOM_A + vec3(3.6, 6.5, -1.6), QROOM_A + vec3(3.1, 0.4, -1.4), 0.13));
  d = min(d, sdSeg(p, QROOM_A + vec3(0.4, 6.8, 4.2), QROOM_A + vec3(0.3, 1.6, 4.6), 0.10));
  d = min(d, sdSeg(p, QROOM_B + vec3(-2.6, 7.2, 1.6), QROOM_B + vec3(-1.6, -3.0, 0.6), 0.17));
  d = min(d, sdSeg(p, QROOM_B + vec3(2.8, 7.2, -2.0), QROOM_B + vec3(1.8, -2.6, -0.8), 0.14));
  d = min(d, sdSeg(p, QROOM_B + vec3(0.0, 7.5, 2.6), QROOM_B + vec3(0.0, 0.5, 1.2), 0.11));
  return d;
}

vec3 qOpenNormal(vec3 p) {
  vec2 e = vec2(0.03, 0.0);
  return normalize(vec3(
    qOpenSDF(p + e.xyy) - qOpenSDF(p - e.xyy),
    qOpenSDF(p + e.yxy) - qOpenSDF(p - e.yxy),
    qOpenSDF(p + e.yyx) - qOpenSDF(p - e.yyx)));
}

vec3 qRootNormal(vec3 p) {
  vec2 e = vec2(0.02, 0.0);
  return normalize(vec3(
    qRootSDF(p + e.xyy) - qRootSDF(p - e.xyy),
    qRootSDF(p + e.yxy) - qRootSDF(p - e.yxy),
    qRootSDF(p + e.yyx) - qRootSDF(p - e.yyx)));
}


void main() {
  vec3 ro = uEye;
  vec3 rd = applyHeatHaze(computeRayDir());

  int sceneType = 0;
  float th = trace(ro, rd, sceneType);
  float maxT = (th > 0.0) ? th : MAX_DIST;
  NpcHit nh = traceNpcs(ro, rd, maxT);
  HeroHit heroH = traceHero(ro, rd, maxT);

  vec3 col;

  bool heroWins = heroH.t > 0.0 && (nh.t <= 0.0 || heroH.t <= nh.t);
  if (heroWins) {
    // Cutscene figure: a dark traveller silhouette against the bright desert.
    vec3 p = ro + rd * heroH.t;
    vec3 n = heroH.normal;
    float directFactor = 1.0 - smoothstep(0.70, 0.80, uCloudCover);
    float ndotl = max(0.0, dot(n, uSunDir));
    float sh    = directFactor > 0.001 ? softShadow(p + n * 0.5, uSunDir) : 1.0;
    float ao    = calcAO(p, n);
    float cloudShadow = directFactor > 0.001 ? groundCloudShadow(p, uTime) : 1.0;
    float skylight = skylightLevel();
    float dirAmb = 0.30 + 0.70 * max(n.y, 0.0);
    float direct = DIRECTIONAL * ndotl * sh * cloudShadow * directFactor;
    float lit = AMBIENT * ao + skylight * dirAmb * ao + direct;
    col = uHeroColor * lit + uHeroColor * cameraLight(p, n);
    col = mix(col, col * vec3(0.78, 0.85, 0.95), clamp(uStormness, 0.0, 1.0) * 0.45);
    col = applyHaze(col, heroH.t);
  } else if (nh.t > 0.0) {
    vec3 p = ro + rd * nh.t;
    vec3 n = nh.normal;
    float directFactor = 1.0 - smoothstep(0.70, 0.80, uCloudCover);
    float ndotl = max(0.0, dot(n, uSunDir));
    float sh    = directFactor > 0.001 ? softShadow(p + n * 0.5, uSunDir) : 1.0;
    float ao    = calcAO(p, n);
    float cloudShadow = directFactor > 0.001 ? groundCloudShadow(p, uTime) : 1.0;
    float ambBoost = 1.0 + uCloudCover * 0.85;
    float direct  = 0.78 * ndotl * sh * cloudShadow * directFactor;
    float lit     = 0.22 * ao * ambBoost + direct;
    col = uNpcColor * lit + boltGroundLight(p, n) + uNpcColor * cameraLight(p, n);
    col = mix(col, col * vec3(0.78, 0.85, 0.95), clamp(uStormness, 0.0, 1.0) * 0.45);
    col = applyWetness(col);
    col += uNpcColor * orbLight(p, n) + echoGlow(p);
    col = applyHaze(col, nh.t);
  } else if (sceneType == 2) {
    vec3 p = ro + rd * th;
    vec3 n = solidNormal(p);
    // A solid-type hit is an editor placement when the placement field wins
    // here — colour it per-instance instead of the procedural rock colour.
    vec3 pcol;
    float dPlace = placeNearest(p, pcol);
    vec3 sbase = (dPlace < solidProcSDF(p)) ? pcol : uSolidColor;
    float directFactor = 1.0 - smoothstep(0.70, 0.80, uCloudCover);
    float ndotl = max(0.0, dot(n, uSunDir));
    float sh    = directFactor > 0.001 ? softShadow(p + n * 0.5, uSunDir) : 1.0;
    float ao    = calcAO(p, n);
    float cloudShadow = directFactor > 0.001 ? groundCloudShadow(p, uTime) : 1.0;
    float ambBoost = 1.0 + uCloudCover * 0.85;
    float direct  = 0.82 * ndotl * sh * cloudShadow * directFactor;
    float lit     = 0.18 * ao * ambBoost + direct;
    col = sbase * lit + boltGroundLight(p, n) + sbase * cameraLight(p, n);
    col = mix(col, col * vec3(0.78, 0.85, 0.95), clamp(uStormness, 0.0, 1.0) * 0.45);
    col = applyWetness(col);
    col += sbase * orbLight(p, n) + echoGlow(p);
    col += vec3(0.2, 0.7, 1.0) * caveSenseGlow(p, rd) * (0.6 + 0.4 * sin(uTime * 5.0));
    col = applyHaze(col, th);
  } else if (sceneType == 1) {
    vec3 p = ro + rd * th;
    vec3 n = normalAt(p, th);
    float directFactor = 1.0 - smoothstep(0.70, 0.80, uCloudCover);
    float ndotl = max(0.0, dot(n, uSunDir));
    float sh    = directFactor > 0.001 ? softShadow(p + n * 0.5, uSunDir) : 1.0;
    float ao    = calcAO(p, n);
    float cloudShadow = directFactor > 0.001 ? groundCloudShadow(p, uTime) : 1.0;
    // Blob shadow from any overhead NPC / solid feature — gives the
    // ground a soft contact darkening under objects, even when the sun
    // is hidden and casts no sharp shadow.
    float objShadow = objectGroundShadow(p);
    // Skylight: gentle dome of diffuse light from above (kicks in past
    // ~40% cover). 0.6 + 0.4·n.y keeps downward-facing surfaces lit at
    // ~20% so terrain depth reads via AO and orientation, not via
    // hard self-shadowing.
    // Strong directional skylight — upward-facing surfaces (dune tops,
    // flat ground) get full light, sloped/down-facing ones get much less.
    // 0.20 minimum keeps undersides visible but clearly darker. Wider
    // range = more contrast = readable dune shape under overcast where
    // there's no sun shadow to do the job.
    float dirAmb   = 0.20 + 0.80 * max(n.y, 0.0);
    // Overcast skylight is dimmer than full sun, not brighter — clouds
    // diffuse the sun's energy, they don't add more. Peak 0.30 at full
    // cover keeps the world clearly dimmer than direct-sun lighting.
    // Overcast is dimmer than full sun. Peak skylight 0.18 + AMBIENT 0.125
    // → total ambient ≈ 0.30 at full overcast, vs ~0.88 sun-lit max.
    // Cloudy world stays clearly darker than a sunny one.
    float skylight = skylightLevel();
    float direct   = DIRECTIONAL * ndotl * sh * cloudShadow * directFactor;
    float lit      = (AMBIENT * ao + skylight * dirAmb * ao + direct) * objShadow;
    col = sandColor(lit) * sandPatchTint(p.xz) + boltGroundLight(p, n)
        + sandColor(0.6) * cameraLight(p, n);
    col = mix(col, col * vec3(0.78, 0.85, 0.95), clamp(uStormness, 0.0, 1.0) * 0.45);
    col = applyWetness(col);
    col += sandColor(0.7) * orbLight(p, n) + echoGlow(p);
    col += vec3(0.2, 0.7, 1.0) * caveSenseGlow(p, rd) * (0.6 + 0.4 * sin(uTime * 5.0));
    col = applyHaze(col, th);
  } else if (sceneType == 3 || sceneType == 4) {
    // Cave wall (interior rock face). Lit by: daylight that physically finds
    // its way in through the mouths (direct sun shafts + skylight leak),
    // plus the camera lamp. Deep, enclosed rock stays dark — that's what the
    // flashlight is for — but openings are no longer flat black holes.
    vec3 p = ro + rd * th;
    vec3 n = -caveNormal(p);          // face into the hollow (toward light/eye)
    vec3 pv = p + n * 0.3;            // nudge visibility rays just inside the void
    float directFactor = 1.0 - smoothstep(0.70, 0.80, uCloudCover);

    // Direct sun: a hard-ish shaft reaching rock the sun can actually see
    // through an opening — bright sunlit patches near entrances.
    float ndlSun = max(dot(n, uSunDir), 0.0);
    float sun = 0.0;
    if (uSunDir.y > 0.02 && directFactor > 0.001 && ndlSun > 0.0) {
      sun = DIRECTIONAL * ndlSun * caveEscape(pv, uSunDir) * directFactor;
    }
    // Skylight leak: the SAME sky-diffuse the open surface receives
    // (AMBIENT + skylightLevel()), scaled by how much sky this point sees
    // through the mouths. This keeps the cave entrance in lock-step with the
    // desert — in overcast both dim together, so the mouth never glows.
    float skyVis = caveEscape(pv, normalize(n + vec3(0.0, 1.3, 0.0)));
    float ambient = 0.03 + (AMBIENT + skylightLevel()) * skyVis;

    float lit = ambient + sun;
    // Same desert palette + patch texture as the surface sand, just darker —
    // the cave is the same material, underground and in shade.
    col = sandColor(lit) * sandPatchTint(p.xz) * 0.65;
    col += sandColor(0.6) * cameraLight(p, n);
    col += boltGroundLight(p, n);
    col += sandColor(0.7) * orbLight(p, n) + echoGlow(p);
    col = applyHaze(col, th);
  } else {
    // Sky path: gradient → weather-modulated tint → stars → sun → clouds
    // composited on top using the SAME tint so they're part of the same
    // atmosphere instead of looking pasted on.
    float st = skyT(rd);
    vec3 skyTint = applyWeatherToSky(skyColor(rd, st));
    col = skyTint;
    col += starOverlay(rd);
    col = sunOverlay(col);
    CloudSample cs = sampleCumulus(rd, uTime);
    if (cs.alpha > 0.001) {
      vec3 cCol = cloudColor(rd, cs.density, cs.threshold, skyTint);
      // Near-horizon: pull cloud color toward the sky's own horizon tint
      // so distant clouds dissolve into the haze rather than ending in a
      // hard line. Reads as the cloud layer curving down behind the
      // horizon, not a flat ceiling chopped off.
      vec3 hazeCol = applyWeatherToSky(texture(uSkyPal, vec2(0.999, 0.5)).rgb);
      float horizFade = 1.0 - smoothstep(0.0, 0.35, rd.y);
      cCol = mix(cCol, hazeCol, horizFade * 0.65);
      col = mix(col, cCol, cs.alpha);
    }
  }

  // Nearest scene depth (terrain/solid/cave + NPC). Used to occlude both the
  // lightning bolt and the rain so neither renders through closer surfaces.
  float thEff = th    > 0.0 ? th    : 1e9;
  float nhEff = nh.t  > 0.0 ? nh.t  : 1e9;
  float sceneT = min(thEff, nhEff);
  if (sceneT >= 1e9) sceneT = -1.0;  // pure sky — unoccluded

  col = boltOverlay(col, rd, sceneT);
  col = orbOverlay(col, ro, rd, sceneT);

  float rainAlpha = rainParticles(uEye, rd, sceneT);
  // Rain colour MERGES with the current pixel — wet streak = brighter
  // tint of whatever's behind, not a separate sprite. Sharp 1-px
  // centre line is pushed toward white for the wet-bead look (the
  // body of the streak has the soft tint, the very middle a clean
  // bright core).
  if (rainAlpha > 0.001) {
    // Streak body: 50/50 mix of clean wet-bead colour and the pixel
    // behind. Drops carry the colour of whatever's behind them while
    // still reading as drops.
    vec3 wetBead = vec3(0.93, 0.96, 1.00);
    vec3 body = mix(wetBead, col, 0.5);
    // 1-px central core pushed nearly pure white.
    float core = smoothstep(0.70, 1.0, rainAlpha);
    vec3 lit = mix(body, vec3(1.0), core * 0.80);
    col = mix(col, lit, clamp(rainAlpha * uRainAlpha, 0.0, 1.0));
  }

  fragColor = vec4(col, 1.0);
}
`;

// ---------------------------------------------------------------------------
// Sun projection + colors (port from src/render/sun.js)
// ---------------------------------------------------------------------------

function sampleStops(stops, elev) {
  if (elev >= stops[0].e) return stops[0].c;
  if (elev <= stops[stops.length - 1].e) return stops[stops.length - 1].c;
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (elev <= a.e && elev >= b.e) {
      const t = (a.e - elev) / (a.e - b.e);
      return [
        a.c[0] + (b.c[0] - a.c[0]) * t,
        a.c[1] + (b.c[1] - a.c[1]) * t,
        a.c[2] + (b.c[2] - a.c[2]) * t,
      ];
    }
  }
  return stops[0].c;
}

const SUN_CORE_STOPS = [
  { e: 0.6, c: [255, 248, 210] },
  { e: 0.3, c: [255, 222, 130] },
  { e: 0.08, c: [255, 158, 70] },
  { e: 0.0, c: [232, 96, 56] },
];

const SUN_HALO_STOPS = [
  { e: 0.6, c: [255, 230, 160] },
  { e: 0.3, c: [255, 180, 90] },
  { e: 0.08, c: [240, 120, 60] },
  { e: 0.0, c: [200, 70, 40] },
];

/**
 * Project sun.dir (world space) into framebuffer pixel coords via the same
 * yaw + pitch rotation the shader applies to rays — just inverted. Returns
 * { visible: false } if sun is below horizon or behind camera.
 */
function projectSun(sun, camera, W, H) {
  if (sun.dir[1] <= -0.08) return { visible: false };

  const cy = Math.cos(camera.yaw);
  const sy = Math.sin(camera.yaw);
  // Inverse yaw around Y (shader's forward yaw rotates +Z toward +X, so
  // inverse rotates world sun back into camera-local-yaw=0 frame).
  const x1 = sun.dir[0] * cy - sun.dir[2] * sy;
  const y1 = sun.dir[1];
  const z1 = sun.dir[0] * sy + sun.dir[2] * cy;

  // Inverse pitch around X (shader's forward pitch rotates +Z toward +Y).
  const cp = Math.cos(camera.pitch);
  const sp = Math.sin(camera.pitch);
  const x2 = x1;
  const y2 = y1 * cp - z1 * sp;
  const z2 = y1 * sp + z1 * cp;

  if (z2 <= 0.05) return { visible: false };

  // Pinhole projection. gl_FragCoord is bottom-up: y>0 in camera-local maps
  // to higher frag.y, so no sign flip needed.
  const sx = Math.round((x2 / z2) * camera.focal + W / 2);
  const sy_p = Math.round((y2 / z2) * camera.focal + H / 2);
  return { visible: true, sx, sy: sy_p };
}

// ---------------------------------------------------------------------------
// Polar rotation matrix for stars (axis tilted 55° from −Z toward +Y)
// ---------------------------------------------------------------------------

// Polar axis tilt = observer latitude. Izmail = 45.36° N → celestial pole
// sits 45.36° above the northern horizon, equatorial stars reach max alt
// of (90 - 45.36) = 44.64° at meridian.
const STAR_POLAR_LAT = (45.36 * Math.PI) / 180;
const STAR_POLAR_Y = Math.sin(STAR_POLAR_LAT);
const STAR_POLAR_Z = -Math.cos(STAR_POLAR_LAT);

/**
 * R_polar(-2π·t) via Rodrigues. Returned column-major for gl.uniformMatrix3fv.
 */
function polarMatrix(t) {
  const ang = -t * Math.PI * 2;
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const oneMC = 1 - c;
  const pX = 0;
  const pY = STAR_POLAR_Y;
  const pZ = STAR_POLAR_Z;
  const r00 = c + pX * pX * oneMC;
  const r01 = pX * pY * oneMC - pZ * s;
  const r02 = pX * pZ * oneMC + pY * s;
  const r10 = pY * pX * oneMC + pZ * s;
  const r11 = c + pY * pY * oneMC;
  const r12 = pY * pZ * oneMC - pX * s;
  const r20 = pZ * pX * oneMC - pY * s;
  const r21 = pZ * pY * oneMC + pX * s;
  const r22 = c + pZ * pZ * oneMC;
  // Column-major: col0=(r00,r10,r20), col1=(r01,r11,r21), col2=(r02,r12,r22).
  return new Float32Array([r00, r10, r20, r01, r11, r21, r02, r12, r22]);
}

// ---------------------------------------------------------------------------
// Palette → 1D texture helpers
// ---------------------------------------------------------------------------

function buildSandTexData(store) {
  const s = store.get();
  if (s.dayCycleEnabled) return blendedSandRamp(s.timeOfDay, SAND_N);
  const hex = SAND_PALETTES[s.sandPalette] ?? SAND_PALETTES.classic;
  return buildSandRamp(hex, SAND_N);
}

function buildSkyTexData(store) {
  const s = store.get();
  const stops = s.dayCycleEnabled
    ? blendedSkyStops(s.timeOfDay)
    : SKY_PALETTES[s.skyPalette] ?? SKY_PALETTES.classic;

  // Bake a SKY_N-long RGB ramp by sampling the stops linearly.
  const out = new Uint8ClampedArray(SKY_N * 3);
  const m = stops.length - 1;
  for (let i = 0; i < SKY_N; i++) {
    const u = i / (SKY_N - 1);
    // Find segment
    let seg = 0;
    while (seg < m && stops[seg + 1][0] < u) seg++;
    const a = stops[seg];
    const b = stops[Math.min(m, seg + 1)];
    const span = Math.max(1e-6, b[0] - a[0]);
    const lt = Math.min(1, Math.max(0, (u - a[0]) / span));
    const c0 = a[1];
    const c1 = b[1];
    out[i * 3] = c0[0] + (c1[0] - c0[0]) * lt;
    out[i * 3 + 1] = c0[1] + (c1[1] - c0[1]) * lt;
    out[i * 3 + 2] = c0[2] + (c1[2] - c0[2]) * lt;
  }
  return out;
}

function upload1DPalette(gl, tex, rgbBytes, n) {
  // Pack as RGBA (WebGL prefers it; some drivers misalign RGB).
  const rgba = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    rgba[i * 4] = rgbBytes[i * 3];
    rgba[i * 4 + 1] = rgbBytes[i * 3 + 1];
    rgba[i * 4 + 2] = rgbBytes[i * 3 + 2];
    rgba[i * 4 + 3] = 255;
  }
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, n, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

// ---------------------------------------------------------------------------
// Shader compile helpers
// ---------------------------------------------------------------------------

function compileShaderAsync(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh); // non-blocking: do NOT query COMPILE_STATUS here
  return sh;
}

// Kick off a NON-BLOCKING compile + link. With KHR_parallel_shader_compile the
// driver compiles on a background thread; we verify the result later (once
// completion is reported) in checkProgram. Querying status here would force a
// synchronous wait and freeze the tab — that's exactly what we avoid.
function linkProgramAsync(gl, vsSrc, fsSrc) {
  const vs = compileShaderAsync(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compileShaderAsync(gl, gl.FRAGMENT_SHADER, fsSrc);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  return { prog, vs, fs };
}

// Verify a completed compile/link; throw with the info log on failure.
function checkProgram(gl, prog, vs, fs) {
  if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
    throw new Error('Vertex shader compile failed: ' + gl.getShaderInfoLog(vs));
  }
  if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
    throw new Error('Fragment shader compile failed: ' + gl.getShaderInfoLog(fs));
  }
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error('Program link failed: ' + gl.getProgramInfoLog(prog));
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

// Max editor placements rendered in-world. MUST match `#define MAX_PLACE` in
// the fragment shader above.
const MAX_PLACE = 24;

export class GlPipeline {
  constructor(canvas, store) {
    this.canvas = canvas;
    this.store = store;
    this.width = canvas.width;
    this.height = canvas.height;

    const gl = canvas.getContext('webgl2', {
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 not available');
    this.gl = gl;

    // Kick off a NON-BLOCKING compile/link so the big shader compiles in the
    // background while the boot loading screen animates, instead of the tab
    // freezing for seconds. Finalised in _finishInit() once pollReady() sees
    // completion.
    this._parallelExt = gl.getExtension('KHR_parallel_shader_compile');
    const linked = linkProgramAsync(gl, VERT_SRC, FRAG_SRC);
    this.program = linked.prog;
    this._vs = linked.vs;
    this._fs = linked.fs;
    this._ready = false;
    this._sawPoll = false;
    this._initError = null;
    this._nightLevel = 0;
    this._t0 = performance.now();
  }

  // Finish GPU setup once the program has linked. Everything here needs the
  // linked program (attrib/uniform locations) or a configured GL context, so it
  // must run only after the compile completes — see pollReady().
  _finishInit() {
    const gl = this.gl;
    checkProgram(gl, this.program, this._vs, this._fs);
    gl.useProgram(this.program);

    // Full-screen quad
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]), // oversized triangle
      gl.STATIC_DRAW
    );
    const aPos = gl.getAttribLocation(this.program, 'aPos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    // Uniform locations
    const u = (name) => gl.getUniformLocation(this.program, name);
    this.u = {
      res: u('uRes'),
      eye: u('uEye'),
      yaw: u('uYaw'),
      pitch: u('uPitch'),
      tanHalfFov: u('uTanHalfFov'),
      focal: u('uFocal'),
      sunDir: u('uSunDir'),
      sandPal: u('uSandPal'),
      skyPal: u('uSkyPal'),
      skyBands: u('uSkyBands'),
      skyHeight: u('uSkyHeight'),
      time: u('uTime'),
      cellSize: u('uCellSize'),
      emptyRate: u('uEmptyRate'),
      duneLengthMin: u('uDuneLengthMin'),
      duneLengthMax: u('uDuneLengthMax'),
      duneHeightMin: u('uDuneHeightMin'),
      duneHeightMax: u('uDuneHeightMax'),
      seed: u('uSeed'),
      nightLevel: u('uNightLevel'),
      starsEnabled: u('uStarsEnabled'),
      polarMat: u('uPolarMat'),
      sunScreen: u('uSunScreen'),
      sunVisible: u('uSunVisible'),
      sunCore: u('uSunCore'),
      sunHalo: u('uSunHalo'),
      sunHaloAlpha: u('uSunHaloAlpha'),
      sunCoreR: u('uSunCoreR'),
      sunHaloR: u('uSunHaloR'),
      cloudCover: u('uCloudCover'),
      rainIntensity: u('uRainIntensity'),
      wetness: u('uWetness'),
      dustIntensity: u('uDustIntensity'),
      stormness: u('uStormness'),
      sunVisibility: u('uSunVisibility'),
      cloudAltitude: u('uCloudAltitude'),
      cloudScale: u('uCloudScale'),
      cloudMorphSpeed: u('uCloudMorphSpeed'),
      cloudWind: u('uCloudWind'),
      fog: u('uFog'),
      boltCount: u('uBoltCount'),
      bolt2D: u('uBolt2D[0]'),
      boltLight: u('uBoltLight'),
      boltIntensity: u('uBoltIntensity'),
      boltColor: u('uBoltColor'),
      rainWindX: u('uRainWindX'),
      rainDropCount: u('uRainDropCount'),
      rainDropsTex: u('uRainDropsTex'),
      rainVelocity: u('uRainVelocity'),
      rainColor: u('uRainColor'),
      rainAlpha: u('uRainAlpha'),
      rainLengthMul: u('uRainLengthMul'),
      rainWidthMul:  u('uRainWidthMul'),
      npcCount: u('uNpcCount'),
      npcs: u('uNpcs[0]'),
      npcColor: u('uNpcColor'),
      solidCount: u('uSolidCount'),
      solids: u('uSolids[0]'),
      solidRot: u('uSolidRot[0]'),
      solidColor: u('uSolidColor'),
      placeCount: u('uPlaceCount'),
      place: u('uPlace[0]'),
      placeKind: u('uPlaceKind[0]'),
      placeColor: u('uPlaceColor[0]'),
      spawnPlateauY: u('uSpawnPlateauY'),
      caveSegCount: u('uCaveSegCount'),
      caveSegA: u('uCaveSegA[0]'),
      caveSegB: u('uCaveSegB[0]'),
      caveBounds: u('uCaveBounds'),
      caveColor: u('uCaveColor'),
      lightMode: u('uLightMode'),
      lightRange: u('uLightRange'),
      lightColor: u('uLightColor'),
      heatHaze: u('uHeatHaze'),
      echoOrigin: u('uEchoOrigin'),
      echoAge: u('uEchoAge'),
      orbCount: u('uOrbCount'),
      orbs: u('uOrbs[0]'),
      orbColor: u('uOrbColor'),
      caveSense: u('uCaveSense'),
      resonOrigin: u('uResonOrigin'),
      resonAge: u('uResonAge'),
      heroVisible: u('uHeroVisible'),
      heroPos: u('uHeroPos'),
      heroYaw: u('uHeroYaw'),
      heroPhase: u('uHeroPhase'),
      heroFall: u('uHeroFall'),
      heroColor: u('uHeroColor'),
    };

    // Reusable buffers — avoid per-frame allocation.
    this._npcBuf   = new Float32Array(16 * 4);
    this._solidBuf = new Float32Array(16 * 4);
    this._boltBuf  = new Float32Array(24 * 4);

    // Rain drop texture (RGBA32F, 64×64 = up to 4096 drops).
    // Bound to texture unit 4. xyz=position, w=per-drop vy.
    this._rainTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this._rainTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 100, 100, 0, gl.RGBA, gl.FLOAT, null);
    this._solidRot = new Float32Array(16);
    this._placeBuf = new Float32Array(MAX_PLACE * 4);
    this._placeKind = new Float32Array(MAX_PLACE);
    this._placeColor = new Float32Array(MAX_PLACE * 3);
    // Cave capsule endpoints — 64 segments × vec4 each (xyz + radius).
    this._caveSegA = new Float32Array(64 * 4);
    this._caveSegB = new Float32Array(64 * 4);
    this._orbBuf   = new Float32Array(8 * 4);

    // Palette textures
    this.sandTex = gl.createTexture();
    this.skyTex = gl.createTexture();
    this.invalidateSand();
    this.invalidateSky();

    // Bind units once — they don't change.
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sandTex);
    gl.uniform1i(this.u.sandPal, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.skyTex);
    gl.uniform1i(this.u.skyPal, 1);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this._rainTex);
    gl.uniform1i(this.u.rainDropsTex, 4);

    gl.viewport(0, 0, this.width, this.height);

    this._t0 = performance.now();
    this._ready = true;
  }

  get ready() {
    return this._ready;
  }

  // Drive the parallel shader compile; returns true once GPU init is finished.
  // While the program is still compiling it returns false WITHOUT blocking, so
  // the caller can animate a loading screen each frame. Without the
  // KHR_parallel_shader_compile extension it falls back to a one-time blocking
  // finish (after letting the loading screen paint once).
  pollReady() {
    if (this._ready) return true;
    if (this._initError) throw this._initError;
    const gl = this.gl;
    const ext = this._parallelExt;
    if (ext) {
      if (!gl.getProgramParameter(this.program, ext.COMPLETION_STATUS_KHR)) return false;
    } else if (!this._sawPoll) {
      this._sawPoll = true; // let the loading screen paint before we block
      return false;
    }
    try {
      this._finishInit();
    } catch (e) {
      this._initError = e;
      throw e;
    }
    return this._ready;
  }

  setNightLevel(n) {
    this._nightLevel = n;
  }

  invalidateSand() {
    if (!this.sandTex) return; // not finished compiling yet — _finishInit builds it
    const data = buildSandTexData(this.store);
    upload1DPalette(this.gl, this.sandTex, data, SAND_N);
  }

  invalidateSky() {
    if (!this.skyTex) return; // not finished compiling yet — _finishInit builds it
    const data = buildSkyTexData(this.store);
    upload1DPalette(this.gl, this.skyTex, data, SKY_N);
  }

  render({ camera, sun, npcs = [], solids = [], placements = [], cave = null, light = null, spawnPlateauY = 0, fx = null, weather = null, time = null, fog = 0.3, bolt = null, rain = null, hero = null }) {
    if (!this._ready) return; // shader still compiling — frame loop shows the loader
    const gl = this.gl;
    const s = this.store.get();

    // Draw to the default framebuffer at full canvas resolution.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    gl.uniform2f(this.u.res, this.width, this.height);
    gl.uniform3f(this.u.eye, camera.x, s.cameraY, camera.z);
    gl.uniform1f(this.u.yaw, camera.yaw);
    gl.uniform1f(this.u.pitch, camera.pitch);
    gl.uniform1f(this.u.tanHalfFov, camera.tanHalfFov);
    gl.uniform1f(this.u.focal, camera.focal);
    gl.uniform3f(this.u.sunDir, sun.dir[0], sun.dir[1], sun.dir[2]);
    gl.uniform1f(this.u.skyBands, s.skyBands);
    gl.uniform1f(this.u.skyHeight, s.skyHeight);
    gl.uniform1f(this.u.time, time != null ? time : (performance.now() - this._t0) * 0.001);

    gl.uniform1f(this.u.cellSize, s.cellSize);
    gl.uniform1f(this.u.emptyRate, s.emptyRate);
    gl.uniform1f(this.u.duneLengthMin, s.duneLengthMin);
    gl.uniform1f(this.u.duneLengthMax, s.duneLengthMax);
    gl.uniform1f(this.u.duneHeightMin, s.duneHeightMin);
    gl.uniform1f(this.u.duneHeightMax, s.duneHeightMax);
    gl.uniform1i(this.u.seed, s.seed | 0);

    // Stars
    gl.uniform1f(this.u.nightLevel, this._nightLevel);
    gl.uniform1f(this.u.starsEnabled, s.starsEnabled ? 1 : 0);
    gl.uniformMatrix3fv(this.u.polarMat, false, polarMatrix(s.timeOfDay || 0));

    // Sun disc. Real angular size is 0.53° (~1.5 px), but a tiny dot
    // reads poorly on a low-res framebuffer; we scale the disc up
    // slightly and rely on the soft bloom for the rest. Core ~2.5 px
    // → ~5-6 px diameter.
    const SUN_ANG_R = (0.265 * Math.PI) / 180;
    const sunPxR = camera.focal * Math.tan(SUN_ANG_R);
    const coreR  = Math.max(2.5, sunPxR * 2.0);   // ~3 px → ~6 px diameter
    const haloR  = coreR + 8;                      // soft bloom
    gl.uniform1f(this.u.sunCoreR, coreR);
    gl.uniform1f(this.u.sunHaloR, haloR);

    const sp = projectSun(sun, camera, this.width, this.height);
    if (sp.visible) {
      const elev = sun.dir[1];
      const core = sampleStops(SUN_CORE_STOPS, elev);
      const halo = sampleStops(SUN_HALO_STOPS, elev);
      const haloAlpha = elev < 0.0 ? Math.max(0, (elev + 0.08) / 0.08) : 1;
      gl.uniform1f(this.u.sunVisible, 1);
      gl.uniform2f(this.u.sunScreen, sp.sx + 0.5, sp.sy + 0.5);
      gl.uniform3f(this.u.sunCore, core[0] / 255, core[1] / 255, core[2] / 255);
      gl.uniform3f(this.u.sunHalo, halo[0] / 255, halo[1] / 255, halo[2] / 255);
      gl.uniform1f(this.u.sunHaloAlpha, haloAlpha);
    } else {
      gl.uniform1f(this.u.sunVisible, 0);
    }

    // Weather uniforms.
    const w = weather || EMPTY_WEATHER;
    gl.uniform1f(this.u.cloudCover, w.cloudCover);
    gl.uniform1f(this.u.rainIntensity, w.rainIntensity);
    gl.uniform1f(this.u.wetness, w.surfaceWetness);
    gl.uniform1f(this.u.dustIntensity, w.dustIntensity);
    gl.uniform1f(this.u.stormness, w.stormness ?? 0);
    gl.uniform1f(this.u.sunVisibility, w.sunVisibility ?? 1);
    gl.uniform1f(this.u.cloudAltitude, w.cloudAltitudeM ?? 3000);
    gl.uniform1f(this.u.cloudScale, w.cloudScale ?? 800);
    gl.uniform1f(this.u.cloudMorphSpeed, w.cloudMorphSpeed ?? 0.04);
    gl.uniform2f(this.u.cloudWind, w.windDirX * w.windSpeed, w.windDirZ * w.windSpeed);
    gl.uniform1f(this.u.fog, Math.max(0, Math.min(1, fog)));

    // Rain wind tilt — project world wind onto camera's right vector,
    // then scale to pixels-per-second. ~18 px/s per m/s of wind gives
    // ~45° tilt at 10 m/s (base fall 180 px/s). Visually like real
    // wind-driven rain.
    const camRightX =  Math.cos(camera.yaw);
    const camRightZ = -Math.sin(camera.yaw);
    const windRight = (w.windDirX * camRightX + w.windDirZ * camRightZ) * w.windSpeed;
    gl.uniform1f(this.u.rainWindX, windRight * 18.0);

    // Rain particles — upload drop array to 64×64 RGBA32F texture.
    if (rain && rain.count > 0) {
      gl.uniform1i(this.u.rainDropCount, rain.count);
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, this._rainTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 100, 100, gl.RGBA, gl.FLOAT, rain.buffer);
      gl.uniform3f(this.u.rainVelocity, rain.velocity[0], rain.velocity[1], rain.velocity[2]);
    } else {
      gl.uniform1i(this.u.rainDropCount, 0);
      gl.uniform3f(this.u.rainVelocity, 0, -60, 0);
    }
    const rc = rain && rain.color ? rain.color : [0.55, 0.62, 0.76];
    gl.uniform3f(this.u.rainColor, rc[0], rc[1], rc[2]);
    gl.uniform1f(this.u.rainAlpha, rain && rain.alpha != null ? rain.alpha : 0.7);
    gl.uniform1f(this.u.rainLengthMul, rain && rain.lengthMul != null ? rain.lengthMul : 1.0);
    gl.uniform1f(this.u.rainWidthMul,  rain && rain.widthMul  != null ? rain.widthMul  : 1.0);

    // Lightning bolt
    if (bolt && bolt.intensity > 0.001) {
      const pts = bolt.points;
      const count = Math.min(pts.length, 24);
      for (let i = 0; i < count; i++) {
        const p = pts[i];
        this._boltBuf[i * 4]     = p[0];
        this._boltBuf[i * 4 + 1] = p[1];
        this._boltBuf[i * 4 + 2] = p[2];
        this._boltBuf[i * 4 + 3] = p[3];
      }
      for (let i = count * 4; i < this._boltBuf.length; i++) this._boltBuf[i] = 0;
      gl.uniform1i(this.u.boltCount, count);
      gl.uniform4fv(this.u.bolt2D, this._boltBuf);
      gl.uniform3f(this.u.boltLight, bolt.lightPos[0], bolt.lightPos[1], bolt.lightPos[2]);
      gl.uniform1f(this.u.boltIntensity, bolt.intensity);
      const c = bolt.color || [0.95, 0.97, 1.0];
      gl.uniform3f(this.u.boltColor, c[0], c[1], c[2]);
    } else {
      gl.uniform1i(this.u.boltCount, 0);
      gl.uniform1f(this.u.boltIntensity, 0);
      gl.uniform3f(this.u.boltColor, 0.95, 0.97, 1.0);
    }

    // NPCs
    const n = Math.min(npcs.length, 16);
    for (let i = 0; i < n; i++) {
      const npc = npcs[i];
      this._npcBuf[i * 4]     = npc.x;
      this._npcBuf[i * 4 + 1] = npc.y;
      this._npcBuf[i * 4 + 2] = npc.z;
      this._npcBuf[i * 4 + 3] = npc.r;
    }
    for (let i = n * 4; i < this._npcBuf.length; i++) this._npcBuf[i] = 0;
    gl.uniform1i(this.u.npcCount, n);
    gl.uniform4fv(this.u.npcs, this._npcBuf);
    gl.uniform3f(this.u.npcColor, 0.78, 0.32, 0.22);

    // Solid 3D features (M7)
    const m = Math.min(solids.length, 16);
    for (let i = 0; i < m; i++) {
      const sol = solids[i];
      this._solidBuf[i * 4]     = sol.x;
      this._solidBuf[i * 4 + 1] = sol.y;
      this._solidBuf[i * 4 + 2] = sol.z;
      this._solidBuf[i * 4 + 3] = sol.w;
      this._solidRot[i] = sol.rot || 0;
    }
    for (let i = m * 4; i < this._solidBuf.length; i++) this._solidBuf[i] = 0;
    for (let i = m; i < this._solidRot.length; i++) this._solidRot[i] = 0;
    gl.uniform1i(this.u.solidCount, m);
    gl.uniform4fv(this.u.solids, this._solidBuf);
    gl.uniform1fv(this.u.solidRot, this._solidRot);
    gl.uniform3f(this.u.solidColor, 0.45, 0.36, 0.30);

    // Editor placements — proxy primitives folded into solidSDF, per-instance colour.
    const pc = Math.min(placements.length, MAX_PLACE);
    for (let i = 0; i < pc; i++) {
      const pl = placements[i];
      this._placeBuf[i * 4] = pl.x;
      this._placeBuf[i * 4 + 1] = pl.y;
      this._placeBuf[i * 4 + 2] = pl.z;
      this._placeBuf[i * 4 + 3] = pl.scale ?? 1;
      this._placeKind[i] = pl.kind ?? 0;
      const c = pl.color ?? [0.8, 0.8, 0.8];
      this._placeColor[i * 3] = c[0];
      this._placeColor[i * 3 + 1] = c[1];
      this._placeColor[i * 3 + 2] = c[2];
    }
    for (let i = pc * 4; i < this._placeBuf.length; i++) this._placeBuf[i] = 0;
    for (let i = pc; i < this._placeKind.length; i++) this._placeKind[i] = 0;
    gl.uniform1i(this.u.placeCount, pc);
    gl.uniform4fv(this.u.place, this._placeBuf);
    gl.uniform1fv(this.u.placeKind, this._placeKind);
    gl.uniform3fv(this.u.placeColor, this._placeColor);
    gl.uniform1f(this.u.spawnPlateauY, spawnPlateauY);

    // Cave — capsule-graph subtraction (src/terrain/cave.js)
    const segs = cave?.segments ?? [];
    const cv = Math.min(segs.length, 64);
    for (let i = 0; i < cv; i++) {
      const s = segs[i];
      this._caveSegA[i * 4]     = s.ax;
      this._caveSegA[i * 4 + 1] = s.ay;
      this._caveSegA[i * 4 + 2] = s.az;
      this._caveSegA[i * 4 + 3] = s.ar;
      this._caveSegB[i * 4]     = s.bx;
      this._caveSegB[i * 4 + 1] = s.by;
      this._caveSegB[i * 4 + 2] = s.bz;
      this._caveSegB[i * 4 + 3] = s.br;
    }
    for (let i = cv * 4; i < this._caveSegA.length; i++) { this._caveSegA[i] = 0; this._caveSegB[i] = 0; }
    gl.uniform1i(this.u.caveSegCount, cv);
    gl.uniform4fv(this.u.caveSegA, this._caveSegA);
    gl.uniform4fv(this.u.caveSegB, this._caveSegB);
    if (cave?.bounds) {
      const b = cave.bounds;
      gl.uniform4f(this.u.caveBounds, b.cx, b.cy, b.cz, b.r);
    } else {
      gl.uniform4f(this.u.caveBounds, 0, 0, 0, -1);
    }
    gl.uniform3f(this.u.caveColor, 0.42, 0.36, 0.31);

    // Camera light ("flashlight")
    const lm = light?.mode | 0;
    gl.uniform1i(this.u.lightMode, lm);
    gl.uniform1f(this.u.lightRange, light?.range ?? 45);
    const lc = light?.color ?? [1.0, 0.95, 0.82];
    gl.uniform3f(this.u.lightColor, lc[0], lc[1], lc[2]);

    // Interactive effects (heat haze, echo, orbs, cave sense, resonance)
    gl.uniform1f(this.u.heatHaze, fx?.heatHaze ?? 0);
    const eo = fx?.echoOrigin ?? [0, 0, 0];
    gl.uniform3f(this.u.echoOrigin, eo[0], eo[1], eo[2]);
    gl.uniform1f(this.u.echoAge, fx?.echoAge ?? -1);
    const orbs = fx?.orbs ?? [];
    const oc = Math.min(orbs.length, 8);
    for (let i = 0; i < oc; i++) {
      const o = orbs[i];
      this._orbBuf[i * 4] = o.x;
      this._orbBuf[i * 4 + 1] = o.y;
      this._orbBuf[i * 4 + 2] = o.z;
      this._orbBuf[i * 4 + 3] = o.r ?? 0.6;
    }
    for (let i = oc * 4; i < this._orbBuf.length; i++) this._orbBuf[i] = 0;
    gl.uniform1i(this.u.orbCount, oc);
    gl.uniform4fv(this.u.orbs, this._orbBuf);
    const ocol = fx?.orbColor ?? [1.0, 0.78, 0.32];
    gl.uniform3f(this.u.orbColor, ocol[0], ocol[1], ocol[2]);
    gl.uniform1f(this.u.caveSense, fx?.caveSense ? 1 : 0);
    const ro2 = fx?.resonOrigin ?? [0, 0];
    gl.uniform2f(this.u.resonOrigin, ro2[0], ro2[1]);
    gl.uniform1f(this.u.resonAge, fx?.resonAge ?? -1);

    // Cutscene hero (intro only).
    gl.uniform1f(this.u.heroVisible, hero?.visible ? 1 : 0);
    gl.uniform3f(this.u.heroPos, hero?.x ?? 0, hero?.y ?? 0, hero?.z ?? 0);
    gl.uniform1f(this.u.heroYaw, hero?.yaw ?? 0);
    gl.uniform1f(this.u.heroPhase, hero?.phase ?? 0);
    gl.uniform1f(this.u.heroFall, hero?.fall ?? 0);
    const hc = hero?.color ?? [0.16, 0.13, 0.1];
    gl.uniform3f(this.u.heroColor, hc[0], hc[1], hc[2]);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}