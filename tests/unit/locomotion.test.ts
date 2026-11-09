import {
  BoxGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Scene,
  Vector3,
} from "three";
import { describe, expect, it, vi } from "vitest";
import { Emitter } from "../../src/events";
import type { AllEvents, KitContext, RaySource } from "../../src/internal";
import {
  createLocomotion,
  DEAD_ZONE,
  defaultLocomotion,
  MAX_DROP_PER_FRAME,
  stickToMove,
  WALL_MARGIN,
} from "../../src/locomotion";
import { directionFromYaw, upVector } from "../../src/math";
import { createDefaultRaycast } from "../../src/raycast";
import type { LocomotionOptions, RaycastFn, UpAxis, XRMode } from "../../src/types";

const frame = {} as XRFrame;
const DT = 0.05;

/** A box between two corners given as [east, north, height], mapped to the scene's up axis. */
type Plan = [number, number, number];
function planPoint(up: UpAxis, [e, n, h]: Plan): Vector3 {
  return up === "z" ? new Vector3(e, n, h) : new Vector3(e, h, -n);
}

function box(up: UpAxis, min: Plan, max: Plan): Mesh {
  const a = planPoint(up, min);
  const b = planPoint(up, max);
  const size = b.clone().sub(a);
  const mesh = new Mesh(
    new BoxGeometry(Math.abs(size.x), Math.abs(size.y), Math.abs(size.z)),
    new MeshBasicMaterial(),
  );
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  return mesh;
}

interface World {
  /** Walkable boxes. */
  floors?: Array<[Plan, Plan]>;
  /** Boxes that are not floors (walls). */
  walls?: Array<[Plan, Plan]>;
}

/** The default ground: 20 m square, top at height 0. */
const GROUND: [Plan, Plan] = [
  [-10, -10, -0.2],
  [10, 10, 0],
];

function makeRaycast(up: UpAxis, world: World) {
  const scene = new Scene();
  const floors: Mesh[] = [];
  for (const [a, b] of world.floors ?? [GROUND]) {
    const m = box(up, a, b);
    floors.push(m);
    scene.add(m);
  }
  for (const [a, b] of world.walls ?? []) scene.add(box(up, a, b));
  scene.updateMatrixWorld(true);
  const kitRoot = new Group();
  return createDefaultRaycast(
    () => floors,
    () => scene,
    kitRoot,
  );
}

function gamepad(axes = [0, 0, 0, 0], grip = false): Gamepad {
  const buttons = Array.from({ length: 7 }, () => ({ pressed: false, touched: false, value: 0 }));
  buttons[1].pressed = grip;
  buttons[1].value = grip ? 1 : 0;
  return { axes, buttons } as unknown as Gamepad;
}

function controller(
  id: string,
  pad: Gamepad,
  handedness: "left" | "right" = "right",
  kind: RaySource["kind"] = "controller",
): RaySource {
  return {
    id,
    kind,
    handedness,
    origin: new Vector3(),
    direction: new Vector3(0, 0, -1),
    selecting: false,
    gamepad: pad,
  };
}

