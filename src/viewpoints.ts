import { Vector3 } from "three";
import type { FloorSearch, KitContext, ResolvedViewpoint, ViewpointsController } from "./internal";
import type { ARAlignment, UpAxis, Viewpoint, ViewpointsFile } from "./types";

const PREFIX = "[llhil-webxr] viewpoints:";
/** A floor is at most 30 degrees off horizontal, as for teleport. */
const FLOOR_COS = Math.cos((30 * Math.PI) / 180);
/** Start the ray a little above the eye so a floor exactly at eye level is still found. */
const RAY_LIFT = 0.05;
/** Metres searched below a viewpoint. */
const RAY_FAR = 100;

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** The top level of a viewpoints file (an object, or its JSON text), or a thrown error. */
function topLevel(json: unknown): Json {
  let input = json;
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch (error) {
      throw new Error(`${PREFIX} invalid JSON (${(error as Error).message})`);
    }
  }
  if (!isObject(input)) throw new Error(`${PREFIX} expected an object at the top level`);
  return input;
}

function fail(problems: string[]): never {
  const list = problems.length === 1 ? ` ${problems[0]}` : `\n  ${problems.join("\n  ")}`;
  throw new Error(`${PREFIX}${list}`);
}

const isPoint = (v: unknown): v is [number, number, number] =>
  Array.isArray(v) && v.length === 3 && v.every(isFiniteNumber);

/**
 * Validates a viewpoints file (an object, or its JSON text) and returns a clean copy with unknown
 * keys dropped. Throws one error listing every problem with its JSON path.
 */
export function parseViewpointsFile(json: unknown): ViewpointsFile {
  const input = topLevel(json);

  const problems: string[] = [];
  const out: ViewpointsFile = { version: 1, viewpoints: [] };

  if (input.version !== 1) problems.push("version: expected 1");

  if (input.model !== undefined) {
    if (typeof input.model === "string") out.model = input.model;
    else problems.push("model: expected a string");
  }
  if (input.metresPerUnit !== undefined) {
    if (isFiniteNumber(input.metresPerUnit) && input.metresPerUnit > 0) {
      out.metresPerUnit = input.metresPerUnit;
    } else {
      problems.push("metresPerUnit: expected a finite number > 0");
    }
  }
  if (input.up !== undefined) {
    if (input.up === "y" || input.up === "z") out.up = input.up as UpAxis;
    else problems.push('up: expected "y" or "z"');
  }

  if (!Array.isArray(input.viewpoints)) {
    problems.push("viewpoints: expected an array");
  } else {
    const firstIndex = new Map<string, number>();
    input.viewpoints.forEach((raw: unknown, i: number) => {
      const path = `viewpoints[${i}]`;
      if (!isObject(raw)) {
        problems.push(`${path}: expected an object`);
        return;
      }
      const before = problems.length;
      const { id, label, position, yaw, fov } = raw;
      if (typeof id !== "string" || id.length === 0) {
        problems.push(`${path}.id: expected a non-empty string`);
      } else if (firstIndex.has(id)) {
        problems.push(
          `${path}.id: duplicate id "${id}" (first at viewpoints[${firstIndex.get(id)}])`,
        );
      } else {
        firstIndex.set(id, i);
      }
      if (!Array.isArray(position) || position.length !== 3 || !position.every(isFiniteNumber)) {
        problems.push(`${path}.position: expected 3 finite numbers`);
      }
      if (!isFiniteNumber(yaw)) problems.push(`${path}.yaw: expected a finite number`);
      if (label !== undefined && typeof label !== "string") {
        problems.push(`${path}.label: expected a string`);
      }
      if (fov !== undefined && !(isFiniteNumber(fov) && fov > 0 && fov < 180)) {
        problems.push(`${path}.fov: expected a number between 0 and 180 (exclusive)`);
      }
      if (problems.length > before) return;
      const p = position as number[];
      const vp: Viewpoint = {
        id: id as string,
        position: [p[0], p[1], p[2]],
        yaw: yaw as number,
      };
      if (label !== undefined) vp.label = label as string;
      if (fov !== undefined) vp.fov = fov as number;
      out.viewpoints.push(vp);
    });
  }

  if (problems.length > 0) fail(problems);
  return out;
}

