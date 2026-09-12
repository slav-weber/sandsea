/**
 * Declarative control panel. UI is generated from this list.
 *
 * `tab`     — which tab the control lives under.
 * `affects` — what to invalidate on change ('sky'/'sun'/'camera'/'none').
 * `format`  — optional custom label formatter (receives slider value).
 *
 * NOTE: terrain parameters are no longer surfaced — the world is canonical
 * and locked. Only time / weather / camera / atmosphere are tunable.
 */

const fmtHHMM = (v) => {
  const minutes = Math.round(v * 1440); // 1440 min in a day
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

const fmtTimeRate = (v) => (v <= 1.0001 ? '1:1 real time' : `×${Math.round(v)}`);
const fmtPct      = (v) => `${Math.round(v * 100)}%`;
const fmtMps      = (v) => `${v.toFixed(1)} m/s`;
const fmtDeg      = (v) => `${Math.round(v)}°`;

export const controls = [
  // --- Time and sky
  { tab: 'Sky', key: 'timeOfDay', label: 'Time of day',
    min: 0, max: 1, step: 1 / 1440, affects: 'sun', format: fmtHHMM },
  { tab: 'Sky', key: 'timeRate', label: 'Time rate',
    min: 1, max: 3600, step: 1, affects: 'none', format: fmtTimeRate },
  { tab: 'Sky', type: 'toggle', key: 'dayCycleEnabled',
    label: 'Day cycle', affects: 'none' },
  { tab: 'Sky', key: 'skyBands', label: 'Sky bands',
    min: 2, max: 100, step: 1, affects: 'sky' },
  { tab: 'Sky', key: 'skyHeight', label: 'Sky height',
    min: 40, max: 400, step: 5, affects: 'sky' },
  { tab: 'Sky', type: 'toggle', key: 'starsEnabled',
    label: 'Stars at night', affects: 'sky' },

  // --- Light (manual override — used only when the day cycle is off)
  { tab: 'Light', key: 'sunAzim', label: 'Sun azimuth, °',
    min: -180, max: 180, step: 1, affects: 'sun' },
  { tab: 'Light', key: 'sunElev', label: 'Sun elevation, °',
    min: 0, max: 90, step: 1, affects: 'sun' },
  { tab: 'Light', key: 'shadowStrength', label: 'Shadow strength',
    min: 0, max: 1, step: 0.02, affects: 'none' },

  // --- Camera
  { tab: 'Camera', key: 'cameraY', label: 'Camera height',
    min: 5, max: 400, step: 1, affects: 'none' },
  { tab: 'Camera', key: 'cameraSpeed', label: 'Speed',
    min: 0, max: 20, step: 0.1, affects: 'none' },
  { tab: 'Camera', key: 'fovDeg', label: 'Field of view, °',
    min: 20, max: 150, step: 1, affects: 'camera' },
  { tab: 'Camera', key: 'mouseSensitivity', label: 'Mouse sensitivity',
    min: 0.0005, max: 0.01, step: 0.0005, affects: 'none' },

  // --- Weather (sub-tabs: Clouds / Rain / Wind and fog / Lightning)
  // Mode sits outside the groups — rendered above the sub-tabs, always visible.
  // Auto = simulation drives weather. Manual = these sliders take over.
  { tab: 'Weather', type: 'select', key: 'weatherMode', label: 'Mode',
    options: [
      { value: 'auto',   label: 'Auto' },
      { value: 'manual', label: 'Manual' },
    ], affects: 'none' },


  { tab: 'Weather', group: 'Clouds', key: 'weatherCloudCover', label: 'Cloud cover',
    min: 0, max: 1, step: 0.02, affects: 'none', format: fmtPct },

  { tab: 'Weather', group: 'Clouds', key: 'weatherCloudMorph', label: 'Cloud morphing',
    min: 0, max: 1, step: 0.02, affects: 'none', format: fmtPct },


  // weatherRainOverride = -1 means "follow simulation" (rain only when clouds
  // are heavy). Any value 0..1 overrides — 1.0 forces max rain right now.
  { tab: 'Weather', group: 'Rain', key: 'weatherRainOverride', label: 'Rain (manual)',
    min: -1, max: 1, step: 0.05, affects: 'none',
    format: (v) => v < 0 ? 'auto (from cover)' : `${Math.round(v * 100)}%` },
  { tab: 'Weather', group: 'Rain', key: 'weatherRainRadius', label: 'Rain radius',
    min: 100, max: 1000, step: 10, affects: 'none', format: (v) => `${Math.round(v)} m` },
  { tab: 'Weather', group: 'Rain', key: 'weatherRainHeight', label: 'Rain altitude',
    min: 100, max: 1000, step: 10, affects: 'none', format: (v) => `${Math.round(v)} m` },
  { tab: 'Weather', group: 'Rain', key: 'weatherRainSpeed', label: 'Rain speed',
    min: 1, max: 10, step: 0.1, affects: 'none', format: (v) => `×${v.toFixed(1)}` },
  { tab: 'Weather', group: 'Rain', key: 'weatherRainCount', label: 'Drop count',
    min: 100, max: 10000, step: 100, affects: 'none', format: (v) => `${Math.round(v)}` },
  { tab: 'Weather', group: 'Rain', key: 'weatherRainAlpha', label: 'Rain opacity',
    min: 0, max: 1, step: 0.02, affects: 'none', format: fmtPct },
  { tab: 'Weather', group: 'Rain', key: 'weatherRainLength', label: 'Drop length',
    min: 0.2, max: 3, step: 0.05, affects: 'none', format: (v) => `×${v.toFixed(2)}` },
  { tab: 'Weather', group: 'Rain', key: 'weatherRainWidth', label: 'Drop width',
    min: 0.4, max: 3, step: 0.05, affects: 'none', format: (v) => `×${v.toFixed(2)}` },


  { tab: 'Weather', group: 'Wind and fog', key: 'weatherWindSpeed', label: 'Wind speed',
    min: 0, max: 30, step: 0.5, affects: 'none', format: fmtMps },
  { tab: 'Weather', group: 'Wind and fog', key: 'weatherWindDir', label: 'Wind direction',
    min: 0, max: 360, step: 5, affects: 'none', format: fmtDeg },
  { tab: 'Weather', group: 'Wind and fog', key: 'weatherFog', label: 'Fog',
    min: 0, max: 1, step: 0.02, affects: 'none', format: fmtPct },
  { tab: 'Weather', group: 'Wind and fog', key: 'weatherHeatHaze', label: 'Heat haze',
    min: 0, max: 1, step: 0.02, affects: 'none', format: fmtPct },


  { tab: 'Weather', group: 'Lightning', type: 'toggle', key: 'lightningEnabled',
    label: 'Lightning (70%+ cover)', affects: 'none' },
  { tab: 'Weather', group: 'Lightning', type: 'button', key: 'lightningFire',
    label: 'Strike lightning', action: 'fireLightning' },

  // --- Caves

  { tab: 'Caves', type: 'select', key: 'caveLightMode', label: 'Flashlight (L)',
    options: [
      { value: '0', label: 'Off' },
      { value: '1', label: 'Flashlight' },
      { value: '2', label: 'Soft light' },
      { value: '3', label: 'Flashlight + soft' },
    ], affects: 'none' },
  { tab: 'Caves', key: 'flashRange', label: 'Light range',
    min: 15, max: 120, step: 1, affects: 'none', format: (v) => `${Math.round(v)} m` },

  { tab: 'Caves', key: 'caveDepth', label: 'Depth and length',
    min: 0, max: 1, step: 0.02, affects: 'none', format: fmtPct },
  { tab: 'Caves', key: 'caveBranching', label: 'Branching',
    min: 0, max: 1, step: 0.02, affects: 'none', format: fmtPct },
  { tab: 'Caves', key: 'caveRadiusMin', label: 'Width: squeezes',
    min: 1.5, max: 10, step: 0.5, affects: 'none', format: (v) => `${v.toFixed(1)} m` },
  { tab: 'Caves', key: 'caveRadiusMax', label: 'Width: galleries',
    min: 2, max: 16, step: 0.5, affects: 'none', format: (v) => `${v.toFixed(1)} m` },
  { tab: 'Caves', key: 'caveEntrances', label: 'Entrances',
    min: 1, max: 4, step: 1, affects: 'none', format: (v) => String(Math.round(v)) },
  { tab: 'Caves', key: 'caveSeed', label: 'Seed',
    min: 0, max: 99999, step: 1, affects: 'none', format: (v) => String(Math.round(v)) },
  { tab: 'Caves', type: 'button', key: 'caveRegenerate',
    label: 'Regenerate', action: 'regenerateCave' },

  // --- Effects
  // smoothPixels = bilinear upscale of the framebuffer. It interpolates
  // colors between neighbouring pixels — same kind of soft gradient look
  // you got on a Sega over composite/NTSC (analog signal blurred adjacent
  // pixels into one another).
  { tab: 'Effects', type: 'toggle', key: 'smoothPixels',
    label: 'Pixel smoothing', affects: 'pixelation' },
  { tab: 'Effects', key: 'brightness', label: 'Brightness',
    min: 0.5, max: 1.5, step: 0.02, affects: 'none' },
  { tab: 'Effects', key: 'saturation', label: 'Saturation',
    min: 0, max: 2, step: 0.02, affects: 'none' },
];

export const TABS = ['Sky', 'Weather', 'Light', 'Camera', 'Caves', 'Effects'];

export function controlsByTab() {
  const map = new Map();
  for (const t of TABS) map.set(t, []);
  for (const c of controls) {
    if (!map.has(c.tab)) map.set(c.tab, []);
    map.get(c.tab).push(c);
  }
  return map;
}
