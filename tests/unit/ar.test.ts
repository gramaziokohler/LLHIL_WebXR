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
import { describe, expect, it, vi } from "vitest";
import { createAR } from "../../src/ar";
import { Emitter } from "../../src/events";
import { resolveOptions } from "../../src/index";
import type { AllEvents, KitContext, RaySource } from "../../src/internal";
import { upVector } from "../../src/math";
import type { UpAxis, XRMode } from "../../src/types";

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

function fakeHit(point: Vector3, createAnchor?: () => Promise<unknown>) {
  return { getPose: (_space: unknown) => fakePose(point), createAnchor };
}

class FakeFrame {
  results = new Map<FakeHitSource, any[]>();
  poses = new Map<unknown, ReturnType<typeof fakePose>>();
  getHitTestResults(source: FakeHitSource) {
    return this.results.get(source) ?? [];
  }
  getPose(space: unknown, _ref: unknown) {
    return this.poses.get(space) ?? null;
  }
}

function inputSource(handedness: "left" | "right") {
  return { handedness, targetRayMode: "tracked-pointer", targetRaySpace: { kind: handedness } };
}

function controllerRay(id: string, x: number): RaySource {
  return {
    id,
    kind: "controller",
    handedness: "right",
    origin: new Vector3(),
    direction: new Vector3(0, 0, -1),
    selecting: false,
    gamepad: { axes: [0, 0, x, 0] } as unknown as Gamepad,
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

/** A 2 x 4 x 2 box at (5, 2, 0), turned 30 degrees about Y: its base centre is (5, 0, 0). */
function boxModel(): Mesh {
  const mesh = new Mesh(new BoxGeometry(2, 4, 2));
  mesh.position.set(5, 2, 0);
  mesh.rotation.y = 30 * (Math.PI / 180);
  return mesh;
}

interface SetupOptions {
  model?: Object3D | "scene";
  mode?: XRMode;
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
  const xrCamera = new PerspectiveCamera();
  const renderer = {
    clearAlpha: 1,
    xr: { getReferenceSpace: () => ref, getCamera: () => xrCamera },
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
    ar: { anchors: o.anchors ?? false },
  });
  const root = new Group();
  const rays: RaySource[] = [];
  const session = new FakeSession();
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
    input: { rays: () => rays },
    mode: o.mode ?? "ar",
    session,
  } as unknown as KitContext;
  const ar = createAR(ctx);
  const frame = new FakeFrame();

  /** Mirrors createXRKit: the root joins the scene before modules start. */
  async function start() {
    scene.add(root);
    ar.start();
    await flush();
  }
  function stop() {
    ar.stop();
    root.removeFromParent();
  }
  function viewerSource() {
    return session.sourceFor(session.viewerSpace);
  }
  function hitAt(point: Vector3, source = viewerSource(), createAnchor?: () => Promise<unknown>) {
    frame.results.set(source, [fakeHit(point, createAnchor)]);
    ar.update(frame as unknown as XRFrame, 0);
  }
  function select(ray: RaySource = tapRay) {
    ctx.events.emit("selectend", { ray });
  }
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
    start,
    stop,
    viewerSource,
    hitAt,
    select,
    reticle,
    xrCamera,
  };
}

const worldBox = (o: Object3D) => new Box3().setFromObject(o);
const baseOf = (o: Object3D, up = new Vector3(0, 1, 0)) => {
  const b = worldBox(o);
  const c = b.getCenter(new Vector3());
  return c.addScaledVector(up, b.min.dot(up) - c.dot(up));
};