/** The `ar` section of a viewpoints file: how the model is shown on site at 1:1. */
export interface ViewpointsFileAR {
  /** The two reference points, in the file's scene coordinates and units. */
  alignment?: ARAlignment;
  /** Names of objects (`object.name`, anywhere under the model) to hide on site, e.g. the terrain. */
  hide?: string[];
}

/**
 * Validates the `ar` section of a viewpoints file (an object, or its JSON text) and returns a clean
 * copy, or null when the file has none. Throws like `parseViewpointsFile`, with paths under `ar`.
 */
export function parseViewpointsFileAR(json: unknown): ViewpointsFileAR | null {
  const input = topLevel(json);
  if (input.ar === undefined) return null;
  const ar = input.ar;
  if (!isObject(ar)) fail(["ar: expected an object"]);

  const problems: string[] = [];
  const out: ViewpointsFileAR = {};

  if (ar.alignment !== undefined) {
    const raw = ar.alignment;
    const path = "ar.alignment";
    if (!isObject(raw)) {
      problems.push(`${path}: expected an object`);
    } else {
      const before = problems.length;
      const { id, a, b, labels } = raw;
      if (typeof id !== "string" || id.length === 0) {
        problems.push(`${path}.id: expected a non-empty string`);
      }
      if (!isPoint(a)) problems.push(`${path}.a: expected 3 finite numbers`);
      if (!isPoint(b)) problems.push(`${path}.b: expected 3 finite numbers`);
      // Two coincident points give no heading.
      else if (isPoint(a) && a.every((v, i) => v === b[i])) {
        problems.push(`${path}.b: expected a point apart from a`);
      }
      let cleanLabels: ARAlignment["labels"];
      if (labels !== undefined) {
        if (!isObject(labels)) {
          problems.push(`${path}.labels: expected an object`);
        } else {
          cleanLabels = {};
          for (const key of ["a", "b"] as const) {
            const label = labels[key];
            if (label === undefined) continue;
            if (typeof label === "string") cleanLabels[key] = label;
            else problems.push(`${path}.labels.${key}: expected a string`);
          }
        }
      }
      if (problems.length === before) {
        const pa = a as number[];
        const pb = b as number[];
        const alignment: ARAlignment = {
          id: id as string,
          a: [pa[0], pa[1], pa[2]],
          b: [pb[0], pb[1], pb[2]],
        };
        if (cleanLabels) alignment.labels = cleanLabels;
        out.alignment = alignment;
      }
    }
  }

  if (ar.hide !== undefined) {
    if (!Array.isArray(ar.hide)) {
      problems.push("ar.hide: expected an array of object names");
    } else {
      const before = problems.length;
      ar.hide.forEach((name: unknown, i: number) => {
        if (typeof name !== "string" || name.length === 0) {
          problems.push(`ar.hide[${i}]: expected a non-empty string`);
        }
      });
      if (problems.length === before) out.hide = [...(ar.hide as string[])];
    }
  }

  if (problems.length > 0) fail(problems);
  return out;
}

/** How long a missed floor is looked for again while the host's floors are not ready, seconds. */
export const FLOOR_RETRY_SECONDS = 10;

/**
 * Viewpoints in VR. A viewpoint's floor is found when it is used (`goTo`, the start placement),
 * not when it is set: only then is the model scaled to metres and, in hosts that build their
 * collision model late, are the floors there at all. Before `start()` and after `stop()`,
 * `list()` is empty.
 */
