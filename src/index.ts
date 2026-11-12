import { Group, type Object3D, Quaternion, Vector3 } from "three";
import { createAR } from "./ar";
import { createDiagnostics } from "./diagnostics";
import { Emitter } from "./events";
import { createInput } from "./input";
import { createLocomotion, defaultLocomotion, patchLocomotion } from "./locomotion";
import type {
  AllEvents,
  ARController,
  DiagnosticsController,
  KitContext,
  KitModule,
  MenuController,
  PanelsController,
  ResolvedOptions,
  SessionController,
  ViewpointsController,
} from "./internal";
import { upVector, yawFromDirection } from "./math";
import { createDefaultRaycast } from "./raycast";
import { createSessionController } from "./session";
import { createSpace } from "./space";
import { createHud } from "./hud";
import { createMenu } from "./menu";
import { createPanels } from "./panels";
import { DEFAULT_THEME, mergeTheme } from "./theme";
import { createTeleport } from "./teleport";
import type {
  EnterAROptions,
  EnterVROptions,
  KitEvents,
  LocomotionOptions,
  XRKit,
  XRKitOptions,
  XRMode,
  XRSupport,
} from "./types";
import { createViewpoints } from "./viewpoints";

export type * from "./types";
export { createXRButtons, type XRButtons, type XRButtonsOptions } from "./buttons";
export { parseViewpointsFile, parseViewpointsFileAR, type ViewpointsFileAR } from "./viewpoints";
export { directionFromYaw, forwardAtYawZero, yawFromDirection } from "./math";
export { DEFAULT_THEME } from "./theme";

