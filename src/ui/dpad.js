import { axes } from '../input/axes.js';

/**
 * Touch/mouse-friendly dpad. Hold a direction to move; release to stop.
 * Writes to the shared input axes (same as keyboard). The middle "stop"
 * button hard-resets all axes.
 */
const DIR_AXIS = {
  forward: ['forward', 1],
  backward: ['forward', -1],
  left: ['strafe', -1],
  right: ['strafe', 1],
};

export function mountDpad(rootEl) {
  const buttons = rootEl.querySelectorAll('button[data-dir]');
  let activeDir = 'stop';

  function setDir(dir) {
    activeDir = dir;
    axes.forward = 0;
    axes.strafe = 0;
    if (dir !== 'stop' && DIR_AXIS[dir]) {
      const [axis, sign] = DIR_AXIS[dir];
      axes[axis] = sign;
    }
    buttons.forEach((b) => b.classList.toggle('active', b.dataset.dir === dir));
  }

  buttons.forEach((btn) => {
    const dir = btn.dataset.dir;
    if (dir === 'stop') {
      btn.addEventListener('click', () => setDir('stop'));
      return;
    }
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      btn.setPointerCapture(e.pointerId);
      setDir(dir);
    });
    const release = () => {
      if (activeDir === dir) setDir('stop');
    };
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointercancel', release);
  });

  setDir('stop');
}