describe("createAR", () => {
  it("hides the model until placed and the reticle follows hits", async () => {
    const t = setup();
    await t.start();
    expect(t.model.visible).toBe(false);
    expect(t.reticle()?.visible).toBe(false);

    t.hitAt(new Vector3(1, 0.5, -2));
    const r = t.reticle()!;
    expect(r.visible).toBe(true);
    expect(new Vector3().setFromMatrixPosition(r.matrix).toArray()).toEqual([1, 0.5, -2]);

    t.hitAt(new Vector3(-3, 0, 4));
    expect(new Vector3().setFromMatrixPosition(r.matrix).toArray()).toEqual([-3, 0, 4]);

    t.frame.results.clear();
    t.ar.update(t.frame as unknown as XRFrame, 0);
    expect(r.visible).toBe(false);
    expect(t.model.visible).toBe(false);
  });

  it("ignores a select without a hit", async () => {
    const t = setup();
    const placed = vi.fn();
    t.ctx.events.on("placed", placed);
    await t.start();
    t.ar.update(t.frame as unknown as XRFrame, 0);
    t.select();
    expect(placed).not.toHaveBeenCalled();
    expect(t.model.visible).toBe(false);
  });

  it("places the model base on the hit, keeping its yaw, and emits placed", async () => {
    const t = setup();
    const yaw0 = t.model.getWorldQuaternion(new Quaternion());
    const placed = vi.fn();
    t.ctx.events.on("placed", placed);
    t.ar.setScale(1);
    await t.start();
    const hit = new Vector3(1, 0.5, -2);
    t.hitAt(hit);
    t.select();

    expect(t.model.visible).toBe(true);
    expect(t.reticle()!.visible).toBe(false);
    const base = baseOf(t.model);
    expect(base.distanceTo(hit)).toBeLessThan(1e-9);
    expect(t.model.getWorldQuaternion(new Quaternion()).angleTo(yaw0)).toBeLessThan(1e-9);
    expect(placed).toHaveBeenCalledTimes(1);
    const matrix: Matrix4 = placed.mock.calls[0][0].matrix;
    expect(matrix.equals(t.model.matrixWorld)).toBe(true);
    expect(matrix).not.toBe(t.model.matrixWorld);

    // The reticle stays hidden while placed.
    t.hitAt(new Vector3(9, 0, 9));
    expect(t.reticle()!.visible).toBe(false);
  });

  it("places by the base along Z in a Z-up scene", async () => {
    const mesh = new Mesh(new BoxGeometry(2, 2, 4));
    mesh.position.set(0, 3, 2);
    const t = setup({ model: mesh, up: "z" });
    t.ar.setScale(1);
    await t.start();
    const hit = new Vector3(1, 1, 0.75);
    t.hitAt(hit);
    t.select();
    expect(baseOf(t.model, new Vector3(0, 0, 1)).distanceTo(hit)).toBeLessThan(1e-9);
    const size = worldBox(t.model).getSize(new Vector3());
    expect(size.z).toBeCloseTo(4);
  });

  it("applies the initial scale times metresPerUnit and rescales about the placed point", async () => {
    // A millimetre model, 4000 units tall: 4 m at 1:1.
    const mesh = new Mesh(new BoxGeometry(2000, 4000, 2000));
    mesh.position.set(5000, 2000, 0);
    mesh.scale.setScalar(1);
    const t = setup({ model: mesh, metresPerUnit: 0.001 });
    t.ar.setScale(1 / 100);
    await t.start();
    const hit = new Vector3(1, 0.5, -2);
    t.hitAt(hit);
    t.select();
    expect(worldBox(t.model).getSize(new Vector3()).y).toBeCloseTo(0.04, 9);
    expect(baseOf(t.model).distanceTo(hit)).toBeLessThan(1e-9);

    t.ar.setScale(1 / 2);
    expect(worldBox(t.model).getSize(new Vector3()).y).toBeCloseTo(2, 9);
    expect(baseOf(t.model).distanceTo(hit)).toBeLessThan(1e-9);

    t.ar.setScale(0);
    t.ar.setScale(-1);
    t.ar.setScale(Number.NaN);
    expect(worldBox(t.model).getSize(new Vector3()).y).toBeCloseTo(2, 9);
  });

  it("restores the model, the background and the clear alpha on stop", async () => {
    const t = setup();
    const bg = t.scene.background;
    const position = t.model.position.clone();
    const quaternion = t.model.quaternion.clone();
    const scale = t.model.scale.clone();
    t.model.updateWorldMatrix(true, false);
    const world = t.model.matrixWorld.clone();
    await t.start();
    expect(t.scene.background).toBeNull();
    expect(t.renderer.clearAlpha).toBe(0);
    t.hitAt(new Vector3(1, 0, 1));
    t.select();
    t.stop();

    expect(t.scene.background).toBe(bg);
    expect(t.renderer.clearAlpha).toBe(1);
    expect(t.model.visible).toBe(true);
    expect(t.model.matrixAutoUpdate).toBe(true);
    expect(t.model.position.equals(position)).toBe(true);
    expect(t.model.quaternion.equals(quaternion)).toBe(true);
    expect(t.model.scale.equals(scale)).toBe(true);
    expect(t.model.matrixWorld.equals(world)).toBe(true);
    expect(t.reticle()).toBeUndefined();
    expect(t.viewerSource().cancelled).toBe(true);
  });

  it("moves the scene's children into a group when the model is the scene, and back", async () => {
    const scene = new Scene();
    const a = new Mesh(new BoxGeometry(2, 2, 2));
    a.position.set(0, 1, 0);
    const b = new Group();
    const c = new Mesh(new BoxGeometry(1, 1, 1));
    c.position.set(4, 0.5, 0);
    scene.add(a, b, c);
    const t = setup({ scene, model: "scene" });
    t.ar.setScale(1);
    await t.start();

    const proxy = scene.children.find((o) => o !== t.root)!;
    expect(scene.children).toHaveLength(2);
    expect(scene.children).toContain(t.root);
    expect(proxy.children).toEqual([a, b, c]);
    expect(proxy.visible).toBe(false);
    expect(scene.visible).toBe(true);

    const hit = new Vector3(-1, 0.2, -1);
    t.hitAt(hit);
    t.select();
    expect(proxy.visible).toBe(true);
    expect(baseOf(proxy).distanceTo(hit)).toBeLessThan(1e-9);
    expect(scene.matrixWorld.equals(new Matrix4())).toBe(true);
    expect(t.root.matrixWorld.equals(new Matrix4())).toBe(true);

    t.ar.stop();
    expect(scene.children).toEqual([a, b, c, t.root]);
    expect(a.parent).toBe(scene);
    expect(a.matrixWorld.equals(new Matrix4().makeTranslation(0, 1, 0))).toBe(true);
    t.root.removeFromParent();
    expect(scene.children).toEqual([a, b, c]);
  });

  it("keeps the scene's order when the root sat between its children", async () => {
    const scene = new Scene();
    const a = new Group();
    const c = new Group();
    const t = setup({ scene, model: "scene" });
    scene.add(a, t.root, c);
    t.ar.start();
    await flush();
    t.ar.stop();
    expect(scene.children).toEqual([a, t.root, c]);
  });

  it("re-places on the second select after a select while placed", async () => {
    const t = setup();
    const placed = vi.fn();
    t.ctx.events.on("placed", placed);
    t.ar.setScale(1);
    await t.start();
    t.hitAt(new Vector3(0, 0, 0));
    t.select();
    t.select();
    t.hitAt(new Vector3(3, 1, 3));
    expect(t.reticle()!.visible).toBe(true);
    expect(t.model.visible).toBe(true);
    t.select();
    expect(baseOf(t.model).distanceTo(new Vector3(3, 1, 3))).toBeLessThan(1e-9);
    expect(t.reticle()!.visible).toBe(false);
    expect(placed).toHaveBeenCalledTimes(2);
  });

  it("turns the placed model smoothly with the stick, about up through the placed point", async () => {
    const t = setup();
    t.ar.setScale(1);
    const q0 = t.model.getWorldQuaternion(new Quaternion());
    await t.start();
    const hit = new Vector3(2, 0, 2);
    t.hitAt(hit);
    t.select();

    const ray = controllerRay("c0", 1);
    t.rays.push(ray);
    const expectYaw = (deg: number) => {
      const q = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), deg * (Math.PI / 180));
      const expected = q.multiply(q0);
      expect(t.model.getWorldQuaternion(new Quaternion()).angleTo(expected)).toBeLessThan(1e-6);
      expect(baseOf(t.model).distanceTo(hit)).toBeLessThan(1e-9);
      expect(t.ar.rotation).toBeCloseTo(deg, 6);
    };

    // Full right for a tenth of a second at 60 degrees a second: clockwise seen from above.
    t.ar.update(t.frame as unknown as XRFrame, 0.1);
    expectYaw(-6);
    // Inside the dead zone: nothing.
    (ray.gamepad as any).axes[2] = 0.1;
    t.ar.update(t.frame as unknown as XRFrame, 0.1);
    expectYaw(-6);
    // Half way between the dead zone and full, to the left: half speed.
    (ray.gamepad as any).axes[2] = -0.575;
    t.ar.update(t.frame as unknown as XRFrame, 0.1);
    expectYaw(-3);
    // A panel has the controllers: the stick is the panel's.
    (t.ctx as any).uiCapture = true;
    t.ar.update(t.frame as unknown as XRFrame, 0.1);
    expectYaw(-3);
    (t.ctx as any).uiCapture = false;
    (ray.gamepad as any).axes[2] = 0;
    t.ar.setRotation(90);
    expectYaw(90);
  });

  it("slides the placed model on its plane with the grip held, forward being where the user looks", async () => {
    const t = setup();
    t.ar.setScale(1);
    await t.start();
    const hit = new Vector3(2, 0, 2);
    t.hitAt(hit);
    t.select();
    const q = t.model.getWorldQuaternion(new Quaternion());

    // Stick right and half forward, grip held; the user looks along -Z, a little down.
    const ray = controllerRay("c0", 1);
    (ray.gamepad as any).axes[3] = -0.575;
    (ray.gamepad as any).buttons = [{}, { pressed: true }];
    t.rays.push(ray);
    t.xrCamera.lookAt(0, -1, -5);
    t.xrCamera.updateMatrixWorld(true);
    t.ar.update(t.frame as unknown as XRFrame, 1);
    // 0.3 m/s: right is +X, forward -Z; no turn, no lift.
    expect(baseOf(t.model).distanceTo(new Vector3(2.3, 0, 1.85))).toBeLessThan(1e-6);
    expect(t.model.getWorldQuaternion(new Quaternion()).angleTo(q)).toBeLessThan(1e-9);
    // A trigger a panel took does not ask for a new spot.
    (t.ctx as any).uiCapture = true;
    t.select();
    (t.ctx as any).uiCapture = false;
    t.hitAt(new Vector3(9, 0, 9));
    t.ar.update(t.frame as unknown as XRFrame, 0);
    expect(baseOf(t.model).distanceTo(new Vector3(2.3, 0, 1.85))).toBeLessThan(1e-6);
  });

  it("does not take a hand for a surface: a hit beside a controller is skipped for the next one", async () => {
    const t = setup();
    await t.start();
    const hand = controllerRay("c1", 0);
    hand.origin.set(0.1, 1, -0.4);
    t.rays.push(hand);
    // Only the hand: nothing to place on.
    t.hitAt(new Vector3(0.1, 1.05, -0.45));
    expect(t.reticle()!.visible).toBe(false);
    t.select();
    expect(t.model.visible).toBe(false);
    // The hand, then the table behind it: the table.
    const table = new Vector3(0.2, 0.7, -1.2);
    t.frame.results.set(t.viewerSource(), [fakeHit(new Vector3(0.1, 1.05, -0.45)), fakeHit(table)]);
    t.ar.update(t.frame as unknown as XRFrame, 0);
    t.select();
    expect(baseOf(t.model).distanceTo(table)).toBeLessThan(1e-9);
  });

  it("does not turn before the model is placed", async () => {
    const t = setup();
    await t.start();
    t.rays.push(controllerRay("c0", 0.9));
    t.ar.update(t.frame as unknown as XRFrame, 0);
    t.hitAt(new Vector3());
    t.select();
    const q = t.model.quaternion.clone();
    expect(t.model.getWorldQuaternion(new Quaternion()).angleTo(q)).toBeLessThan(1e-9);
  });

  it("prefers a controller's hit-test source and follows inputsourceschange", async () => {
    const t = setup();
    const right = inputSource("right");
    t.session.inputSources.push(right);
    await t.start();
    const rightSource = t.session.sourceFor(right.targetRaySpace);

    // Both hit: the controller wins over the viewer.
    t.frame.results.set(t.viewerSource(), [fakeHit(new Vector3(9, 0, 9))]);
    t.frame.results.set(rightSource, [fakeHit(new Vector3(1, 0, 1))]);
    t.ar.update(t.frame as unknown as XRFrame, 0);
    expect(new Vector3().setFromMatrixPosition(t.reticle()!.matrix).toArray()).toEqual([1, 0, 1]);

    const left = inputSource("left");
    const added = Object.assign(new Event("inputsourceschange"), { added: [left], removed: [] });
    t.session.dispatchEvent(added);
    await flush();
    const leftSource = t.session.sourceFor(left.targetRaySpace);

    const removed = Object.assign(new Event("inputsourceschange"), {
      added: [],
      removed: [right],
    });
    t.session.dispatchEvent(removed);
    expect(rightSource.cancelled).toBe(true);
    t.frame.results.set(leftSource, [fakeHit(new Vector3(-1, 0, -1))]);
    t.ar.update(t.frame as unknown as XRFrame, 0);
    expect(new Vector3().setFromMatrixPosition(t.reticle()!.matrix).toArray()).toEqual([-1, 0, -1]);

    t.stop();
    expect(leftSource.cancelled).toBe(true);
    expect(t.viewerSource().cancelled).toBe(true);
  });

  it("anchors the placed model where anchors are offered, and deletes them on stop", async () => {
    const t = setup({ anchors: true });
    t.ar.setScale(1);
    await t.start();
    const anchorSpace = { kind: "anchor" };
    const anchor = { anchorSpace, delete: vi.fn() };
    const createAnchor = vi.fn(() => Promise.resolve(anchor));
    const hit = new Vector3(1, 0, 1);
    t.hitAt(hit, t.viewerSource(), createAnchor);
    t.select();
    expect(createAnchor).not.toHaveBeenCalled();
    // Made in the next frame, while a frame is active.
    t.hitAt(new Vector3(1.01, 0, 1), t.viewerSource(), createAnchor);
    expect(createAnchor).toHaveBeenCalledTimes(1);
    await flush();

    // The first pose fixes the offset: no jump.
    t.frame.poses.set(anchorSpace, fakePose(new Vector3(1.01, 0, 1)));
    t.ar.update(t.frame as unknown as XRFrame, 0);
    expect(baseOf(t.model).distanceTo(hit)).toBeLessThan(1e-9);
    // The anchor drifts by 5 cm: the model follows.
    t.frame.poses.set(anchorSpace, fakePose(new Vector3(1.06, 0, 1)));
    t.ar.update(t.frame as unknown as XRFrame, 0);
    expect(baseOf(t.model).distanceTo(new Vector3(1.05, 0, 1))).toBeLessThan(1e-9);

    t.stop();
    expect(anchor.delete).toHaveBeenCalledTimes(1);
  });

  it("falls back silently when an anchor cannot be made", async () => {
    const t = setup({ anchors: true });
    t.ar.setScale(1);
    await t.start();
    const createAnchor = vi.fn(() => Promise.reject(new Error("not supported")));
    t.hitAt(new Vector3(1, 0, 1), t.viewerSource(), createAnchor);
    t.select();
    t.hitAt(new Vector3(1, 0, 1), t.viewerSource(), createAnchor);
    await flush();
    t.ar.update(t.frame as unknown as XRFrame, 0);
    expect(createAnchor).toHaveBeenCalledTimes(1);
    expect(baseOf(t.model).distanceTo(new Vector3(1, 0, 1))).toBeLessThan(1e-9);
  });

  it("does not anchor when anchors are off", async () => {
    const t = setup({ anchors: false });
    await t.start();
    const createAnchor = vi.fn(() => Promise.resolve({ anchorSpace: {}, delete() {} }));
    t.hitAt(new Vector3(), t.viewerSource(), createAnchor);
    t.select();
    t.hitAt(new Vector3(), t.viewerSource(), createAnchor);
    expect(createAnchor).not.toHaveBeenCalled();
  });

  it("is inactive in VR", async () => {
    const t = setup({ mode: "vr" });
    const bg = t.scene.background;
    const placed = vi.fn();
    t.ctx.events.on("placed", placed);
    await t.start();
    expect(t.session.sources).toHaveLength(0);
    expect(t.model.visible).toBe(true);
    expect(t.scene.background).toBe(bg);
    expect(t.renderer.clearAlpha).toBe(1);
    t.ar.update(t.frame as unknown as XRFrame, 0);
    t.select();
    expect(placed).not.toHaveBeenCalled();
    expect(t.reticle()).toBeUndefined();
    t.stop();
    expect(t.scene.background).toBe(bg);
  });

  it("cancels hit-test sources that resolve after stop", async () => {
    const t = setup();
    t.session.inputSources.push(inputSource("right"));
    t.scene.add(t.root);
    t.ar.start();
    t.ar.stop();
    await flush();
    expect(t.session.sources).toHaveLength(1);
    for (const s of t.session.sources) expect(s.cancelled).toBe(true);
  });

  it("frees the reticle on dispose", async () => {
    const t = setup();
    await t.start();
    const mesh = t.reticle() as Mesh;
    const geometryDispose = vi.spyOn(mesh.geometry, "dispose");
    const materialDispose = vi.spyOn(mesh.material as any, "dispose");
    t.ar.dispose();
    expect(geometryDispose).toHaveBeenCalled();
    expect(materialDispose).toHaveBeenCalled();
    expect(t.model.visible).toBe(true);
  });
});
