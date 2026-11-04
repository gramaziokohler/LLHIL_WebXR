// Two-point on-site alignment and the nudge by eye, pure math.
import { Matrix4, Vector3 } from "three";
import type { TwoPointSolution } from "./internal";
import { normalizeDegrees } from "./math";

const DEG = Math.PI / 180;
/** Below this the heading from two points is noise, not information. */
const MIN_SPAN_M = 0.1;

function horizontal(v: Vector3, up: Vector3, out = new Vector3()): Vector3 {
  return out.copy(v).addScaledVector(up, -v.dot(up));
}

/**
 * The rigid correction (turn about `up`, then translation; no scale) that maps the model's points
 * `a`, `b` onto the measured points `realA`, `realB`, all in world (scene) coordinates. Heading
 * from the horizontal directions a->b and realA->realB; horizontal position from the midpoints;
 * height from the mean of the two vertical offsets.
 */
export function solveTwoPoint(
  a: Vector3,
  b: Vector3,
  realA: Vector3,
  realB: Vector3,
  up: Vector3,
): TwoPointSolution {
  const d = horizontal(new Vector3().subVectors(b, a), up);
  const r = horizontal(new Vector3().subVectors(realB, realA), up);
  const dLen = d.length();
  const rLen = r.length();
  if (dLen < MIN_SPAN_M || rLen < MIN_SPAN_M) {
    throw new Error("[llhil-webxr] align: the two reference points are too close");
  }

  // Signed angle about up from d to r: right-handed, so positive is counter-clockwise from above.
  const yaw = Math.atan2(new Vector3().crossVectors(d, r).dot(up), d.dot(r));
  const rotation = new Matrix4().makeRotationAxis(up, yaw);

  // A turn about up keeps heights, so mapping the 3D midpoint at once gives both the horizontal
  // midpoint match and the mean of the two vertical offsets.
  const mid = new Vector3().addVectors(a, b).multiplyScalar(0.5).applyMatrix4(rotation);
  const realMid = new Vector3().addVectors(realA, realB).multiplyScalar(0.5);
  const t = realMid.sub(mid);
  const matrix = new Matrix4().makeTranslation(t.x, t.y, t.z).multiply(rotation);

  return { matrix, yawDeg: normalizeDegrees(yaw / DEG), errorM: Math.abs(dLen - rLen) };
}

/**
 * Applies a nudge to a correction: a turn of `turnDeg` about `up` through `pivot`, then a move by
 * `moveWorld` (a horizontal world vector). Returns a new matrix.
 */
export function nudgeMatrix(
  correction: Matrix4,
  pivot: Vector3,
  up: Vector3,
  turnDeg: number,
  moveWorld: Vector3,
): Matrix4 {
  const turn = new Matrix4().makeRotationAxis(up, turnDeg * DEG);
  return new Matrix4()
    .makeTranslation(moveWorld.x + pivot.x, moveWorld.y + pivot.y, moveWorld.z + pivot.z)
    .multiply(turn)
    .multiply(new Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z))
    .multiply(correction);
}

/**
 * Turns a nudge in the user's frame, [right, forward] metres, into a horizontal world vector,
 * using the head's forward flattened onto the ground. A head looking straight up or down has no
 * ground heading, so the move is dropped (zero vector) rather than guessed.
 */
export function userFrameMove(move: [number, number], headForward: Vector3, up: Vector3): Vector3 {
  const forward = horizontal(headForward, up);
  if (forward.lengthSq() < 1e-12) return new Vector3();
  forward.normalize();
  // forward x up points right in a right-handed frame, for either up axis.
  const right = new Vector3().crossVectors(forward, up);
  return right.multiplyScalar(move[0]).addScaledVector(forward, move[1]);
}
