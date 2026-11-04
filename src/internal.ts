import type { Group, Object3D, PerspectiveCamera, Scene, Vector3, WebGLRenderer } from "three";
import type { Emitter } from "./events";
import type {
  AROptions,
  KitEvents,
  PerformanceOptions,
  RaycastFn,
  RayKind,
  UpAxis,
  Viewpoint,
  VROptions,
  XRMode,
  XRSupport,
} from "./types";

/** Options with every default applied. Built once by `resolveOptions` in index.ts. */
export interface ResolvedOptions {
  model: Object3D;
  metresPerUnit: number;
  up: UpAxis;
  floors: "auto" | Object3D[];
  viewpoints: Viewpoint[];
  vr: Required<VROptions>;
  ar: Required<AROptions>;
  performance: Required<PerformanceOptions>;
  controllerModels: boolean;
  hands: boolean;
}

/** Events modules send each other; not part of the public API. */
export interface InternalEvents {
  selectstart: { ray: RaySource };
  selectend: { ray: RaySource };
}

export type AllEvents = KitEvents & InternalEvents;

/**
 * Shared state every module receives. Created once by `createXRKit`; `mode` and `session` change
 * with the session lifecycle.
 */
export interface KitContext {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
  options: ResolvedOptions;
  events: Emitter<AllEvents>;
  /**
   * Group the kit adds to `scene` at identity while a session runs and removes after it. Modules
   * put their visuals here (controllers, hands, the teleport arc, the AR reticle).
   */
  root: Group;
  /** Unit vector of the scene's up axis: (0,1,0) or (0,0,1). */
  up: Vector3;
  /** Raycast in scene coordinates: the host's `raycast` option, or the default one. */
  raycast: RaycastFn;
  /** Moves the user (T2). Always present; set before any module starts. */
  space: SpaceController;
  /** Rays from controllers, hands, transient pointers and screen taps (T3). */
  input: InputController;
  mode: XRMode | null;
  session: XRSession | null;
}

/**
 * Lifecycle every module implements. `start` runs after the session and its base reference space
 * exist and after `space.reset`; `update` runs from `kit.update(frame)` while presenting; `stop`
 * runs when the session ends; `dispose` frees everything.
 */
export interface KitModule {
  start(): void;
  update(frame: XRFrame, dt: number): void;
  stop(): void;
  dispose(): void;
}

/**
 * The only code that moves the user (T2). Works by replacing the renderer's XR reference space
 * with an offset of the session's base `local-floor` space: three.js then reports the head,
 * controllers and hit-test results directly in scene coordinates, with the scene's up axis up.
 */
export interface SpaceController extends KitModule {
  /** Called once per session with the base reference space, before any module starts. */
  reset(base: XRReferenceSpace): void;
  /**
   * Moves the user so the floor point below the head lands on `floorPoint` (scene coordinates),
   * facing `yawDeg` (spec convention, see `Viewpoint.yaw`). Without `yawDeg` the facing is kept.
   */
  placeUser(floorPoint: Vector3, yawDeg?: number): void;
  /** Turns the user by `deltaDeg` around the head (positive turns left). */
  snapTurn(deltaDeg: number): void;
  /** The head now: eye and the floor point below it in scene coordinates, and its yaw. */
  head(): { eye: Vector3; floorPoint: Vector3; yawDeg: number };
}

/** One ray per active input source, refreshed every frame, in scene coordinates (T3). */
export interface RaySource {
  id: string;
  kind: RayKind;
  handedness: "left" | "right" | "none";
  origin: Vector3;
  /** Unit length. */
  direction: Vector3;
  selecting: boolean;
  /** Thumbsticks and buttons, where the source has a gamepad. */
  gamepad?: Gamepad;
}

export interface InputController extends KitModule {
  rays(): readonly RaySource[];
}

/** Starts and ends sessions (T1). */
export interface SessionController {
  supports(): Promise<XRSupport>;
  enter(mode: XRMode): Promise<void>;
  exit(): Promise<void>;
  dispose(): void;
}

/** Hooks the session controller calls; wired by `createXRKit`. */
export interface SessionHooks {
  /** The session runs and `renderer.xr` has its base reference space. */
  onStart(session: XRSession, mode: XRMode, base: XRReferenceSpace): void;
  /** The session ended (by `exit()`, the browser, or the user). */
  onEnd(mode: XRMode): void;
}

/** Resolved viewpoint: the floor point to stand on, in scene coordinates (T5). */
export interface ResolvedViewpoint {
  id: string;
  label: string;
  floorPoint: Vector3;
  yaw: number;
}

export interface ViewpointsController extends KitModule {
  set(viewpoints: Viewpoint[]): void;
  list(): readonly ResolvedViewpoint[];
  /** Teleports to the viewpoint; throws on an unknown id. */
  goTo(id: string): void;
}

export interface ARController extends KitModule {
  setScale(scale: number): void;
}

/** Factory signature every module file exports. */
export type ModuleFactory<T extends KitModule = KitModule> = (ctx: KitContext) => T;

/** Re-exported for modules that need the camera type without importing three in full. */
export type { PerspectiveCamera };
