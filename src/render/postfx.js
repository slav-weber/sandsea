/**
 * Per-pixel post-processing pass. All operations work in-place on the RGBA
 * Uint8ClampedArray that was filled by sky + terrain. Each effect is gated
 * by a parameter so the loop short-circuits when nothing is enabled.
 */

/**
 * Combined pass that applies vignette + scanlines + brightness/saturation in
 * a single sweep. Single-pass is much cheaper than three separate ones.
 */
export function applyPostFx(data, width, height, params) {
  const { vignette = 0, scanlines = 0, brightness = 1, saturation = 1 } = params;

  const vig = vignette > 0;
  const scn = scanlines > 0;
  const brt = brightness !== 1;
  const sat = saturation !== 1;

  if (!vig && !scn && !brt && !sat) return;

  const cx = width / 2;
  const cy = height / 2;
  // Max distance² from center → corner; used to normalise vignette falloff.
  const maxD2 = cx * cx + cy * cy;

  for (let y = 0; y < height; y++) {
    // Scanline factor: every odd row dimmed by `scanlines` strength.
    const scanFactor = scn && (y & 1) === 1 ? 1 - scanlines * 0.4 : 1;

    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      let r = data[i];
      let g = data[i + 1];
      let b = data[i + 2];

      if (sat) {
        // Luma-preserving saturation tweak (Rec. 601 weights).
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        r = lum + (r - lum) * saturation;
        g = lum + (g - lum) * saturation;
        b = lum + (b - lum) * saturation;
      }

      if (brt) {
        r *= brightness;
        g *= brightness;
        b *= brightness;
      }

      if (vig) {
        const dx = x - cx;
        const dy = y - cy;
        const d2 = (dx * dx + dy * dy) / maxD2;
        const fall = 1 - vignette * d2; // d2 ∈ [0..1], so fall ∈ [1..1-vignette]
        r *= fall;
        g *= fall;
        b *= fall;
      }

      if (scn) {
        r *= scanFactor;
        g *= scanFactor;
        b *= scanFactor;
      }

      data[i] = r < 0 ? 0 : r > 255 ? 255 : r;
      data[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
      data[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
    }
  }
}