function setup(
  options: {
    up?: UpAxis;
    loco?: Partial<LocomotionOptions>;
    turn?: "snap" | "none";
    world?: World;
    raycast?: RaycastFn;
    mode?: XRMode;
    start?: Plan;
    yaw?: number;
  } = {},
) {
  const upAxis = options.up ?? "y";
  const up = upVector(upAxis);
  const feet = planPoint(upAxis, options.start ?? [0, 0, 0]);
  const forward = directionFromYaw(options.yaw ?? 0, upAxis);
  const base = options.raycast ?? makeRaycast(upAxis, options.world ?? {});
  let rayCount = 0;
  const raycast: RaycastFn = (o, d, f, t) => {
    rayCount++;
    return base(o, d, f, t);
  };
  const space = {
    headInto(eye: Vector3, f: Vector3, floorPoint: Vector3) {
      floorPoint.copy(feet);
      eye.copy(feet).addScaledVector(up, 1.6);
      f.copy(forward);
    },
    moveBy: vi.fn((d: Vector3) => {
      feet.add(d);
    }),
    snapTurn: vi.fn(),
    placeUser: vi.fn(),
  };
  const rays: RaySource[] = [];
  const root = new Group();
  const ctx = {
    events: new Emitter<AllEvents>(),
    root,
    up,
    raycast,
    space,
    input: { rays: () => rays },
    camera: new PerspectiveCamera(),
    mode: options.mode ?? "vr",
    session: null,
    options: {
      up: upAxis,
      vr: {
        turn: options.turn ?? "snap",
        snapDegrees: 30,
        eyeHeight: 1.6,
        teleport: true,
        locomotion: { ...defaultLocomotion(30), ...options.loco },
      },
    },
  } as unknown as KitContext;
  const module = createLocomotion(ctx);
  module.start();
  const run = (frames: number, dt = DT) => {
    for (let i = 0; i < frames; i++) module.update(frame, dt);
  };
  const height = () => feet.dot(up);
  /** Plan coordinates [east, north] of the feet. */
  const plan = () => (upAxis === "z" ? [feet.x, feet.y] : ([feet.x, -feet.z] as [number, number]));
  return {
    ctx,
    module,
    rays,
    space,
    feet,
    forward,
    up,
    run,
    height,
    plan,
    rayCount: () => rayCount,
    resetRays: () => {
      rayCount = 0;
    },
    loco: ctx.options.vr.locomotion,
  };
}

describe("stickToMove", () => {
  const up = new Vector3(0, 1, 0);

  it("maps stick forward to where the head looks, turned by its yaw", () => {
    const out = new Vector3();
    stickToMove(0, -1, directionFromYaw(0, "y"), up, false, out);
    expect(out.distanceTo(new Vector3(0, 0, -1))).toBeLessThan(1e-9);
    // Yaw 90 looks along -X.
    stickToMove(0, -1, directionFromYaw(90, "y"), up, false, out);
    expect(out.distanceTo(new Vector3(-1, 0, 0))).toBeLessThan(1e-9);
    // Back.
    stickToMove(0, 1, directionFromYaw(90, "y"), up, false, out);
    expect(out.distanceTo(new Vector3(1, 0, 0))).toBeLessThan(1e-9);
  });

  it("strafes to the head's right", () => {
    const out = new Vector3();
    stickToMove(1, 0, directionFromYaw(0, "y"), up, false, out);
    expect(out.distanceTo(new Vector3(1, 0, 0))).toBeLessThan(1e-9);
    stickToMove(1, 0, directionFromYaw(90, "y"), up, false, out);
    expect(out.distanceTo(new Vector3(0, 0, -1))).toBeLessThan(1e-9);
  });

  it("walks horizontally whatever the head pitch, and flies along it", () => {
    const out = new Vector3();
    const down45 = new Vector3(0, -1, -1).normalize();
    stickToMove(0, -1, down45, up, false, out);
    expect(out.distanceTo(new Vector3(0, 0, -1))).toBeLessThan(1e-9);
    stickToMove(0, -1, down45, up, true, out);
    expect(out.distanceTo(down45)).toBeLessThan(1e-9);
    // Flying strafe stays horizontal.
    stickToMove(1, 0, down45, up, true, out);
    expect(out.distanceTo(new Vector3(1, 0, 0))).toBeLessThan(1e-9);
  });

  it("works in a Z-up scene", () => {
    const out = new Vector3();
    const z = new Vector3(0, 0, 1);
    stickToMove(0, -1, directionFromYaw(0, "z"), z, false, out);
    expect(out.distanceTo(new Vector3(0, 1, 0))).toBeLessThan(1e-9);
    stickToMove(1, 0, directionFromYaw(0, "z"), z, false, out);
    expect(out.distanceTo(new Vector3(1, 0, 0))).toBeLessThan(1e-9);
  });

  it("has a radial dead zone, rescales past it and caps at 1", () => {
    const out = new Vector3();
    const f = directionFromYaw(0, "y");
    stickToMove(0.1, -0.1, f, up, false, out);
    expect(out.length()).toBe(0);
    stickToMove(0, -DEAD_ZONE, f, up, false, out);
    expect(out.length()).toBe(0);
    const half = DEAD_ZONE + (1 - DEAD_ZONE) / 2;
    stickToMove(0, -half, f, up, false, out);
    expect(out.length()).toBeCloseTo(0.5, 9);
    stickToMove(1, -1, f, up, false, out);
    expect(out.length()).toBeCloseTo(1, 9);
    // Two hands pushing together are no faster than one.
    stickToMove(0, -2, f, up, false, out);
    expect(out.length()).toBeCloseTo(1, 9);
  });
});