export function createViewpoints(ctx: KitContext): ViewpointsController {
  let raw: Viewpoint[] = [];
  let started = false;

  /** A user placed at the fallback height while the host's floors were not ready. */
  let pending: {
    eye: Vector3;
    far: number;
    anySurface: boolean;
    generation: number;
    elapsed: number;
  } | null = null;

  const down = new Vector3();
  const origin = new Vector3();

  /** The floor point below `eye` (scene coordinates, metres), or null. */
  function findFloor(eye: Vector3, far: number, anySurface: boolean): Vector3 | null {
    const up = ctx.up;
    origin.copy(eye).addScaledVector(up, RAY_LIFT);
    down.copy(up).negate();
    const hit = ctx.raycast(origin, down, far, "floors");
    if (!hit) return null;
    // A steep first hit (a wall, a sloped roof) is not a floor; fall back rather than search on.
    if (!anySurface && hit.normal !== null && hit.normal.dot(up) < FLOOR_COS) return null;
    return hit.point.clone();
  }

  const eyeOf = (vp: Viewpoint) =>
    new Vector3(...vp.position).multiplyScalar(ctx.options.metresPerUnit);
  const fallback = (eye: Vector3) => eye.clone().addScaledVector(ctx.up, -ctx.options.vr.eyeHeight);

  function resolveOne(vp: Viewpoint): ResolvedViewpoint {
    const eye = eyeOf(vp);
    const floorPoint = findFloor(eye, RAY_FAR, false) ?? fallback(eye);
    return { id: vp.id, label: vp.label ?? vp.id, floorPoint, yaw: vp.yaw };
  }

  function placeBelow(eye: Vector3, yawDeg: number, options: FloorSearch = {}): void {
    const far = options.far ?? RAY_FAR;
    const anySurface = options.anySurface ?? false;
    const floor = findFloor(eye, far, anySurface);
    ctx.space.placeUser(floor ?? fallback(eye), yawDeg);
    const ready = ctx.options.floorsReady;
    pending =
      !floor && ready && !ready()
        ? { eye: eye.clone(), far, anySurface, generation: ctx.space.generation, elapsed: 0 }
        : null;
  }

  /** Looks for the floor of a fallback placement again; moves the user up or down onto it. */
  function retry(dt: number): void {
    const p = pending;
    if (!p) return;
    // Moved on since (teleport, another viewpoint): the old floor no longer matters.
    if (ctx.space.generation !== p.generation) {
      pending = null;
      return;
    }
    const floor = findFloor(p.eye, p.far, p.anySurface);
    if (floor) {
      pending = null;
      // Only the height changes: steps taken in the room and turns made meanwhile are kept.
      const at = ctx.space.head().floorPoint;
      at.addScaledVector(ctx.up, floor.sub(at).dot(ctx.up));
      ctx.space.placeUser(at);
      ctx.events.emit("teleport", { position: at.clone() });
      return;
    }
    p.elapsed += dt;
    const ready = ctx.options.floorsReady;
    // Ready and still nothing below: there is no floor there.
    if (!ready || ready() || p.elapsed >= FLOOR_RETRY_SECONDS) pending = null;
  }

  return {
    set(viewpoints: Viewpoint[]): void {
      raw = [...viewpoints];
    },
    /** Finds each floor now (one raycast per viewpoint); not meant for every frame. */
    list: () => (started ? raw.map(resolveOne) : []),
    goTo(id: string): void {
      if (ctx.mode !== "vr") return;
      const vp = raw.find((v) => v.id === id);
      if (!vp) throw new Error(`${PREFIX} unknown viewpoint "${id}"`);
      placeBelow(eyeOf(vp), vp.yaw);
      ctx.events.emit("viewpoint", { id });
    },
    placeBelow(eye: Vector3, yawDeg: number, options?: FloorSearch): void {
      if (ctx.mode !== "vr") return;
      placeBelow(eye, yawDeg, options);
    },
    start(): void {
      started = true;
      pending = null;
    },
    update(_frame: XRFrame, dt: number): void {
      retry(dt);
    },
    stop(): void {
      started = false;
      pending = null;
    },
    dispose(): void {
      started = false;
      pending = null;
      raw = [];
    },
  };
}
