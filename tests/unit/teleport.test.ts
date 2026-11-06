import { Group, Line, Mesh, Object3D, Vector3 } from "three";
import { describe, expect, it, vi } from "vitest";
import { Emitter } from "../../src/events";
import type { AllEvents, KitContext, RaySource } from "../../src/internal";
import { upVector } from "../../src/math";
import {
  ARC_GRAVITY,
  ARC_SAMPLES,
  ARC_SPEED,
  ARC_STEP,
  type ArcResult,
  createTeleport,
  traceArc,
} from "../../src/teleport";
import type { RaycastFn, UpAxis, VROptions, XRMode } from "../../src/types";

const frame = {} as XRFrame;
const floorObject = new Object3D();

/** A horizontal floor at height `h` along `up`. */
function floorPlane(up: Vector3, h = 0): RaycastFn {
  return (origin, direction, far) => {
    const denom = direction.dot(up);
    if (denom >= -1e-12) return null;
    const t = (h - origin.dot(up)) / denom;
    if (t < 0 || t > far) return null;
    return {
      point: origin.clone().addScaledVector(direction, t),
      normal: up.clone(),
      object: floorObject,
      distance: t,
    };
  };
}

/** A vertical wall at x = 2, facing -X. */
const wall: RaycastFn = (origin, direction, far) => {
  if (direction.x <= 1e-12) return null;
  const t = (2 - origin.x) / direction.x;
  if (t < 0 || t > far) return null;
  return {
    point: origin.clone().addScaledVector(direction, t),
    normal: new Vector3(-1, 0, 0),
    object: floorObject,
    distance: t,
  };
};

function gamepad(axes: number[]): Gamepad {
  return { axes, buttons: [] } as unknown as Gamepad;
}

function ray(
  id: string,
  kind: RaySource["kind"],
  origin: Vector3,
  direction: Vector3,
  pad?: Gamepad,
): RaySource {
  return {
    id,
    kind,
    handedness: "right",
    origin,
    direction: direction.clone().normalize(),
    selecting: false,
    gamepad: pad,
  };
}

function setup(
  options: { up?: UpAxis; vr?: Partial<VROptions>; mode?: XRMode; raycast?: RaycastFn } = {},
) {
  const upAxis = options.up ?? "y";
  const up = upVector(upAxis);
  const events = new Emitter<AllEvents>();
  const root = new Group();
  const rays: RaySource[] = [];
  const space = { placeUser: vi.fn(), snapTurn: vi.fn() };
  const teleports: Vector3[] = [];
  events.on("teleport", ({ position }) => teleports.push(position));
  const ctx = {
    events,
    root,
    up,
    raycast: options.raycast ?? floorPlane(up),
    space,
    input: { rays: () => rays },
    mode: options.mode ?? "vr",
    session: null,
    options: {
      up: upAxis,
      vr: { turn: "snap", snapDegrees: 30, eyeHeight: 1.6, teleport: true, ...options.vr },
    },
  } as unknown as KitContext;
  const module = createTeleport(ctx);
  module.start();
  const marker = () => root.children.find((c) => c instanceof Mesh) as Mesh | undefined;
  const line = () => root.children.find((c) => c instanceof Line) as Line | undefined;
  return { ctx, module, events, rays, space, teleports, root, up, marker, line };
}