describe("walk", () => {
  it("walks forward at the speed, relative to the head, on the floor", () => {
    const t = setup();
    t.rays.push(controller("r", gamepad([0, 0, 0, -1])));
    t.run(20); // 1 s
    expect(t.plan()[1]).toBeCloseTo(1.4, 6);
    expect(t.plan()[0]).toBeCloseTo(0, 6);
    expect(t.height()).toBeCloseTo(0, 6);
  });

  it("follows the head's yaw", () => {
    const t = setup({ yaw: 90 });
    t.rays.push(controller("r", gamepad([0, 0, 0, -1])));
    t.run(10);
    expect(t.feet.x).toBeCloseTo(-0.7, 6);
    expect(t.feet.z).toBeCloseTo(0, 6);
  });

  it("uses the speed option, and either hand", () => {
    const t = setup({ loco: { speed: 2 } });
    t.rays.push(controller("l", gamepad([0, 0, 1, 0]), "left"));
    t.run(10);
    expect(t.plan()[0]).toBeCloseTo(1, 6);
  });

  it("does nothing within the dead zone and casts no ray", () => {
    const t = setup();
    t.rays.push(controller("r", gamepad([0, 0, 0.1, -0.1])));
    t.run(10);
    expect(t.space.moveBy).not.toHaveBeenCalled();
    expect(t.rayCount()).toBe(0);
  });

  it("ignores hands (pinch keeps teleporting)", () => {
    const t = setup();
    t.rays.push(controller("h", gamepad([0, 0, 0, -1]), "right", "hand"));
    t.run(5);
    expect(t.space.moveBy).not.toHaveBeenCalled();
  });

  it("steps up onto a step of at most 0.35 m", () => {
    const t = setup({
      world: {
        floors: [
          GROUND,
          [
            [-1, 1, 0],
            [1, 3, 0.3],
          ],
        ],
      },
    });
    t.rays.push(controller("r", gamepad([0, 0, 0, -1])));
    t.run(30); // 2.1 m: on the step
    expect(t.plan()[1]).toBeGreaterThan(1.2);
    expect(t.height()).toBeCloseTo(0.3, 6);
  });

  it("walks up the demo scene's stair (18 steps of 0.167 m on 0.28 m treads)", () => {
    const rise = 3 / 18;
    const steps: Array<[Plan, Plan]> = [];
    for (let i = 0; i < 18; i++) {
      steps.push([
        [-1, 1 + i * 0.28, i * rise],
        [1, 1.28 + i * 0.28, (i + 1) * rise],
      ]);
    }
    const top: [Plan, Plan] = [
      [-1, 1 + 18 * 0.28, 2.8],
      [1, 10, 3],
    ];
    const t = setup({ world: { floors: [GROUND, ...steps, top] } });
    t.rays.push(controller("r", gamepad([0, 0, 0, -1])));
    t.run(200); // 10 s, 14 m
    expect(t.height()).toBeCloseTo(3, 6);
    expect(t.plan()[1]).toBeGreaterThan(7);
  });

  it("refuses a step higher than 0.35 m, even one below knee height", () => {
    const t = setup({
      world: {
        floors: [
          GROUND,
          [
            [-1, 1, 0],
            [1, 3, 0.38],
          ],
        ],
      },
    });
    t.rays.push(controller("r", gamepad([0, 0, 0, -1])));
    t.run(30);
    expect(t.plan()[1]).toBeLessThan(1);
    expect(t.plan()[1]).toBeGreaterThan(0.9);
    expect(t.height()).toBeCloseTo(0, 6);
  });

  it("steps down under gravity, at most 0.5 m per frame, and keeps falling with the stick released", () => {
    const t = setup({
      start: [0, 0, 6],
      world: {
        floors: [
          GROUND,
          [
            [-1, -1, 5.8],
            [1, 0.05, 6],
          ],
        ],
      },
    });
    t.feet.copy(planPoint("y", [0, 0, 6]));
    const pad = gamepad([0, 0, 0, -1]);
    t.rays.push(controller("r", pad));
    const heights: number[] = [t.height()];
    t.run(2);
    heights.push(t.height());
    // Off the edge now: release the stick and fall.
    (pad.axes as number[])[3] = 0;
    for (let i = 0; i < 60; i++) {
      t.run(1, 0.1);
      heights.push(t.height());
    }
    expect(heights.at(-1)).toBeCloseTo(0, 6);
    for (let i = 1; i < heights.length; i++) {
      const drop = heights[i - 1] - heights[i];
      expect(drop).toBeGreaterThanOrEqual(-1e-9);
      expect(drop).toBeLessThanOrEqual(MAX_DROP_PER_FRAME + 1e-9);
    }
    // Gravity-like: it took several frames, not one.
    expect(heights.filter((h) => h > 0.01 && h < 5.99).length).toBeGreaterThan(5);
  });

  it("takes small drops at once (ramps)", () => {
    const t = setup({
      world: {
        floors: [
          [
            [-5, -5, -0.2],
            [5, 1, 0],
          ],
          [
            [-5, 1, -0.24],
            [5, 5, -0.04],
          ],
        ],
      },
    });
    t.rays.push(controller("r", gamepad([0, 0, 0, -1])));
    t.run(20);
    expect(t.height()).toBeCloseTo(-0.04, 6);
  });

  it("refuses to walk off into the void and stays on the last floor", () => {
    const t = setup({
      world: {
        floors: [
          [
            [-5, -5, -0.2],
            [5, 1, 0],
          ],
        ],
      },
    });
    t.rays.push(controller("r", gamepad([0, 0, 0, -1])));
    t.run(60);
    expect(t.plan()[1]).toBeLessThanOrEqual(1);
    expect(t.plan()[1]).toBeGreaterThan(0.9);
    expect(t.height()).toBeCloseTo(0, 6);
  });

  it("stops at a wall, keeping the margin", () => {
    const t = setup({
      world: {
        walls: [
          [
            [-5, 3, 0],
            [5, 3.2, 3],
          ],
        ],
      },
    });
    t.rays.push(controller("r", gamepad([0, 0, 0, -1])));
    t.run(100);
    expect(t.plan()[1]).toBeLessThanOrEqual(3 - WALL_MARGIN + 1e-6);
    expect(t.plan()[1]).toBeGreaterThan(3 - WALL_MARGIN - 0.01);
  });

  it("slides along a wall hit at an angle", () => {
    const t = setup({
      world: {
        walls: [
          [
            [-50, 3, 0],
            [50, 3.2, 3],
          ],
        ],
      },
    });
    // Forward and right at 45 degrees.
    t.rays.push(controller("r", gamepad([0, 0, Math.SQRT1_2, -Math.SQRT1_2])));
    t.run(100); // 5 s
    // The margin holds square to the wall, not along the diagonal ray.
    expect(t.plan()[1]).toBeLessThanOrEqual(3 - WALL_MARGIN + 1e-6);
    expect(t.plan()[1]).toBeGreaterThan(3 - WALL_MARGIN - 0.01);
    // Without sliding, x would stop near 2.75 too; it keeps going along the wall.
    expect(t.plan()[0]).toBeGreaterThan(4);
  });

  it("stops at a low wall caught by the knee ray only", () => {
    const t = setup({
      world: {
        walls: [
          [
            [-5, 2, 0],
            [5, 2.2, 0.6],
          ],
        ],
      },
    });
    t.rays.push(controller("r", gamepad([0, 0, 0, -1])));
    t.run(100);
    expect(t.plan()[1]).toBeLessThanOrEqual(2 - WALL_MARGIN + 1e-6);
  });

  it("casts at most 6 rays per frame, and none with the stick at rest", () => {
    const t = setup({
      world: {
        walls: [
          [
            [-50, 3, 0],
            [50, 3.2, 3],
          ],
        ],
      },
    });
    const pad = gamepad([0, 0, Math.SQRT1_2, -Math.SQRT1_2]);
    t.rays.push(controller("r", pad));
    for (let i = 0; i < 100; i++) {
      t.resetRays();
      t.run(1);
      expect(t.rayCount()).toBeLessThanOrEqual(6);
    }
    (pad.axes as number[])[2] = 0;
    (pad.axes as number[])[3] = 0;
    t.resetRays();
    t.run(10);
    expect(t.rayCount()).toBe(0);
  });

  it("works in a Z-up scene, step included", () => {
    const t = setup({
      up: "z",
      world: {
        floors: [
          GROUND,
          [
            [-1, 1, 0],
            [1, 3, 0.2],
          ],
        ],
      },
    });
    t.rays.push(controller("r", gamepad([0, 0, 0, -1])));
    t.run(30);
    expect(t.feet.y).toBeGreaterThan(1.2);
    expect(t.feet.z).toBeCloseTo(0.2, 6);
  });
});

