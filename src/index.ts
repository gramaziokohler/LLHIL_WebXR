import { Group, type Object3D, Quaternion, Vector3 } from "three";
import { createAR } from "./ar";
import { Emitter } from "./events";
import { createInput } from "./input";
import type {
  AllEvents,
  ARController,
  KitContext,
  KitModule,
  ResolvedOptions,
  SessionController,
  ViewpointsController,
} from "./internal";
import { upVector, yawFromDirection } from "./math";
import { createDefaultRaycast } from "./raycast";
import { createSessionController } from "./session";
import { createSpace } from "./space";
import { createTeleport } from "./teleport";
import type {
  EnterAROptions,
  EnterVROptions,
  KitEvents,
  XRKit,
  XRKitOptions,
  XRMode,
  XRSupport,
} from "./types";
import { createViewpoints } from "./viewpoints";

export type * from "./types";
export { createXRButtons, type XRButtons, type XRButtonsOptions } from "./buttons";
export { parseViewpointsFile } from "./viewpoints";
export { directionFromYaw, forwardAtYawZero, yawFromDirection } from "./math";

/** Applies every default. Exported for tests. */
export function resolveOptions(options: XRKitOptions): ResolvedOptions {
  return {
    model: options.model ?? options.scene,
    metresPerUnit: options.metresPerUnit ?? 1,
    up: options.up ?? "y",
    floors: options.floors ?? "auto",
    viewpoints: options.viewpoints ?? [],
    vr: {
      turn: options.vr?.turn ?? "snap",
      snapDegrees: options.vr?.snapDegrees ?? 30,
      eyeHeight: options.vr?.eyeHeight ?? 1.6,
      teleport: options.vr?.teleport ?? true,
    },
    ar: {
      scales: options.ar?.scales ?? [1, 1 / 50, 1 / 100, 1 / 200],
      defaultScale: options.ar?.defaultScale ?? 1 / 100,
      anchors: options.ar?.anchors ?? true,
      rotateStepDegrees: options.ar?.rotateStepDegrees ?? 15,
    },
    performance: {
      framebufferScale: options.performance?.framebufferScale ?? 1,
      foveation: options.performance?.foveation ?? 1,
    },
    controllerModels: options.controllerModels ?? true,
    hands: options.hands ?? true,
  };
}

/**
 * Makes a three.js scene enterable in VR and AR. The host keeps its render loop and calls
 * `kit.update(frame)` once per frame; while `kit.presenting` is set it renders with plain
 * `renderer.render(scene, camera)`.
 */
export function createXRKit(options: XRKitOptions): XRKit {
  const resolved = resolveOptions(options);
  const root = new Group();
  root.name = "llhil-webxr";
  const floors = (): Object3D[] =>
    resolved.floors === "auto" ? [resolved.model] : resolved.floors;

  const ctx = {
    renderer: options.renderer,
    scene: options.scene,
    camera: options.camera,
    options: resolved,
    events: new Emitter<AllEvents>(),
    root,
    up: upVector(resolved.up),
    raycast: options.raycast ?? createDefaultRaycast(floors, () => resolved.model, root),
    mode: null,
    session: null,
  } as unknown as KitContext;

  ctx.space = createSpace(ctx);
  ctx.input = createInput(ctx);
  const teleport = createTeleport(ctx);
  const viewpoints: ViewpointsController = createViewpoints(ctx);
  const ar: ARController = createAR(ctx);
  viewpoints.set(resolved.viewpoints);

  const modulesFor = (mode: XRMode): KitModule[] =>
    mode === "vr" ? [ctx.space, ctx.input, teleport, viewpoints] : [ctx.space, ctx.input, ar];

  let active: KitModule[] = [];
  let pendingViewpoint: string | undefined;
  let savedModelScale: Vector3 | null = null;
  let lastTime = -1;

  const session: SessionController = createSessionController(ctx, {
    onStart(xrSession, mode, base) {
      ctx.session = xrSession;
      ctx.mode = mode;
      ctx.scene.add(root);
      if (mode === "vr" && resolved.metresPerUnit !== 1) {
        savedModelScale = resolved.model.scale.clone();
        resolved.model.scale.multiplyScalar(resolved.metresPerUnit);
        resolved.model.updateMatrixWorld(true);
      }
      ctx.space.reset(base);
      active = modulesFor(mode);
      for (const m of active) m.start();
      if (mode === "vr") placeAtStart();
      lastTime = -1;
      ctx.events.emit("sessionstart", { mode });
    },
    onEnd(mode) {
      for (const m of [...active].reverse()) m.stop();
      active = [];
      root.removeFromParent();
      if (savedModelScale) {
        resolved.model.scale.copy(savedModelScale);
        resolved.model.updateMatrixWorld(true);
        savedModelScale = null;
      }
      ctx.session = null;
      ctx.mode = null;
      pendingViewpoint = undefined;
      ctx.events.emit("sessionend", { mode });
    },
  });

  /** Starts at the pending viewpoint, else on the floor below the desktop camera, facing its way. */
  function placeAtStart(): void {
    if (pendingViewpoint) {
      viewpoints.goTo(pendingViewpoint);
      return;
    }
    const s = resolved.metresPerUnit;
    const eye = new Vector3();
    ctx.camera.getWorldPosition(eye).multiplyScalar(s);
    const down = ctx.up.clone().negate();
    const hit = ctx.raycast(eye, down, 1e5, "floors");
    const floor = hit ? hit.point : eye.clone().addScaledVector(ctx.up, -resolved.vr.eyeHeight);
    // A camera looks along its local -Z, whatever its up vector.
    const dir = new Vector3(0, 0, -1).applyQuaternion(
      ctx.camera.getWorldQuaternion(new Quaternion()),
    );
    ctx.space.placeUser(floor, yawFromDirection(dir, resolved.up));
  }

  const kit: XRKit = {
    supports(): Promise<XRSupport> {
      return session.supports();
    },
    async enter(mode: XRMode, opts?: EnterVROptions | EnterAROptions): Promise<void> {
      if (ctx.mode) throw new Error(`[llhil-webxr] already presenting (${ctx.mode})`);
      if (mode === "vr") pendingViewpoint = (opts as EnterVROptions | undefined)?.viewpoint;
      if (mode === "ar")
        ar.setScale((opts as EnterAROptions | undefined)?.scale ?? resolved.ar.defaultScale);
      await session.enter(mode);
    },
    exit(): Promise<void> {
      return session.exit();
    },
    goTo(id: string): void {
      if (ctx.mode !== "vr") return;
      viewpoints.goTo(id);
    },
    setViewpoints(list) {
      resolved.viewpoints = list;
      viewpoints.set(list);
    },
    setScale(scale: number): void {
      ar.setScale(scale);
    },
    update(frame?: XRFrame): void {
      if (!ctx.mode || !frame) return;
      const now = performance.now();
      const dt = lastTime < 0 ? 0 : (now - lastTime) / 1000;
      lastTime = now;
      for (const m of active) m.update(frame, dt);
    },
    get presenting() {
      return ctx.mode;
    },
    on<K extends keyof KitEvents>(event: K, listener: (payload: KitEvents[K]) => void) {
      return ctx.events.on(event, listener as (payload: AllEvents[K]) => void);
    },
    dispose(): void {
      if (ctx.mode) void session.exit();
      for (const m of [teleport, viewpoints, ar, ctx.input, ctx.space]) m.dispose();
      session.dispose();
      root.removeFromParent();
      ctx.events.clear();
    },
  };
  return kit;
}
