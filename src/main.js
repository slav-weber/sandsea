import './styles/main.css';

import { createStore } from './state/store.js';
import { defaults, WORLD_SEED } from './state/defaults.js';
import { loadPersisted, bindPersistence } from './state/persist.js';
import { SAND_PALETTES, SKY_PALETTES } from './config/palettes.js';
import { Camera } from './camera.js';
import { Sun } from './lighting.js';
import { GlPipeline } from './render/glPipeline.js';
import { heightAt, terrainParamsFromStore, SPAWN_HILL } from './terrain/sdfHeight.js';
import { listVisibleSolids } from './terrain/solids.js';
import { generateCave, caveFloorAt } from './terrain/cave.js';
import { WeatherSystem } from './weather/weather.js';
import { LightningSystem } from './weather/lightning.js';
import { RainParticles } from './weather/rain.js';
import { mountControls } from './ui/controls.js';
import { mountPresets } from './ui/presets.js';
import { mountHud } from './ui/hud.js';
import { mountLoading } from './ui/loading.js';
import { toast } from './ui/toast.js';
import { bindKeyboard } from './input/keyboard.js';
import { bindPointer } from './input/pointer.js';
import { axes } from './input/axes.js';

function hexToRgb(hex) {
  const h = (hex || '').replace('#', '');
  const v = parseInt(h.length === 3 ? h.replace(/(.)/g, '$1$1') : h, 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

const canvas = document.getElementById('desert');
const canvasWrap = document.querySelector('.sea-canvas-wrap');
const controlsRoot = document.getElementById('controls-root');

// Shown immediately; the shader compiles in the background (pollReady).
const loading = mountLoading(canvasWrap);

const initial = loadPersisted(defaults);
if (!SAND_PALETTES[initial.sandPalette]) initial.sandPalette = defaults.sandPalette;
if (!SKY_PALETTES[initial.skyPalette]) initial.skyPalette = defaults.skyPalette;
// The world identity is fixed: the same seed and dune parameters every visit.
initial.seed = WORLD_SEED;
// A poisoned value in localStorage or the URL must not survive a reload.
if (!Number.isFinite(initial.cameraY)) initial.cameraY = defaults.cameraY;
const store = createStore(initial);
bindPersistence(store);

const camera = new Camera(canvas.width, canvas.height, store.get('fovDeg'));
const sun = new Sun();
const pipeline = new GlPipeline(canvas, store);

function applySunState() {
  if (store.get('dayCycleEnabled')) sun.setFromTimeOfDay(store.get('timeOfDay'));
  else sun.setFromAngles(store.get('sunAzim'), store.get('sunElev'));
  const y = sun.dir[1];
  const nightLevel = y >= 0.1 ? 0 : y <= -0.2 ? 1 : (0.1 - y) / 0.3;
  pipeline.setNightLevel(nightLevel);
}

// The SDF renderer computes the world in the fragment shader; heightAt is the
// CPU mirror used by the camera and the rain collisions. The HUD reads the
// chunk counters, which stay empty here.
const terrain = {
  chunks: new Map(),
  pendingCount: 0,
  heightAt: (x, z) => heightAt(x, z, terrainParamsFromStore(store)),
};

const weather = new WeatherSystem();
const lightning = new LightningSystem();
const rainParticles = new RainParticles();

function applyWeatherOverrides() {
  const mode = store.get('weatherMode');
  weather.mode = mode;
  if (mode === 'manual') {
    weather.cloudCover = store.get('weatherCloudCover');
    weather.windSpeed = store.get('weatherWindSpeed');
    const azim = (store.get('weatherWindDir') * Math.PI) / 180;
    weather.windDirX = Math.cos(azim);
    weather.windDirZ = Math.sin(azim);
  }
  const rainOverride = store.get('weatherRainOverride');
  if (rainOverride >= 0) {
    weather.rainIntensity = rainOverride;
    weather.surfaceWetness = rainOverride > 0.05 ? 1 : weather.surfaceWetness;
  }
  weather.cloudMorphSpeed = (store.get('weatherCloudMorph') ?? 0.1) * 0.4;
  lightning.setEnabled(!!store.get('lightningEnabled'));
}

let cave = generateCave(terrainParamsFromStore(store));
for (const key of ['caveSeed', 'caveDepth', 'caveBranching', 'caveRadiusMin', 'caveRadiusMax', 'caveEntrances']) {
  store.subscribe(key, () => {
    cave = generateCave(terrainParamsFromStore(store));
  });
}

function onAffect(kind) {
  if (kind === 'sky') pipeline.invalidateSky();
  else if (kind === 'sand') pipeline.invalidateSand();
}
store.subscribe('sandPalette', () => pipeline.invalidateSand());
store.subscribe('skyPalette', () => pipeline.invalidateSky());

mountControls(controlsRoot, store, onAffect, {
  beforeTabs: [{ name: 'Scene', mount: (panel) => mountPresets(panel, store, { onToast: toast }) }],
  actions: {
    fireLightning: () =>
      lightning.fire(camera, store.get('cameraY'), terrainParamsFromStore(store)),
    regenerateCave: () => {
      store.set('caveSeed', (Math.random() * 99999) | 0);
      toast?.('New cave');
    },
  },
});

const hud = mountHud(canvasWrap, store, {
  getCamera: () => camera,
  getTerrain: () => terrain,
  getAxes: () => axes,
});

bindKeyboard(store, { canvas, hud, toast, getMode: () => 'editor' });
bindPointer(canvas, store, camera);

let lastFrameT = performance.now();
let gameSeconds = store.get('timeOfDay') * 86400;
// The clock and the slider write to the same key. This flag tells them apart:
// a write from the slider re-anchors the clock instead of being overwritten.
let clockWrite = false;
store.subscribe('timeOfDay', (v) => {
  if (clockWrite || !Number.isFinite(v)) return;
  gameSeconds = v * 86400;
});

function frame(now) {
  if (now == null) now = performance.now();

  if (!pipeline.ready) {
    try {
      pipeline.pollReady();
    } catch (e) {
      loading.fail(e);
      return;
    }
    loading.tick();
    if (!pipeline.ready) {
      requestAnimationFrame(frame);
      return;
    }
    loading.hide();
    lastFrameT = now;
  }

  const dt = Math.min(0.1, (now - lastFrameT) / 1000);
  lastFrameT = now;
  if (!store.get('paused')) gameSeconds += dt * store.get('timeRate');

  const tparams = terrainParamsFromStore(store);

  if (!store.get('paused')) {
    const sinY = Math.sin(camera.yaw);
    const cosY = Math.cos(camera.yaw);
    const sp = store.get('cameraSpeed') * (axes.boost > 0.5 ? 60 : 20) * dt;
    // Free flight: forward follows the look direction, so pitching up and
    // holding W climbs. Strafing stays horizontal, as it should.
    const cosP = Math.cos(camera.pitch);
    const sinP = Math.sin(camera.pitch);
    let dy = 0;
    if (axes.forward !== 0 || axes.strafe !== 0) {
      const fwd = axes.forward * cosP;
      camera.move((fwd * sinY + axes.strafe * cosY) * sp, (fwd * cosY + axes.strafe * -sinY) * sp);
      dy += axes.forward * sinP * sp;
    }
    dy += axes.up * sp;
    if (dy !== 0) {
      const y = store.get('cameraY');
      const base = Number.isFinite(y) ? y : defaults.cameraY;
      store.set('cameraY', Math.max(1, Math.min(400, base + dy)));
    }
  }

  // The clock writes back only while it is running; otherwise the slider owns
  // the value and would be overwritten on the very next frame.
  if (store.get('dayCycleEnabled') && !store.get('paused')) {
    clockWrite = true;
    store.set('timeOfDay', (gameSeconds / 86400) % 1);
    clockWrite = false;
  }
  applySunState();
  applyWeatherOverrides();
  weather.tick(dt, gameSeconds);
  weather.updateSunVisibility(sun.dir, gameSeconds, camera.x, camera.z);
  lightning.tick(dt, weather, camera, store.get('cameraY'), tparams);

  const solids = listVisibleSolids(camera, tparams);
  const bolt = lightning.toRenderData(camera, store.get('cameraY'), canvas.width, canvas.height);

  rainParticles.tick(weather, camera, store.get('cameraY'), tparams, dt, {
    radius: store.get('weatherRainRadius'),
    height: store.get('weatherRainHeight'),
    speed: store.get('weatherRainSpeed'),
    maxCount: store.get('weatherRainCount'),
    npcs: [],
    solids,
    cave,
  });
  const rain = {
    count: rainParticles.packBuffer(),
    buffer: rainParticles.buffer,
    velocity: rainParticles.velocity,
    color: hexToRgb(store.get('weatherRainColor') || '#aac4dc'),
    alpha: store.get('weatherRainAlpha'),
    lengthMul: store.get('weatherRainLength'),
    widthMul: store.get('weatherRainWidth'),
  };

  // Walking into a cave mouth eases the eye down to the cave floor.
  const storedY = store.get('cameraY');
  const eyeY = Number.isFinite(storedY) ? storedY : defaults.cameraY;
  const cf = caveFloorAt(camera.x, camera.z, cave, tparams, eyeY);
  if (cf !== null) store.set('cameraY', eyeY + (cf + 1.7 - eyeY) * Math.min(1, dt * 6));

  pipeline.render({
    camera,
    sun,
    solids,
    cave,
    light: {
      mode: store.get('caveLightMode') | 0,
      range: store.get('flashRange') ?? 45,
      color: [1.0, 0.95, 0.82],
    },
    spawnPlateauY: heightAt(SPAWN_HILL.x, SPAWN_HILL.z, tparams),
    fx: { heatHaze: store.get('weatherHeatHaze') ?? 0 },
    weather,
    time: gameSeconds,
    fog: store.get('weatherFog'),
    bolt,
    rain,
  });
  hud.tick();

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
