import { Matrix4, Quaternion, Vector3 } from "three";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { KitContext } from "../../src/internal";
import { normalizeDegrees, upVector, yawFromDirection } from "../../src/math";
import { createSpace } from "../../src/space";
import type { UpAxis, XRMode } from "../../src/types";

/** XRRigidTransform as the WebXR spec defines it: a normalized orientation and a column-major matrix. */
class FakeRigidTransform {
  readonly position: DOMPointReadOnly;
  readonly orientation: DOMPointReadOnly;
  readonly matrix: Float32Array;
  constructor(position: DOMPointInit = {}, orientation: DOMPointInit = {}) {
    this.position = {
      x: position.x ?? 0,
      y: position.y ?? 0,
      z: position.z ?? 0,
      w: 1,
    } as DOMPointReadOnly;
    const q = new Quaternion(
      orientation.x ?? 0,
      orientation.y ?? 0,
      orientation.z ?? 0,
      orientation.w ?? 1,
    ).normalize();
    this.orientation = { x: q.x, y: q.y, z: q.z, w: q.w } as DOMPointReadOnly;
    const m = new Matrix4().compose(
      new Vector3(this.position.x, this.position.y, this.position.z),
      q,
      new Vector3(1, 1, 1),
    );
    // three.js matrices store elements column-major, like the spec's `matrix`.
    this.matrix = new Float32Array(m.elements);
  }
}

interface FakeSpace {
  originOffset: FakeRigidTransform | null;
  parent: FakeSpace | null;
  getOffsetReferenceSpace(t: FakeRigidTransform): FakeSpace;
}

function makeSpace(parent: FakeSpace | null, originOffset: FakeRigidTransform | null): FakeSpace {
  const space: FakeSpace = {
    originOffset,
    parent,
    getOffsetReferenceSpace(t) {
      return makeSpace(space, t);
    },
  };
  return space;
}

const matrixOf = (t: { matrix: Float32Array }) => new Matrix4().fromArray(Array.from(t.matrix));

/** new_from_base: per spec, poses in an offset space are inverse(originOffset) * poses in its parent. */
function fromBase(space: FakeSpace): Matrix4 {
  if (!space.parent || !space.originOffset) return new Matrix4();
  return matrixOf(space.originOffset).invert().multiply(fromBase(space.parent));
}

/** A frame with a head pose given in base coordinates; reports it in whichever space is asked. */
function makeFrame(position: Vector3 | null, orientation = new Quaternion()) {
  return {
    getViewerPose(space: FakeSpace) {
      if (!position) return null;
      const m = fromBase(space).multiply(
        new Matrix4().compose(position, orientation, new Vector3(1, 1, 1)),
      );
      const p = new Vector3();
      const q = new Quaternion();
      m.decompose(p, q, new Vector3());
      return {
        transform: {
          position: { x: p.x, y: p.y, z: p.z, w: 1 },
          orientation: { x: q.x, y: q.y, z: q.z, w: q.w },
        },
      };
    },
  } as unknown as XRFrame;
}

function setup(up: UpAxis, mode: XRMode = "vr") {
  const setReferenceSpace = vi.fn();
  const ctx = {
    renderer: { xr: { setReferenceSpace } },
    options: { up },
    up: upVector(up),
    mode,
  } as unknown as KitContext;
  const space = createSpace(ctx);
  const base = makeSpace(null, null);
  const current = (): FakeSpace => setReferenceSpace.mock.lastCall?.[0];
  return { ctx, space, base, setReferenceSpace, current };
}

const yawQuat = (deg: number) =>
  new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), (deg * Math.PI) / 180);
const close = (a: Vector3, b: Vector3) => expect(a.distanceTo(b)).toBeLessThan(1e-6);
const closeYaw = (a: number, b: number) =>
  expect(Math.abs(normalizeDegrees(a - b))).toBeLessThan(1e-6);

const HEAD = new Vector3(0.3, 1.7, -0.2);

beforeAll(() => {
  (globalThis as unknown as { XRRigidTransform: unknown }).XRRigidTransform = FakeRigidTransform;
});
afterAll(() => {
  delete (globalThis as unknown as { XRRigidTransform?: unknown }).XRRigidTransform;
});

