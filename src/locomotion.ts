// Thumbstick locomotion in VR, identical on both controllers so it works with one hand:
// stick = walk (or fly) relative to where the head looks, grip held + stick left/right = turn.
// Walking follows the floors and stops at walls; a head-locked vignette darkens the edges of the
// view while moving or smooth-turning. Moves the user only through ctx.space. Teleport (trigger)
// lives in src/teleport.ts, the menu button in src/input.ts.
import { BufferAttribute, BufferGeometry, Mesh, MeshBasicMaterial, Vector3 } from "three";
import type { KitContext, KitModule } from "./internal";
import { isValidFloor } from "./teleport";
import type { LocomotionMode, LocomotionOptions, RaycastHit } from "./types";

/** Default walking speed, m/s. */
export const WALK_SPEED = 1.4;
/** Radial dead zone of the stick (and of smooth turn on its x axis). */
export const DEAD_ZONE = 0.15;
/** Highest step walked up without stopping, m. */
export const STEP_UP = 0.35;
/** Gravity of a step down, m/s^2. */
export const GRAVITY = 9.81;
/** Most a step down may drop in one frame, m. */
export const MAX_DROP_PER_FRAME = 0.5;
/** Drops up to this are taken at once (ramps, float noise), m. */
export const SNAP_DOWN = 0.05;
/** How far below the feet a floor is still a floor, m; farther is the void. */
export const FLOOR_PROBE = 10;
/** Heights above the feet of the two wall rays, m. */
export const KNEE_HEIGHT = 0.4;
export const CHEST_HEIGHT = 1.2;
/** Distance kept from walls, m. */
export const WALL_MARGIN = 0.25;
/** Wall rays reach this far past the move, so the margin holds square to a wall hit up to 60 degrees off. */
const WALL_REACH = 2 * WALL_MARGIN;
/** Distance kept from a ceiling when flying up, m. */
export const HEAD_MARGIN = 0.15;
/** Snap turn: fires past PRESS, re-arms once the stick is back within RELEASE. */
export const TURN_PRESS = 0.6;
export const TURN_RELEASE = 0.3;
/** The grip counts as held from this value on. */
export const GRIP_HELD = 0.5;
/** Vignette fade in and out, s. */
export const VIGNETTE_FADE = 0.15;
/** Longest frame step integrated, s; a longer gap (a pause) is not one huge step. */
const MAX_DT = 0.1;

const LOCOMOTION_MODES: readonly LocomotionMode[] = ["walk", "fly", "teleport"];

/** Every default of `vr.locomotion`; `snapDegrees` falls back to `vr.snapDegrees`. */
export function defaultLocomotion(snapDegrees = 30): LocomotionOptions {
  return {
    mode: "walk",
    speed: WALK_SPEED,
    turn: "snap",
    snapDegrees,
    smoothDegreesPerSecond: 90,
    vignette: true,
  };
}

const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;

/**
 * Applies the valid fields of `patch` to `target` (in place); invalid ones are ignored with a
 * warning. Returns true when the mode changed.
 */
export function patchLocomotion(
  target: LocomotionOptions,
  patch: Partial<LocomotionOptions> | undefined,
): boolean {
  if (!patch) return false;
  const before = target.mode;
  const warn = (key: string, value: unknown) =>
    console.warn(`[llhil-webxr] ignoring locomotion.${key} = ${String(value)}`);
  if (patch.mode !== undefined) {
    if (LOCOMOTION_MODES.includes(patch.mode)) target.mode = patch.mode;
    else warn("mode", patch.mode);
  }
  if (patch.turn !== undefined) {
    if (patch.turn === "snap" || patch.turn === "smooth") target.turn = patch.turn;
    else warn("turn", patch.turn);
  }
  for (const key of ["speed", "snapDegrees", "smoothDegreesPerSecond"] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (positive(value)) target[key] = value;
    else warn(key, value);
  }
  if (patch.vignette !== undefined) target.vignette = patch.vignette !== false;
  return target.mode !== before;
}

