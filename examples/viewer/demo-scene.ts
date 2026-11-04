import {
  Box3,
  BoxGeometry,
  CylinderGeometry,
  DirectionalLight,
  Group,
  HemisphereLight,
  type Material,
  Mesh,
  MeshLambertMaterial,
  type Object3D,
  Vector3,
} from "three";
import type { ARAlignment, UpAxis, Viewpoint } from "../../src/index";

export interface DemoSceneOptions {
  up: UpAxis;
}

export interface DemoScene {
  /** Everything of the demo, lights included; pass it as the kit's `model`. */
  root: Group;
  /** Teleport targets: the ground slab, the mezzanine and the 18 steps. */
  floors: Object3D[];
  viewpoints: Viewpoint[];
  /** The two on-site marks, A and B, on the ground slab; drawn as crosses named `alignment-a/b`. */
  alignment: ARAlignment;
  bounds: Box3;
}

/** Plan dimensions in metres; exported so tests and the viewer share them. */
export const DEMO = {
  ground: { width: 24, depth: 16, thickness: 0.3 },
  wallHeight: 2.8,
  wallThickness: 0.15,
  doorHeight: 2.1,
  mezzanineTop: 3,
  steps: 18,
  eyeHeight: 1.6,
} as const;

/**
 * The scene is described in plan coordinates (east, north, height) and every position and size is
 * mapped to the requested up axis when the mesh is made, so a Z-up scene really has Z as height
 * rather than being a rotated Y-up group. North is -Z when Y is up and +Y when Z is up, which is
 * where yaw 0 looks in either convention.
 */
type Plan = [east: number, north: number, height: number];

function mapper(up: UpAxis) {
  const point = ([e, n, h]: Plan): Vector3 =>
    up === "z" ? new Vector3(e, n, h) : new Vector3(e, h, -n);
  const size = ([e, n, h]: Plan): [number, number, number] => (up === "z" ? [e, n, h] : [e, h, n]);
  return { point, size };
}

/** A hemisphere light from the up axis and a sun from the south-west. */
export function createLights(up: UpAxis): Group {
  const m = mapper(up);
  const group = new Group();
  group.name = "lights";
  const hemi = new HemisphereLight(0xf4f7ff, 0x8f887c, 1.8);
  hemi.position.copy(m.point([0, 0, 1]));
  const sun = new DirectionalLight(0xffffff, 1.6);
  sun.position.copy(m.point([-8, -12, 20]));
  group.add(hemi, sun);
  return group;
}

