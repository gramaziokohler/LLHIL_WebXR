import { Quaternion, Vector3 } from "three";
import type { KitContext, SpaceController } from "./internal";
import { normalizeDegrees, projectToPlane, yawFromDirection } from "./math";

const DEG = Math.PI / 180;
const AXIS_X = new Vector3(1, 0, 0);
const AXIS_Y = new Vector3(0, 1, 0);

/**
 * Moves the user by replacing the renderer's reference space with an offset of the base
 * `local-floor` space; the scene and the camera never move.
 *
 * The state is W = world_from_base = T(position) * R_up * R_yaw(theta). `getOffsetReferenceSpace`
 * takes the new space's origin expressed in the base space (base_from_new): poses in the new space
 * are inverse(originOffset) * poses in base. For poses to come out in scene coordinates the new
 * space must be the scene, so originOffset = inverse(W).
 */
export function createSpace(ctx: KitContext): SpaceController {
  let base: XRReferenceSpace | null = null;
  const position = new Vector3();
  let thetaDeg = 0;
  let generation = 0;
  // WebXR is Y up; a Z-up scene needs base +Y on scene +Z and base -Z on scene +Y.
  const upRotation = new Quaternion();

  // Last known head in base coordinates; camera looks along its local -Z.
  const headBase = new Vector3();
  const forwardBase = new Vector3(0, 0, -1);

  const q = new Quaternion();
  const qInv = new Quaternion();
  const tmp = new Vector3();
  const tmp2 = new Vector3();

  function setUpRotation(): void {
    if (ctx.options.up === "z") upRotation.setFromAxisAngle(AXIS_X, Math.PI / 2);
    else upRotation.identity();
  }

  /** R_up * R_yaw(theta): base directions to scene directions. */
  function rotation(out: Quaternion): Quaternion {
    return out.setFromAxisAngle(AXIS_Y, thetaDeg * DEG).premultiply(upRotation);
  }

  function apply(): void {
    if (!base) return;
    rotation(q);
    qInv.copy(q).invert();
    // inverse(T(p) * R) = T(-(R^-1 p)) * R^-1
    tmp.copy(position).applyQuaternion(qInv).negate();
    const offset = new XRRigidTransform(
      { x: tmp.x, y: tmp.y, z: tmp.z, w: 1 },
      { x: qInv.x, y: qInv.y, z: qInv.z, w: qInv.w },
    );
    ctx.renderer.xr.setReferenceSpace(base.getOffsetReferenceSpace(offset));
  }

  /** Puts the position so the head's floor point lands on `floorPoint` at the current theta. */
  function anchorHeadAt(floorPoint: Vector3): void {
    rotation(q);
    tmp.set(headBase.x, 0, headBase.z).applyQuaternion(q);
    position.copy(floorPoint).sub(tmp);
  }

  /** The head's floor point in scene coordinates, into `out`. */
  function currentFloorPoint(out: Vector3): Vector3 {
    rotation(q);
    return out.set(headBase.x, 0, headBase.z).applyQuaternion(q).add(position);
  }

  return {
    get generation() {
      return generation;
    },

    reset(nextBase: XRReferenceSpace): void {
      base = nextBase;
      setUpRotation();
      position.set(0, 0, 0);
      thetaDeg = 0;
      // A new session has its own tracking origin: forget the old head until a pose arrives.
      headBase.set(0, 0, 0);
      forwardBase.set(0, 0, -1);
      apply();
    },

    placeUser(floorPoint: Vector3, yawDeg?: number): void {
      // AR moves the model, never the user.
      if (ctx.mode === "ar") return;
      generation++;
      if (yawDeg !== undefined) {
        // Scene yaw = base yaw + theta: R_up maps the base yaw convention onto the scene's.
        thetaDeg = normalizeDegrees(yawDeg - yawFromDirection(forwardBase, "y"));
      }
      anchorHeadAt(floorPoint);
      apply();
    },

    snapTurn(deltaDeg: number): void {
      if (ctx.mode === "ar") return;
      currentFloorPoint(tmp2);
      thetaDeg = normalizeDegrees(thetaDeg + deltaDeg);
      anchorHeadAt(tmp2);
      apply();
    },

    moveBy(delta: Vector3): void {
      if (ctx.mode === "ar") return;
      generation++;
      position.add(delta);
      apply();
    },

    headInto(eye: Vector3, forward: Vector3, floorPoint: Vector3): void {
      rotation(q);
      eye.copy(headBase).applyQuaternion(q).add(position);
      forward.copy(forwardBase).applyQuaternion(q);
      projectToPlane(eye, position, ctx.up, floorPoint);
    },

    head() {
      rotation(q);
      const eye = headBase.clone().applyQuaternion(q).add(position);
      const floorPoint = projectToPlane(eye, position, ctx.up);
      const dir = forwardBase.clone().applyQuaternion(q);
      return { eye, floorPoint, yawDeg: yawFromDirection(dir, ctx.options.up) };
    },

    start(): void {},

    update(frame: XRFrame, _dt: number): void {
      if (!base) return;
      const pose = frame.getViewerPose(base);
      if (!pose) return;
      const p = pose.transform.position;
      const o = pose.transform.orientation;
      headBase.set(p.x, p.y, p.z);
      q.set(o.x, o.y, o.z, o.w);
      tmp.set(0, 0, -1).applyQuaternion(q);
      // Looking straight up or down has no facing: keep the last one.
      if (tmp.x * tmp.x + tmp.z * tmp.z > 1e-8) forwardBase.copy(tmp);
    },

    stop(): void {
      // The session is over; three.js clears the custom space when the next session is set.
      base = null;
    },

    dispose(): void {
      base = null;
    },
  };
}
