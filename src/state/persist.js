/**
 * Persistence layer: keeps a subset of store keys in sync with localStorage
 * and the URL hash. URL hash wins on initial load (sharable links), then
 * localStorage, then defaults.
 */

const LS_KEY = 'sandsea:state:v1';

/**
 * Keys that should be persisted. Runtime state (paused, motionDir) is excluded
 * — it would be jarring to come back paused or moving.
 */
// Persisted keys — note that world identity (seed, dune params) is NOT
// persisted: the world is canonical and force-set from defaults at boot.
export const PERSISTENT_KEYS = [
  'cameraMode', 'cameraY', 'cameraSpeed', 'fovDeg', 'mouseSensitivity',
  'sunAzim', 'sunElev', 'shadowStrength',
  'skyBands', 'horizonY', 'skyHeight',
  'sandPalette', 'skyPalette',
  // timeOfDay deliberately not persisted — each visit starts at the
  // defaults.timeOfDay (morning). If the cycle is on, time immediately
  // begins to flow at the persisted timeRate.
  'dayCycleEnabled', 'timeRate', 'starsEnabled',
  'weatherMode', 'weatherCloudCover', 'weatherWindSpeed', 'weatherWindDir',
  'weatherFog', 'weatherHeatHaze', 'weatherCloudMorph', 'lightningEnabled',
  'weatherRainOverride', 'weatherRainRadius', 'weatherRainHeight',
  'weatherRainSpeed', 'weatherRainCount',
  'weatherRainColor', 'weatherRainAlpha',
  'weatherRainLength', 'weatherRainWidth',
  'caveSeed', 'caveDepth', 'caveBranching', 'caveRadiusMin', 'caveRadiusMax',
  'caveEntrances', 'caveLightMode', 'flashRange',
  'smoothPixels', 'brightness', 'saturation',
];

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

function readLocalStorage() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeLocalStorage(state) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(pick(state, PERSISTENT_KEYS)));
  } catch {
    // Quota or disabled storage — silently ignore.
  }
}

// --- URL hash codec --------------------------------------------------------
// Format: #k1=v1&k2=v2 — short, human-readable, easy to share.

function encodeHash(state) {
  const parts = [];
  for (const k of PERSISTENT_KEYS) {
    const v = state[k];
    if (v === undefined) continue;
    parts.push(`${k}=${encodeURIComponent(v)}`);
  }
  return '#' + parts.join('&');
}

function decodeHash(hash) {
  if (!hash || hash.length < 2) return null;
  const out = {};
  for (const part of hash.slice(1).split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = decodeURIComponent(part.slice(0, eq));
    const raw = decodeURIComponent(part.slice(eq + 1));
    if (!PERSISTENT_KEYS.includes(k)) continue;
    // Coerce numeric strings back to numbers.
    const asNum = Number(raw);
    out[k] = Number.isFinite(asNum) && raw.trim() !== '' ? asNum : raw;
  }
  return Object.keys(out).length ? out : null;
}

// --- Public API ------------------------------------------------------------

/**
 * Merge persisted state (URL > localStorage > defaults) into `defaults`.
 * Returns a plain object suitable for passing to createStore.
 */
export function loadPersisted(defaults) {
  return {
    ...defaults,
    ...(readLocalStorage() ?? {}),
    ...(decodeHash(window.location.hash) ?? {}),
  };
}

/**
 * Wire up live persistence: subscribe to store changes, debounce writes to
 * localStorage, and reflect them into the URL hash. Also listens for
 * `hashchange` (e.g. user pastes a new shared link) and patches the store.
 */
export function bindPersistence(store) {
  let saveTimer = null;
  const schedule = () => {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      const s = store.get();
      writeLocalStorage(s);
      // Update hash without spamming history.
      const newHash = encodeHash(s);
      if (window.location.hash !== newHash) {
        history.replaceState(null, '', window.location.pathname + window.location.search + newHash);
      }
      saveTimer = null;
    }, 300);
  };

  store.subscribe((key) => {
    if (PERSISTENT_KEYS.includes(key)) schedule();
  });

  window.addEventListener('hashchange', () => {
    const decoded = decodeHash(window.location.hash);
    if (decoded) store.patch(decoded);
  });
}

export function shareUrl(state) {
  return window.location.origin + window.location.pathname + encodeHash(state);
}
