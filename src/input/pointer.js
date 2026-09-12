/**
 * Mouse / pointer bindings on the canvas:
 *  - click on canvas → request Pointer Lock (mouse-look)
 *  - while locked, mouse movement → camera.rotate(yaw, pitch)
 *  - wheel → camera height (cameraY in store)
 *  - ESC exits Pointer Lock (browser default)
 */
export function bindPointer(canvas, store, camera, { onLockChange } = {}) {
  let locked = false;

  canvas.addEventListener('click', () => {
    if (!locked) canvas.requestPointerLock?.();
  });

  document.addEventListener('pointerlockchange', () => {
    locked = document.pointerLockElement === canvas;
    onLockChange?.(locked);
  });

  document.addEventListener('mousemove', (e) => {
    if (!locked) return;
    const sens = store.get('mouseSensitivity') || 0.003;
    camera.rotate(e.movementX * sens, -e.movementY * sens);
  });

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const step = e.deltaY > 0 ? 2 : -2;
      const cur = store.get('cameraY');
      const min = 5,
        max = 400;
      store.set('cameraY', Math.max(min, Math.min(max, cur + step)));
    },
    { passive: false }
  );
}
