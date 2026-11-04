// K1 replaces this stub: the two-point solve and the nudge, pure math.
import { Matrix4, type Vector3 } from "three";
import type { TwoPointSolution } from "./internal";

/**
 * The rigid correction (turn about `up`, then translation; no scale) that maps the model's points
 * `a`, `b` onto the measured points `realA`, `realB`, all in world (scene) coordinates. Heading
 * from the horizontal directions a->b and realA->realB; horizontal position from the midpoints;
 * height from the mean of the two vertical offsets.
 */
export function solveTwoPoint(
  _a: Vector3,
  _b: Vector3,
  _realA: Vector3,
  _realB: Vector3,
  _up: Vector3,
): TwoPointSolution {
  return { matrix: new Matrix4(), yawDeg: 0, errorM: 0 };
}

/**
 * Applies a nudge to a correction: a turn of `turnDeg` about `up` through `pivot`, then a move by
 * `moveWorld` (a horizontal world vector). Returns a new matrix.
 */
export function nudgeMatrix(
  correction: Matrix4,
  _pivot: Vector3,
  _up: Vector3,
  _turnDeg: number,
  _moveWorld: Vector3,
): Matrix4 {
  return correction.clone();
}
