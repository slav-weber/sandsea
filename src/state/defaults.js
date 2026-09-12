// World seed is part of the world identity — fixed at boot so the same
// dunes appear every session. Don't expose this through UI.
export const WORLD_SEED = 7;

export const defaults = {
  // terrain — fixed world params (seed especially is force-overridden at
  // boot to WORLD_SEED to neutralise any localStorage tampering)
  cellSize: 128,
  emptyRate: 80,
  duneLengthMin: 70,
  duneLengthMax: 120,
  duneHeightMin: 4,
  duneHeightMax: 15,
  seed: WORLD_SEED,

  // camera
  cameraMode: 'free',       // 'free' (creative fly) | 'game' (1st-person on foot)
  cameraY: 20,
  cameraSpeed: 0.4,
  fovDeg: 60,
  mouseSensitivity: 0.003,

  // lighting (manual override — only used when day cycle is off)
  sunAzim: 30,
  sunElev: 45,
  shadowStrength: 0.72,

  // sky / atmosphere
  skyBands: 14,
  horizonY: 40,
  skyHeight: 130,
  // hazeAmount removed — use weatherFog (Weather tab).

  // palettes (names from config/palettes.js)
  sandPalette: 'classic',
  skyPalette: 'classic',

  // Day cycle: timeOfDay is fraction of solar day [0..1) — 0=midnight,
  // 0.5=noon. timeRate is the real-time multiplier: 1 = 1:1 wall-clock
  // (24h real = 24h game). Slider can bump it up for skipping.
  dayCycleEnabled: 1,
  timeRate: 1,
  timeOfDay: 8 / 24,    // start at 08:00
  starsEnabled: 1,

  // weather — auto runs the simulation; manual = sliders rule
  weatherMode: 'auto',
  weatherCloudCover: 0.4,   // override value when in manual mode (0..1)
  weatherWindSpeed: 10,     // m/s, override
  weatherWindDir: 0,        // degrees from north (azimuth)
  weatherFog: 0.30,         // distance-fog intensity (0..1)
  weatherHeatHaze: 0,       // sand mirage / shimmer strength (0..1)
  weatherCloudMorph: 0.1,   // cloud shape morph speed: 0 static .. 1 fast
  lightningEnabled: 1,      // allow lightning strikes at cover >= 70%
  weatherRainOverride: -1,  // -1 = use sim; 0..1 = manual override
  weatherRainRadius: 150,   // metres — spawn cylinder radius (100..1000)
  weatherRainHeight: 200,   // metres — spawn altitude band above camera (100..1000)
  weatherRainSpeed: 1.0,    // ×60 m/s base fall speed (1..10)
  weatherRainCount: 1500,   // active drop count (100..4096)
  weatherRainColor: '#aac4dc',  // hex rgb for rain streaks (legacy, unused)
  weatherRainAlpha: 0.70,   // 0..1 final compositing alpha multiplier
  weatherRainLength: 1.0,   // 0.2..3 — motion-blur trail length multiplier
  weatherRainWidth:  1.0,   // 0.4..3 — streak thickness multiplier

  // Caves — a single branching cave near spawn, carved by terrain/cave.js.
  // caveSeed drives the whole structure; the rest tune its shape. caveSeed
  // is independent of WORLD_SEED — regenerating it never touches the dunes.
  caveSeed: 1337,
  caveDepth: 0.55,          // 0..1 — how deep/long the cave runs
  caveBranching: 0.4,       // 0..1 — how often passages fork into galleries
  caveRadiusMin: 3,         // metres — narrowest squeezes
  caveRadiusMax: 8,         // metres — widest galleries
  caveEntrances: 2,         // 1..4 — number of surface mouths
  // Camera light: 0=off, 1=flashlight cone, 2=soft omni, 3=cone+soft.
  caveLightMode: 0,
  flashRange: 45,           // metres — light falloff distance

  // Audio
  musicVolume:   0.7,       // playlist player volume (0..1)
  effectsVolume: 0.7,       // weather audio (thunder, rain hiss) (0..1)


  // post-fx
  smoothPixels: 0,    // 0 = crisp pixelated, 1 = bilinear (Sega CRT look)
  brightness: 1,
  saturation: 1,

  // runtime
  paused: false,
};