/** Applies every default. Exported for tests. */
export function resolveOptions(options: XRKitOptions): ResolvedOptions {
  const snapDegrees = options.vr?.snapDegrees ?? 30;
  const locomotion = defaultLocomotion(snapDegrees);
  patchLocomotion(locomotion, options.vr?.locomotion);
  return {
    model: options.model ?? options.scene,
    metresPerUnit: options.metresPerUnit ?? 1,
    up: options.up ?? "y",
    floors: options.floors ?? "auto",
    viewpoints: options.viewpoints ?? [],
    vr: {
      turn: options.vr?.turn ?? "snap",
      snapDegrees,
      eyeHeight: options.vr?.eyeHeight ?? 1.6,
      teleport: options.vr?.teleport ?? true,
      locomotion,
    },
    ar: {
      scales: options.ar?.scales ?? [1, 1 / 50, 1 / 100, 1 / 200],
      defaultScale: options.ar?.defaultScale ?? 1 / 100,
      anchors: options.ar?.anchors ?? true,
      rotateSpeed: options.ar?.rotateSpeed ?? 60,
      moveSpeed: options.ar?.moveSpeed ?? 0.3,
    },
    performance: {
      framebufferScale: options.performance?.framebufferScale ?? 1,
      foveation: options.performance?.foveation ?? 1,
      targetFrameRate: options.performance?.targetFrameRate ?? 72,
    },
    controllerModels: options.controllerModels ?? true,
    hands: options.hands ?? true,
    floorsReady: options.floorsReady ?? null,
    diagnostics: {
      enabled: options.diagnostics?.enabled ?? false,
      extra: options.diagnostics?.extra ?? null,
    },
    ui: {
      icons: { ...options.ui?.icons },
      menu: {
        builtins: [
          ...(options.ui?.menu?.builtins ?? ["viewpoints", "locomotion", "diagnostics", "exit"]),
        ],
        hostItemsFirst: options.ui?.menu?.hostItemsFirst ?? false,
        title: options.ui?.menu?.title ?? null,
      },
    },
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
    theme: mergeTheme(DEFAULT_THEME, options.ui?.theme),
    uiCapture: false,
    mode: null,
    session: null,
  } as unknown as KitContext;

  ctx.space = createSpace(ctx);
  ctx.hud = createHud(ctx);
  ctx.input = createInput(ctx);
  const locomotion = createLocomotion(ctx);
  const teleport = createTeleport(ctx);
  const viewpoints: ViewpointsController = createViewpoints(ctx);
  const ar: ARController = createAR(ctx);
  const diagnostics: DiagnosticsController = createDiagnostics(ctx);
  viewpoints.set(resolved.viewpoints);
  // The menu acts on the kit itself, so it lights up the kit's locomotion and diagnostics.
  const menu: MenuController = createMenu(ctx, {
    viewpoints: () => viewpoints.list(),
    host: () => kit,
    // With side panels set, B and Y are theirs; the two share uiCapture.
    yieldButton: () => panels.hasPanels,
    otherCapture: () => panels.capturing,
  });
  const panels: PanelsController = createPanels(ctx, {
    otherCapture: () => menu.capturing,
    // On site, B and Y align again: no panels there.
    blocked: () => ar.alignmentState !== null,
  });

  const modulesFor = (mode: XRMode): KitModule[] =>
    mode === "vr"
      ? [ctx.space, ctx.input, locomotion, teleport, viewpoints, menu, panels, ctx.hud, diagnostics]
      : [ctx.space, ctx.input, ar, panels, ctx.hud, diagnostics];

  let active: KitModule[] = [];
  let pendingViewpoint: string | undefined;
  let savedModelScale: Vector3 | null = null;
  let lastTime = -1;
  /** VR places the user once the first head pose exists, so the start lands exactly. */
  let placePending = false;

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
      // Place now (so the first frame is close) and again on the first frame with a head pose.
      if (mode === "vr") {
        placeAtStart();
        placePending = true;
      }
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
      placePending = false;
      ctx.events.emit("sessionend", { mode });
    },
  });

  /** Starts at the pending viewpoint, else on the floor below the desktop camera, facing its way. */
  function placeAtStart(): void {
    if (pendingViewpoint) {
      try {
        viewpoints.goTo(pendingViewpoint);
        return;
      } catch (error) {
        console.warn(
          `[llhil-webxr] ${(error as Error).message}; starting below the camera instead`,
        );
        pendingViewpoint = undefined;
      }
    }
    const s = resolved.metresPerUnit;
    const eye = new Vector3();
    ctx.camera.getWorldPosition(eye).multiplyScalar(s);
    // A camera looks along its local -Z, whatever its up vector.
    const dir = new Vector3(0, 0, -1).applyQuaternion(
      ctx.camera.getWorldQuaternion(new Quaternion()),
    );
    // Whatever is below the camera, however far: a desktop view can be high above the model.
    viewpoints.placeBelow(eye, yawFromDirection(dir, resolved.up), { far: 1e5, anySurface: true });
  }

  const kit: XRKit = {
    supports(): Promise<XRSupport> {
      return session.supports();
    },
    async enter(mode: XRMode, opts?: EnterVROptions | EnterAROptions): Promise<void> {
      if (ctx.mode) throw new Error(`[llhil-webxr] already presenting (${ctx.mode})`);
      if (mode === "vr") pendingViewpoint = (opts as EnterVROptions | undefined)?.viewpoint;
      if (mode === "ar") {
        const arOpts = opts as EnterAROptions | undefined;
        ar.setAlignment(arOpts?.alignment ?? null);
        ar.setScale(arOpts?.alignment ? 1 : (arOpts?.scale ?? resolved.ar.defaultScale));
      }
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
    setRotation(degrees: number): void {
      ar.setRotation(degrees);
    },
    get rotation() {
      return ar.rotation;
    },
    realign(): void {
      if (ctx.mode === "ar") ar.realign();
    },
    nudge(n): void {
      if (ctx.mode === "ar") ar.nudge(n);
    },
    saveAlignment(): Promise<boolean> {
      return ctx.mode === "ar" ? ar.saveAlignment() : Promise.resolve(false);
    },
    forgetAlignment(id: string): Promise<void> {
      return ar.forgetAlignment(id);
    },
    get alignmentState() {
      return ctx.mode === "ar" ? ar.alignmentState : null;
    },
    setLocomotion(patch: Partial<LocomotionOptions>): void {
      if (patchLocomotion(resolved.vr.locomotion, patch)) {
        ctx.events.emit("locomotion", { mode: resolved.vr.locomotion.mode });
      }
    },
    get locomotion(): Readonly<LocomotionOptions> {
      return resolved.vr.locomotion;
    },
    update(frame?: XRFrame): void {
      if (!ctx.mode || !frame) return;
      const now = performance.now();
      const dt = lastTime < 0 ? 0 : (now - lastTime) / 1000;
      lastTime = now;
      const [first, ...rest] = active;
      first?.update(frame, dt);
      // The space module (first) has read the head; place the user exactly once it exists.
      if (placePending && ctx.mode === "vr") {
        const ref = ctx.renderer.xr.getReferenceSpace();
        if (ref && frame.getViewerPose(ref)) {
          placePending = false;
          placeAtStart();
        }
      }
      for (const m of rest) m.update(frame, dt);
    },
    get presenting() {
      return ctx.mode;
    },
    setDiagnostics(on: boolean): void {
      diagnostics.setEnabled(on);
    },
    get diagnostics() {
      return diagnostics.enabled;
    },
    get frameStats() {
      return diagnostics.stats;
    },
    openMenu(): void {
      if (ctx.mode !== "vr") return;
      panels.close();
      menu.open();
    },
    closeMenu(): void {
      menu.close();
    },
    get menuOpen() {
      return menu.isOpen;
    },
    setMenuItems(items) {
      menu.setItems(items);
    },
    setPanels(list) {
      panels.set(list);
    },
    updatePanelRow(panelId, rowId, patch) {
      panels.updateRow(panelId, rowId, patch);
    },
    openPanels(): void {
      if (!ctx.mode || !panels.hasPanels) return;
      menu.close();
      panels.open();
    },
    closePanels(): void {
      panels.close();
    },
    get panelsOpen() {
      return panels.isOpen;
    },
    setTheme(patch) {
      ctx.theme = mergeTheme(ctx.theme, patch);
      ctx.events.emit("theme", { theme: ctx.theme });
    },
    on<K extends keyof KitEvents>(event: K, listener: (payload: KitEvents[K]) => void) {
      return ctx.events.on(event, listener as (payload: AllEvents[K]) => void);
    },
    dispose(): void {
      // Ending the session first runs every module's stop() before its dispose().
      session.dispose();
      for (const m of [
        locomotion,
        teleport,
        viewpoints,
        menu,
        panels,
        ar,
        diagnostics,
        ctx.hud,
        ctx.input,
        ctx.space,
      ]) {
        m.dispose();
      }
      root.removeFromParent();
      ctx.events.clear();
    },
  };
  return kit;
}
