// @vitest-environment happy-dom
import { Group, type Mesh, type MeshBasicMaterial, Object3D, Vector3 } from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHud,
  HUD_CANVAS_WIDTH,
  HUD_DISTANCE,
  HUD_DROP,
  HUD_FOLLOW_TAU,
  HUD_RENDER_ORDER,
} from "../../src/hud";
import type { KitContext } from "../../src/internal";
import { upVector } from "../../src/math";
import type { UpAxis } from "../../src/types";

const frame = {} as XRFrame;

interface TextCall {
  text: string;
  x: number;
  y: number;
  font: string;
}

/** A 2D context that records the text it is asked to draw; widths are 0.5 em per character. */
function recordingContext() {
  const texts: TextCall[] = [];
  const noop = () => {};
  const g = {
    font: "10px sans-serif",
    fillStyle: "#000",
    strokeStyle: "#000",
    lineWidth: 1,
    textAlign: "start",
    textBaseline: "alphabetic",
    clearRect: noop,
    beginPath: noop,
    moveTo: noop,
    lineTo: noop,
    arcTo: noop,
    closePath: noop,
    fill: noop,
    stroke: noop,
    fillText(text: string, x: number, y: number) {
      texts.push({ text, x, y, font: g.font });
    },
    measureText(text: string) {
      const size = Number(/(\d+)px/.exec(g.font)?.[1] ?? 10);
      return { width: text.length * size * 0.5 };
    },
  };
  return { g, texts };
}

/** A head at `eye` looking along `look`, with three's XR camera reporting it. */
function makeHead(up: Vector3) {
  const camera = new Object3D();
  const set = (eye: Vector3, look: Vector3) => {
    camera.matrixWorld.lookAt(eye, eye.clone().add(look), up).setPosition(eye);
  };
  return { camera, set };
}

function makeCtx(up: UpAxis) {
  const upVec = upVector(up);
  const head = makeHead(upVec);
  const root = new Group();
  const ctx = {
    renderer: { xr: { getCamera: () => head.camera } },
    root,
    up: upVec,
  } as unknown as KitContext;
  return { ctx, head, root, up: upVec };
}

function hudMesh(root: Group): Mesh {
  const mesh = root.children[0] as Mesh;
  expect(mesh).toBeDefined();
  return mesh;
}

const position = (mesh: Mesh) => new Vector3().setFromMatrixPosition(mesh.matrix);

let recorder: ReturnType<typeof recordingContext>;