/** Thumbstick left/right: axes[2] on xr-standard gamepads, axes[0] when only two exist. */
export function stickX(gamepad: Gamepad | undefined): number {
  if (!gamepad) return 0;
  const axes = gamepad.axes;
  return (axes.length >= 4 ? axes[2] : axes[0]) ?? 0;
}

/** Thumbstick forward/back (forward is negative): axes[3], or axes[1] when only two exist. */
export function stickY(gamepad: Gamepad | undefined): number {
  if (!gamepad) return 0;
  const axes = gamepad.axes;
  return (axes.length >= 4 ? axes[3] : axes[1]) ?? 0;
}

/** The grip (squeeze, xr-standard buttons[1]) is held. */
export function gripHeld(gamepad: Gamepad | undefined): boolean {
  const b = gamepad?.buttons?.[1];
  return !!b && (b.pressed || b.value >= GRIP_HELD);
}

/** One stick axis through the dead zone, rescaled to [-1, 1]. */
export function deadZone1D(v: number): number {
  const a = Math.abs(v);
  if (a <= DEAD_ZONE) return 0;
  return Math.sign(v) * Math.min(1, (a - DEAD_ZONE) / (1 - DEAD_ZONE));
}

const _fh = new Vector3();
const _right = new Vector3();
const _zero = new Vector3();

/**
 * The move direction for a stick vector (x right, y forward negative, as xr-standard reports
 * it), scaled 0..1 after a radial dead zone and capped at 1: forward/back along where the head
 * looks and strafe to its right. Walking stays horizontal; flying follows the head up and down.
 * `forward` is the head's view direction in scene coordinates. Writes and returns `out`.
 */
export function stickToMove(
  x: number,
  y: number,
  forward: Vector3,
  up: Vector3,
  fly: boolean,
  out: Vector3,
): Vector3 {
  const m = Math.hypot(x, y);
  out.set(0, 0, 0);
  if (!(m > DEAD_ZONE)) return out;
  const k = Math.min(1, (m - DEAD_ZONE) / (1 - DEAD_ZONE)) / m;
  const strafe = x * k;
  const ahead = -y * k;
  _fh.copy(forward).addScaledVector(up, -forward.dot(up));
  const lh = _fh.length();
  if (lh > 1e-6) {
    _fh.divideScalar(lh);
    _right.crossVectors(_fh, up);
    out.addScaledVector(_right, strafe);
    if (!fly) out.addScaledVector(_fh, ahead);
  }
  if (fly) {
    const lf = forward.length();
    if (lf > 1e-9) out.addScaledVector(forward, ahead / lf);
  }
  return out;
}

/** Unit-distance ring radii (tangents of the angle from the view axis) and their opacities. */
const VIGNETTE_RINGS: ReadonlyArray<[number, number]> = [
  [Math.tan((35 * Math.PI) / 180), 0],
  [Math.tan((65 * Math.PI) / 180), 1],
  [Math.tan((85 * Math.PI) / 180), 1],
];
const VIGNETTE_SEGMENTS = 32;
/** Nearest distance of the vignette from the eye, m. */
const VIGNETTE_DISTANCE = 0.3;

