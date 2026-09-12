import { applyPreset, randomPresetId } from '../config/presets.js';
import { axes, clearAxes } from './axes.js';

/**
 * Maps a key code to which axis it drives, and which direction. Held keys
 * additively contribute to the axis value; e.g. W+S cancel out.
 */
const AXIS_KEYS = {
  KeyW: ['forward', 1],
  ArrowUp: ['forward', 1],
  KeyS: ['forward', -1],
  ArrowDown: ['forward', -1],
  KeyD: ['strafe', 1],
  ArrowRight: ['strafe', 1],
  KeyA: ['strafe', -1],
  ArrowLeft: ['strafe', -1],
  Space: ['up', 1],
  KeyC: ['up', -1],
  ControlLeft: ['up', -1],
};

const BOOST_KEYS = new Set(['ShiftLeft', 'ShiftRight']);

const LIGHT_MODE_LABELS = ['off', 'flashlight', 'soft light', 'flashlight + soft'];

export function bindKeyboard(store, { canvas, hud, toast, actions = {}, getMode }) {
  const held = new Set();

  function refreshAxes() {
    let fwd = 0,
      str = 0,
      up = 0;
    for (const code of held) {
      const bind = AXIS_KEYS[code];
      if (!bind) continue;
      const [axis, sign] = bind;
      if (axis === 'forward') fwd += sign;
      else if (axis === 'strafe') str += sign;
      else if (axis === 'up') up += sign;
    }
    axes.forward = clamp(fwd, -1, 1);
    axes.strafe = clamp(str, -1, 1);
    axes.up = clamp(up, -1, 1);
  }

  window.addEventListener('keydown', (e) => {
    if (shouldIgnoreTarget(e.target)) return;

    const mode = getMode?.() || 'editor';
    const playing = mode === 'game' || mode === 'editor';

    // Mode switches work in any mode.
    if (e.code === 'F2') {
      e.preventDefault();

      return;
    }
    if (e.code === 'Escape') {

      return;
    }

    // Everything below is player input — ignored in menu / settings / exit.
    if (!playing) return;

    if (AXIS_KEYS[e.code]) {
      e.preventDefault();
      held.add(e.code);
      refreshAxes();
      return;
    }

    if (BOOST_KEYS.has(e.code)) {
      axes.boost = 1;
      return;
    }

    switch (e.code) {
      case 'KeyP':
        store.set('paused', !store.get('paused'));
        break;
      case 'KeyR':
        // World is locked outside the editor — no reseeding in the game.
        if (mode === 'editor') {
          store.set('seed', (Math.random() * 99999) | 0);
          toast?.('New seed');
        }
        break;
      case 'KeyF':
        toggleFullscreen(canvas);
        break;
      case 'KeyH':
        hud?.toggle();
        break;
      case 'KeyN': {
        const id = randomPresetId();
        applyPreset(store, id);
        toast?.('Preset: ' + id);
        break;
      }
      // Interactive tools on the number row (presets are on N / the Scene tab).
      case 'Digit1': {
        const next = ((store.get('caveLightMode') | 0) + 1) % 4;
        store.set('caveLightMode', next);
        toast?.('Flashlight: ' + LIGHT_MODE_LABELS[next]);
        break;
      }
      case 'Digit2':

        break;
      case 'Digit3':

        break;
      case 'Digit4':

        break;
      case 'Digit5':

        break;
      case 'KeyE':

        break;
      case 'KeyQ':

        break;
      case 'KeyI':

        break;


      case 'KeyB':

        break;
      case 'KeyX':
        actions.deleteNearest?.();
        break;
    }
  });

  window.addEventListener('keyup', (e) => {
    if (AXIS_KEYS[e.code]) {
      held.delete(e.code);
      refreshAxes();
    } else if (BOOST_KEYS.has(e.code)) {
      axes.boost = 0;
    }
  });

  window.addEventListener('blur', () => {
    held.clear();
    clearAxes();
  });
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function shouldIgnoreTarget(t) {
  if (!t) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}

function toggleFullscreen(el) {
  if (!document.fullscreenElement) {
    el.requestFullscreen?.();
  } else {
    document.exitFullscreen?.();
  }
}