describe("fly", () => {
  it("moves along the full head direction, without floor following", () => {
    const t = setup({ loco: { mode: "fly" } });
    t.forward.set(0, 1, -1).normalize();
    t.rays.push(controller("r", gamepad([0, 0, 0, -1])));
    t.run(20);
    const s = 1.4 * Math.SQRT1_2;
    expect(t.feet.y).toBeCloseTo(s, 6);
    expect(t.feet.z).toBeCloseTo(-s, 6);
  });

  it("stops at the floor when flying down, and at a ceiling", () => {
    const t = setup({
      loco: { mode: "fly", speed: 3 },
      world: {
        walls: [
          [
            [-5, -5, 2.5],
            [5, 5, 2.7],
          ],
        ],
      },
    });
    t.forward.set(0, -1, -0.001).normalize();
    t.rays.push(controller("r", gamepad([0, 0, 0, -1])));
    t.run(20);
    expect(t.height()).toBeGreaterThanOrEqual(-1e-6);
    expect(t.height()).toBeLessThan(0.01);
    // Up into the ceiling: the eye (1.6 m above the feet) stays below it.
    t.forward.set(0, 1, -0.001).normalize();
    t.run(40);
    expect(t.height() + 1.6).toBeLessThanOrEqual(2.5);
    expect(t.height() + 1.6).toBeGreaterThan(2.2);
  });

  it("is stopped by walls", () => {
    const t = setup({
      loco: { mode: "fly" },
      world: {
        walls: [
          [
            [-5, 3, 0],
            [5, 3.2, 3],
          ],
        ],
      },
    });
    t.rays.push(controller("r", gamepad([0, 0, 0, -1])));
    t.run(100);
    expect(t.plan()[1]).toBeLessThanOrEqual(3 - WALL_MARGIN + 1e-6);
  });

  it("switching to walk settles onto the floor below", () => {
    const t = setup({ loco: { mode: "fly" } });
    t.feet.set(0, 2, 0);
    t.loco.mode = "walk";
    t.run(40, 0.1);
    expect(t.height()).toBeCloseTo(0, 6);
  });
});

