import { Group, Object3D, PerspectiveCamera, Scene, Vector3 } from "three";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Emitter } from "../../src/events";
import { resolveOptions } from "../../src/index";
import { createInput, SLOT_COUNT } from "../../src/input";
import type { AllEvents, KitContext } from "../../src/internal";
import type { RaycastFn, RaycastHit } from "../../src/types";

// The model factories load from a CDN; replace them with spies that record what they were given.
const spies = vi.hoisted(() => ({
  controllerModels: [] as unknown[],
  handModels: [] as Array<{ hand: unknown; profile: string | undefined }>,
  handLoaders: [] as any[],
}));

vi.mock("three/examples/jsm/webxr/XRControllerModelFactory.js", async () => {
  const { Object3D } = await import("three");
  return {
    XRControllerModelFactory: class {
      createControllerModel(grip: unknown) {
        spies.controllerModels.push(grip);
        const o = new Object3D();
        o.name = "controller-model";
        return o;
      }
    },
  };
});

vi.mock("three/examples/jsm/webxr/XRHandModelFactory.js", async () => {
  const { Object3D } = await import("three");
  return {
    XRHandModelFactory: class {
      constructor(loader: unknown) {
        spies.handLoaders.push(loader);
      }
      createHandModel(hand: unknown, profile?: string) {
        spies.handModels.push({ hand, profile });
        const o = new Object3D();
        o.name = `hand-${profile}`;
        return o;
      }
    },
  };
});

vi.mock("three/examples/jsm/loaders/GLTFLoader.js", () => ({
  GLTFLoader: class {
    setPath() {
      return this;
    }
    load(_url: string, _onLoad: unknown, _onProgress: unknown, onError?: (e: unknown) => void) {
      onError?.(new Error("404"));
    }
  },
}));

interface FakeXR {
  getController(i: number): Group;
  getControllerGrip(i: number): Group;
  getHand(i: number): Group;
  controllers: Group[];
  grips: Group[];
  hands: Group[];
}

function fakeXR(): FakeXR {
  const controllers: Group[] = [];
  const grips: Group[] = [];
  const hands: Group[] = [];
  const get = (list: Group[], i: number) => {
    if (!list[i]) list[i] = new Group();
    return list[i];
  };
  return {
    controllers,
    grips,
    hands,
    getController: vi.fn((i: number) => get(controllers, i)),
    getControllerGrip: vi.fn((i: number) => get(grips, i)),
    getHand: vi.fn((i: number) => get(hands, i)),
  };
}

function fakeSource(
  targetRayMode: XRTargetRayMode,
  extra: { hand?: boolean; handedness?: XRHandedness; gamepad?: boolean } = {},
): XRInputSource {
  return {
    targetRayMode,
    handedness: extra.handedness ?? "none",
    hand: extra.hand ? new Map() : undefined,
    gamepad: extra.gamepad ? ({ id: "pad" } as unknown as Gamepad) : undefined,
    targetRaySpace: {},
    profiles: [],
  } as unknown as XRInputSource;
}

const frame = {} as XRFrame;

function setup(
  opts: { controllerModels?: boolean; hands?: boolean; hit?: RaycastHit | null } = {},
) {
  const xr = fakeXR();
  const scene = new Scene();
  const root = new Group();
  scene.add(root);
  const options = resolveOptions({
    renderer: { xr } as any,
    scene,
    camera: new PerspectiveCamera(),
    controllerModels: opts.controllerModels ?? false,
    hands: opts.hands ?? false,
  });
  const raycast = vi.fn<RaycastFn>(() => opts.hit ?? null);
  const events = new Emitter<AllEvents>();
  const ctx = {
    renderer: { xr },
    scene,
    camera: new PerspectiveCamera(),
    options,
    events,
    root,
    up: new Vector3(0, 1, 0),
    raycast,
    mode: "vr",
    session: null,
  } as unknown as KitContext;
  const input = createInput(ctx);
  const log: Array<[string, any]> = [];
  for (const type of ["selectstart", "selectend", "select"] as const) {
    events.on(type, (payload) => log.push([type, payload]));
  }
  return { xr, root, input, raycast, log, ctx };
}