describe("space controller", () => {
  const expectedAfterReset = {
    y: { eye: new Vector3(0.3, 1.7, -0.2), floor: new Vector3(0.3, 0, -0.2) },
    // +90 degrees about X: base (x, y, z) lands on scene (x, -z, y).
    z: { eye: new Vector3(0.3, 0.2, 1.7), floor: new Vector3(0.3, 0.2, 0) },
  };

  for (const up of ["y", "z"] as const) {
    describe(`${up} up`, () => {
      it("maps the head into scene coordinates after reset", () => {
        const { space, base, setReferenceSpace } = setup(up);
        space.reset(base as unknown as XRReferenceSpace);
        expect(setReferenceSpace).toHaveBeenCalledTimes(1);
        space.update(makeFrame(HEAD), 0);
        const h = space.head();
        close(h.eye, expectedAfterReset[up].eye);
        close(h.floorPoint, expectedAfterReset[up].floor);
        closeYaw(h.yawDeg, 0);
      });

      it("reports poses in the space it sets exactly as head() says (inverse of the origin offset)", () => {
        const { space, base, current } = setup(up);
        space.reset(base as unknown as XRReferenceSpace);
        const frame = makeFrame(HEAD, yawQuat(20));
        space.update(frame, 0);
        space.placeUser(up === "z" ? new Vector3(4, -3, 0.5) : new Vector3(4, 0.5, -3), 75);
        space.snapTurn(-30);
        const h = space.head();
        // What three.js would see: the viewer pose in the space we set.
        const pose = frame.getViewerPose(current() as unknown as XRReferenceSpace);
        const p = pose?.transform.position as DOMPointReadOnly;
        close(new Vector3(p.x, p.y, p.z), h.eye);
        // Same check by hand from the recorded transform.
        const offset = current().originOffset as FakeRigidTransform;
        close(HEAD.clone().applyMatrix4(matrixOf(offset).invert()), h.eye);
        // And the facing three.js would see.
        const o = pose?.transform.orientation as DOMPointReadOnly;
        const dir = new Vector3(0, 0, -1).applyQuaternion(new Quaternion(o.x, o.y, o.z, o.w));
        closeYaw(yawFromDirection(dir, up), h.yawDeg);
        closeYaw(h.yawDeg, 45);
      });

      it("places the head's floor point on the target, facing the given yaw", () => {
        const { space, base } = setup(up);
        space.reset(base as unknown as XRReferenceSpace);
        space.update(makeFrame(HEAD, yawQuat(-50)), 0);
        const target = up === "z" ? new Vector3(5, -2, 3) : new Vector3(5, 3, 2);
        for (const yaw of [0, 90, -135, 180]) {
          space.placeUser(target, yaw);
          const h = space.head();
          close(h.floorPoint, target);
          closeYaw(h.yawDeg, yaw);
          // The eye stands straight above the target at the height the headset reports.
          close(h.eye, target.clone().addScaledVector(upVector(up), HEAD.y));
        }
      });

      it("keeps the facing when no yaw is given", () => {
        const { space, base } = setup(up);
        space.reset(base as unknown as XRReferenceSpace);
        space.update(makeFrame(HEAD, yawQuat(10)), 0);
        space.placeUser(new Vector3(1, 1, 1), 60);
        const target = up === "z" ? new Vector3(-7, 2, 4) : new Vector3(-7, 4, 2);
        space.placeUser(target);
        const h = space.head();
        close(h.floorPoint, target);
        closeYaw(h.yawDeg, 60);
      });

      it("snap turns around the head", () => {
        const { space, base } = setup(up);
        space.reset(base as unknown as XRReferenceSpace);
        space.update(makeFrame(HEAD, yawQuat(15)), 0);
        space.placeUser(up === "z" ? new Vector3(2, 3, 0) : new Vector3(2, 0, 3), 170);
        const before = space.head();
        space.snapTurn(30);
        const after = space.head();
        close(after.floorPoint, before.floorPoint);
        close(after.eye, before.eye);
        closeYaw(after.yawDeg, before.yawDeg + 30);
      });

      it("treats the head as at the base origin facing -Z before any pose", () => {
        const { space, base } = setup(up);
        space.reset(base as unknown as XRReferenceSpace);
        space.update(makeFrame(null), 0);
        const target = up === "z" ? new Vector3(1, 2, 0.5) : new Vector3(1, 0.5, 2);
        space.placeUser(target, 90);
        const h = space.head();
        close(h.floorPoint, target);
        close(h.eye, target);
        closeYaw(h.yawDeg, 90);
      });

      it("ignores placeUser and snapTurn in AR, but still applies the up rotation", () => {
        const { space, base, setReferenceSpace } = setup(up, "ar");
        space.reset(base as unknown as XRReferenceSpace);
        expect(setReferenceSpace).toHaveBeenCalledTimes(1);
        space.update(makeFrame(HEAD), 0);
        space.placeUser(new Vector3(9, 9, 9), 45);
        space.snapTurn(30);
        expect(setReferenceSpace).toHaveBeenCalledTimes(1);
        const h = space.head();
        close(h.eye, expectedAfterReset[up].eye);
        closeYaw(h.yawDeg, 0);
      });
    });
  }

  it("keeps the last facing when the head looks straight down", () => {
    const { space, base } = setup("y");
    space.reset(base as unknown as XRReferenceSpace);
    space.update(makeFrame(HEAD, yawQuat(40)), 0);
    const down = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);
    space.update(makeFrame(HEAD, down), 0);
    closeYaw(space.head().yawDeg, 40);
  });

  it("is reusable after stop: the next reset starts from scratch", () => {
    const { space, base, setReferenceSpace } = setup("y");
    space.reset(base as unknown as XRReferenceSpace);
    space.update(makeFrame(HEAD), 0);
    space.placeUser(new Vector3(3, 0, 3), 90);
    space.stop();
    const calls = setReferenceSpace.mock.calls.length;
    // Without a session nothing reaches the renderer.
    space.update(makeFrame(HEAD), 0);
    space.snapTurn(30);
    expect(setReferenceSpace).toHaveBeenCalledTimes(calls);
    const next = makeSpace(null, null);
    space.reset(next as unknown as XRReferenceSpace);
    expect(setReferenceSpace.mock.lastCall?.[0].parent).toBe(next);
    const h = space.head();
    close(h.eye, new Vector3());
    closeYaw(h.yawDeg, 0);
  });
});
