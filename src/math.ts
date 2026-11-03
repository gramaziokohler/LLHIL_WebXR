import { Vector3 } from "three";
import type { UpAxis } from "./types";

const DEG = Math.PI / 180;

/** Unit vector of the scene's up axis. */
export function upVector(up: UpAxis, out = new Vector3()): Vector3 {
  return up === "z" ? out.set(0, 0, 1) : out.set(0, 1, 0);
}

/**
 * The horizontal direction yaw 0 looks along: -Z in a Y-up scene, +Y in a Z-up scene
 * (the image of three.js's -Z under the rotation that stands a Z-up scene upright).
 */
export function forwardAtYawZero(up: UpAxis, out = new Vector3()): Vector3 {
  return up === "z" ? out.set(0, 1, 0) : out.set(0, 0, -1);
}

/** Horizontal unit direction for a yaw in degrees (counter-clockwise seen from above). */
export function directionFromYaw(yawDeg: number, up: UpAxis, out = new Vector3()): Vector3 {
  const a = yawDeg * DEG;
  if (up === "z") {
    // Yaw 0 is +Y; positive turns towards -X.
    return out.set(-Math.sin(a), Math.cos(a), 0);
  }
  // Yaw 0 is -Z; positive turns towards -X.
  return out.set(-Math.sin(a), 0, -Math.cos(a));
}

/**
 * Yaw in degrees of a direction, ignoring its vertical part, in (-180, 180].
 * Returns 0 for a vertical or zero direction.
 */
export function yawFromDirection(direction: Vector3, up: UpAxis): number {
  let x: number;
  let f: number;
  if (up === "z") {
    x = direction.x;
    f = direction.y;
  } else {
    x = direction.x;
    f = -direction.z;
  }
  if (Math.abs(x) < 1e-12 && Math.abs(f) < 1e-12) return 0;
  const yaw = Math.atan2(-x, f) / DEG;
  return normalizeDegrees(yaw);
}

/** Wraps an angle to (-180, 180]. */
export function normalizeDegrees(deg: number): number {
  let d = deg % 360;
  if (d <= -180) d += 360;
  if (d > 180) d -= 360;
  return Object.is(d, -0) ? 0 : d;
}

/** Projects `point` onto the horizontal plane through `planePoint` (normal `up`). */
export function projectToPlane(
  point: Vector3,
  planePoint: Vector3,
  up: Vector3,
  out = new Vector3(),
): Vector3 {
  const h = out.copy(point).sub(planePoint).dot(up);
  return out.copy(point).addScaledVector(up, -h);
}
