import {
  Box3,
  BoxGeometry,
  Color,
  Group,
  Matrix4,
  Mesh,
  type Object3D,
  PerspectiveCamera,
  Quaternion,
  Scene,
  Vector3,
} from "three";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAR } from "../../src/ar";
import { Emitter } from "../../src/events";
import { resolveOptions } from "../../src/index";
import type { AllEvents, KitContext, RaySource } from "../../src/internal";
import { upVector } from "../../src/math";
import type { ARAlignment, KitEvents, UpAxis } from "../../src/types";

// The solve and the store are built in parallel: simple, correct stand-ins of their contracts.
vi.mock("../../src/align", async () => {
  const { Matrix4, Vector3 } = await import("three");
  const horizontal = (v: InstanceType<typeof Vector3>, up: InstanceType<typeof Vector3>) =>
    v.clone().addScaledVector(up, -v.dot(up));
  return {
    solveTwoPoint(
      a: InstanceType<typeof Vector3>,
      b: InstanceType<typeof Vector3>,
      ra: InstanceType<typeof Vector3>,
      rb: InstanceType<typeof Vector3>,
      up: InstanceType<typeof Vector3>,
    ) {
      const dm = horizontal(b.clone().sub(a), up);
      const dr = horizontal(rb.clone().sub(ra), up);
      if (dr.length() < 0.1) throw new Error("The marks are too close together");
      const yaw = Math.atan2(new Vector3().crossVectors(dm, dr).dot(up), dm.dot(dr));
      const r = new Matrix4().makeRotationAxis(up, yaw);
      const midM = a.clone().add(b).multiplyScalar(0.5).applyMatrix4(r);
      const t = ra.clone().add(rb).multiplyScalar(0.5).sub(midM);
      const matrix = new Matrix4().makeTranslation(t.x, t.y, t.z).multiply(r);
      const errorM = Math.abs(a.distanceTo(b) - ra.distanceTo(rb));
      return { matrix, yawDeg: (yaw * 180) / Math.PI, errorM };
    },
    nudgeMatrix(
      correction: InstanceType<typeof Matrix4>,
      pivot: InstanceType<typeof Vector3>,
      up: InstanceType<typeof Vector3>,
      turnDeg: number,
      move: InstanceType<typeof Vector3>,
    ) {
      const m = new Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z);
      m.premultiply(new Matrix4().makeRotationAxis(up, (turnDeg * Math.PI) / 180));
      m.premultiply(
        new Matrix4().makeTranslation(pivot.x + move.x, pivot.y + move.y, pivot.z + move.z),
      );
      return m.multiply(correction);
    },
  };
});

const store = vi.hoisted(() => ({
  supported: vi.fn((_session: unknown) => false),
  has: vi.fn((_id: string) => true),
  save: vi.fn(async (_s: unknown, _id: string, _a: unknown, _b: unknown) => true),
  restore: vi.fn(async (_s: unknown, _id: string): Promise<unknown> => null),
  forget: vi.fn(async (_s: unknown, _id: string) => {}),
}));
vi.mock("../../src/persist", () => ({ createAlignmentStore: () => store }));

class FakeRigidTransform {
  position: { x: number; y: number; z: number; w: number };
  constructor(p: { x?: number; y?: number; z?: number } = {}) {
    this.position = { x: p.x ?? 0, y: p.y ?? 0, z: p.z ?? 0, w: 1 };
  }
}
(globalThis as any).XRRigidTransform = FakeRigidTransform;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

class FakeHitSource {
  cancelled = false;
  constructor(readonly space: unknown) {}
  cancel(): void {
    this.cancelled = true;
  }
}

class FakeSession extends EventTarget {
  inputSources: any[] = [];
  sources: FakeHitSource[] = [];
  viewerSpace = { kind: "viewer" };
  async requestReferenceSpace(type: string) {
    expect(type).toBe("viewer");
    return this.viewerSpace;
  }
  requestHitTestSource({ space }: { space: unknown }) {
    const source = new FakeHitSource(space);
    this.sources.push(source);
    return Promise.resolve(source);
  }
  sourceFor(space: unknown): FakeHitSource {
    const s = this.sources.find((x) => x.space === space);
    if (!s) throw new Error("no hit-test source for that space");
    return s;
  }
}

function fakePose(position: Vector3, orientation = new Quaternion()) {
  const m = new Matrix4().compose(position, orientation, new Vector3(1, 1, 1));
  return {
    transform: {
      position: { x: position.x, y: position.y, z: position.z, w: 1 },
      orientation: { x: orientation.x, y: orientation.y, z: orientation.z, w: orientation.w },
      matrix: new Float32Array(m.elements),
    },
  };
}

