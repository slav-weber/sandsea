/**
 * Shared, mutable input axes. Multiple input sources (keyboard, dpad, future
 * gamepad) write to the same fields; the frame loop reads them once per tick
 * and turns them into a movement vector relative to the camera's yaw.
 *
 * Convention:
 *   forward: +1 = move toward camera forward, -1 = backward
 *   strafe:  +1 = right, -1 = left
 *   up:      +1 = ascend, -1 = descend
 *   boost:   0..1 multiplier on top of base speed (Shift = 1)
 */
export const axes = {
  forward: 0,
  strafe: 0,
  up: 0,
  boost: 0,
};

/** Reset everything (e.g. on window blur). */
export function clearAxes() {
  axes.forward = 0;
  axes.strafe = 0;
  axes.up = 0;
  axes.boost = 0;
}