const dispatch = (g: Group, type: string, data?: XRInputSource) =>
  (g as any).dispatchEvent({ type, data });

beforeEach(() => {
  spies.controllerModels.length = 0;
  spies.handModels.length = 0;
  spies.handLoaders.length = 0;
});

describe("createInput", () => {
  it("creates the fixed slots and adds them to the root on start", () => {
    const { xr, root, input } = setup();
    input.start();
    expect(xr.controllers).toHaveLength(SLOT_COUNT);
    expect(xr.grips).toHaveLength(SLOT_COUNT);
    expect(xr.getHand).not.toHaveBeenCalled();
    for (let i = 0; i < SLOT_COUNT; i++) {
      expect(xr.controllers[i].parent).toBe(root);
      expect(xr.grips[i].parent).toBe(root);
    }
    expect(input.rays()).toHaveLength(0);
  });

  it("maps the four target-ray modes to ray kinds", () => {
    const { xr, input } = setup();
    input.start();
    dispatch(xr.controllers[0], "connected", fakeSource("tracked-pointer", { gamepad: true }));
    dispatch(xr.controllers[1], "connected", fakeSource("tracked-pointer", { hand: true }));
    dispatch(xr.controllers[2], "connected", fakeSource("transient-pointer"));
    dispatch(xr.controllers[3], "connected", fakeSource("screen"));
    expect(input.rays().map((r) => r.kind)).toEqual(["controller", "hand", "transient", "screen"]);
    dispatch(xr.controllers[2], "disconnected", undefined);
    dispatch(xr.controllers[2], "connected", fakeSource("gaze"));
    expect(input.rays()[2].kind).toBe("transient");
  });

  it("reports handedness, gamepad and a stable id per slot and source", () => {
    const { xr, input } = setup();
    input.start();
    const left = fakeSource("tracked-pointer", { handedness: "left", gamepad: true });
    const right = fakeSource("tracked-pointer", { handedness: "right" });
    dispatch(xr.controllers[0], "connected", left);
    dispatch(xr.controllers[1], "connected", right);
    const [a, b] = input.rays();
    expect(a.handedness).toBe("left");
    expect(b.handedness).toBe("right");
    expect(a.gamepad).toBe(left.gamepad);
    expect(b.gamepad).toBeUndefined();
    expect(a.id).not.toBe(b.id);
    const id = a.id;
    dispatch(xr.controllers[0], "disconnected", left);
    dispatch(xr.controllers[0], "connected", left);
    expect(input.rays().find((r) => r.handedness === "left")?.id).toBe(id);
  });

  it("returns the same array, holding only connected sources", () => {
    const { xr, input } = setup();
    input.start();
    const list = input.rays();
    const s = fakeSource("tracked-pointer");
    dispatch(xr.controllers[1], "connected", s);
    expect(input.rays()).toBe(list);
    expect(list).toHaveLength(1);
    dispatch(xr.controllers[1], "disconnected", s);
    expect(list).toHaveLength(0);
  });

  it("refreshes origin and direction in world coordinates without new vectors", () => {
    const { xr, input } = setup();
    input.start();
    dispatch(xr.controllers[0], "connected", fakeSource("tracked-pointer"));
    const ray = input.rays()[0];
    const { origin, direction } = ray;
    const c = xr.controllers[0];
    c.position.set(1, 2, 3);
    c.rotation.set(0, Math.PI / 2, 0); // local -Z turns to world -X
    input.update(frame, 0.016);
    expect(ray.origin).toBe(origin);
    expect(ray.direction).toBe(direction);
    expect(ray.origin.toArray()).toEqual([1, 2, 3]);
    expect(ray.direction.x).toBeCloseTo(-1);
    expect(ray.direction.y).toBeCloseTo(0);
    expect(ray.direction.z).toBeCloseTo(0);
    expect(ray.direction.length()).toBeCloseTo(1);
  });

  it("includes the root's transform in the world pose", () => {
    const { xr, root, input } = setup();
    input.start();
    dispatch(xr.controllers[0], "connected", fakeSource("tracked-pointer"));
    root.position.set(0, 10, 0);
    xr.controllers[0].position.set(1, 0, 0);
    input.update(frame, 0);
    expect(input.rays()[0].origin.toArray()).toEqual([1, 10, 0]);
  });

  it("sets selecting and emits the internal selectstart and selectend", () => {
    const { xr, input, log } = setup();
    input.start();
    const s = fakeSource("tracked-pointer", { handedness: "right" });
    dispatch(xr.controllers[0], "connected", s);
    const ray = input.rays()[0];
    dispatch(xr.controllers[0], "selectstart", s);
    expect(ray.selecting).toBe(true);
    expect(log).toEqual([["selectstart", { ray }]]);
    dispatch(xr.controllers[0], "selectend", s);
    expect(ray.selecting).toBe(false);
    expect(log[1]).toEqual(["selectend", { ray }]);
  });

  it("emits the public select with the hit, from one raycast along the ray", () => {
    const object = new Object3D();
    const point = new Vector3(4, 0, -2);
    const { xr, input, log, raycast } = setup({
      hit: { object, point, normal: null, distance: 3 },
    });
    input.start();
    const s = fakeSource("tracked-pointer");
    dispatch(xr.controllers[0], "connected", s);
    xr.controllers[0].position.set(0, 1.5, 0);
    dispatch(xr.controllers[0], "select", s);
    expect(raycast).toHaveBeenCalledTimes(1);
    const [origin, direction, far, targets] = raycast.mock.calls[0];
    expect(origin.toArray()).toEqual([0, 1.5, 0]);
    expect(direction.toArray()).toEqual([0, 0, -1]);
    expect(far).toBe(1e5);
    expect(targets).toBe("all");
    expect(log).toEqual([["select", { object, point, source: "controller" }]]);
  });

  it("emits select with nulls when nothing is hit", () => {
    const { xr, input, log } = setup();
    input.start();
    const s = fakeSource("screen");
    dispatch(xr.controllers[0], "connected", s);
    dispatch(xr.controllers[0], "select", s);
    expect(log).toEqual([["select", { object: null, point: null, source: "screen" }]]);
  });

  it("keeps a transient source's ray for the length of the pinch only", () => {
    const { xr, input, log } = setup();
    input.start();
    const s = fakeSource("transient-pointer");
    const c = xr.controllers[0];
    // three's order: connected, selectstart, select, selectend, disconnected.
    dispatch(c, "connected", s);
    dispatch(c, "selectstart", s);
    expect(input.rays()).toHaveLength(1);
    expect(input.rays()[0].selecting).toBe(true);
    c.position.set(0, 0, -1);
    input.update(frame, 0);
    expect(input.rays()[0].origin.z).toBe(-1);
    dispatch(c, "select", s);
    dispatch(c, "selectend", s);
    expect(input.rays()).toHaveLength(1);
    dispatch(c, "disconnected", s);
    expect(input.rays()).toHaveLength(0);
    expect(log.map(([t]) => t)).toEqual(["selectstart", "select", "selectend"]);
  });

  it("ends the select when a source disappears while selecting", () => {
    const { xr, input, log } = setup();
    input.start();
    const s = fakeSource("transient-pointer");
    dispatch(xr.controllers[0], "connected", s);
    dispatch(xr.controllers[0], "selectstart", s);
    const ray = input.rays()[0];
    dispatch(xr.controllers[0], "disconnected", s);
    expect(input.rays()).toHaveLength(0);
    expect(ray.selecting).toBe(false);
    expect(log.map(([t]) => t)).toEqual(["selectstart", "selectend"]);
  });

  it("shows the ray line for controllers and hands only", () => {
    const { xr, input } = setup();
    input.start();
    const line = (i: number) => xr.controllers[i].getObjectByName("llhil-webxr-ray")!;
    for (let i = 0; i < SLOT_COUNT; i++) expect(line(i).visible).toBe(false);
    const pad = fakeSource("tracked-pointer");
    dispatch(xr.controllers[0], "connected", pad);
    dispatch(xr.controllers[1], "connected", fakeSource("tracked-pointer", { hand: true }));
    dispatch(xr.controllers[2], "connected", fakeSource("transient-pointer"));
    dispatch(xr.controllers[3], "connected", fakeSource("screen"));
    expect([0, 1, 2, 3].map((i) => line(i).visible)).toEqual([true, true, false, false]);
    dispatch(xr.controllers[0], "disconnected", pad);
    expect(line(0).visible).toBe(false);
  });

  it("records connections that arrive before start", () => {
    const { xr, input } = setup();
    dispatch(xr.controllers[0], "connected", fakeSource("tracked-pointer"));
    expect(input.rays()).toHaveLength(0);
    input.start();
    expect(input.rays()).toHaveLength(1);
  });

  it("stop leaves no rays and a second start does not duplicate listeners", () => {
    const { xr, root, input, log, raycast } = setup();
    input.start();
    const s = fakeSource("tracked-pointer");
    dispatch(xr.controllers[0], "connected", s);
    dispatch(xr.controllers[0], "selectstart", s);
    const ray = input.rays()[0];
    input.stop();
    expect(input.rays()).toHaveLength(0);
    expect(ray.selecting).toBe(false);
    expect(root.children).toHaveLength(0);
    // Events between sessions are ignored.
    dispatch(xr.controllers[0], "select", s);
    expect(raycast).not.toHaveBeenCalled();

    log.length = 0;
    input.start();
    expect(root.children).toHaveLength(SLOT_COUNT * 2);
    const t = fakeSource("tracked-pointer");
    dispatch(xr.controllers[0], "connected", t);
    expect(input.rays()).toHaveLength(1);
    dispatch(xr.controllers[0], "selectstart", t);
    dispatch(xr.controllers[0], "select", t);
    dispatch(xr.controllers[0], "selectend", t);
    expect(log.map(([type]) => type)).toEqual(["selectstart", "select", "selectend"]);
    expect(raycast).toHaveBeenCalledTimes(1);
  });

  it("dispose removes the listeners and the ray lines", () => {
    const { xr, input, log } = setup();
    input.start();
    input.dispose();
    const s = fakeSource("tracked-pointer");
    dispatch(xr.controllers[0], "connected", s);
    dispatch(xr.controllers[0], "selectstart", s);
    expect(input.rays()).toHaveLength(0);
    expect(log).toHaveLength(0);
    expect(xr.controllers[0].getObjectByName("llhil-webxr-ray")).toBeUndefined();
  });

  it("does nothing on a renderer without WebXR controllers", () => {
    const ctx = { renderer: { xr: {} }, options: { hands: false, controllerModels: false } };
    const input = createInput(ctx as unknown as KitContext);
    expect(() => input.start()).not.toThrow();
    expect(input.rays()).toHaveLength(0);
    input.dispose();
  });
});

