// Observer location: Izmail, Ukraine (45.36°N, 28.84°E). Astronomically
// fixed — the game world is set here, so sun & stars match.
export const OBSERVER_LAT_DEG = 45.36;
// Solar declination at summer solstice (~June 21). Held constant: the
// game lives in mid-summer, the year doesn't advance.
const SOLAR_DECLINATION_DEG = 23.4;

/**
 * Sun direction as a unit vector in world space. Convention follows the
 * existing setFromAngles: azim=0 → +Z (south at Izmail), azim=+90 → +X
 * (west), azim=-90 → -X (east), elev=0 = horizon, +90 = zenith.
 */
export class Sun {
  constructor() {
    this.dir = [0, 1, 0];
  }

  setFromAngles(azimDeg, elevDeg) {
    const az = (azimDeg * Math.PI) / 180;
    const el = (elevDeg * Math.PI) / 180;
    const ce = Math.cos(el);
    this.dir[0] = Math.sin(az) * ce;
    this.dir[1] = Math.sin(el);
    this.dir[2] = Math.cos(az) * ce;
  }

  /**
   * Astronomically-correct sun for Izmail at summer solstice.
   *
   * `t` ∈ [0..1] is fraction of solar day (0 = midnight, 0.5 = solar noon).
   * Uses the standard altitude/azimuth formulas with observer latitude
   * 45.36° N and solar declination +23.4°. Gives:
   *   - sunrise  ≈ 04:16  (t ≈ 0.178)
   *   - sunset   ≈ 19:44  (t ≈ 0.822)
   *   - noon altitude ≈ 67.96°
   *   - day length  ≈ 15.5 h
   * Sun rises in the NE and sets in the NW, peaks due south at noon.
   */
  setFromTimeOfDay(t) {
    const lat  = (OBSERVER_LAT_DEG    * Math.PI) / 180;
    const decl = (SOLAR_DECLINATION_DEG * Math.PI) / 180;
    // Hour angle: 0 at solar noon, positive afternoon (going west).
    const H = (t - 0.5) * 2 * Math.PI;

    const sinAlt = Math.sin(lat) * Math.sin(decl)
                 + Math.cos(lat) * Math.cos(decl) * Math.cos(H);
    const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt)));

    // Azimuth from south, positive west: standard form using atan2.
    const azFromSouth = Math.atan2(
      Math.sin(H),
      Math.cos(H) * Math.sin(lat) - Math.tan(decl) * Math.cos(lat)
    );

    this.setFromAngles((azFromSouth * 180) / Math.PI, (alt * 180) / Math.PI);
  }
}

/**
 * Ray-march the heightfield against the sun direction. Returns true if a
 * point at (wx, wy, wz) is occluded.
 */
export function inShadow(terrain, sun, wx, wy, wz) {
  for (let s = 1; s <= 8; s++) {
    const t = s * 5;
    const sy = wy + sun.dir[1] * t;
    const th = terrain.heightAt(wx + sun.dir[0] * t, wz + sun.dir[2] * t);
    if (th > sy) return true;
  }
  return false;
}
