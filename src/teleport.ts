// Teleport (parabolic arc for controllers, straight ray for hands and transient pointers) and
// snap turn on the thumbstick. Moves the user only through ctx.space.
import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  RingGeometry,
  Vector3,
} from "three";
import type { KitContext, KitModule, RaySource } from "./internal";
import type { RaycastFn, RaycastHit } from "./types";

/** Launch speed of the arc, m/s. */
export const ARC_SPEED = 7;
/** Gravity of the arc, m/s^2, along -up. */
export const ARC_GRAVITY = 9.81;
/** Time between arc samples, s. */
export const ARC_STEP = 0.05;
/** Arc duration, s. */
export const ARC_DURATION = 2;
/** Arc samples including the start point. */
export const ARC_SAMPLES = Math.round(ARC_DURATION / ARC_STEP) + 1;
/** Reach of the straight ray for hands and transient pointers, m. */
export const STRAIGHT_FAR = 30;

const MARKER_RADIUS = 0.3;
const MAX_SLOPE_COS = Math.cos((30 * Math.PI) / 180);
const PRESS = 0.6;
const RELEASE = 0.3;

export interface ArcResult {
  /** Points written to `positions` (the last one is the hit point when there is a hit). */
  count: number;
  hit: RaycastHit | null;
}

const _a = new Vector3();
const _b = new Vector3();
const _seg = new Vector3();

/**
 * Samples the ballistic arc from `origin` along `direction` (unit) under gravity along -up,
 * raycasting each segment against the floors and stopping at the first hit. Writes the sampled
 * points into `positions` (at least ARC_SAMPLES * 3 long) and returns `out`.
 */
export function traceArc(
  origin: Vector3,
  direction: Vector3,
  up: Vector3,
  raycast: RaycastFn,
  positions: Float32Array,
  out: ArcResult,
): ArcResult {
  out.count = 1;
  out.hit = null;
  _a.copy(origin);
  positions[0] = _a.x;
  positions[1] = _a.y;
  positions[2] = _a.z;
  for (let i = 1; i < ARC_SAMPLES; i++) {
    const t = i * ARC_STEP;
    _b.copy(origin)
      .addScaledVector(direction, ARC_SPEED * t)
      .addScaledVector(up, -0.5 * ARC_GRAVITY * t * t);
    _seg.subVectors(_b, _a);
    const len = _seg.length();
    if (len > 1e-9) {
      _seg.divideScalar(len);
      const hit = raycast(_a, _seg, len, "floors");
      if (hit) {
        positions[i * 3] = hit.point.x;
        positions[i * 3 + 1] = hit.point.y;
        positions[i * 3 + 2] = hit.point.z;
        out.count = i + 1;
        out.hit = hit;
        return out;
      }
    }
    positions[i * 3] = _b.x;
    positions[i * 3 + 1] = _b.y;
    positions[i * 3 + 2] = _b.z;
    out.count = i + 1;
    _a.copy(_b);
  }
  return out;
}

/** A floor is valid when its normal is within 30 degrees of up; an unknown normal is accepted. */
export function isValidFloor(hit: RaycastHit, up: Vector3): boolean {
  return hit.normal === null || hit.normal.dot(up) >= MAX_SLOPE_COS;
}

/** Thumbstick forward/back: axes[3] on xr-standard gamepads, axes[1] when only two exist. */
function stickY(gamepad: Gamepad | undefined): number {
  if (!gamepad) return 0;
  const axes = gamepad.axes;
  return (axes.length >= 4 ? axes[3] : axes[1]) ?? 0;
}

/** Thumbstick left/right: axes[2], or axes[0] when only two exist. */
function stickX(gamepad: Gamepad | undefined): number {
  if (!gamepad) return 0;
  const axes = gamepad.axes;
  return (axes.length >= 4 ? axes[2] : axes[0]) ?? 0;
}