interface FakeAnchor {
  anchorSpace: object;
  delete: ReturnType<typeof vi.fn>;
}

function fakeAnchor(): FakeAnchor {
  return { anchorSpace: {}, delete: vi.fn() };
}

class FakeFrame {
  results = new Map<FakeHitSource, any[]>();
  poses = new Map<unknown, ReturnType<typeof fakePose>>();
  created: { anchor: FakeAnchor; at: Vector3; space: unknown }[] = [];
  getHitTestResults(source: FakeHitSource) {
    return this.results.get(source) ?? [];
  }
  getPose(space: unknown, _ref: unknown) {
    return this.poses.get(space) ?? null;
  }
  createAnchor(pose: FakeRigidTransform, space: unknown) {
    const anchor = fakeAnchor();
    const p = pose.position;
    this.created.push({ anchor, at: new Vector3(p.x, p.y, p.z), space });
    return Promise.resolve(anchor);
  }
}

function gamepadRay(id: string, handedness: "left" | "right" = "right"): RaySource {
  return {
    id,
    kind: "controller",
    handedness,
    origin: new Vector3(),
    direction: new Vector3(0, 0, -1),
    selecting: false,
    gamepad: {
      axes: [0, 0, 0, 0],
      buttons: Array.from({ length: 6 }, () => ({ pressed: false })),
    } as unknown as Gamepad,
  };
}

const tapRay: RaySource = {
  id: "screen",
  kind: "screen",
  handedness: "none",
  origin: new Vector3(),
  direction: new Vector3(0, 0, -1),
  selecting: false,
};

/** A 2 x 4 x 2 box at (5, 2, 0), turned 30 degrees about Y. */
function boxModel(): Mesh {
  const mesh = new Mesh(new BoxGeometry(2, 4, 2));
  mesh.position.set(5, 2, 0);
  mesh.rotation.y = 30 * (Math.PI / 180);
  return mesh;
}

const DEG = Math.PI / 180;
/** Model points 4 m apart along -Z. */
const ALIGNMENT: ARAlignment = {
  id: "poi-7",
  a: [5, 0, 0],
  b: [5, 0, -4],
  labels: { a: "north-west corner" },
};
const REAL_A = new Vector3(1, 0, 1);
const REAL_B = new Vector3(5, 0, 1);
const HINT = "Stick: turn · Grip + stick: move · A: save · B: again";

interface SetupOptions {
  model?: Object3D | "scene";
  metresPerUnit?: number;
  up?: UpAxis;
  anchors?: boolean;
  scene?: Scene;
}

function setup(o: SetupOptions = {}) {
  const scene = o.scene ?? new Scene();
  scene.background = new Color(0x336699);
  const model = o.model === "scene" ? scene : (o.model ?? boxModel());
  if (model !== scene && !model.parent) scene.add(model);
  const ref = { kind: "local-floor" };
  /** The head: three.js writes the XR camera's world matrix; looking along -Z by default. */
  const head = { matrixWorld: new Matrix4() };
  const renderer = {
    clearAlpha: 1,
    xr: { getReferenceSpace: () => ref, getCamera: () => head },
    getClearAlpha() {
      return this.clearAlpha;
    },
    setClearAlpha(a: number) {
      this.clearAlpha = a;
    },
  };
  const options = resolveOptions({
    renderer: renderer as any,
    scene,
    camera: new PerspectiveCamera(),
    model,
    metresPerUnit: o.metresPerUnit,
    up: o.up,
    ar: { anchors: o.anchors ?? true },
  });
  const root = new Group();
  const rays: RaySource[] = [];
  const session = new FakeSession();
  const hud = { show: vi.fn(), hide: vi.fn() };
  const ctx = {
    renderer,
    scene,
    camera: new PerspectiveCamera(),
    options,
    events: new Emitter<AllEvents>(),
    root,
    up: upVector(options.up),
    raycast: () => null,
    space: {},
    hud,
    input: { rays: () => rays },
    mode: "ar",
    session,
  } as unknown as KitContext;
  const ar = createAR(ctx);
  const frame = new FakeFrame();
  const states: KitEvents["alignment"][] = [];
  ctx.events.on("alignment", (e) => states.push(e));

  // The model's resting world matrix, to map scene points onto the placed model.
  model.updateWorldMatrix(true, false);
  const restInverse = model.matrixWorld.clone().invert();
  const placedTarget = () =>
    model === scene ? scene.children.find((c) => c.name === "llhil-webxr-ar-model")! : model;
  /** Where a point in scene coordinates sits after placement. */
  function mapped(p: Vector3 | [number, number, number]): Vector3 {
    const v = Array.isArray(p) ? new Vector3(...p) : p.clone();
    const target = placedTarget();
    target.updateWorldMatrix(true, false);
    return v.applyMatrix4(restInverse).applyMatrix4(target.matrixWorld);
  }

  async function start(alignment: ARAlignment | null = ALIGNMENT) {
    ar.setAlignment(alignment);
    if (alignment) ar.setScale(1);
    scene.add(root);
    ar.start();
    await flush();
  }
  function stop() {
    ar.stop();
    root.removeFromParent();
  }
  function update(dt = 0) {
    ar.update(frame as unknown as XRFrame, dt);
  }
  function viewerSource() {
    return session.sourceFor(session.viewerSpace);
  }
  /** One frame whose hit is `point`; `createAnchor` stands for the hit result's. */
  function hitAt(point: Vector3, createAnchor?: () => Promise<unknown>) {
    frame.results.set(viewerSource(), [
      { getPose: () => fakePose(point), createAnchor: createAnchor ?? undefined },
    ]);
    update();
  }
  function select(ray: RaySource = tapRay) {
    ctx.events.emit("selectend", { ray });
  }
  /** Points at A and at B and pulls the trigger on each, as a user does. */
  async function pick(a = REAL_A, b = REAL_B, anchors?: [FakeAnchor, FakeAnchor]) {
    const make = (i: 0 | 1) => (anchors ? () => Promise.resolve(anchors[i]) : undefined);
    hitAt(a, make(0));
    select();
    // Each anchor is made in the frame after its pick, from that frame's hit.
    hitAt(a, make(0));
    hitAt(b, make(1));
    select();
    hitAt(b, make(1));
    await flush();
  }
  const lastHud = () => hud.show.mock.calls.at(-1) as [string, string[]] | undefined;
  const reticle = () => root.children.find((c) => c.name === "llhil-webxr-reticle");
  return {
    ar,
    ctx,
    scene,
    model,
    root,
    rays,
    session,
    renderer,
    frame,
    hud,
    head,
    states,
    mapped,
    placedTarget,
    start,
    stop,
    update,
    hitAt,
    select,
    pick,
    lastHud,
    reticle,
  };
}

