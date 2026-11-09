import { BoxGeometry, Group, Mesh, MeshBasicMaterial, type Object3D, Scene, Vector3 } from "three";
import { describe, expect, it, vi } from "vitest";
import { Emitter } from "../../src/events";
import type { AllEvents, KitContext } from "../../src/internal";
import { upVector } from "../../src/math";
import { createDefaultRaycast } from "../../src/raycast";
import type { RaycastFn, UpAxis, Viewpoint } from "../../src/types";
import { createViewpoints, parseViewpointsFile, parseViewpointsFileAR } from "../../src/viewpoints";

describe("parseViewpointsFile", () => {
  it("accepts a minimal file", () => {
    const file = parseViewpointsFile({
      version: 1,
      viewpoints: [{ id: "a", position: [1, 2, 3], yaw: 0 }],
    });
    expect(file).toEqual({ version: 1, viewpoints: [{ id: "a", position: [1, 2, 3], yaw: 0 }] });
  });

  it("accepts an empty viewpoints list", () => {
    expect(parseViewpointsFile({ version: 1, viewpoints: [] })).toEqual({
      version: 1,
      viewpoints: [],
    });
  });

  it("accepts a full file and drops unknown keys", () => {
    const file = parseViewpointsFile({
      version: 1,
      model: "model.glb",
      metresPerUnit: 0.001,
      up: "z",
      extra: true,
      viewpoints: [
        { id: "entrance", label: "Entrance", position: [12.4, 1.6, -3], yaw: 90, note: "x" },
        { id: "atrium", label: "Atrium", position: [4, 7.2, 8.5], yaw: 180, fov: 60 },
      ],
    });
    expect(file).toEqual({
      version: 1,
      model: "model.glb",
      metresPerUnit: 0.001,
      up: "z",
      viewpoints: [
        { id: "entrance", label: "Entrance", position: [12.4, 1.6, -3], yaw: 90 },
        { id: "atrium", label: "Atrium", position: [4, 7.2, 8.5], yaw: 180, fov: 60 },
      ],
    });
  });

  it("returns a copy, not the input", () => {
    const position: [number, number, number] = [1, 2, 3];
    const input = { version: 1, viewpoints: [{ id: "a", position, yaw: 0 }] };
    const file = parseViewpointsFile(input);
    expect(file.viewpoints[0].position).not.toBe(position);
    expect(file.viewpoints).not.toBe(input.viewpoints);
  });

  it("parses JSON text", () => {
    const text = JSON.stringify({
      version: 1,
      up: "y",
      viewpoints: [{ id: "a", label: "A", position: [0, 1.6, 0], yaw: -45 }],
    });
    expect(parseViewpointsFile(text).viewpoints[0]).toEqual({
      id: "a",
      label: "A",
      position: [0, 1.6, 0],
      yaw: -45,
    });
  });

  it("rejects malformed JSON text", () => {
    expect(() => parseViewpointsFile("{ version: 1")).toThrow(
      /^\[llhil-webxr\] viewpoints: invalid JSON/,
    );
  });

  it.each([null, 42, [], "[]", "null"])("rejects a non-object top level (%j)", (input) => {
    expect(() => parseViewpointsFile(input)).toThrow(
      "[llhil-webxr] viewpoints: expected an object at the top level",
    );
  });

  const vp = { id: "a", position: [0, 0, 0], yaw: 0 };
  it.each([
    [{ version: 2, viewpoints: [] }, "version: expected 1"],
    [{ viewpoints: [] }, "version: expected 1"],
    [{ version: 1 }, "viewpoints: expected an array"],
    [{ version: 1, viewpoints: {} }, "viewpoints: expected an array"],
    [{ version: 1, model: 3, viewpoints: [] }, "model: expected a string"],
    [
      { version: 1, metresPerUnit: 0, viewpoints: [] },
      "metresPerUnit: expected a finite number > 0",
    ],
    [{ version: 1, metresPerUnit: -1, viewpoints: [] }, "metresPerUnit"],
    [{ version: 1, metresPerUnit: "1", viewpoints: [] }, "metresPerUnit"],
    [{ version: 1, up: "x", viewpoints: [] }, 'up: expected "y" or "z"'],
    [{ version: 1, viewpoints: [7] }, "viewpoints[0]: expected an object"],
    [
      { version: 1, viewpoints: [{ ...vp, id: "" }] },
      "viewpoints[0].id: expected a non-empty string",
    ],
    [
      { version: 1, viewpoints: [{ ...vp, id: 5 }] },
      "viewpoints[0].id: expected a non-empty string",
    ],
    [
      { version: 1, viewpoints: [vp, { ...vp, id: "b", position: [0, 0] }] },
      "viewpoints[1].position: expected 3 finite numbers",
    ],
    [{ version: 1, viewpoints: [{ ...vp, position: [0, 0, 0, 0] }] }, "viewpoints[0].position"],
    [
      { version: 1, viewpoints: [{ ...vp, position: [0, Number.NaN, 0] }] },
      "viewpoints[0].position",
    ],
    [{ version: 1, viewpoints: [{ ...vp, position: "0,0,0" }] }, "viewpoints[0].position"],
    [
      { version: 1, viewpoints: [{ ...vp, yaw: "90" }] },
      "viewpoints[0].yaw: expected a finite number",
    ],
    [{ version: 1, viewpoints: [{ ...vp, yaw: Number.POSITIVE_INFINITY }] }, "viewpoints[0].yaw"],
    [{ version: 1, viewpoints: [{ ...vp, label: 1 }] }, "viewpoints[0].label: expected a string"],
    [{ version: 1, viewpoints: [{ ...vp, fov: 0 }] }, "viewpoints[0].fov"],
    [{ version: 1, viewpoints: [{ ...vp, fov: 180 }] }, "viewpoints[0].fov"],
    [{ version: 1, viewpoints: [{ ...vp, fov: "60" }] }, "viewpoints[0].fov"],
  ])("rejects %j", (input, message) => {
    expect(() => parseViewpointsFile(input)).toThrow(`[llhil-webxr] viewpoints: ${message}`);
  });

  it("rejects duplicate ids, naming both places", () => {
    expect(() =>
      parseViewpointsFile({
        version: 1,
        viewpoints: [vp, { ...vp, id: "b" }, { ...vp, position: [1, 1, 1] }],
      }),
    ).toThrow('viewpoints[2].id: duplicate id "a" (first at viewpoints[0])');
  });

  it("reports every problem at once", () => {
    let message = "";
    try {
      parseViewpointsFile({
        version: 0,
        up: "Y",
        viewpoints: [
          { id: "a", position: [0, 0, 0], yaw: 0 },
          { id: "a", position: [0, 0], yaw: null, fov: 200 },
          null,
        ],
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message.startsWith("[llhil-webxr] viewpoints:")).toBe(true);
    const lines = message
      .split("\n")
      .slice(1)
      .map((l) => l.trim());
    expect(lines).toEqual([
      "version: expected 1",
      'up: expected "y" or "z"',
      'viewpoints[1].id: duplicate id "a" (first at viewpoints[0])',
      "viewpoints[1].position: expected 3 finite numbers",
      "viewpoints[1].yaw: expected a finite number",
      "viewpoints[1].fov: expected a number between 0 and 180 (exclusive)",
      "viewpoints[2]: expected an object",
    ]);
  });
});

describe("parseViewpointsFileAR", () => {
  const alignment = {
    id: "site",
    a: [0, 0, 0],
    b: [12, 0, -5],
    labels: { a: "south-west corner", b: "north-east corner" },
  };
  const file = <T>(ar: T) => ({ version: 1, viewpoints: [], ar });

  it("returns null when the file has no ar section", () => {
    expect(parseViewpointsFileAR({ version: 1, viewpoints: [] })).toBeNull();
    expect(parseViewpointsFileAR('{"version":1,"viewpoints":[]}')).toBeNull();
  });

  it("accepts an empty ar section", () => {
    expect(parseViewpointsFileAR(file({}))).toEqual({});
  });

  it("accepts a full ar section, drops unknown keys and copies the input", () => {
    const input = file({ alignment: { ...alignment, note: 1 }, hide: ["terrain", "trees"], x: 2 });
    const ar = parseViewpointsFileAR(input);
    expect(ar).toEqual({ alignment, hide: ["terrain", "trees"] });
    expect(ar?.alignment?.a).not.toBe(alignment.a);
    expect(ar?.hide).not.toBe(input.ar.hide);
  });

  it("accepts an alignment without labels, or with one label", () => {
    const { labels: _, ...bare } = alignment;
    expect(parseViewpointsFileAR(file({ alignment: bare }))).toEqual({ alignment: bare });
    expect(parseViewpointsFileAR(file({ alignment: { ...bare, labels: { b: "gate" } } }))).toEqual({
      alignment: { ...bare, labels: { b: "gate" } },
    });
  });

  it("parses JSON text", () => {
    expect(parseViewpointsFileAR(JSON.stringify(file({ hide: ["terrain"] })))).toEqual({
      hide: ["terrain"],
    });
  });

  it("leaves parseViewpointsFile accepting a file with an ar section", () => {
    expect(parseViewpointsFile(file({ alignment, hide: ["terrain"] }))).toEqual({
      version: 1,
      viewpoints: [],
    });
  });

  it("rejects malformed JSON text and a non-object top level", () => {
    expect(() => parseViewpointsFileAR("{ ar: ")).toThrow(
      /^\[llhil-webxr\] viewpoints: invalid JSON/,
    );
    expect(() => parseViewpointsFileAR([])).toThrow("expected an object at the top level");
  });

  it.each([
    [[], "ar: expected an object"],
    ["on", "ar: expected an object"],
    [{ alignment: 1 }, "ar.alignment: expected an object"],
    [{ alignment: { ...alignment, id: "" } }, "ar.alignment.id: expected a non-empty string"],
    [{ alignment: { ...alignment, id: undefined } }, "ar.alignment.id"],
    [{ alignment: { ...alignment, a: [0, 0] } }, "ar.alignment.a: expected 3 finite numbers"],
    [{ alignment: { ...alignment, a: [0, Number.NaN, 0] } }, "ar.alignment.a"],
    [{ alignment: { ...alignment, b: "1,2,3" } }, "ar.alignment.b: expected 3 finite numbers"],
    [
      { alignment: { ...alignment, b: [0, 0, 0] } },
      "ar.alignment.b: expected a point apart from a",
    ],
    [{ alignment: { ...alignment, labels: "A" } }, "ar.alignment.labels: expected an object"],
    [{ alignment: { ...alignment, labels: { a: 1 } } }, "ar.alignment.labels.a: expected a string"],
    [{ hide: "terrain" }, "ar.hide: expected an array of object names"],
    [{ hide: ["terrain", 3] }, "ar.hide[1]: expected a non-empty string"],
    [{ hide: [""] }, "ar.hide[0]: expected a non-empty string"],
  ])("rejects ar %j", (ar, message) => {
    expect(() => parseViewpointsFileAR(file(ar))).toThrow(`[llhil-webxr] viewpoints: ${message}`);
  });

  it("reports every problem in the ar section at once", () => {
    let message = "";
    try {
      parseViewpointsFileAR(
        file({ alignment: { a: [0, 0], b: [1, 2, 3], labels: { b: false } }, hide: [null] }),
      );
    } catch (error) {
      message = (error as Error).message;
    }
    const lines = message
      .split("\n")
      .slice(1)
      .map((l) => l.trim());
    expect(lines).toEqual([
      "ar.alignment.id: expected a non-empty string",
      "ar.alignment.a: expected 3 finite numbers",
      "ar.alignment.labels.b: expected a string",
      "ar.hide[0]: expected a non-empty string",
    ]);
  });
});

// A two-storey plan: ground slab (top at height 0) over x in [-10, 5], a mezzanine (top at
// height 3) over x in [0, 5], z (or y) in [-5, 5]; nothing over x > 5, a hole.
function box(w: number, h: number, d: number, x: number, vertical: number, up: UpAxis): Mesh {
  const geometry = up === "y" ? new BoxGeometry(w, h, d) : new BoxGeometry(w, d, h);
  const mesh = new Mesh(geometry, new MeshBasicMaterial());
  if (up === "y") mesh.position.set(x, vertical, 0);
  else mesh.position.set(x, 0, vertical);
  return mesh;
}

function twoStoreyScene(up: UpAxis, unit = 1): { scene: Scene; model: Group } {
  const scene = new Scene();
  const model = new Group();
  model.add(box(15 * unit, 1 * unit, 20 * unit, -2.5 * unit, -0.5 * unit, up));
  model.add(box(5 * unit, 0.3 * unit, 10 * unit, 2.5 * unit, 2.85 * unit, up));
  scene.add(model);
  return { scene, model };
}

interface FakeCtx {
  ctx: KitContext;
  placeUser: ReturnType<typeof vi.fn>;
  events: Emitter<AllEvents>;
}

function makeCtx(opts: {
  up?: UpAxis;
  raycast: RaycastFn;
  metresPerUnit?: number;
  eyeHeight?: number;
  mode?: "vr" | "ar" | null;
}): FakeCtx {
  const placeUser = vi.fn();
  const events = new Emitter<AllEvents>();
  const up = opts.up ?? "y";
  const ctx = {
    up: upVector(up),
    options: {
      up,
      metresPerUnit: opts.metresPerUnit ?? 1,
      vr: { turn: "snap", snapDegrees: 30, eyeHeight: opts.eyeHeight ?? 1.5, teleport: true },
    },
    events,
    raycast: opts.raycast,
    space: { placeUser },
    mode: opts.mode === undefined ? "vr" : opts.mode,
    session: null,
  } as unknown as KitContext;
  return { ctx, placeUser, events };
}

function defaultRaycast(model: Object3D): RaycastFn {
  return createDefaultRaycast(
    () => [model],
    () => model,
    new Group(),
  );
}

const floorOf = (ctrl: ReturnType<typeof createViewpoints>, id: string): Vector3 => {
  const vp = ctrl.list().find((v) => v.id === id);
  if (!vp) throw new Error(`missing ${id}`);
  return vp.floorPoint;
};

function expectVec(v: Vector3, x: number, y: number, z: number): void {
  expect(v.x).toBeCloseTo(x, 6);
  expect(v.y).toBeCloseTo(y, 6);
  expect(v.z).toBeCloseTo(z, 6);
}

describe("createViewpoints: floor resolution", () => {
  const yUp: Viewpoint[] = [
    { id: "mezzanine", label: "Mezzanine", position: [2, 4.6, 0], yaw: 90 },
    { id: "ground", position: [-5, 1.6, 2], yaw: 0 },
    { id: "under", position: [2, 1.6, 0], yaw: 0 },
    { id: "hole", position: [8, 1.6, 0], yaw: 0 },
  ];

  it("lands on the floor below each viewpoint, Y up", () => {
    const { scene, model } = twoStoreyScene("y");
    scene.updateMatrixWorld(true);
    const { ctx } = makeCtx({ raycast: defaultRaycast(model) });
    const vps = createViewpoints(ctx);
    vps.set(yUp);
    expect(vps.list()).toEqual([]);
    vps.start();
    expectVec(floorOf(vps, "mezzanine"), 2, 3, 0);
    expectVec(floorOf(vps, "ground"), -5, 0, 2);
    expectVec(floorOf(vps, "under"), 2, 0, 0);
    // No floor: eye minus eyeHeight (1.5).
    expectVec(floorOf(vps, "hole"), 8, 0.1, 0);
    expect(vps.list().map((v) => v.label)).toEqual(["Mezzanine", "ground", "under", "hole"]);
    expect(vps.list()[0].yaw).toBe(90);
  });

  it("lands on the floor below each viewpoint, Z up", () => {
    const { scene, model } = twoStoreyScene("z");
    scene.updateMatrixWorld(true);
    const { ctx } = makeCtx({ up: "z", raycast: defaultRaycast(model) });
    const vps = createViewpoints(ctx);
    vps.set([
      { id: "mezzanine", position: [2, 0, 4.6], yaw: 90 },
      { id: "ground", position: [-5, 2, 1.6], yaw: 0 },
      { id: "hole", position: [8, 0, 1.6], yaw: 0 },
    ]);
    vps.start();
    expectVec(floorOf(vps, "mezzanine"), 2, 0, 3);
    expectVec(floorOf(vps, "ground"), -5, 2, 0);
    expectVec(floorOf(vps, "hole"), 8, 0, 0.1);
  });

  it("scales positions by metresPerUnit (the model is scaled to metres during VR)", () => {
    const { scene, model } = twoStoreyScene("y", 1000);
    model.scale.setScalar(0.001);
    scene.updateMatrixWorld(true);
    const { ctx } = makeCtx({ raycast: defaultRaycast(model), metresPerUnit: 0.001 });
    const vps = createViewpoints(ctx);
    vps.set([
      { id: "mezzanine", position: [2000, 4600, 0], yaw: 0 },
      { id: "ground", position: [-5000, 1600, 2000], yaw: 0 },
      { id: "hole", position: [8000, 1600, 0], yaw: 0 },
    ]);
    vps.start();
    expectVec(floorOf(vps, "mezzanine"), 2, 3, 0);
    expectVec(floorOf(vps, "ground"), -5, 0, 2);
    expectVec(floorOf(vps, "hole"), 8, 0.1, 0);
  });

  it("casts from just above the eye, straight down, against the floors", () => {
    const raycast = vi.fn<RaycastFn>(() => null);
    const { ctx } = makeCtx({ up: "z", raycast, eyeHeight: 1.6 });
    const vps = createViewpoints(ctx);
    vps.set([{ id: "a", position: [1, 2, 3], yaw: 0 }]);
    vps.start();
    expect(raycast).toHaveBeenCalledTimes(1);
    const [origin, direction, far, targets] = raycast.mock.calls[0];
    expectVec(origin, 1, 2, 3.05);
    expectVec(direction, 0, 0, -1);
    expect(far).toBe(100);
    expect(targets).toBe("floors");
    expectVec(floorOf(vps, "a"), 1, 2, 1.4);
  });

  it("rejects a steep first hit and accepts one with an unknown normal", () => {
    const object = new Group();
    const steep: RaycastFn = (o) => ({
      point: new Vector3(o.x, 0.5, o.z),
      normal: new Vector3(1, 1, 0).normalize(), // 45 degrees off up
      object,
      distance: 1,
    });
    const gentle: RaycastFn = (o) => ({
      point: new Vector3(o.x, 0.5, o.z),
      normal: new Vector3(0.3, 1, 0).normalize(), // about 17 degrees off up
      object,
      distance: 1,
    });
    const unknown: RaycastFn = (o) => ({
      point: new Vector3(o.x, 0.5, o.z),
      normal: null,
      object,
      distance: 1,
    });
    const list: Viewpoint[] = [{ id: "a", position: [1, 1.6, 2], yaw: 0 }];
    const results = [steep, gentle, unknown].map((raycast) => {
      const vps = createViewpoints(makeCtx({ raycast }).ctx);
      vps.set(list);
      vps.start();
      return floorOf(vps, "a");
    });
    expectVec(results[0], 1, 0.1, 2);
    expectVec(results[1], 1, 0.5, 2);
    expectVec(results[2], 1, 0.5, 2);
  });

  it("re-resolves on set while started, and clears on stop", () => {
    const raycast = vi.fn<RaycastFn>(() => null);
    const vps = createViewpoints(makeCtx({ raycast }).ctx);
    vps.set([{ id: "a", position: [0, 1.6, 0], yaw: 0 }]);
    expect(raycast).not.toHaveBeenCalled();
    vps.start();
    expect(vps.list().map((v) => v.id)).toEqual(["a"]);
    vps.set([
      { id: "b", position: [0, 1.6, 0], yaw: 0 },
      { id: "c", position: [1, 1.6, 0], yaw: 0 },
    ]);
    expect(vps.list().map((v) => v.id)).toEqual(["b", "c"]);
    vps.stop();
    expect(vps.list()).toEqual([]);
    vps.set([{ id: "d", position: [0, 1.6, 0], yaw: 0 }]);
    expect(vps.list()).toEqual([]);
    vps.start();
    expect(vps.list().map((v) => v.id)).toEqual(["d"]);
    vps.dispose();
    expect(vps.list()).toEqual([]);
  });
});

describe("createViewpoints: goTo", () => {
  function setup(mode: "vr" | "ar" | null = "vr") {
    const { scene, model } = twoStoreyScene("y");
    scene.updateMatrixWorld(true);
    const fake = makeCtx({ raycast: defaultRaycast(model), mode });
    const vps = createViewpoints(fake.ctx);
    vps.set([
      { id: "mezzanine", position: [2, 4.6, 0], yaw: 90 },
      { id: "ground", position: [-5, 1.6, 2], yaw: -30 },
    ]);
    vps.start();
    return { ...fake, vps };
  }

  it("places the user on the floor point facing the yaw, and emits viewpoint", () => {
    const { vps, placeUser, events } = setup();
    const seen: string[] = [];
    events.on("viewpoint", ({ id }) => seen.push(id));
    vps.goTo("mezzanine");
    expect(placeUser).toHaveBeenCalledTimes(1);
    const [point, yaw] = placeUser.mock.calls[0];
    expectVec(point, 2, 3, 0);
    expect(yaw).toBe(90);
    vps.goTo("ground");
    expectVec(placeUser.mock.calls[1][0], -5, 0, 2);
    expect(placeUser.mock.calls[1][1]).toBe(-30);
    expect(seen).toEqual(["mezzanine", "ground"]);
  });

  it("does not let the caller mutate the stored floor point", () => {
    const { vps, placeUser } = setup();
    vps.goTo("mezzanine");
    (placeUser.mock.calls[0][0] as Vector3).set(99, 99, 99);
    expectVec(floorOf(vps, "mezzanine"), 2, 3, 0);
  });

  it("throws on an unknown id", () => {
    const { vps, placeUser } = setup();
    expect(() => vps.goTo("roof")).toThrow('[llhil-webxr] viewpoints: unknown viewpoint "roof"');
    expect(placeUser).not.toHaveBeenCalled();
  });

  it.each([null, "ar"] as const)("does nothing outside VR (mode %s)", (mode) => {
    const { vps, placeUser, events } = setup(mode);
    const listener = vi.fn();
    events.on("viewpoint", listener);
    expect(() => vps.goTo("mezzanine")).not.toThrow();
    expect(() => vps.goTo("roof")).not.toThrow();
    expect(placeUser).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });
});