/** A flat ring at unit distance, facing +Z, black with an alpha gradient outwards. */
function vignetteGeometry(): BufferGeometry {
  const rings = VIGNETTE_RINGS.length;
  const columns = VIGNETTE_SEGMENTS + 1;
  const position = new Float32Array(rings * columns * 3);
  const color = new Float32Array(rings * columns * 4);
  for (let r = 0; r < rings; r++) {
    const [radius, alpha] = VIGNETTE_RINGS[r];
    for (let s = 0; s < columns; s++) {
      const a = (s / VIGNETTE_SEGMENTS) * Math.PI * 2;
      const i = r * columns + s;
      position[i * 3] = Math.cos(a) * radius;
      position[i * 3 + 1] = Math.sin(a) * radius;
      position[i * 3 + 2] = 0;
      color[i * 4 + 3] = alpha;
    }
  }
  const index: number[] = [];
  for (let r = 0; r < rings - 1; r++) {
    for (let s = 0; s < VIGNETTE_SEGMENTS; s++) {
      const a = r * columns + s;
      const b = a + columns;
      index.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(position, 3));
  geometry.setAttribute("color", new BufferAttribute(color, 4));
  geometry.setIndex(index);
  return geometry;
}

export interface LocomotionModule extends KitModule {
  /** The vignette mesh (for tests and diagnostics). */
  readonly vignette: Mesh;
}

export function createLocomotion(ctx: KitContext): LocomotionModule {
  const up = ctx.up;
  const down = up.clone().negate();
  const zAxis = new Vector3(0, 0, 1);

  const geometry = vignetteGeometry();
  const material = new MeshBasicMaterial({
    color: 0xffffff,
    vertexColors: true,
    transparent: true,
    opacity: 0,
    depthTest: false,
    depthWrite: false,
  });
  const vignette = new Mesh(geometry, material);
  vignette.name = "locomotion-vignette";
  vignette.frustumCulled = false;
  vignette.renderOrder = 1e6;
  vignette.visible = false;

  // Scratch, reused every frame.
  const eye = new Vector3();
  const forward = new Vector3();
  const feet = new Vector3();
  const move = new Vector3();
  const horizontal = new Vector3();
  const vertical = new Vector3();
  const dir = new Vector3();
  const normal = new Vector3();
  const origin = new Vector3();
  const total = new Vector3();
  const facing = new Vector3();

  let running = false;
  let fade = 0;
  let fallSpeed = 0;
  /** Above the floor and still falling (walk); also set to settle onto the floor after flying. */
  let airborne = false;
  let lastMode: LocomotionMode | null = null;
  /** After a UI capture the sticks must come back to centre before they move or turn again. */
  let needCentre = false;
  // Per input source: whether the stick has returned to centre since the last snap.
  const turnArmed = new Map<string, boolean>();

  /** Wall-ray result of the last `castPair`, copied out of the hit. */
  let wallDistance = 0;
  let wallHasNormal = false;

  const live = () => running && ctx.mode === "vr";

  /**
   * Casts the knee and chest rays from the feet along `direction` (unit), `far` long. Returns
   * true when either hits; the nearer hit's distance and normal are kept in wallDistance/normal.
   */
  function castPair(direction: Vector3, far: number): boolean {
    let blocked = false;
    for (let i = 0; i < 2; i++) {
      origin.copy(feet).addScaledVector(up, i === 0 ? KNEE_HEIGHT : CHEST_HEIGHT);
      const hit: RaycastHit | null = ctx.raycast(origin, direction, far, "all");
      if (!hit || (blocked && hit.distance >= wallDistance)) continue;
      blocked = true;
      wallDistance = hit.distance;
      wallHasNormal = hit.normal !== null;
      if (hit.normal) normal.copy(hit.normal);
    }
    return blocked;
  }

  /**
   * Clamps `h` (horizontal, in place, `len` long) so the feet stay WALL_MARGIN from the nearest
   * wall ahead, measured square to the wall: only the part of the move into the wall is cut, the
   * part along it is kept (sliding). Two rays. Returns "clear", "clamped" or "stop" (a hit
   * without a usable normal).
   */
  function clampToWall(h: Vector3, len: number): "clear" | "clamped" | "stop" {
    dir.copy(h).divideScalar(len);
    if (!castPair(dir, len + WALL_REACH)) return "clear";
    if (!wallHasNormal) return "stop";
    // The wall's normal on the ground, facing the walker.
    normal.addScaledVector(up, -normal.dot(up));
    const ln = normal.length();
    if (ln < 1e-6) return "stop";
    normal.divideScalar(ln);
    if (normal.dot(dir) > 0) normal.negate();
    const clearance = wallDistance * -normal.dot(dir);
    const into = -h.dot(normal);
    const allowed = Math.max(0, clearance - WALL_MARGIN);
    if (into <= allowed + 1e-9) return "clear";
    h.addScaledVector(normal, into - allowed);
    return "clamped";
  }

  /** Stops `h` (horizontal, in place) at walls, sliding along them when it can. At most 4 rays. */
  function blockHorizontal(h: Vector3): void {
    const len = h.length();
    if (len < 1e-9) return;
    const first = clampToWall(h, len);
    if (first === "clear") return;
    const rest = h.length();
    // A second wall in the way of the slide (a corner): stop.
    if (first === "stop" || (rest > 1e-9 && clampToWall(h, rest) !== "clear")) h.set(0, 0, 0);
  }

  /** Fly: stops `v` (vertical, in place) at a ceiling above the eye or a surface below the feet. */
  function blockVertical(v: Vector3): void {
    const amount = v.dot(up);
    if (Math.abs(amount) < 1e-9) return;
    let hit: RaycastHit | null;
    let allowed: number;
    if (amount > 0) {
      hit = ctx.raycast(eye, up, amount + HEAD_MARGIN, "all");
      allowed = hit ? Math.max(0, hit.distance - HEAD_MARGIN) : amount;
    } else {
      origin.copy(feet).addScaledVector(up, KNEE_HEIGHT);
      hit = ctx.raycast(origin, down, KNEE_HEIGHT - amount, "all");
      allowed = hit ? Math.max(0, hit.distance - KNEE_HEIGHT) : -amount;
    }
    v.copy(up).multiplyScalar(Math.sign(amount) * Math.min(Math.abs(amount), allowed));
  }

  /**
   * The floor below the feet moved by `h`: one ray down from knee height. Returns the height of
   * the floor relative to the feet, or null when there is none (the void, a slope too steep, or
   * a step higher than STEP_UP).
   */
  function floorRise(h: Vector3): number | null {
    origin.copy(feet).add(h).addScaledVector(up, KNEE_HEIGHT);
    const hit = ctx.raycast(origin, down, KNEE_HEIGHT + FLOOR_PROBE, "floors");
    if (!hit || !isValidFloor(hit, up)) return null;
    const rise = KNEE_HEIGHT - hit.distance;
    return rise > STEP_UP ? null : rise;
  }

  /**
   * Walk: the vertical move that keeps the feet on the floor at `feet + h`, written into `out`.
   * Steps up at once, steps down under gravity. Returns false to refuse the move (no floor there
   * while the user stands on one).
   */
  function followFloor(h: Vector3, dt: number, out: Vector3): boolean {
    out.set(0, 0, 0);
    const rise = floorRise(h);
    if (rise === null) {
      airborne = false;
      fallSpeed = 0;
      // Nothing underfoot here either (flown out over the void): move on without a floor.
      if (h.lengthSq() > 0 && floorRise(_zero) === null) return true;
      return h.lengthSq() === 0;
    }
    if (rise >= -SNAP_DOWN) {
      out.copy(up).multiplyScalar(rise);
      airborne = false;
      fallSpeed = 0;
      return true;
    }
    fallSpeed += GRAVITY * dt;
    const drop = Math.min(fallSpeed * dt, MAX_DROP_PER_FRAME, -rise);
    airborne = drop < -rise - 1e-9;
    if (!airborne) fallSpeed = 0;
    out.copy(up).multiplyScalar(-drop);
    return true;
  }

  function placeVignette(): void {
    const d = Math.max(VIGNETTE_DISTANCE, ctx.camera.near * 2);
    vignette.position.copy(eye).addScaledVector(forward, d);
    facing.copy(forward).negate();
    vignette.quaternion.setFromUnitVectors(zAxis, facing);
    vignette.scale.setScalar(d);
  }

  function reset(): void {
    fade = 0;
    fallSpeed = 0;
    airborne = false;
    needCentre = false;
    material.opacity = 0;
    vignette.visible = false;
    turnArmed.clear();
  }

  return {
    vignette,

    start(): void {
      running = ctx.mode === "vr";
      if (!running) return;
      reset();
      lastMode = ctx.options.vr.locomotion.mode;
      ctx.root.add(vignette);
    },

    update(_frame: XRFrame, rawDt: number): void {
      if (!live()) return;
      const dt = Math.min(Math.max(rawDt, 0), MAX_DT);
      const opts = ctx.options.vr.locomotion;
      const turnOn = ctx.options.vr.turn !== "none";
      if (opts.mode !== lastMode) {
        // Settle onto the floor after flying; nothing to carry over otherwise.
        airborne = opts.mode === "walk";
        fallSpeed = 0;
        lastMode = opts.mode;
      }

      let sx = 0;
      let sy = 0;
      let turnDeg = 0;
      let smoothTurning = false;
      const captured = ctx.uiCapture;
      if (captured) needCentre = true;
      const rays = ctx.input.rays();
      let centred = true;
      for (let i = 0; i < rays.length; i++) {
        const r = rays[i];
        // Hands (no gamepad) keep pinch-to-teleport only.
        if (r.kind !== "controller" || !r.gamepad) continue;
        const pad = r.gamepad;
        const x = stickX(pad);
        const ax = Math.abs(x);
        if (Math.hypot(x, stickY(pad)) > DEAD_ZONE) centred = false;
        if (ax < TURN_RELEASE && turnArmed.get(r.id) === false) turnArmed.set(r.id, true);
        // A UI (the VR menu) has the sticks: no snap until this stick has centred again.
        if (captured || needCentre) {
          turnArmed.set(r.id, false);
          continue;
        }
        if (gripHeld(pad)) {
          // Grip held: the stick turns and does not move.
          if (!turnOn) continue;
          if (opts.turn === "snap") {
            if (turnArmed.get(r.id) !== false && ax > TURN_PRESS) {
              turnDeg += x > 0 ? -opts.snapDegrees : opts.snapDegrees;
              turnArmed.set(r.id, false);
            }
          } else {
            const s = deadZone1D(x);
            if (s !== 0) {
              turnDeg -= s * opts.smoothDegreesPerSecond * dt;
              smoothTurning = true;
            }
          }
          continue;
        }
        sx += x;
        sy += stickY(pad);
      }
      if (needCentre && !captured && centred) needCentre = false;
      if (turnDeg !== 0) ctx.space.snapTurn(turnDeg);

      let moving = false;
      if (opts.mode !== "teleport" && !captured) {
        ctx.space.headInto(eye, forward, feet);
        const fly = opts.mode === "fly";
        stickToMove(sx, sy, forward, up, fly, move);
        const deflected = move.lengthSq() > 0;
        if (deflected || (airborne && !fly)) {
          move.multiplyScalar(opts.speed * dt);
          vertical.copy(up).multiplyScalar(move.dot(up));
          horizontal.copy(move).sub(vertical);
          if (deflected) blockHorizontal(horizontal);
          let ok = true;
          if (fly) blockVertical(vertical);
          else ok = followFloor(horizontal, dt, vertical);
          if (ok) {
            total.copy(horizontal).add(vertical);
            if (total.lengthSq() > 1e-14) {
              ctx.space.moveBy(total);
              moving = deflected && horizontal.lengthSq() + (fly ? vertical.lengthSq() : 0) > 0;
            }
          }
        }
      }

      // Vignette: fades in while moving or smooth-turning, out otherwise.
      const target = opts.vignette && (moving || smoothTurning) ? 1 : 0;
      const step = dt / VIGNETTE_FADE;
      fade = target > fade ? Math.min(1, fade + step) : Math.max(0, fade - step);
      material.opacity = fade;
      vignette.visible = fade > 0;
      if (vignette.visible) {
        // After the move, so the ring sits on this frame's head.
        ctx.space.headInto(eye, forward, feet);
        placeVignette();
      }
    },

    stop(): void {
      running = false;
      reset();
      vignette.removeFromParent();
    },

    dispose(): void {
      running = false;
      vignette.removeFromParent();
      geometry.dispose();
      material.dispose();
    },
  };
}