const near = (a: Vector3, b: Vector3, eps = 1e-6) => expect(a.distanceTo(b)).toBeLessThan(eps);
const stateNames = (t: ReturnType<typeof setup>) => t.states.map((s) => s.state);

beforeEach(() => {
  store.supported.mockReset().mockReturnValue(false);
  store.has.mockReset().mockReturnValue(true);
  store.save.mockReset().mockResolvedValue(true);
  store.restore.mockReset().mockResolvedValue(null);
  store.forget.mockReset().mockResolvedValue(undefined);
});

describe("on-site alignment: picking", () => {
  it("picks A, then B, and places the model at 1:1 so both points coincide", async () => {
    const t = setup();
    const placed = vi.fn();
    t.ctx.events.on("placed", placed);
    await t.start();
    expect(t.model.visible).toBe(false);
    expect(t.ar.alignmentState).toBe("pick-a");
    t.update();
    expect(t.lastHud()).toEqual(["Point at mark A", ["north-west corner", "Pull the trigger"]]);

    t.hitAt(REAL_A);
    expect(t.reticle()!.visible).toBe(true);
    t.select();
    expect(t.ar.alignmentState).toBe("pick-b");
    t.hitAt(REAL_B);
    expect(t.lastHud()).toEqual(["Point at mark B", ["Pull the trigger"]]);
    t.select();

    expect(t.ar.alignmentState).toBe("aligned");
    expect(t.model.visible).toBe(true);
    near(t.mapped(ALIGNMENT.a), REAL_A);
    near(t.mapped(ALIGNMENT.b), REAL_B);
    // 1:1: the 4 m box is still 4 m tall.
    expect(new Box3().setFromObject(t.model).getSize(new Vector3()).y).toBeCloseTo(4, 9);
    expect(placed).toHaveBeenCalledTimes(1);

    t.update();
    expect(t.reticle()!.visible).toBe(false);
    expect(t.lastHud()).toEqual([
      "Aligned, error 0.0 cm",
      [HINT, "Left stick: up and down · Y: menu"],
    ]);
    expect(t.states).toEqual([
      { state: "pick-a", errorM: null, restored: false },
      { state: "pick-b", errorM: null, restored: false },
      { state: "aligned", errorM: 0, restored: false },
    ]);
  });

  it("reports the mismatch of the two distances as errorM", async () => {
    const t = setup();
    await t.start();
    await t.pick(REAL_A, new Vector3(5.02, 0, 1));
    const last = t.states.at(-1)!;
    expect(last.state).toBe("aligned");
    expect(last.errorM).toBeCloseTo(0.02, 9);
    expect(t.lastHud()?.[0]).toBe("Aligned, error 2.0 cm");
  });

  it("aligns a millimetre model at 1:1", async () => {
    const mesh = new Mesh(new BoxGeometry(2000, 4000, 2000));
    mesh.position.set(5000, 2000, 0);
    const t = setup({ model: mesh, metresPerUnit: 0.001 });
    await t.start({ id: "mm", a: [5000, 0, 0], b: [5000, 0, -4000] });
    await t.pick();
    expect(new Box3().setFromObject(mesh).getSize(new Vector3()).y).toBeCloseTo(4, 9);
    // Scene point a lands on real A: world = C * S(0.001) * rest.
    near(t.mapped([5000, 0, 0]), REAL_A);
    near(t.mapped([5000, 0, -4000]), REAL_B);
  });

  it("aligns the scene itself through its stand-in group", async () => {
    const scene = new Scene();
    const box = new Mesh(new BoxGeometry(1, 1, 1));
    box.position.set(5, 0.5, 0);
    scene.add(box);
    const t = setup({ scene, model: "scene" });
    await t.start();
    await t.pick();
    const proxy = scene.children.find((c) => c !== t.root)!;
    expect(proxy.visible).toBe(true);
    near(new Vector3(5, 0, 0).applyMatrix4(proxy.matrixWorld), REAL_A);
    near(new Vector3(5, 0, -4).applyMatrix4(proxy.matrixWorld), REAL_B);
    expect(scene.matrixWorld.equals(new Matrix4())).toBe(true);
    t.stop();
    expect(box.parent).toBe(scene);
  });

  it("goes back to pick-a with the message when the solve throws", async () => {
    const t = setup();
    await t.start();
    await t.pick(REAL_A, new Vector3(1.02, 0, 1));
    expect(t.ar.alignmentState).toBe("pick-a");
    expect(t.model.visible).toBe(false);
    t.update();
    expect(t.lastHud()).toEqual([
      "Point at mark A",
      ["The marks are too close together", "north-west corner", "Pull the trigger"],
    ]);
    expect(stateNames(t)).toEqual(["pick-a", "pick-b", "pick-a"]);
    // It picks again from A.
    await t.pick();
    expect(t.ar.alignmentState).toBe("aligned");
  });

  it("ignores selects without a hit and once aligned", async () => {
    const t = setup();
    await t.start();
    t.update();
    t.select();
    expect(t.ar.alignmentState).toBe("pick-a");
    await t.pick();
    t.hitAt(new Vector3(9, 0, 9));
    t.select();
    expect(t.ar.alignmentState).toBe("aligned");
    near(t.mapped(ALIGNMENT.a), REAL_A);
  });

  it("ignores setScale: on site is always 1:1", async () => {
    const t = setup();
    await t.start();
    await t.pick();
    t.ar.setScale(1 / 100);
    near(t.mapped(ALIGNMENT.b), REAL_B);
  });
});

