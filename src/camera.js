/**
 * Camera state + projection. Position + yaw/pitch are mutable; projection
 * is recomputed when fov or viewport changes.
 *
 * Yaw is in radians, 0 = looking +Z; positive yaw rotates clockwise (viewed
 * from above), so +π/2 looks +X. Pitch is in radians, 0 = level; positive
 * pitch looks up. Pitch is approximated by shifting the horizon line — fine
 * for moderate angles, breaks past ~±70°.
 */
export class Camera {
  constructor(width, height, fovDeg = 60) {
    this.x = 0;
    this.z = 0;
    this.yaw = 0;
    this.pitch = 0;
    this.width = width;
    this.height = height;
    this.setFov(fovDeg);
  }

  setFov(fovDeg) {
    this.fovDeg = fovDeg;
    const fovH = (fovDeg * Math.PI) / 180;
    this.focal = this.width / 2 / Math.tan(fovH / 2);
    this.tanHalfFov = Math.tan(fovH / 2);
  }

  setViewport(w, h) {
    this.width = w;
    this.height = h;
    this.setFov(this.fovDeg);
  }

  /** Translate in world coordinates. */
  move(dx, dz) {
    this.x += dx;
    this.z += dz;
  }

  /** Rotate around Y axis. dx is mouse-x movement (in radians-equivalent). */
  rotate(dyaw, dpitch) {
    this.yaw += dyaw;
    // Wrap yaw to [-π, π] to keep numbers small.
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    else if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
    // Pitch clamped just shy of ±90° — at exactly ±π/2 the camera-local
    // forward vector collapses (cos(pitch)=0) and yaw stops affecting view.
    const PITCH_LIMIT = Math.PI / 2 - 0.001;
    this.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.pitch + dpitch));
  }
}