describe("teleport mode", () => {
  it("the stick does not move; grip + stick still turns", () => {
    const t = setup({ loco: { mode: "teleport" } });
    const pad = gamepad([0, 0, 0, -1]);
    t.rays.push(controller("r", pad));
    t.run(10);
    expect(t.space.moveBy).not.toHaveBeenCalled();
    (pad.buttons[1] as { pressed: boolean }).pressed = true;
    (pad.axes as number[])[2] = 0.9;
    t.run(2);
    expect(t.space.snapTurn.mock.calls).toEqual([[-30]]);
  });
});

describe("turn", () => {
  it("grip + stick snap turns once per push, right negative, re-arming at centre", () => {
    const t = setup({ loco: { snapDegrees: 45 } });
    const pad = gamepad([0, 0, 0, 0], true);
    t.rays.push(controller("r", pad));
    const axes = pad.axes as number[];
    axes[2] = 0.9;
    t.run(2);
    axes[2] = 0.5; // still outside the re-arm zone
    t.run(1);
    axes[2] = 0.9;
    t.run(1);
    expect(t.space.snapTurn.mock.calls).toEqual([[-45]]);
    axes[2] = 0.1;
    t.run(1);
    axes[2] = -0.8;
    t.run(2);
    expect(t.space.snapTurn.mock.calls).toEqual([[-45], [45]]);
    // Gripping, the stick does not walk.
    expect(t.space.moveBy).not.toHaveBeenCalled();
  });

  it("the stick without grip strafes instead of turning", () => {
    const t = setup();
    t.rays.push(controller("r", gamepad([0, 0, 0.9, 0])));
    t.run(4);
    expect(t.space.snapTurn).not.toHaveBeenCalled();
    expect(t.plan()[0]).toBeGreaterThan(0.1);
  });

  it("both hands turn alike; snap degrees default to vr.snapDegrees", () => {
    const t = setup();
    t.rays.push(controller("l", gamepad([0, 0, -0.9, 0], true), "left"));
    t.run(2);
    expect(t.space.snapTurn.mock.calls).toEqual([[30]]);
  });

  it("reads the two-axis layout", () => {
    const t = setup();
    t.rays.push(controller("r", gamepad([-0.9, 0], true)));
    t.run(1);
    expect(t.space.snapTurn.mock.calls).toEqual([[30]]);
  });

  it("smooth turn at degrees per second, scaled past the dead zone", () => {
    const t = setup({ loco: { turn: "smooth", smoothDegreesPerSecond: 90 } });
    const pad = gamepad([0, 0, 1, 0], true);
    t.rays.push(controller("r", pad));
    t.run(1, 0.1);
    expect(t.space.snapTurn.mock.calls[0][0]).toBeCloseTo(-9, 9);
    (pad.axes as number[])[2] = -(DEAD_ZONE + (1 - DEAD_ZONE) / 2);
    t.run(1, 0.1);
    expect(t.space.snapTurn.mock.calls[1][0]).toBeCloseTo(4.5, 9);
    (pad.axes as number[])[2] = 0.1;
    t.run(1, 0.1);
    expect(t.space.snapTurn).toHaveBeenCalledTimes(2);
  });

  it("vr.turn 'none' disables turning", () => {
    const t = setup({ turn: "none" });
    t.rays.push(controller("r", gamepad([0, 0, 0.9, 0], true)));
    t.run(3);
    expect(t.space.snapTurn).not.toHaveBeenCalled();
    expect(t.space.moveBy).not.toHaveBeenCalled();
  });
});

