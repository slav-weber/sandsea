/**
 * Diagnostic overlay: FPS, camera state, chunk queue, controls hint, and
 * pointer-lock prompt. Toggle with H.
 */
export function mountHud(parentEl, store, { getCamera, getTerrain, getAxes }) {
  const el = document.createElement('div');
  el.className = 'hud';
  el.innerHTML = `
    <div class="hud-row" data-k="fps">FPS: <span>—</span></div>
    <div class="hud-row" data-k="pos">XZ: <span>0, 0</span></div>
    <div class="hud-row" data-k="yaw">Yaw / Pitch: <span>0° / 0°</span></div>
    <div class="hud-row" data-k="chunks">Chunks: <span>0 / 0</span></div>
    <div class="hud-row" data-k="dir">Motion: <span>idle</span></div>
    <div class="hud-hint">
      WASD — move • Space / C — up / down<br>
      Shift — boost • P — pause • R — reseed<br>
      F — fullscreen • H — hide HUD • N — next preset<br>
      Click — capture mouse (ESC — release)
    </div>
  `;
  parentEl.appendChild(el);

  const lockHint = document.createElement('div');
  lockHint.className = 'pointer-lock-hint';
  lockHint.textContent = 'Click to control the camera';
  parentEl.appendChild(lockHint);

  const fpsEl = el.querySelector('[data-k="fps"] span');
  const posEl = el.querySelector('[data-k="pos"] span');
  const yawEl = el.querySelector('[data-k="yaw"] span');
  const chunksEl = el.querySelector('[data-k="chunks"] span');
  const dirEl = el.querySelector('[data-k="dir"] span');

  let frames = 0;
  let lastT = performance.now();

  function fmtMotion(a) {
    const parts = [];
    if (a.forward > 0) parts.push('↑');
    else if (a.forward < 0) parts.push('↓');
    if (a.strafe > 0) parts.push('→');
    else if (a.strafe < 0) parts.push('←');
    if (a.up > 0) parts.push('▲');
    else if (a.up < 0) parts.push('▼');
    if (a.boost > 0) parts.push('×4');
    return parts.length ? parts.join(' ') : 'idle';
  }

  function tick() {
    frames++;
    const now = performance.now();
    if (now - lastT >= 500) {
      const fps = Math.round((frames * 1000) / (now - lastT));
      fpsEl.textContent = String(fps);
      frames = 0;
      lastT = now;
    }
    const cam = getCamera();
    posEl.textContent = `${cam.x.toFixed(1)}, ${cam.z.toFixed(1)}`;
    yawEl.textContent = `${((cam.yaw * 180) / Math.PI).toFixed(0)}° / ${((cam.pitch * 180) / Math.PI).toFixed(0)}°`;
    const ter = getTerrain();
    chunksEl.textContent = `${ter.chunks.size} loaded / ${ter.pendingCount} queued`;
    dirEl.textContent = fmtMotion(getAxes());
  }

  return {
    tick,
    toggle() {
      el.classList.toggle('hud--hidden');
    },
    show() {
      el.classList.remove('hud--hidden');
    },
    hide() {
      el.classList.add('hud--hidden');
    },
    setPointerLock(locked) {
      lockHint.classList.toggle('pointer-lock-hint--hidden', locked);
    },
  };
}
