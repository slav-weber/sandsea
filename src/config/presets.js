/**
 * Presets jump the simulation to a moment in the day. They never touch
 * world-shaping parameters (seed, dune size, cell layout) — the world is
 * canonical. Only time and weather-like atmospherics change.
 *
 * Times are calibrated to summer-solstice Izmail: sunrise ≈ 04:16,
 * sunset ≈ 19:44.
 */

export const PRESETS = {
  morning: {
    label: 'Morning',
    state: { timeOfDay: 6 / 24, weatherFog: 0.40, sandPalette: 'classic', skyPalette: 'sunset' },
  },
  noon: {
    label: 'Noon',
    state: { timeOfDay: 12 / 24, weatherFog: 0.25, sandPalette: 'classic', skyPalette: 'classic' },
  },
  sunset: {
    label: 'Sunset',
    state: { timeOfDay: 19.5 / 24, weatherFog: 0.55, sandPalette: 'sunset', skyPalette: 'sunset' },
  },
  night: {
    label: 'Night',
    state: { timeOfDay: 1 / 24, weatherFog: 0.20, sandPalette: 'night', skyPalette: 'night' },
  },
};

export const PRESET_IDS = Object.keys(PRESETS);

export function applyPreset(store, id) {
  const preset = PRESETS[id];
  if (!preset) return false;
  store.patch(preset.state);
  return true;
}

export function randomPresetId(exclude) {
  const ids = PRESET_IDS.filter((id) => id !== exclude);
  return ids[(Math.random() * ids.length) | 0];
}
