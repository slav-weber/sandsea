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

const fmtTimeRate = (v) => (v <= 1.0001 ? '1:1 реальное' : `×${Math.round(v)}`);
const fmtPct      = (v) => `${Math.round(v * 100)}%`;
const fmtMps      = (v) => `${v.toFixed(1)} м/с`;
const fmtDeg      = (v) => `${Math.round(v)}°`;

export const controls = [
  // --- Время и небо
  { tab: 'Небо', key: 'timeOfDay', label: 'Время суток',
    min: 0, max: 1, step: 1 / 1440, affects: 'sun', format: fmtHHMM },
  { tab: 'Небо', key: 'timeRate', label: 'Скорость времени',
    min: 1, max: 3600, step: 1, affects: 'none', format: fmtTimeRate },
  { tab: 'Небо', type: 'toggle', key: 'dayCycleEnabled',
    label: 'Время идёт', affects: 'none' },
  { tab: 'Небо', key: 'skyBands', label: 'Полос в небе',
    min: 2, max: 100, step: 1, affects: 'sky' },
  { tab: 'Небо', key: 'skyHeight', label: 'Высота неба',
    min: 40, max: 400, step: 5, affects: 'sky' },
  { tab: 'Небо', type: 'toggle', key: 'starsEnabled',
    label: 'Звёзды ночью', affects: 'sky' },

  // --- Освещение (manual override — used only when "время идёт" is off)
  { tab: 'Освещение', key: 'sunAzim', label: 'Азимут солнца, °',
    min: -180, max: 180, step: 1, affects: 'sun' },
  { tab: 'Освещение', key: 'sunElev', label: 'Высота солнца, °',
    min: 0, max: 90, step: 1, affects: 'sun' },
  { tab: 'Освещение', key: 'shadowStrength', label: 'Сила тени',
    min: 0, max: 1, step: 0.02, affects: 'none' },

  // --- Камера
  { tab: 'Камера', key: 'cameraY', label: 'Высота камеры',
    min: 5, max: 400, step: 1, affects: 'none' },
  { tab: 'Камера', key: 'cameraSpeed', label: 'Скорость',
    min: 0, max: 20, step: 0.1, affects: 'none' },
  { tab: 'Камера', key: 'fovDeg', label: 'Поле зрения, °',
    min: 20, max: 150, step: 1, affects: 'camera' },
  { tab: 'Камера', key: 'mouseSensitivity', label: 'Чувствительность мыши',
    min: 0.0005, max: 0.01, step: 0.0005, affects: 'none' },

  // --- Погода (подвкладки: Облака / Дождь / Ветер и туман / Молния)
  // Режим без группы — рендерится над под-вкладками, всегда виден.
  // Auto = simulation drives weather. Manual = these sliders take over.
  { tab: 'Погода', type: 'select', key: 'weatherMode', label: 'Режим',
    options: [
      { value: 'auto',   label: 'Авто' },
      { value: 'manual', label: 'Ручной' },
    ], affects: 'none' },

  // -- Облака
  { tab: 'Погода', group: 'Облака', key: 'weatherCloudCover', label: 'Облачность',
    min: 0, max: 1, step: 0.02, affects: 'none', format: fmtPct },
  // Скорость морфинга формы облаков: 0 = статично, 100% = быстро.
  { tab: 'Погода', group: 'Облака', key: 'weatherCloudMorph', label: 'Морфинг облаков',
    min: 0, max: 1, step: 0.02, affects: 'none', format: fmtPct },

  // -- Дождь
  // weatherRainOverride = -1 means "follow simulation" (rain only when clouds
  // are heavy). Any value 0..1 overrides — 1.0 forces max rain right now.
  { tab: 'Погода', group: 'Дождь', key: 'weatherRainOverride', label: 'Дождь (вручную)',
    min: -1, max: 1, step: 0.05, affects: 'none',
    format: (v) => v < 0 ? 'авто (от облачности)' : `${Math.round(v * 100)}%` },
  { tab: 'Погода', group: 'Дождь', key: 'weatherRainRadius', label: 'Радиус дождя',
    min: 100, max: 1000, step: 10, affects: 'none', format: (v) => `${Math.round(v)} м` },
  { tab: 'Погода', group: 'Дождь', key: 'weatherRainHeight', label: 'Высота дождя',
    min: 100, max: 1000, step: 10, affects: 'none', format: (v) => `${Math.round(v)} м` },
  { tab: 'Погода', group: 'Дождь', key: 'weatherRainSpeed', label: 'Скорость дождя',
    min: 1, max: 10, step: 0.1, affects: 'none', format: (v) => `×${v.toFixed(1)}` },
  { tab: 'Погода', group: 'Дождь', key: 'weatherRainCount', label: 'Интенсивность (капель)',
    min: 100, max: 10000, step: 100, affects: 'none', format: (v) => `${Math.round(v)}` },
  { tab: 'Погода', group: 'Дождь', key: 'weatherRainAlpha', label: 'Прозрачность дождя',
    min: 0, max: 1, step: 0.02, affects: 'none', format: fmtPct },
  { tab: 'Погода', group: 'Дождь', key: 'weatherRainLength', label: 'Длина капель',
    min: 0.2, max: 3, step: 0.05, affects: 'none', format: (v) => `×${v.toFixed(2)}` },
  { tab: 'Погода', group: 'Дождь', key: 'weatherRainWidth', label: 'Толщина капель',
    min: 0.4, max: 3, step: 0.05, affects: 'none', format: (v) => `×${v.toFixed(2)}` },

  // -- Ветер и туман
  { tab: 'Погода', group: 'Ветер и туман', key: 'weatherWindSpeed', label: 'Сила ветра',
    min: 0, max: 30, step: 0.5, affects: 'none', format: fmtMps },
  { tab: 'Погода', group: 'Ветер и туман', key: 'weatherWindDir', label: 'Направление ветра',
    min: 0, max: 360, step: 5, affects: 'none', format: fmtDeg },
  { tab: 'Погода', group: 'Ветер и туман', key: 'weatherFog', label: 'Туман',
    min: 0, max: 1, step: 0.02, affects: 'none', format: fmtPct },
  { tab: 'Погода', group: 'Ветер и туман', key: 'weatherHeatHaze', label: 'Тепловое марево',
    min: 0, max: 1, step: 0.02, affects: 'none', format: fmtPct },

  // -- Молния
  { tab: 'Погода', group: 'Молния', type: 'toggle', key: 'lightningEnabled',
    label: 'Молнии (от 70% облачности)', affects: 'none' },
  { tab: 'Погода', group: 'Молния', type: 'button', key: 'lightningFire',
    label: 'Ударить молнией', action: 'fireLightning' },

  // --- Пещеры
  // Фонарик: свет вокруг камеры. Клавиша L циклит те же 4 режима.
  { tab: 'Пещеры', type: 'select', key: 'caveLightMode', label: 'Фонарик (L)',
    options: [
      { value: '0', label: 'Выкл' },
      { value: '1', label: 'Фонарик' },
      { value: '2', label: 'Мягкий свет' },
      { value: '3', label: 'Фонарик + мягкий' },
    ], affects: 'none' },
  { tab: 'Пещеры', key: 'flashRange', label: 'Дальность света',
    min: 15, max: 120, step: 1, affects: 'none', format: (v) => `${Math.round(v)} м` },
  // Генерация: меняешь — пещера пересобирается (main.js слушает эти ключи).
  { tab: 'Пещеры', key: 'caveDepth', label: 'Глубина и длина',
    min: 0, max: 1, step: 0.02, affects: 'none', format: fmtPct },
  { tab: 'Пещеры', key: 'caveBranching', label: 'Ветвистость',
    min: 0, max: 1, step: 0.02, affects: 'none', format: fmtPct },
  { tab: 'Пещеры', key: 'caveRadiusMin', label: 'Ширина: узкие лазы',
    min: 1.5, max: 10, step: 0.5, affects: 'none', format: (v) => `${v.toFixed(1)} м` },
  { tab: 'Пещеры', key: 'caveRadiusMax', label: 'Ширина: залы',
    min: 2, max: 16, step: 0.5, affects: 'none', format: (v) => `${v.toFixed(1)} м` },
  { tab: 'Пещеры', key: 'caveEntrances', label: 'Входов/выходов',
    min: 1, max: 4, step: 1, affects: 'none', format: (v) => String(Math.round(v)) },
  { tab: 'Пещеры', key: 'caveSeed', label: 'Seed',
    min: 0, max: 99999, step: 1, affects: 'none', format: (v) => String(Math.round(v)) },
  { tab: 'Пещеры', type: 'button', key: 'caveRegenerate',
    label: 'Сгенерировать заново', action: 'regenerateCave' },

  // --- Эффекты
  // smoothPixels = bilinear upscale of the framebuffer. It interpolates
  // colors between neighbouring pixels — same kind of soft gradient look
  // you got on a Sega over composite/NTSC (analog signal blurred adjacent
  // pixels into one another).
  { tab: 'Эффекты', type: 'toggle', key: 'smoothPixels',
    label: 'Сглаживание пикселей (Sega CRT)', affects: 'pixelation' },
  { tab: 'Эффекты', key: 'brightness', label: 'Яркость',
    min: 0.5, max: 1.5, step: 0.02, affects: 'none' },
  { tab: 'Эффекты', key: 'saturation', label: 'Насыщенность',
    min: 0, max: 2, step: 0.02, affects: 'none' },
];

export const TABS = ['Небо', 'Погода', 'Освещение', 'Камера', 'Пещеры', 'Эффекты'];

export function controlsByTab() {
  const map = new Map();
  for (const t of TABS) map.set(t, []);
  for (const c of controls) {
    if (!map.has(c.tab)) map.set(c.tab, []);
    map.get(c.tab).push(c);
  }
  return map;
}
