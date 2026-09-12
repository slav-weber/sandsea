import { PRESETS, PRESET_IDS, applyPreset } from '../config/presets.js';
import { shareUrl } from '../state/persist.js';

/**
 * Сцена tab. Two controls:
 *   - "Время суток" dropdown that jumps the clock to a preset moment
 *     (Утро / Полдень / Закат / Ночь). Each preset is a partial state
 *     patch — only time + atmospheric haze, never the world itself.
 *   - Share link button.
 *
 * Palette selectors were removed: with the day/night auto-cycle on,
 * palettes are derived from time-of-day, so picking them manually is
 * meaningless and only adds noise to the UI.
 */
export function mountPresets(root, store, { onToast } = {}) {
  const bar = document.createElement('div');
  bar.className = 'preset-bar';

  // --- Camera mode (Свободная камера / Игра) -----------------------------
  const modeGroup = document.createElement('label');
  modeGroup.className = 'preset-group';
  const modeLab = document.createElement('span');
  modeLab.className = 'preset-group-label';
  modeLab.textContent = 'Режим:';
  modeGroup.appendChild(modeLab);

  const modeSelect = document.createElement('select');
  modeSelect.className = 'preset-select';
  for (const opt of [
    { value: 'free', label: 'Свободная камера' },
    { value: 'game', label: 'Игра' },
  ]) {
    const o = document.createElement('option');
    o.value = opt.value;
    o.textContent = opt.label;
    modeSelect.appendChild(o);
  }
  modeSelect.value = store.get('cameraMode') || 'free';
  modeSelect.addEventListener('change', () => store.set('cameraMode', modeSelect.value));
  store.subscribe('cameraMode', (v) => {
    if (modeSelect.value !== v) modeSelect.value = v;
  });
  modeGroup.appendChild(modeSelect);
  bar.appendChild(modeGroup);

  // --- Time-of-day dropdown ---------------------------------------------
  const timeGroup = document.createElement('label');
  timeGroup.className = 'preset-group';

  const timeLab = document.createElement('span');
  timeLab.className = 'preset-group-label';
  timeLab.textContent = 'Время суток:';
  timeGroup.appendChild(timeLab);

  const select = document.createElement('select');
  select.className = 'preset-select';
  for (const id of PRESET_IDS) {
    const o = document.createElement('option');
    o.value = id;
    o.textContent = PRESETS[id].label;
    select.appendChild(o);
  }
  select.addEventListener('change', () => {
    applyPreset(store, select.value);
  });
  // Keep the dropdown roughly in sync with the current clock — pick the
  // preset whose time is closest to the live timeOfDay.
  const syncFromTime = () => {
    const t = store.get('timeOfDay');
    let bestId = PRESET_IDS[0];
    let bestDist = Infinity;
    for (const id of PRESET_IDS) {
      const pt = PRESETS[id].state.timeOfDay ?? 0;
      // Wrap-around distance on [0..1]
      const d = Math.min(Math.abs(t - pt), 1 - Math.abs(t - pt));
      if (d < bestDist) { bestDist = d; bestId = id; }
    }
    if (select.value !== bestId) select.value = bestId;
  };
  syncFromTime();
  store.subscribe('timeOfDay', syncFromTime);
  timeGroup.appendChild(select);
  bar.appendChild(timeGroup);

  // --- Share link -------------------------------------------------------
  const shareBtn = document.createElement('button');
  shareBtn.className = 'preset-btn share-btn';
  shareBtn.textContent = 'Скопировать ссылку';
  shareBtn.addEventListener('click', async () => {
    const url = shareUrl(store.get());
    try {
      await navigator.clipboard.writeText(url);
      onToast?.('Ссылка скопирована');
    } catch {
      window.prompt('Скопируй ссылку:', url);
    }
  });
  bar.appendChild(shareBtn);

  root.appendChild(bar);
}