export function createDemoScene({ up }: DemoSceneOptions): DemoScene {
  const m = mapper(up);
  const root = new Group();
  root.name = "demo-scene";
  const floors: Object3D[] = [];

  const mat = (color: number, extra: Partial<MeshLambertMaterial> = {}): Material =>
    Object.assign(new MeshLambertMaterial({ color }), extra);
  const materials = {
    ground: mat(0xb8b3a9),
    wall: mat(0xefebe4),
    slab: mat(0xcbc5ba),
    step: mat(0xc2bcb1),
    column: mat(0xdcd8d0),
    glass: mat(0xbfd3dc, { transparent: true, opacity: 0.35, depthWrite: false }),
    marker: mat(0x4f7fb4),
    mark: mat(0xd9731f),
  };

  /** A box between two plan corners. */
  const box = (name: string, min: Plan, max: Plan, material: Material): Mesh => {
    const size: Plan = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    const mesh = new Mesh(new BoxGeometry(...m.size(size)), material);
    mesh.position.copy(
      m.point([(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]),
    );
    mesh.name = name;
    root.add(mesh);
    return mesh;
  };

  const { width, depth, thickness } = DEMO.ground;
  floors.push(
    box(
      "ground",
      [-width / 2, -depth / 2, -thickness],
      [width / 2, depth / 2, 0],
      materials.ground,
    ),
  );

  // Walls: a straight run with door openings, split into solid pieces and a lintel per door.
  const t = DEMO.wallThickness;
  const H = DEMO.wallHeight;
  type Door = { at: number; width: number };
  let wallCount = 0;
  const wall = (axis: "east" | "north", line: number, from: number, to: number, doors: Door[]) => {
    const piece = (a: number, b: number, h0: number, h1: number) => {
      if (b - a < 1e-6) return;
      const name = `wall-${++wallCount}`;
      if (axis === "east") box(name, [a, line - t / 2, h0], [b, line + t / 2, h1], materials.wall);
      else box(name, [line - t / 2, a, h0], [line + t / 2, b, h1], materials.wall);
    };
    let cursor = from;
    for (const d of [...doors].sort((p, q) => p.at - q.at)) {
      piece(cursor, d.at - d.width / 2, 0, H);
      piece(d.at - d.width / 2, d.at + d.width / 2, DEMO.doorHeight, H);
      cursor = d.at + d.width / 2;
    }
    piece(cursor, to, 0, H);
  };

  // Room 1 (south-west) and room 2 (north-west) share a wall with a door; each opens east onto
  // the hall. Runs along east span the corners; runs along north stop short of them, so no two
  // boxes overlap and no coplanar faces flicker.
  const [w, e, s, mid, n] = [-10, -4, -6, 0, 6];
  wall("east", s, w - t / 2, e + t / 2, []);
  wall("east", mid, w - t / 2, e + t / 2, [{ at: -7, width: 0.9 }]);
  wall("east", n, w - t / 2, e + t / 2, []);
  wall("north", w, s + t / 2, mid - t / 2, []);
  wall("north", w, mid + t / 2, n - t / 2, []);
  wall("north", e, s + t / 2, mid - t / 2, [{ at: -3, width: 1 }]);
  wall("north", e, mid + t / 2, n - t / 2, [{ at: 3, width: 1 }]);

  // Mezzanine over the north-east of the hall, on four columns.
  const top = DEMO.mezzanineTop;
  const slab = 0.25;
  const mz = { w: 3, e: 11, s: 1, n: 7 };
  floors.push(box("mezzanine", [mz.w, mz.s, top - slab], [mz.e, mz.n, top], materials.slab));
  const c = 0.15;
  const columns: [number, number, number][] = [
    [mz.w + 0.3, mz.s + 0.3, top - slab],
    [mz.e - 0.3, mz.s + 0.3, top - slab],
    [mz.w + 0.3, mz.n - 0.3, top - slab],
    [mz.e - 0.3, mz.n - 0.3, top - slab],
    [0, -3, top],
    [0, 3, top],
  ];
  columns.forEach(([ce, cn, ch], i) => {
    box(`column-${i + 1}`, [ce - c, cn - c, 0], [ce + c, cn + c, ch], materials.column);
  });

  // Stair: 18 steps running north, the last one flush with the mezzanine's south edge.
  const stair = { w: 5, e: 6.2, tread: 0.28 };
  const rise = top / DEMO.steps;
  for (let i = 0; i < DEMO.steps; i++) {
    const n1 = mz.s - (DEMO.steps - 1 - i) * stair.tread;
    const step = box(
      `step-${String(i + 1).padStart(2, "0")}`,
      [stair.w, n1 - stair.tread, i * rise],
      [stair.e, n1, (i + 1) * rise],
      materials.step,
    );
    floors.push(step);
  }

  // Glass guard on the open edges of the mezzanine, with a gap for the stair.
  const g = 0.03;
  box("guard-1", [mz.w, mz.s, top], [stair.w, mz.s + g, top + 1], materials.glass);
  box("guard-2", [stair.e, mz.s, top], [mz.e, mz.s + g, top + 1], materials.glass);
  box("guard-3", [mz.w, mz.s + g, top], [mz.w + g, mz.n, top + 1], materials.glass);

  const eye = DEMO.eyeHeight;
  const viewpoints: Viewpoint[] = [
    { id: "entrance", label: "Entrance", plan: [0, -7, eye] as Plan, yaw: 0 },
    { id: "room-1", label: "Room 1", plan: [-7, -4.5, eye] as Plan, yaw: 0 },
    { id: "room-2", label: "Room 2", plan: [-8.5, 3, eye] as Plan, yaw: -90 },
    { id: "mezzanine", label: "Mezzanine", plan: [8, 5.5, top + eye] as Plan, yaw: 135, fov: 75 },
  ].map(({ plan, ...rest }) => ({ ...rest, position: m.point(plan).toArray() }));

  // Floor markers under each viewpoint, lifted a little to stay clear of the floor surface.
  const disc = new CylinderGeometry(0.3, 0.3, 0.02, 32);
  if (up === "z") disc.rotateX(Math.PI / 2);
  for (const vp of viewpoints) {
    const marker = new Mesh(disc, materials.marker);
    marker.name = `marker-${vp.id}`;
    const p = new Vector3(...vp.position);
    const h = up === "z" ? p.z : p.y;
    const base = h - eye + 0.015;
    if (up === "z") p.z = base;
    else p.y = base;
    marker.position.copy(p);
    root.add(marker);
  }

  // On-site marks at the inner corners of the west wing, room 1's south-west and room 2's
  // north-east, about 12 m apart: the farther apart, the smaller the heading error on site.
  const inset = t / 2 + 0.4;
  const plan: Record<"a" | "b", Plan> = {
    a: [w + inset, s + inset, 0],
    b: [e - inset, n - inset, 0],
  };
  const alignment: ARAlignment = {
    id: "demo",
    a: m.point(plan.a).toArray(),
    b: m.point(plan.b).toArray(),
    labels: { a: "A, south-west corner", b: "B, north-east corner" },
  };
  // A flat cross centred on each mark, 0.6 m across and 1 cm thick, sitting on the slab. The
  // north-south bar is two halves, so the bars do not overlap.
  const arm = 0.3;
  const bar = 0.02;
  const lift = 0.01;
  for (const key of ["a", "b"] as const) {
    const [pe, pn] = plan[key];
    const name = `alignment-${key}`;
    box(`${name}-1`, [pe - arm, pn - bar, 0], [pe + arm, pn + bar, lift], materials.mark);
    box(`${name}-2`, [pe - bar, pn + bar, 0], [pe + bar, pn + arm, lift], materials.mark);
    box(`${name}-3`, [pe - bar, pn - arm, 0], [pe + bar, pn - bar, lift], materials.mark);
  }

  root.add(createLights(up));
  root.updateMatrixWorld(true);
  const bounds = new Box3().setFromObject(root);
  return { root, floors, viewpoints, alignment, bounds };
}