export function createTeleport(ctx: KitContext): KitModule {
  const positions = new Float32Array(ARC_SAMPLES * 3);
  const arc: ArcResult = { count: 0, hit: null };

  const lineGeometry = new BufferGeometry();
  lineGeometry.setAttribute("position", new BufferAttribute(positions, 3));
  lineGeometry.setDrawRange(0, 0);
  const lineMaterial = new LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8 });
  const line = new Line(lineGeometry, lineMaterial);
  line.name = "teleport-arc";
  // The arc moves every frame; its bounds would be stale anyway.
  line.frustumCulled = false;
  line.visible = false;

  const ringGeometry = new RingGeometry(MARKER_RADIUS * 0.75, MARKER_RADIUS, 32);
  const validMaterial = new MeshBasicMaterial({
    color: 0x33dd77,
    side: DoubleSide,
    transparent: true,
    opacity: 0.9,
  });
  const invalidMaterial = new MeshBasicMaterial({
    color: 0xee3344,
    side: DoubleSide,
    transparent: true,
    opacity: 0.9,
  });
  const marker = new Mesh(ringGeometry, validMaterial);
  marker.name = "teleport-marker";
  marker.visible = false;
  // The ring is built in the XY plane, facing +Z; turn it to face the scene's up.
  marker.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), ctx.up);

  let running = false;
  let unsubscribe: (() => void)[] = [];
  let aimRay: RaySource | null = null;
  let aimId: string | null = null;
  let aimBy: "select" | "stick" = "select";
  let hasTarget = false;
  let targetValid = false;
  const targetPoint = new Vector3();
  // Per input source: whether the stick has returned to centre since the last snap.
  const turnArmed = new Map<string, boolean>();

  const teleportOn = () => ctx.options.vr.teleport;
  const live = () => running && ctx.mode === "vr";

  function hideVisuals(): void {
    line.visible = false;
    marker.visible = false;
  }

  function beginAim(ray: RaySource, by: "select" | "stick"): void {
    aimRay = ray;
    aimId = ray.id;
    aimBy = by;
    hasTarget = false;
    targetValid = false;
  }

  function clearAim(): void {
    aimRay = null;
    aimId = null;
    hasTarget = false;
    targetValid = false;
    hideVisuals();
  }

  /** Recomputes the target from the ray's current pose and updates the visuals. */
  function aim(ray: RaySource): void {
    let hit: RaycastHit | null;
    if (ray.kind === "controller") {
      traceArc(ray.origin, ray.direction, ctx.up, ctx.raycast, positions, arc);
      hit = arc.hit;
    } else {
      hit = ctx.raycast(ray.origin, ray.direction, STRAIGHT_FAR, "floors");
      positions[0] = ray.origin.x;
      positions[1] = ray.origin.y;
      positions[2] = ray.origin.z;
      if (hit) _b.copy(hit.point);
      else _b.copy(ray.origin).addScaledVector(ray.direction, STRAIGHT_FAR);
      positions[3] = _b.x;
      positions[4] = _b.y;
      positions[5] = _b.z;
      arc.count = 2;
    }
    lineGeometry.setDrawRange(0, arc.count);
    (lineGeometry.getAttribute("position") as BufferAttribute).needsUpdate = true;
    line.visible = true;

    hasTarget = hit !== null;
    if (hit) {
      targetValid = isValidFloor(hit, ctx.up);
      targetPoint.copy(hit.point);
      marker.position.copy(hit.point).addScaledVector(ctx.up, 0.005);
      marker.material = targetValid ? validMaterial : invalidMaterial;
      marker.visible = true;
      lineMaterial.color.setHex(targetValid ? 0x33dd77 : 0xee3344);
    } else {
      targetValid = false;
      marker.visible = false;
      lineMaterial.color.setHex(0xffffff);
    }
  }

  function finishAim(ray: RaySource): void {
    // A select can start and end between two frames (a quick pinch): aim once now.
    if (!hasTarget) aim(ray);
    const go = hasTarget && targetValid;
    clearAim();
    if (!go) return;
    ctx.space.placeUser(targetPoint.clone());
    ctx.events.emit("teleport", { position: targetPoint.clone() });
  }

  function onSelectStart({ ray }: { ray: RaySource }): void {
    if (!live() || !teleportOn() || aimId !== null) return;
    beginAim(ray, "select");
  }

  function onSelectEnd({ ray }: { ray: RaySource }): void {
    if (!live() || aimId !== ray.id || aimBy !== "select") return;
    finishAim(ray);
  }

  function findRay(rays: readonly RaySource[], id: string): RaySource | null {
    for (const r of rays) if (r.id === id) return r;
    return null;
  }

  function updateTurn(ray: RaySource): void {
    if (!ray.gamepad || ctx.options.vr.turn === "none") return;
    const x = stickX(ray.gamepad);
    const armed = turnArmed.get(ray.id) ?? true;
    if (Math.abs(x) < RELEASE) {
      if (!armed) turnArmed.set(ray.id, true);
      return;
    }
    if (aimId === ray.id && aimBy === "stick") {
      // A diagonal push while aiming is not a turn; wait for the stick to centre.
      if (armed) turnArmed.set(ray.id, false);
      return;
    }
    if (armed && Math.abs(x) > PRESS) {
      const deg = ctx.options.vr.snapDegrees;
      ctx.space.snapTurn(x > 0 ? -deg : deg);
      turnArmed.set(ray.id, false);
    }
  }

  return {
    start(): void {
      running = ctx.mode === "vr";
      if (!running) return;
      clearAim();
      turnArmed.clear();
      ctx.root.add(line, marker);
      unsubscribe = [
        ctx.events.on("selectstart", onSelectStart),
        ctx.events.on("selectend", onSelectEnd),
      ];
    },

    update(_frame: XRFrame, _dt: number): void {
      if (!live()) return;
      const rays = ctx.input.rays();

      if (aimId !== null) {
        const current = findRay(rays, aimId);
        if (aimBy === "stick") {
          if (!current) clearAim();
          else if (stickY(current.gamepad) > -RELEASE) finishAim(current);
          else aim(current);
        } else {
          // Between selectstart and selectend; the source keeps its last pose if it is not listed.
          const ray = current ?? aimRay;
          if (ray) aim(ray);
        }
      } else if (teleportOn()) {
        for (const r of rays) {
          if (r.kind === "controller" && stickY(r.gamepad) < -PRESS) {
            beginAim(r, "stick");
            aim(r);
            break;
          }
        }
      }

      for (const r of rays) updateTurn(r);
    },

    stop(): void {
      for (const off of unsubscribe) off();
      unsubscribe = [];
      running = false;
      clearAim();
      turnArmed.clear();
    },

    dispose(): void {
      for (const off of unsubscribe) off();
      unsubscribe = [];
      running = false;
      line.removeFromParent();
      marker.removeFromParent();
      lineGeometry.dispose();
      lineMaterial.dispose();
      ringGeometry.dispose();
      validMaterial.dispose();
      invalidMaterial.dispose();
    },
  };
}