beforeEach(() => {
  recorder = recordingContext();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => recorder.g as unknown as CanvasRenderingContext2D,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("hud content", () => {
  it("draws the title and the detail lines", () => {
    const { ctx } = makeCtx("y");
    const hud = createHud(ctx);
    hud.show("Point A", ["Stand on the first mark", "Pull the trigger"]);
    const texts = recorder.texts.map((t) => t.text);
    expect(texts).toEqual(["Point A", "Stand on the first mark", "Pull the trigger"]);
    // Title above the lines and larger, in bold.
    const [title, l1, l2] = recorder.texts;
    expect(title.y).toBeLessThan(l1.y);
    expect(l1.y).toBeLessThan(l2.y);
    expect(title.font).toMatch(/bold/);
    const px = (f: string) => Number(/(\d+)px/.exec(f)?.[1]);
    expect(px(title.font)).toBeGreaterThan(px(l1.font));
  });

  it("keeps at most three detail lines", () => {
    const { ctx } = makeCtx("y");
    createHud(ctx).show("T", ["a", "b", "c", "d"]);
    expect(recorder.texts.map((t) => t.text)).toEqual(["T", "a", "b", "c"]);
  });

  it("fits a long line inside the panel", () => {
    const { ctx } = makeCtx("y");
    createHud(ctx).show("T", ["x".repeat(200)]);
    const line = recorder.texts[1];
    expect(line.text.endsWith("…")).toBe(true);
    recorder.g.font = line.font;
    expect(recorder.g.measureText(line.text).width).toBeLessThanOrEqual(HUD_CANVAS_WIDTH);
  });

  it("uploads the texture once per change, not per frame", () => {
    const { ctx, head, root } = makeCtx("y");
    head.set(new Vector3(0, 1.6, 0), new Vector3(0, 0, -1));
    const hud = createHud(ctx);
    hud.start();
    const material = hudMesh(root).material as MeshBasicMaterial;
    const texture = material.map!;
    const v0 = texture.version;

    hud.show("One", ["line"]);
    expect(texture.version).toBe(v0 + 1);
    for (let i = 0; i < 10; i++) hud.update(frame, 1 / 72);
    hud.show("One", ["line"]);
    expect(texture.version).toBe(v0 + 1);
    expect(recorder.texts).toHaveLength(2);

    hud.show("Two");
    expect(texture.version).toBe(v0 + 2);
    hud.show("Two", ["more"]);
    expect(texture.version).toBe(v0 + 3);
  });

  it("renders on top of the scene", () => {
    const { ctx, root } = makeCtx("y");
    const hud = createHud(ctx);
    hud.start();
    const mesh = hudMesh(root);
    const material = mesh.material as MeshBasicMaterial;
    expect(material.depthTest).toBe(false);
    expect(material.transparent).toBe(true);
    expect(mesh.renderOrder).toBe(HUD_RENDER_ORDER);
  });

  it("hide makes it invisible and show makes it visible again", () => {
    const { ctx, root } = makeCtx("y");
    const hud = createHud(ctx);
    hud.start();
    const mesh = hudMesh(root);
    expect(mesh.visible).toBe(false);
    hud.show("Hello");
    expect(mesh.visible).toBe(true);
    hud.hide();
    expect(mesh.visible).toBe(false);
    hud.show("Hello");
    expect(mesh.visible).toBe(true);
  });
});

describe("hud lifecycle", () => {
  it("start adds it to the root and stop removes it", () => {
    const { ctx, root } = makeCtx("y");
    const hud = createHud(ctx);
    expect(root.children).toHaveLength(0);
    hud.start();
    expect(root.children).toHaveLength(1);
    hud.stop();
    expect(root.children).toHaveLength(0);
  });

  it("dispose frees geometry, material and texture", () => {
    const { ctx, root } = makeCtx("y");
    const hud = createHud(ctx);
    hud.start();
    const mesh = hudMesh(root);
    const material = mesh.material as MeshBasicMaterial;
    const spies = [
      vi.spyOn(mesh.geometry, "dispose"),
      vi.spyOn(material, "dispose"),
      vi.spyOn(material.map!, "dispose"),
    ];
    hud.dispose();
    for (const s of spies) expect(s).toHaveBeenCalledOnce();
    expect(root.children).toHaveLength(0);
    expect(() => hud.show("late")).not.toThrow();
  });
});

describe.each(["y", "z"] as const)("hud placement, %s up", (axis) => {
  const horizontal = (up: Vector3, x: number, f: number) =>
    // A horizontal direction: x along +X, f along the other horizontal axis.
    up.z === 1 ? new Vector3(x, f, 0) : new Vector3(x, 0, -f);

  function expectedTarget(eye: Vector3, fwd: Vector3, up: Vector3) {
    return eye
      .clone()
      .addScaledVector(fwd.clone().normalize(), HUD_DISTANCE)
      .addScaledVector(up, -HUD_DROP);
  }

  it("snaps in front of and below the head, facing it, on the first frame", () => {
    const { ctx, head, root, up } = makeCtx(axis);
    const eye = up
      .clone()
      .multiplyScalar(1.6)
      .add(horizontal(up, 2, -1));
    const fwd = horizontal(up, 1, 1).normalize();
    // Looking a little down: the panel still sits along the horizontal forward.
    head.set(eye, fwd.clone().addScaledVector(up, -0.4));
    const hud = createHud(ctx);
    hud.start();
    hud.show("Here");
    hud.update(frame, 1 / 72);

    const mesh = hudMesh(root);
    const p = position(mesh);
    expect(p.distanceTo(expectedTarget(eye, fwd, up))).toBeLessThan(1e-6);

    // Plane normal (+Z) towards the eye, its +Y on the scene's up side.
    const toEye = eye.clone().sub(p).normalize();
    const normal = new Vector3().setFromMatrixColumn(mesh.matrix, 2).normalize();
    const yAxis = new Vector3().setFromMatrixColumn(mesh.matrix, 1).normalize();
    expect(normal.dot(toEye)).toBeGreaterThan(0.999);
    expect(yAxis.dot(up)).toBeGreaterThan(0.9);
  });

  it("follows the head smoothly", () => {
    const { ctx, head, root, up } = makeCtx(axis);
    const eye = up.clone().multiplyScalar(1.6);
    const fwd = horizontal(up, 0, 1);
    head.set(eye, fwd);
    const hud = createHud(ctx);
    hud.start();
    hud.show("Here");
    hud.update(frame, 1 / 72);
    const mesh = hudMesh(root);
    const start = position(mesh);

    // Turn 90 degrees to the right.
    const fwd2 = horizontal(up, 1, 0);
    head.set(eye, fwd2);
    const target = expectedTarget(eye, fwd2, up);
    const dt = 0.1;
    hud.update(frame, dt);
    const a = 1 - Math.exp(-dt / HUD_FOLLOW_TAU);
    const expected = start.clone().lerp(target, a);
    expect(position(mesh).distanceTo(expected)).toBeLessThan(1e-6);
    expect(position(mesh).distanceTo(target)).toBeGreaterThan(0.1);

    // A zero dt does not move it.
    hud.update(frame, 0);
    expect(position(mesh).distanceTo(expected)).toBeLessThan(1e-6);

    // After a few time constants it has arrived.
    for (let i = 0; i < 40; i++) hud.update(frame, 0.1);
    expect(position(mesh).distanceTo(target)).toBeLessThan(1e-3);
  });

  it("snaps again when shown after being hidden", () => {
    const { ctx, head, root, up } = makeCtx(axis);
    const eye = up.clone().multiplyScalar(1.6);
    head.set(eye, horizontal(up, 0, 1));
    const hud = createHud(ctx);
    hud.start();
    hud.show("A");
    hud.update(frame, 1 / 72);
    hud.hide();
    const fwd2 = horizontal(up, -1, 0);
    head.set(eye, fwd2);
    hud.show("B");
    hud.update(frame, 1 / 72);
    expect(position(hudMesh(root)).distanceTo(expectedTarget(eye, fwd2, up))).toBeLessThan(1e-6);
  });

  it("places it relative to a moved root", () => {
    const { ctx, head, root, up } = makeCtx(axis);
    root.position.set(5, 0, 0);
    root.updateMatrixWorld(true);
    const eye = up.clone().multiplyScalar(1.6);
    const fwd = horizontal(up, 0, 1);
    head.set(eye, fwd);
    const hud = createHud(ctx);
    hud.start();
    hud.show("A");
    hud.update(frame, 1 / 72);
    const mesh = hudMesh(root);
    mesh.updateMatrixWorld(true);
    const world = new Vector3().setFromMatrixPosition(mesh.matrixWorld);
    expect(world.distanceTo(expectedTarget(eye, fwd, up))).toBeLessThan(1e-6);
  });
});

describe("hud without a 2D context", () => {
  function expectNoop(ctx: KitContext, root: Group) {
    const hud = createHud(ctx);
    expect(() => {
      hud.show("T", ["a"]);
      hud.start();
      hud.update(frame, 0.1);
      hud.hide();
      hud.stop();
      hud.dispose();
    }).not.toThrow();
    hud.start();
    expect(root.children).toHaveLength(0);
  }

  it("is a no-op when the canvas has no 2D context", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const { ctx, root } = makeCtx("y");
    expectNoop(ctx, root);
  });

  it("is a no-op when getContext throws", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => {
      throw new Error("no canvas");
    });
    const { ctx, root } = makeCtx("y");
    expectNoop(ctx, root);
  });

  it("is a no-op without a document or OffscreenCanvas", () => {
    vi.stubGlobal("document", undefined);
    vi.stubGlobal("OffscreenCanvas", undefined);
    const { ctx, root } = makeCtx("z");
    expectNoop(ctx, root);
  });

  it("uses OffscreenCanvas where there is no document", () => {
    const made: number[][] = [];
    class FakeOffscreen {
      constructor(w: number, h: number) {
        made.push([w, h]);
      }
      getContext() {
        return recorder.g;
      }
    }
    vi.stubGlobal("document", undefined);
    vi.stubGlobal("OffscreenCanvas", FakeOffscreen);
    const { ctx, root } = makeCtx("y");
    const hud = createHud(ctx);
    hud.start();
    hud.show("Offscreen");
    expect(made).toHaveLength(1);
    expect(root.children).toHaveLength(1);
    expect(recorder.texts.map((t) => t.text)).toEqual(["Offscreen"]);
  });
});
