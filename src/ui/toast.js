/**
 * Tiny transient notifications in the top-right corner.
 */
let container = null;

function ensureContainer() {
  if (container) return container;
  container = document.createElement('div');
  container.className = 'toast-stack';
  document.body.appendChild(container);
  return container;
}

export function toast(message, { duration = 1800 } = {}) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  ensureContainer().appendChild(el);
  requestAnimationFrame(() => el.classList.add('toast--in'));
  setTimeout(() => {
    el.classList.remove('toast--in');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
  }, duration);
}