describe("on-site alignment: restoring", () => {
  it("asks for mark A straight away when nothing is saved on the device", async () => {
    store.supported.mockReturnValue(true);
    store.has.mockReturnValueOnce(false);
    const t = setup();
    await t.start();
    expect(store.restore).not.toHaveBeenCalled();
    expect(t.ar.alignmentState).toBe("pick-a");
  });

  it("restores a saved alignment from its anchors and places the model by them", async () => {
    const a = fakeAnchor();
    const b = fakeAnchor();
    store.supported.mockReturnValue(true);
    store.restore.mockResolvedValue({ a, b });
    const t = setup();
    await t.start();
    expect(store.restore).toHaveBeenCalledWith(t.session, "poi-7");
    expect(t.ar.alignmentState).toBe("restoring");
    expect(t.model.visible).toBe(false);

    // Only one pose known: still looking.
    t.frame.poses.set(a.anchorSpace, fakePose(REAL_A));
    t.update(1);
    expect(t.ar.alignmentState).toBe("restoring");
    expect(t.lastHud()?.[0]).toBe("Looking for the saved alignment");

    t.frame.poses.set(b.anchorSpace, fakePose(REAL_B));
    t.update(1);
    expect(t.ar.alignmentState).toBe("saved");
    expect(t.model.visible).toBe(true);
    near(t.mapped(ALIGNMENT.a), REAL_A);
    near(t.mapped(ALIGNMENT.b), REAL_B);
    expect(t.lastHud()).toEqual(["Restored, error 0.0 cm", [HINT]]);
    expect(t.states).toEqual([
      { state: "restoring", errorM: null, restored: false },
      { state: "saved", errorM: 0, restored: true },
    ]);
    // Saved already: nothing to do.
    await expect(t.ar.saveAlignment()).resolves.toBe(true);
    expect(store.save).not.toHaveBeenCalled();

    // The saved anchors are the store's: never deleted here.
    t.stop();
    expect(a.delete).not.toHaveBeenCalled();
    expect(b.delete).not.toHaveBeenCalled();
  });

  it("goes lost, then to pick-a, when the restore fails", async () => {
    store.supported.mockReturnValue(true);
    store.restore.mockRejectedValue(new Error("no such anchor"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = setup();
    await t.start();
    expect(t.ar.alignmentState).toBe("lost");
    t.update(1);
    expect(t.lastHud()?.[0]).toBe("Saved alignment not found here");
    expect(t.ar.alignmentState).toBe("lost");
    t.update(1);
    expect(t.ar.alignmentState).toBe("pick-a");
    expect(stateNames(t)).toEqual(["restoring", "lost", "pick-a"]);
    warn.mockRestore();
  });

  it("goes lost when nothing is saved for the id", async () => {
    store.supported.mockReturnValue(true);
    const t = setup();
    await t.start();
    t.update(2);
    expect(stateNames(t)).toEqual(["restoring", "lost", "pick-a"]);
  });

  it("goes lost when the restored anchors give no pose for 3 s", async () => {
    store.supported.mockReturnValue(true);
    store.restore.mockResolvedValue({ a: fakeAnchor(), b: fakeAnchor() });
    const t = setup();
    await t.start();
    t.update(1.5);
    t.update(1.4);
    expect(t.ar.alignmentState).toBe("restoring");
    t.update(0.2);
    expect(t.ar.alignmentState).toBe("lost");
    t.update(1.5);
    expect(stateNames(t)).toEqual(["restoring", "lost", "pick-a"]);
  });

  it("skips restoring where the store is not supported", async () => {
    const t = setup();
    await t.start();
    expect(store.restore).not.toHaveBeenCalled();
    expect(stateNames(t)).toEqual(["pick-a"]);
  });
});

describe("on-site alignment: fine-tune", () => {
  /** The real point B turned about real A by `deg` (positive turns left). */
  const turnedB = (deg: number) =>
    REAL_B.clone()
      .sub(REAL_A)
      .applyAxisAngle(new Vector3(0, 1, 0), deg * DEG)
      .add(REAL_A);

  it("turns about A smoothly on the thumbstick, a light push slowly", async () => {
    const t = setup();
    await t.start();
    await t.pick();
    const ray = gamepadRay("r");
    t.rays.push(ray);
    const axes = (ray.gamepad as any).axes as number[];

    // Full right for a tenth of a second at 20 degrees a second: clockwise seen from above.
    axes[2] = 1;
    t.update(0.1);
    near(t.mapped(ALIGNMENT.a), REAL_A);
    near(t.mapped(ALIGNMENT.b), turnedB(-2));
    // Inside the dead zone nothing happens.
    axes[2] = 0.1;
    t.update(1);
    near(t.mapped(ALIGNMENT.b), turnedB(-2));
    // Half way, to the left: a quarter of the speed (the response is squared).
    axes[2] = -0.575;
    t.update(0.1);
    near(t.mapped(ALIGNMENT.b), turnedB(-1.5));
    near(t.mapped(ALIGNMENT.a), REAL_A);
  });

  it("slides along the head's forward and right on the ground with the grip held", async () => {
    const t = setup();
    await t.start();
    await t.pick();
    // The head looks along -X, tilted down: forward on the ground is still -X, right is -Z.
    t.head.matrixWorld.makeRotationY(90 * DEG).multiply(new Matrix4().makeRotationX(-40 * DEG));
    const ray = gamepadRay("r");
    t.rays.push(ray);
    const axes = (ray.gamepad as any).axes as number[];
    (ray.gamepad as any).buttons[1].pressed = true;
    axes[3] = -1;
    t.update(0.1);
    near(t.mapped(ALIGNMENT.a), REAL_A.clone().add(new Vector3(-0.05, 0, 0)));
    axes[3] = 0;
    axes[2] = 1;
    t.update(0.1);
    near(t.mapped(ALIGNMENT.a), REAL_A.clone().add(new Vector3(-0.05, 0, -0.05)));
    // No turn while sliding.
    near(t.mapped(ALIGNMENT.b), REAL_B.clone().add(new Vector3(-0.05, 0, -0.05)));
  });

  it("start: stand places A under the head and B ahead of it, with no marks; B places again", async () => {
    const t = setup();
    const pose = (x: number, z: number, yawDeg: number) => ({
      transform: {
        position: { x, y: 1.7, z },
        matrix: new Matrix4().makeRotationY(yawDeg * DEG).setPosition(x, 1.7, z).elements,
      },
    });
    let viewer: ReturnType<typeof pose> | null = null;
    (t.frame as any).getViewerPose = () => viewer;
    await t.start({ ...ALIGNMENT, start: "stand" });
    // No head pose yet: nothing placed, no marks asked for.
    t.update();
    expect(t.ar.alignmentState).toBe(null);
    // Standing at (2, 3), looking along -X: A on the floor below, B four metres ahead.
    viewer = pose(2, 3, 90);
    t.update();
    expect(t.ar.alignmentState).toBe("aligned");
    near(t.mapped(ALIGNMENT.a), new Vector3(2, 0, 3));
    near(t.mapped(ALIGNMENT.b), new Vector3(-2, 0, 3));
    // B (re-align): from where the user stands now.
    viewer = pose(0, 0, 0);
    const ray = gamepadRay("r");
    t.rays.push(ray);
    (ray.gamepad as any).buttons[5].pressed = true;
    t.update();
    // Placed on the next frame.
    t.update();
    near(t.mapped(ALIGNMENT.a), new Vector3(0, 0, 0));
    near(t.mapped(ALIGNMENT.b), new Vector3(0, 0, -4));
    expect(t.ar.alignmentState).toBe("aligned");
  });

  it("start: stand takes two floor marks touched with a controller: the first is A, the second the direction", async () => {
    const t = setup();
    const viewer = {
      transform: {
        position: { x: 2, y: 1.7, z: 3 },
        matrix: new Matrix4().setPosition(2, 1.7, 3).elements,
      },
    };
    (t.frame as any).getViewerPose = () => viewer;
    await t.start({ ...ALIGNMENT, start: "stand" });
    t.update();
    near(t.mapped(ALIGNMENT.a), new Vector3(2, 0, 3));
    const ray = gamepadRay("r");
    // Held up: a trigger pull is not a touch.
    ray.origin.set(7, 1.1, 7);
    t.select(ray);
    near(t.mapped(ALIGNMENT.a), new Vector3(2, 0, 3));
    // Down at the first mark, then at the second, six metres along +X: B is four metres that way.
    ray.origin.set(10, 0.04, -5);
    t.select(ray);
    near(t.mapped(ALIGNMENT.a), new Vector3(2, 0, 3));
    // Too close to the first: asked again.
    ray.origin.set(10.2, 0.04, -5);
    t.select(ray);
    ray.origin.set(16, 0.05, -5);
    t.select(ray);
    near(t.mapped(ALIGNMENT.a), new Vector3(10, 0, -5));
    near(t.mapped(ALIGNMENT.b), new Vector3(14, 0, -5));
    expect(t.ar.alignmentState).toBe("aligned");
  });

  it("lifts and lowers the model with the left stick, and with nudge({ lift })", async () => {
    const t = setup();
    await t.start();
    await t.pick();
    const right = gamepadRay("r");
    const left = gamepadRay("l", "left");
    t.rays.push(right, left);
    // Forward on the left stick (negative): up, 0.2 m/s at full deflection.
    (left.gamepad as any).axes[3] = -1;
    t.update(0.1);
    near(t.mapped(ALIGNMENT.a), REAL_A.clone().add(new Vector3(0, 0.02, 0)));
    near(t.mapped(ALIGNMENT.b), REAL_B.clone().add(new Vector3(0, 0.02, 0)));
    (left.gamepad as any).axes[3] = 0;
    t.ar.nudge({ lift: -0.05 });
    near(t.mapped(ALIGNMENT.a), REAL_A.clone().add(new Vector3(0, -0.03, 0)));
    expect(t.ar.alignmentState).toBe("aligned");
  });

  it("nudge() turns about A and moves in the user's frame", async () => {
    const t = setup();
    await t.start();
    await t.pick();
    t.head.matrixWorld.makeRotationY(90 * DEG);
    // Facing -X, right is -Z.
    t.ar.nudge({ move: [0.1, 0.2] });
    const moved = new Vector3(-0.2, 0, -0.1);
    near(t.mapped(ALIGNMENT.a), REAL_A.clone().add(moved));
    near(t.mapped(ALIGNMENT.b), REAL_B.clone().add(moved));
    t.ar.nudge({ turnDeg: 10 });
    near(t.mapped(ALIGNMENT.a), REAL_A.clone().add(moved));
    near(t.mapped(ALIGNMENT.b), turnedB(10).add(moved));
  });

  it("does not fine-tune before aligning", async () => {
    const t = setup();
    await t.start();
    const ray = gamepadRay("r");
    t.rays.push(ray);
    (ray.gamepad as any).axes[2] = 0.9;
    t.update(0.016);
    t.ar.nudge({ turnDeg: 5 });
    expect(t.model.visible).toBe(false);
    expect(stateNames(t)).toEqual(["pick-a"]);
  });

  it("sets a saved alignment back to aligned on a nudge", async () => {
    const a = fakeAnchor();
    const b = fakeAnchor();
    store.supported.mockReturnValue(true);
    store.restore.mockResolvedValue({ a, b });
    const t = setup();
    await t.start();
    t.frame.poses.set(a.anchorSpace, fakePose(REAL_A));
    t.frame.poses.set(b.anchorSpace, fakePose(REAL_B));
    t.update();
    expect(t.ar.alignmentState).toBe("saved");
    t.ar.nudge({ turnDeg: 1 });
    t.ar.nudge({ turnDeg: 1 });
    expect(t.ar.alignmentState).toBe("aligned");
    expect(t.states.at(-1)).toEqual({ state: "aligned", errorM: 0, restored: true });
    expect(stateNames(t)).toEqual(["restoring", "saved", "aligned"]);
    near(t.mapped(ALIGNMENT.b), turnedB(2));
  });
});

describe("on-site alignment: save and realign", () => {
  function press(t: ReturnType<typeof setup>, ray: RaySource, button: number) {
    const buttons = (ray.gamepad as any).buttons as { pressed: boolean }[];
    buttons[button].pressed = true;
    t.update(0.016);
    t.update(0.016);
    buttons[button].pressed = false;
    t.update(0.016);
  }

  it("saves the picked anchors on the A button", async () => {
    store.supported.mockReturnValue(true);
    const t = setup();
    await t.start();
    // Nothing saved yet: restoring finds nothing and picking starts.
    t.update(2);
    const anchors: [FakeAnchor, FakeAnchor] = [fakeAnchor(), fakeAnchor()];
    await t.pick(REAL_A, REAL_B, anchors);
    const ray = gamepadRay("r");
    t.rays.push(ray);
    press(t, ray, 4);
    await flush();
    expect(store.save).toHaveBeenCalledTimes(1);
    expect(store.save).toHaveBeenCalledWith(t.session, "poi-7", anchors[0], anchors[1]);
    expect(t.ar.alignmentState).toBe("saved");
    expect(t.states.at(-1)).toEqual({ state: "saved", errorM: 0, restored: false });
    t.update();
    expect(t.lastHud()).toEqual(["Saved, error 0.0 cm", [HINT]]);
    // Saved anchors belong to the store now.
    t.stop();
    for (const a of anchors) expect(a.delete).not.toHaveBeenCalled();
  });

  it("saves new anchors at the corrected points after a nudge", async () => {
    store.supported.mockReturnValue(true);
    const t = setup();
    await t.start();
    t.update(2);
    const anchors: [FakeAnchor, FakeAnchor] = [fakeAnchor(), fakeAnchor()];
    await t.pick(REAL_A, REAL_B, anchors);
    t.ar.nudge({ move: [0, 0.1] });
    const saving = t.ar.saveAlignment();
    expect(t.frame.created).toHaveLength(0);
    // The anchors need an active frame.
    t.update();
    await expect(saving).resolves.toBe(true);
    expect(t.frame.created).toHaveLength(2);
    const forward = new Vector3(0, 0, -0.1);
    near(t.frame.created[0].at, REAL_A.clone().add(forward));
    near(t.frame.created[1].at, REAL_B.clone().add(forward));
    expect(store.save).toHaveBeenCalledWith(
      t.session,
      "poi-7",
      t.frame.created[0].anchor,
      t.frame.created[1].anchor,
    );
    expect(t.ar.alignmentState).toBe("saved");
    // The pick anchors are replaced and deleted; the saved ones stay.
    for (const a of anchors) expect(a.delete).toHaveBeenCalledTimes(1);
    t.stop();
    for (const c of t.frame.created) expect(c.anchor.delete).not.toHaveBeenCalled();
  });

  it("resolves false with a notice where saving is not supported", async () => {
    const t = setup();
    await t.start();
    const anchors: [FakeAnchor, FakeAnchor] = [fakeAnchor(), fakeAnchor()];
    await t.pick(REAL_A, REAL_B, anchors);
    const ray = gamepadRay("r");
    t.rays.push(ray);
    await expect(t.ar.saveAlignment()).resolves.toBe(false);
    t.update();
    expect(t.lastHud()).toEqual(["Saving is not available on this device", [HINT]]);
    expect(store.save).not.toHaveBeenCalled();
    expect(t.ar.alignmentState).toBe("aligned");
    // The A button does the same, without changing state.
    press(t, ray, 4);
    await flush();
    expect(store.save).not.toHaveBeenCalled();
    expect(stateNames(t)).toEqual(["pick-a", "pick-b", "aligned"]);
  });

  it("resolves false when the store fails to save", async () => {
    store.supported.mockReturnValue(true);
    store.save.mockResolvedValue(false);
    const t = setup();
    await t.start();
    t.update(2);
    await t.pick(REAL_A, REAL_B, [fakeAnchor(), fakeAnchor()]);
    await expect(t.ar.saveAlignment()).resolves.toBe(false);
    expect(t.ar.alignmentState).toBe("aligned");
  });

  it("realigns on the B button, dropping the anchors in use but not the saved ones", async () => {
    store.supported.mockReturnValue(true);
    const t = setup();
    await t.start();
    t.update(2);
    const anchors: [FakeAnchor, FakeAnchor] = [fakeAnchor(), fakeAnchor()];
    await t.pick(REAL_A, REAL_B, anchors);
    const ray = gamepadRay("l", "left");
    t.rays.push(ray);
    press(t, ray, 5);
    expect(t.ar.alignmentState).toBe("pick-a");
    expect(t.model.visible).toBe(false);
    for (const a of anchors) expect(a.delete).toHaveBeenCalledTimes(1);
    expect(store.forget).not.toHaveBeenCalled();
    expect(stateNames(t)).toEqual(["restoring", "lost", "pick-a", "pick-b", "aligned", "pick-a"]);
    expect(t.states.at(-1)).toEqual({ state: "pick-a", errorM: null, restored: false });
    // Held: one realign only.
    expect(stateNames(t).filter((s) => s === "pick-a")).toHaveLength(2);
    t.update();
    expect(t.reticle()!.visible).toBe(true);
  });

  it("forgets a saved alignment through the store", async () => {
    const t = setup();
    await t.ar.forgetAlignment("poi-7");
    expect(store.forget).toHaveBeenCalledWith(null, "poi-7");
    await t.start();
    await t.ar.forgetAlignment("poi-7");
    expect(store.forget).toHaveBeenLastCalledWith(t.session, "poi-7");
  });
});

describe("on-site alignment: lifecycle", () => {
  it("leaves table-top placement as it is without an alignment", async () => {
    const t = setup();
    await t.start(null);
    t.ar.setScale(1);
    expect(t.ar.alignmentState).toBeNull();
    const hit = new Vector3(1, 0.5, -2);
    t.hitAt(hit);
    t.select();
    expect(t.model.visible).toBe(true);
    const box = new Box3().setFromObject(t.model);
    const base = box.getCenter(new Vector3());
    base.y = box.min.y;
    near(base, hit, 1e-9);
    t.stop();
    expect(t.states).toEqual([]);
    expect(t.hud.show).not.toHaveBeenCalled();
    expect(t.hud.hide).not.toHaveBeenCalled();
  });

  it("clears the alignment with setAlignment(null) before the session", async () => {
    const t = setup();
    t.ar.setAlignment(ALIGNMENT);
    await t.start(null);
    expect(t.ar.alignmentState).toBeNull();
    expect(t.states).toEqual([]);
  });

  it("restores the model on stop, deletes the anchors in use and hides the panel", async () => {
    const t = setup();
    const position = t.model.position.clone();
    const quaternion = t.model.quaternion.clone();
    t.model.updateWorldMatrix(true, false);
    const world = t.model.matrixWorld.clone();
    await t.start();
    const anchors: [FakeAnchor, FakeAnchor] = [fakeAnchor(), fakeAnchor()];
    await t.pick(REAL_A, REAL_B, anchors);
    expect(t.states.at(-1)?.state).toBe("aligned");
    const count = t.states.length;
    t.stop();

    expect(t.ar.alignmentState).toBeNull();
    expect(t.states).toHaveLength(count);
    expect(t.hud.hide).toHaveBeenCalled();
    for (const a of anchors) expect(a.delete).toHaveBeenCalledTimes(1);
    expect(store.forget).not.toHaveBeenCalled();
    expect(t.model.visible).toBe(true);
    expect(t.model.matrixAutoUpdate).toBe(true);
    expect(t.model.position.equals(position)).toBe(true);
    expect(t.model.quaternion.equals(quaternion)).toBe(true);
    expect(t.model.matrixWorld.equals(world)).toBe(true);
    expect(t.reticle()).toBeUndefined();
  });

  it("keeps the alignment for the next session", async () => {
    const t = setup();
    await t.start();
    await t.pick();
    t.stop();
    t.scene.add(t.root);
    t.ar.start();
    await flush();
    expect(t.ar.alignmentState).toBe("pick-a");
    expect(t.model.visible).toBe(false);
  });
});