describe("vignette", () => {
  const opacity = (m: { material: unknown }) => (m.material as MeshBasicMaterial).opacity;

  it("fades in over ~150 ms while walking and out after stopping, head-locked and black", () => {
    const t = setup();
    const v = t.module.vignette;
    expect(v.parent).toBe(t.ctx.root);
    expect(v.visible).toBe(false);
    const pad = gamepad([0, 0, 0, -1]);
    t.rays.push(controller("r", pad));
    t.run(1, 0.075);
    expect(opacity(v)).toBeCloseTo(0.5, 6);
    t.run(1, 0.075);
    expect(opacity(v)).toBeCloseTo(1, 6);
    expect(v.visible).toBe(true);
    // In front of the eye, facing it.
    const eye = t.feet.clone().addScaledVector(t.up, 1.6);
    const ahead = v.position.clone().sub(eye);
    expect(ahead.dot(t.forward)).toBeGreaterThan(0.2);
    expect(new Vector3(0, 0, 1).applyQuaternion(v.quaternion).dot(t.forward)).toBeCloseTo(-1, 6);
    // Neutral black: every vertex colour is black, only alpha varies.
    const color = v.geometry.getAttribute("color");
    for (let i = 0; i < color.count; i++) {
      expect([color.getX(i), color.getY(i), color.getZ(i)]).toEqual([0, 0, 0]);
    }
    (pad.axes as number[])[3] = 0;
    t.run(2, 0.075);
    expect(opacity(v)).toBeCloseTo(0, 6);
    expect(v.visible).toBe(false);
  });

  it("shows while smooth-turning, not while snap-turning", () => {
    const snap = setup();
    snap.rays.push(controller("r", gamepad([0, 0, 0.9, 0], true)));
    snap.run(3);
    expect(snap.module.vignette.visible).toBe(false);
    const smooth = setup({ loco: { turn: "smooth" } });
    smooth.rays.push(controller("r", gamepad([0, 0, 0.9, 0], true)));
    smooth.run(3);
    expect(smooth.module.vignette.visible).toBe(true);
  });

  it("stays off with vignette false, and while blocked by a wall", () => {
    const t = setup({ loco: { vignette: false } });
    t.rays.push(controller("r", gamepad([0, 0, 0, -1])));
    t.run(10);
    expect(t.module.vignette.visible).toBe(false);

    const blocked = setup({
      world: {
        walls: [
          [
            [-5, 0.2, 0],
            [5, 0.4, 3],
          ],
        ],
      },
    });
    blocked.rays.push(controller("r", gamepad([0, 0, 0, -1])));
    blocked.run(10);
    expect(blocked.module.vignette.visible).toBe(false);
  });
});

