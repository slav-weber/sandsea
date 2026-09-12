/**
 * Boot loading screen. The fragment shader is large and can take a few seconds
 * to compile on the GPU. With KHR_parallel_shader_compile that happens in the
 * background (see GlPipeline.pollReady) and this overlay animates meanwhile, so
 * the tab never looks frozen. Removed once the pipeline is ready.
 *
 * API: mountLoading(root) → { tick(), hide(), fail(err) }
 */
export function mountLoading(root) {
  const overlay = document.createElement('div');
  overlay.className = 'loading-overlay';

  const box = document.createElement('div');
  box.className = 'loading-box';

  const title = document.createElement('div');
  title.className = 'loading-title';
  title.textContent = 'SANDSEA';

  const barWrap = document.createElement('div');
  barWrap.className = 'loading-bar';
  const fill = document.createElement('div');
  fill.className = 'loading-fill';
  barWrap.appendChild(fill);

  const sub = document.createElement('div');
  sub.className = 'loading-sub';
  sub.textContent = 'Компиляция шейдеров…';

  box.appendChild(title);
  box.appendChild(barWrap);
  box.appendChild(sub);
  overlay.appendChild(box);
  root.appendChild(overlay);

  const t0 = performance.now();
  let done = false;

  return {
    tick() {
      if (done) return;
      // Eased pseudo-progress toward ~93% — the GPU only reports a boolean
      // "complete", so there's no real percentage; hide() snaps it to 100%.
      const el = (performance.now() - t0) / 1000;
      const pct = 93 * (1 - Math.exp(-el / 8));
      fill.style.width = `${pct.toFixed(1)}%`;
    },
    hide() {
      if (done) return;
      done = true;
      fill.style.width = '100%';
      overlay.classList.add('is-done');
      setTimeout(() => overlay.remove(), 450);
    },
    fail(err) {
      done = true;
      title.textContent = 'СБОЙ ЗАГРУЗКИ';
      sub.textContent = 'Шейдер не скомпилировался. Открой консоль (F12) — там лог.';
      overlay.classList.add('is-error');
      console.error(err);
    },
  };
}