describe("traceArc", () => {
  for (const upAxis of ["y", "z"] as const) {
    it(`falls along -up under gravity (${upAxis} up)`, () => {
      const up = upVector(upAxis);
      const origin = new Vector3(1, 2, 3);
      const dir = new Vector3(0.3, 0.4, -0.5).normalize();
      const positions = new Float32Array(ARC_SAMPLES * 3);
      const out: ArcResult = { count: 0, hit: null };
      traceArc(origin, dir, up, () => null, positions, out);
      expect(out.hit).toBeNull();
      expect(out.count).toBe(ARC_SAMPLES);
      for (let i = 0; i < out.count; i++) {
        const t = i * ARC_STEP;
        const p = new Vector3(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
        const expected = origin
          .clone()
          .addScaledVector(dir, ARC_SPEED * t)
          .addScaledVector(up, -0.5 * ARC_GRAVITY * t * t);
        expect(p.distanceTo(expected)).toBeLessThan(1e-4);
      }
      // The last sample is well below the start along up.
      const last = new Vector3().fromArray(positions, (out.count - 1) * 3);
      expect(last.clone().sub(origin).dot(up)).toBeLessThan(-10);
    });

    it(`hits a floor plane where the parabola lands (${upAxis} up)`, () => {
      const up = upVector(upAxis);
      const forward = upAxis === "z" ? new Vector3(0, 1, 0) : new Vector3(0, 0, -1);
      const height = 1.5;
      const origin = up.clone().multiplyScalar(height);
      const positions = new Float32Array(ARC_SAMPLES * 3);
      const out: ArcResult = { count: 0, hit: null };
      const calls: number[] = [];
      const floor = floorPlane(up);
      traceArc(
        origin,
        forward,
        up,
        (a, d, far, targets) => {
          expect(targets).toBe("floors");
          calls.push(far);
          return floor(a, d, far, targets);
        },
        positions,
        out,
      );
      expect(out.hit).not.toBeNull();
      const tLand = Math.sqrt((2 * height) / ARC_GRAVITY);
      const expected = forward.clone().multiplyScalar(ARC_SPEED * tLand);
      expect(out.hit!.point.distanceTo(expected)).toBeLessThan(0.05);
      expect(Math.abs(out.hit!.point.dot(up))).toBeLessThan(1e-9);
      // Stops at the first hit: one raycast per segment up to the landing one.
      expect(calls.length).toBe(Math.ceil(tLand / ARC_STEP));
      expect(out.count).toBe(calls.length + 1);
      const last = new Vector3().fromArray(positions, (out.count - 1) * 3);
      expect(last.distanceTo(out.hit!.point)).toBeLessThan(1e-5);
    });
  }
});

describe("teleport by select", () => {
  it("teleports to the arc's floor hit on select end and emits teleport", () => {
    const t = setup();
    const r = ray("c1", "controller", new Vector3(0, 1.5, 0), new Vector3(0, 0, -1));
    t.rays.push(r);
    t.events.emit("selectstart", { ray: r });
    t.module.update(frame, 0.016);
    expect(t.marker()!.visible).toBe(true);
    expect(t.line()!.visible).toBe(true);
    // Marker lies on the hit, facing up.
    const markerUp = new Vector3(0, 0, 1).applyQuaternion(t.marker()!.quaternion);
    expect(markerUp.distanceTo(t.up)).toBeLessThan(1e-9);
    t.events.emit("selectend", { ray: r });
    expect(t.space.placeUser).toHaveBeenCalledTimes(1);
    const target = t.space.placeUser.mock.calls[0][0] as Vector3;
    expect(target.y).toBeCloseTo(0, 6);
    expect(target.z).toBeLessThan(-3);
    expect(t.space.placeUser.mock.calls[0][1]).toBeUndefined();
    expect(t.teleports).toHaveLength(1);
    expect(t.teleports[0].distanceTo(target)).toBeLessThan(1e-9);
    expect(t.marker()!.visible).toBe(false);
    expect(t.line()!.visible).toBe(false);
  });

  it("works in a Z-up scene", () => {
    const t = setup({ up: "z" });
    const r = ray("c1", "controller", new Vector3(0, 0, 1.5), new Vector3(0, 1, 0));
    t.rays.push(r);
    t.events.emit("selectstart", { ray: r });
    t.module.update(frame, 0.016);
    t.events.emit("selectend", { ray: r });
    const target = t.space.placeUser.mock.calls[0][0] as Vector3;
    expect(target.z).toBeCloseTo(0, 6);
    expect(target.y).toBeGreaterThan(3);
  });

  it("a hand teleports along a straight ray", () => {
    const t = setup();
    const r = ray("h1", "hand", new Vector3(0, 1.5, 0), new Vector3(0, -1, -1));
    t.rays.push(r);
    t.events.emit("selectstart", { ray: r });
    t.module.update(frame, 0.016);
    t.events.emit("selectend", { ray: r });
    const target = t.space.placeUser.mock.calls[0][0] as Vector3;
    expect(target.distanceTo(new Vector3(0, 0, -1.5))).toBeLessThan(1e-9);
  });

  it("a transient pointer pinch on the floor teleports even without a frame between", () => {
    const t = setup();
    const r = ray("t1", "transient", new Vector3(0, 1.6, 0), new Vector3(1, -1, 0));
    t.events.emit("selectstart", { ray: r });
    t.events.emit("selectend", { ray: r });
    const target = t.space.placeUser.mock.calls[0][0] as Vector3;
    expect(target.distanceTo(new Vector3(1.6, 0, 0))).toBeLessThan(1e-9);
    expect(t.teleports).toHaveLength(1);
  });

  it("does not teleport onto a wall", () => {
    const t = setup({ raycast: wall });
    const r = ray("h1", "hand", new Vector3(0, 1.5, 0), new Vector3(1, 0, 0));
    t.rays.push(r);
    t.events.emit("selectstart", { ray: r });
    t.module.update(frame, 0.016);
    // The invalid marker shows on the wall.
    expect(t.marker()!.visible).toBe(true);
    t.events.emit("selectend", { ray: r });
    expect(t.space.placeUser).not.toHaveBeenCalled();
    expect(t.teleports).toHaveLength(0);
  });

  it("does nothing when the arc hits nothing", () => {
    const t = setup({ raycast: () => null });
    const r = ray("c1", "controller", new Vector3(0, 1.5, 0), new Vector3(0, 0, -1));
    t.rays.push(r);
    t.events.emit("selectstart", { ray: r });
    t.module.update(frame, 0.016);
    expect(t.marker()!.visible).toBe(false);
    t.events.emit("selectend", { ray: r });
    expect(t.space.placeUser).not.toHaveBeenCalled();
  });

  it("accepts a hit with an unknown normal", () => {
    const floor = floorPlane(new Vector3(0, 1, 0));
    const t = setup({
      raycast: (a, d, f, k) => {
        const h = floor(a, d, f, k);
        return h ? { ...h, normal: null } : null;
      },
    });
    const r = ray("h1", "hand", new Vector3(0, 1.5, 0), new Vector3(0, -1, -1));
    t.events.emit("selectstart", { ray: r });
    t.events.emit("selectend", { ray: r });
    expect(t.space.placeUser).toHaveBeenCalledTimes(1);
  });

  it("follows only the first aiming ray", () => {
    const t = setup();
    const a = ray("a", "hand", new Vector3(0, 1.5, 0), new Vector3(0, -1, -1));
    const b = ray("b", "hand", new Vector3(0, 1.5, 0), new Vector3(0, -1, 1));
    t.rays.push(a, b);
    t.events.emit("selectstart", { ray: a });
    t.events.emit("selectstart", { ray: b });
    t.module.update(frame, 0.016);
    t.events.emit("selectend", { ray: b });
    expect(t.space.placeUser).not.toHaveBeenCalled();
    t.events.emit("selectend", { ray: a });
    expect(t.space.placeUser).toHaveBeenCalledTimes(1);
    expect((t.space.placeUser.mock.calls[0][0] as Vector3).z).toBeCloseTo(-1.5, 9);
  });
});

describe("trigger only", () => {
  it("the thumbstick neither aims nor teleports nor turns", () => {
    const t = setup();
    const pad = gamepad([0, 0, 0, -0.9]);
    const r = ray("c1", "controller", new Vector3(0, 1.5, 0), new Vector3(0, 0, -1), pad);
    t.rays.push(r);
    t.module.update(frame, 0.016);
    expect(t.line()!.visible).toBe(false);
    (pad.axes as number[])[3] = 0;
    (pad.axes as number[])[2] = 0.9;
    t.module.update(frame, 0.016);
    expect(t.space.placeUser).not.toHaveBeenCalled();
    expect(t.space.snapTurn).not.toHaveBeenCalled();
    expect(t.teleports).toHaveLength(0);
  });

  it("the trigger (select) of a controller with a gamepad aims and teleports", () => {
    const t = setup();
    const pad = gamepad([0, 0, 0, 0]);
    const r = ray("c1", "controller", new Vector3(0, 1.5, 0), new Vector3(0, 0, -1), pad);
    t.rays.push(r);
    t.events.emit("selectstart", { ray: r });
    t.module.update(frame, 0.016);
    expect(t.line()!.visible).toBe(true);
    // Pushing the stick while aiming changes nothing.
    (pad.axes as number[])[3] = -0.9;
    t.module.update(frame, 0.016);
    t.events.emit("selectend", { ray: r });
    expect(t.space.placeUser).toHaveBeenCalledTimes(1);
    expect(t.teleports).toHaveLength(1);
  });
});

describe("ui capture", () => {
  it("no teleport while a UI has the controllers, and an aim in progress is dropped", () => {
    const t = setup();
    const r = ray("c1", "controller", new Vector3(0, 1.5, 0), new Vector3(0, 0, -1));
    t.rays.push(r);
    t.events.emit("selectstart", { ray: r });
    t.module.update(frame, 0.016);
    expect(t.line()!.visible).toBe(true);
    (t.ctx as { uiCapture: boolean }).uiCapture = true;
    t.module.update(frame, 0.016);
    expect(t.line()!.visible).toBe(false);
    t.events.emit("selectend", { ray: r });
    t.events.emit("selectstart", { ray: r });
    t.events.emit("selectend", { ray: r });
    expect(t.space.placeUser).not.toHaveBeenCalled();
    // Free again: the trigger teleports.
    (t.ctx as { uiCapture: boolean }).uiCapture = false;
    t.events.emit("selectstart", { ray: r });
    t.module.update(frame, 0.016);
    t.events.emit("selectend", { ray: r });
    expect(t.space.placeUser).toHaveBeenCalledTimes(1);
  });
});

describe("options and modes", () => {
  it("vr.teleport false disables teleport", () => {
    const t = setup({ vr: { teleport: false } });
    const pad = gamepad([0, 0, 0, -0.9]);
    const r = ray("c1", "controller", new Vector3(0, 1.5, 0), new Vector3(0, 0, -1), pad);
    t.rays.push(r);
    t.events.emit("selectstart", { ray: r });
    t.module.update(frame, 0.016);
    expect(t.line()!.visible).toBe(false);
    (pad.axes as number[])[3] = 0;
    t.events.emit("selectend", { ray: r });
    t.module.update(frame, 0.016);
    expect(t.space.placeUser).not.toHaveBeenCalled();
  });

  it("is inactive in AR", () => {
    const t = setup({ mode: "ar" });
    const pad = gamepad([0, 0, 0.9, -0.9]);
    const r = ray("c1", "controller", new Vector3(0, 1.5, 0), new Vector3(0, 0, -1), pad);
    t.rays.push(r);
    t.events.emit("selectstart", { ray: r });
    t.module.update(frame, 0.016);
    t.events.emit("selectend", { ray: r });
    expect(t.space.placeUser).not.toHaveBeenCalled();
    expect(t.space.snapTurn).not.toHaveBeenCalled();
    expect(t.root.children).toHaveLength(0);
  });

  it("stop hides the visuals and drops the aim; dispose frees the resources", () => {
    const t = setup();
    const r = ray("c1", "controller", new Vector3(0, 1.5, 0), new Vector3(0, 0, -1));
    t.rays.push(r);
    t.events.emit("selectstart", { ray: r });
    t.module.update(frame, 0.016);
    const marker = t.marker()!;
    const line = t.line()!;
    t.module.stop();
    expect(marker.visible).toBe(false);
    expect(line.visible).toBe(false);
    t.events.emit("selectend", { ray: r });
    expect(t.space.placeUser).not.toHaveBeenCalled();

    // A new session starts clean.
    t.module.start();
    t.events.emit("selectend", { ray: r });
    expect(t.space.placeUser).not.toHaveBeenCalled();

    const disposed = vi.fn();
    marker.geometry.addEventListener("dispose", disposed);
    line.geometry.addEventListener("dispose", disposed);
    t.module.dispose();
    expect(disposed).toHaveBeenCalledTimes(2);
    expect(t.root.children).toHaveLength(0);
  });
});