describe("ui capture (the VR menu has the controllers)", () => {
  it("no walking, turning or vignette while captured; the sticks must centre after", () => {
    const t = setup();
    const pad = gamepad([0, 0, 0, -1]);
    t.rays.push(controller("r", pad));
    (t.ctx as { uiCapture: boolean }).uiCapture = true;
    t.run(5);
    (pad.buttons[1] as { pressed: boolean }).pressed = true;
    (pad.axes as number[])[2] = 0.9;
    t.run(3);
    expect(t.space.moveBy).not.toHaveBeenCalled();
    expect(t.space.snapTurn).not.toHaveBeenCalled();
    expect(t.module.vignette.visible).toBe(false);
    // Released while the stick is still pushed: nothing until it centres.
    (t.ctx as { uiCapture: boolean }).uiCapture = false;
    t.run(3);
    expect(t.space.snapTurn).not.toHaveBeenCalled();
    (pad.axes as number[])[2] = 0;
    (pad.axes as number[])[3] = 0;
    t.run(2);
    (pad.axes as number[])[2] = 0.9;
    t.run(1);
    expect(t.space.snapTurn.mock.calls).toEqual([[-30]]);
    (pad.buttons[1] as { pressed: boolean }).pressed = false;
    (pad.axes as number[])[2] = 0;
    (pad.axes as number[])[3] = -1;
    t.run(2);
    expect(t.space.moveBy).toHaveBeenCalled();
  });
});

describe("lifecycle", () => {
  it("is inactive in AR", () => {
    const t = setup({ mode: "ar" });
    t.rays.push(controller("r", gamepad([0, 0, 0.9, -0.9], true)));
    t.run(5);
    expect(t.space.moveBy).not.toHaveBeenCalled();
    expect(t.space.snapTurn).not.toHaveBeenCalled();
    expect(t.ctx.root.children).toHaveLength(0);
  });

  it("stop removes the vignette; dispose frees it", () => {
    const t = setup();
    const v = t.module.vignette;
    t.module.stop();
    expect(v.parent).toBeNull();
    t.rays.push(controller("r", gamepad([0, 0, 0, -1])));
    t.run(3);
    expect(t.space.moveBy).not.toHaveBeenCalled();
    const disposed = vi.fn();
    v.geometry.addEventListener("dispose", disposed);
    t.module.dispose();
    expect(disposed).toHaveBeenCalledTimes(1);
  });
});
