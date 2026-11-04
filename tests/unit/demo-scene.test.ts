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
