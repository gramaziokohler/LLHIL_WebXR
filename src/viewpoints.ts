import { Vector3 } from "three";
import type { KitContext, ResolvedViewpoint, ViewpointsController } from "./internal";
import type { UpAxis, Viewpoint, ViewpointsFile } from "./types";

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

/**
 * Validates a viewpoints file (an object, or its JSON text) and returns a clean copy with unknown
 * keys dropped. Throws one error listing every problem with its JSON path.
 */
export function parseViewpointsFile(json: unknown): ViewpointsFile {
  let input = json;
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch (error) {
      throw new Error(`${PREFIX} invalid JSON (${(error as Error).message})`);
    }
  }
  if (!isObject(input)) throw new Error(`${PREFIX} expected an object at the top level`);

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

  if (problems.length > 0) {
    const list = problems.length === 1 ? ` ${problems[0]}` : `\n  ${problems.join("\n  ")}`;
    throw new Error(`${PREFIX}${list}`);
  }
  return out;
}

/**
 * Viewpoints in VR. Floor points are resolved on `start()` (and on `set` while started), because
 * only then is the model scaled to metres and the floors in their session pose. Before `start()`
 * and after `stop()`, `list()` is empty.
 */
export function createViewpoints(ctx: KitContext): ViewpointsController {
  let raw: Viewpoint[] = [];
  let resolved: ResolvedViewpoint[] = [];
  let started = false;

  function resolveOne(vp: Viewpoint): ResolvedViewpoint {
    const up = ctx.up;
    const eye = new Vector3(...vp.position).multiplyScalar(ctx.options.metresPerUnit);
    const origin = eye.clone().addScaledVector(up, RAY_LIFT);
    const hit = ctx.raycast(origin, up.clone().negate(), RAY_FAR, "floors");
    // A steep first hit (a wall, a sloped roof) is not a floor; fall back rather than search on.
    const isFloor = hit && (hit.normal === null || hit.normal.dot(up) >= FLOOR_COS);
    const floorPoint = isFloor
      ? hit.point.clone()
      : eye.clone().addScaledVector(up, -ctx.options.vr.eyeHeight);
    return { id: vp.id, label: vp.label ?? vp.id, floorPoint, yaw: vp.yaw };
  }

  function resolveAll(): void {
    resolved = raw.map(resolveOne);
  }

  return {
    set(viewpoints: Viewpoint[]): void {
      raw = [...viewpoints];
      if (started) resolveAll();
    },
    list: () => resolved,
    goTo(id: string): void {
      if (ctx.mode !== "vr") return;
      const vp = resolved.find((v) => v.id === id);
      if (!vp) throw new Error(`${PREFIX} unknown viewpoint "${id}"`);
      ctx.space.placeUser(vp.floorPoint.clone(), vp.yaw);
      ctx.events.emit("viewpoint", { id });
    },
    start(): void {
      started = true;
      resolveAll();
    },
    update(_frame: XRFrame, _dt: number): void {},
    stop(): void {
      started = false;
      resolved = [];
    },
    dispose(): void {
      started = false;
      resolved = [];
      raw = [];
    },
  };
}
