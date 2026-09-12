import { MAX_DIST } from '../terrain/chunks.js';
import { inShadow } from '../lighting.js';

/**
 * Raycast the heightfield for each screen column, write sand pixels into
 * the output buffer (sky is assumed already there).
 *
 * Honors camera.yaw (ray direction rotation around Y) and camera.pitch
 * (horizon shift in screen pixels).
 *
 * Lighting model is intentionally simple and constant:
 *   lit = AMBIENT + DIRECTIONAL · max(0, n·sun)
 * So the ambient floor never "appears" or "disappears" — it's always
 * the same fraction. As the sun sets, the directional term naturally
 * drops to 0 and dunes settle into a uniform ambient-lit look.
 *
 * `hazeColor` is the current sky-horizon color (passed from the pipeline)
 * so distance haze always matches the sky and there's no warm-yellow
 * stripe at the horizon at night.
 */
const AMBIENT = 0.125;
const DIRECTIONAL = 0.75;

export function renderTerrain({
  data,
  width,
  height,
  camera,
  cameraY,
  horizonY,
  terrain,
  sun,
  sandPal,
  sandN,
  shadowStrength,
  hazeAmount,
  hazeColor,
}) {
  const HAZE_R = hazeColor ? hazeColor[0] : 220;
  const HAZE_G = hazeColor ? hazeColor[1] : 196;
  const HAZE_B = hazeColor ? hazeColor[2] : 150;
  const shadowFactor = 1 - shadowStrength;

  const sinY = Math.sin(camera.yaw);
  const cosY = Math.cos(camera.yaw);

  // Effective horizon after pitch — tan(pitch)·focal даёт честную пин-хол
  // проекцию (линейное приближение врёт на больших углах).
  const effHorizon = horizonY + Math.tan(camera.pitch) * camera.focal;

  // Shadows only make sense while the sun is above the horizon.
  const canShadow = shadowFactor < 0.99 && sun.dir[1] > 0.05;

  for (let xs = 0; xs < width; xs++) {
    const ndcX = ((xs - width / 2) / width) * 2 * camera.tanHalfFov;
    const rayDirX = ndcX * cosY + sinY;
    const rayDirZ = -ndcX * sinY + cosY;

    let prevY = height;
    let d = 3;

    while (d < MAX_DIST && prevY > 0) {
      const wx = camera.x + rayDirX * d;
      const wz = camera.z + rayDirZ * d;
      const h = terrain.heightAt(wx, wz);
      const screenY = ((effHorizon + ((cameraY - h) * camera.focal) / d + 0.5) | 0);
      if (screenY >= height) {
        d += 1 + d * 0.012;
        continue;
      }

      if (screenY < prevY) {
        const eps = 1.5;
        const hpx = terrain.heightAt(wx + eps, wz);
        const hmx = terrain.heightAt(wx - eps, wz);
        const hpz = terrain.heightAt(wx, wz + eps);
        const hmz = terrain.heightAt(wx, wz - eps);
        const nx = -(hpx - hmx) / (2 * eps);
        const nz = -(hpz - hmz) / (2 * eps);
        const nlen = Math.sqrt(nx * nx + 1 + nz * nz);

        let litDir = (nx * sun.dir[0] + sun.dir[1] + nz * sun.dir[2]) / nlen;
        if (litDir < 0) litDir = 0;

        // Shadow attenuates ONLY the directional (sun) term. Ambient is
        // by definition light coming from everywhere (sky scattering), so
        // an occluder between this point and the sun can't block it.
        // Result: shadows never crush the pixel below the ambient floor.
        let shadowMul = 1;
        if (canShadow && litDir > 0.08 && d < 500) {
          if (inShadow(terrain, sun, wx, h, wz)) shadowMul = shadowFactor;
        }

        let lit = AMBIENT + DIRECTIONAL * litDir * shadowMul;
        if (lit > 1) lit = 1;

        const palIdx = ((lit * (sandN - 1) + 0.5) | 0);
        let r = sandPal[palIdx * 3];
        let g = sandPal[palIdx * 3 + 1];
        let b = sandPal[palIdx * 3 + 2];

        let haze = (d - 30) / 2200;
        if (haze < 0) haze = 0;
        else if (haze > 1) haze = 1;
        const hm = haze * hazeAmount;
        r = r * (1 - hm) + HAZE_R * hm;
        g = g * (1 - hm) + HAZE_G * hm;
        b = b * (1 - hm) + HAZE_B * hm;

        const top = screenY < 0 ? 0 : screenY;
        const bot = prevY > height ? height : prevY;
        for (let py = top; py < bot; py++) {
          const i = (py * width + xs) * 4;
          data[i] = r;
          data[i + 1] = g;
          data[i + 2] = b;
        }
        prevY = screenY;
      }
      d += 1 + d * 0.012;
    }
  }
}
