import { Box3, Raycaster, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { createDemoScene, DEMO } from "../../examples/viewer/demo-scene";
import { directionFromYaw, parseViewpointsFile, type UpAxis } from "../../src/index";

const upOf = (up: UpAxis) => (up === "z" ? new Vector3(0, 0, 1) : new Vector3(0, 1, 0));
const height = (v: Vector3, up: UpAxis) => (up === "z" ? v.z : v.y);

describe.each(["y", "z"] as const)("demo scene, %s up", (up) => {
  const demo = createDemoScene({ up });
  const floor = (name: string) => {
    const o = demo.floors.find((f) => f.name === name);
    if (!o) throw new Error(`no floor ${name}`);
    return new Box3().setFromObject(o);
  };

  it("has the ground top at 0 and the mezzanine top at 3 along the up axis", () => {
    expect(height(floor("ground").max, up)).toBeCloseTo(0, 6);
    expect(height(floor("mezzanine").max, up)).toBeCloseTo(DEMO.mezzanineTop, 6);
  });

  it("has a 24 x 16 m ground slab", () => {
    const size = floor("ground").getSize(new Vector3());
    const plan = up === "z" ? [size.x, size.y] : [size.x, size.z];
    expect(plan[0]).toBeCloseTo(24, 6);
    expect(plan[1]).toBeCloseTo(16, 6);
  });

  it("climbs to the mezzanine in 18 even steps", () => {
    const steps = demo.floors.filter((f) => f.name.startsWith("step-"));
    expect(steps).toHaveLength(DEMO.steps);
    const tops = steps.map((s) => height(new Box3().setFromObject(s).max, up));
    tops.forEach((t, i) => {
      expect(t).toBeCloseTo(((i + 1) * DEMO.mezzanineTop) / DEMO.steps, 6);
    });
  });

  it("offers four valid viewpoints, each at eye height above a floor", () => {
    const file = parseViewpointsFile({ version: 1, up, viewpoints: demo.viewpoints });
    expect(file.viewpoints.map((v) => v.id)).toEqual(["entrance", "room-1", "room-2", "mezzanine"]);
    const down = upOf(up).negate();
    const raycaster = new Raycaster();
    for (const vp of file.viewpoints) {
      expect(vp.position).toHaveLength(3);
      expect(Number.isFinite(vp.yaw)).toBe(true);
      raycaster.set(new Vector3(...vp.position), down);
      const hit = raycaster.intersectObjects(demo.floors, true)[0];
      expect(hit, vp.id).toBeDefined();
      expect(hit.distance).toBeCloseTo(DEMO.eyeHeight, 6);
    }
    const mezzanine = file.viewpoints.find((v) => v.id === "mezzanine")!;
    expect(height(new Vector3(...mezzanine.position), up)).toBeCloseTo(
      DEMO.mezzanineTop + DEMO.eyeHeight,
      6,
    );
  });

  it("puts both alignment marks on the ground slab top, more than 10 m apart", () => {
    const { alignment } = demo;
    expect(alignment.id).toBe("demo");
    expect(alignment.labels).toEqual({ a: "A, south-west corner", b: "B, north-east corner" });
    const ground = demo.floors.find((f) => f.name === "ground")!;
    const slab = floor("ground");
    const down = upOf(up).negate();
    const raycaster = new Raycaster();
    for (const p of [alignment.a, alignment.b]) {
      const point = new Vector3(...p);
      expect(height(point, up)).toBeCloseTo(0, 6);
      // Straight down from above the mark, the slab's top is hit at the mark.
      raycaster.set(point.clone().addScaledVector(upOf(up), 10), down);
      const hit = raycaster.intersectObject(ground, false)[0];
      expect(hit).toBeDefined();
      expect(hit.point.distanceTo(point)).toBeCloseTo(0, 6);
      expect(slab.containsPoint(point)).toBe(true);
    }
    expect(new Vector3(...alignment.a).distanceTo(new Vector3(...alignment.b))).toBeGreaterThan(10);
  });

  it("draws a cross at each alignment mark", () => {
    for (const key of ["a", "b"] as const) {
      const parts = demo.root.children.filter((o) => o.name.startsWith(`alignment-${key}-`));
      expect(parts.length).toBeGreaterThan(0);
      const cross = new Box3();
      for (const o of parts) cross.union(new Box3().setFromObject(o));
      const centre = cross.getCenter(new Vector3());
      const mark = new Vector3(...demo.alignment[key]);
      // Centred on the mark in plan, sitting on the slab.
      const plan = (v: Vector3) => (up === "z" ? [v.x, v.y] : [v.x, v.z]);
      expect(plan(centre)[0]).toBeCloseTo(plan(mark)[0], 6);
      expect(plan(centre)[1]).toBeCloseTo(plan(mark)[1], 6);
      expect(height(cross.min, up)).toBeCloseTo(0, 6);
    }
  });

  it("keeps the line of sight from each viewpoint free for a metre", () => {
    const raycaster = new Raycaster(undefined, undefined, 0, 1);
    for (const vp of demo.viewpoints) {
      raycaster.set(new Vector3(...vp.position), directionFromYaw(vp.yaw, up));
      raycaster.far = 1;
      expect(raycaster.intersectObject(demo.root, true), vp.id).toHaveLength(0);
    }
  });
});

describe("demo scene up axes", () => {
  it("builds the Z-up scene as the Y-up scene with height on Z", () => {
    const y = createDemoScene({ up: "y" }).bounds;
    const z = createDemoScene({ up: "z" }).bounds;
    // Y up: (east, height, -north). Z up: (east, north, height).
    expect(z.min.x).toBeCloseTo(y.min.x, 6);
    expect(z.max.x).toBeCloseTo(y.max.x, 6);
    expect(z.min.y).toBeCloseTo(-y.max.z, 6);
    expect(z.max.y).toBeCloseTo(-y.min.z, 6);
    expect(z.min.z).toBeCloseTo(y.min.y, 6);
    expect(z.max.z).toBeCloseTo(y.max.y, 6);
  });

  it("places the alignment marks at the same plan points in both", () => {
    const y = createDemoScene({ up: "y" }).alignment;
    const z = createDemoScene({ up: "z" }).alignment;
    expect(z.id).toBe(y.id);
    expect(z.labels).toEqual(y.labels);
    for (const key of ["a", "b"] as const) {
      const [ex, h, mn] = y[key];
      expect(z[key][0]).toBeCloseTo(ex, 6);
      expect(z[key][1]).toBeCloseTo(-mn, 6);
      expect(z[key][2]).toBeCloseTo(h, 6);
    }
    // A is south-west of B: east and north both grow from A to B.
    expect(z.b[0]).toBeGreaterThan(z.a[0]);
    expect(z.b[1]).toBeGreaterThan(z.a[1]);
  });

  it("places the same viewpoints in both, yaw unchanged", () => {
    const y = createDemoScene({ up: "y" }).viewpoints;
    const z = createDemoScene({ up: "z" }).viewpoints;
    y.forEach((vy, i) => {
      const vz = z[i];
      expect(vz.yaw).toBe(vy.yaw);
      const [ex, h, mn] = vy.position;
      expect(vz.position[0]).toBeCloseTo(ex, 6);
      expect(vz.position[1]).toBeCloseTo(-mn, 6);
      expect(vz.position[2]).toBeCloseTo(h, 6);
      // The yaw looks the same way in plan in both conventions.
      const dy = directionFromYaw(vy.yaw, "y");
      const dz = directionFromYaw(vz.yaw, "z");
      expect(dz.x).toBeCloseTo(dy.x, 6);
      expect(dz.y).toBeCloseTo(-dy.z, 6);
    });
  });
});