describe("controller and hand models", () => {
  it("attaches nothing when both flags are off", () => {
    setup({ controllerModels: false, hands: false }).input.start();
    expect(spies.controllerModels).toHaveLength(0);
    expect(spies.handModels).toHaveLength(0);
  });

  it("attaches controller models to the grips and hand meshes to the hands", () => {
    const { xr, root, input } = setup({ controllerModels: true, hands: true });
    input.start();
    expect(spies.controllerModels).toEqual(xr.grips);
    for (let i = 0; i < SLOT_COUNT; i++) {
      expect(xr.grips[i].getObjectByName("controller-model")).toBeDefined();
      expect(xr.hands[i].parent).toBe(root);
      expect(xr.hands[i].getObjectByName("hand-mesh")).toBeDefined();
      expect(xr.hands[i].getObjectByName("hand-spheres")).toBeUndefined();
    }
    expect(spies.handModels.filter((m) => m.profile === "mesh")).toHaveLength(SLOT_COUNT);
  });

  it("falls back to sphere hands when the hand mesh fails to load", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { xr, input } = setup({ controllerModels: false, hands: true });
    input.start();
    const loader = spies.handLoaders[0];
    loader.load("left.glb", () => {}, undefined, undefined);
    for (let i = 0; i < SLOT_COUNT; i++) {
      expect(xr.hands[i].getObjectByName("hand-mesh")).toBeUndefined();
      expect(xr.hands[i].getObjectByName("hand-spheres")).toBeDefined();
    }
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("does not create models twice across sessions", () => {
    const { input } = setup({ controllerModels: true, hands: true });
    input.start();
    input.stop();
    input.start();
    expect(spies.controllerModels).toHaveLength(SLOT_COUNT);
    expect(spies.handModels).toHaveLength(SLOT_COUNT * 2);
  });
});

describe("menu-button", () => {
  function padSource(handedness: XRHandedness, targetRayMode: XRTargetRayMode = "tracked-pointer") {
    const buttons = Array.from({ length: 7 }, () => ({ pressed: false, touched: false, value: 0 }));
    const source = {
      ...fakeSource(targetRayMode, { handedness, hand: false }),
      gamepad: { id: "pad", axes: [0, 0, 0, 0], buttons } as unknown as Gamepad,
    } as XRInputSource;
    return { source, buttons };
  }

  function menuSetup() {
    const t = setup();
    const menu: string[] = [];
    t.ctx.events.on("menu-button", ({ hand }) => menu.push(hand));
    t.input.start();
    return { ...t, menu };
  }

  it("emits once per press edge of buttons[5], with the hand", () => {
    const now = vi.spyOn(performance, "now");
    let time = 1000;
    now.mockImplementation(() => time);
    const t = menuSetup();
    const right = padSource("right");
    const left = padSource("left");
    dispatch(t.xr.controllers[0], "connected", right.source);
    dispatch(t.xr.controllers[1], "connected", left.source);
    t.input.update(frame, 0.016);
    expect(t.menu).toEqual([]);
    right.buttons[5].pressed = true;
    t.input.update(frame, 0.016);
    time += 16;
    t.input.update(frame, 0.016);
    expect(t.menu).toEqual(["right"]);
    // Other buttons do nothing.
    left.buttons[4].pressed = true;
    left.buttons[1].pressed = true;
    t.input.update(frame, 0.016);
    expect(t.menu).toEqual(["right"]);
    left.buttons[5].pressed = true;
    t.input.update(frame, 0.016);
    expect(t.menu).toEqual(["right", "left"]);
    // Released and pressed again after the debounce window: a second press.
    right.buttons[5].pressed = false;
    time += 300;
    t.input.update(frame, 0.016);
    right.buttons[5].pressed = true;
    t.input.update(frame, 0.016);
    expect(t.menu).toEqual(["right", "left", "right"]);
    now.mockRestore();
  });

  it("ignores contact bounce within the debounce window", () => {
    const now = vi.spyOn(performance, "now");
    let time = 5000;
    now.mockImplementation(() => time);
    const t = menuSetup();
    const right = padSource("right");
    dispatch(t.xr.controllers[0], "connected", right.source);
    for (let i = 0; i < 6; i++) {
      right.buttons[5].pressed = i % 2 === 0;
      t.input.update(frame, 0.016);
      time += 20;
    }
    expect(t.menu).toEqual(["right"]);
    now.mockRestore();
  });

  it("ignores hands and sources without a side; fires in AR too", () => {
    const t = menuSetup();
    const none = padSource("none");
    const hand = padSource("left");
    (hand.source as any).hand = new Map();
    dispatch(t.xr.controllers[0], "connected", none.source);
    dispatch(t.xr.controllers[1], "connected", hand.source);
    none.buttons[5].pressed = true;
    hand.buttons[5].pressed = true;
    t.input.update(frame, 0.016);
    expect(t.menu).toEqual([]);

    const ar = menuSetup();
    (ar.ctx as any).mode = "ar";
    const right = padSource("right");
    dispatch(ar.xr.controllers[0], "connected", right.source);
    right.buttons[5].pressed = true;
    ar.input.update(frame, 0.016);
    expect(ar.menu).toEqual(["right"]);
  });
});
