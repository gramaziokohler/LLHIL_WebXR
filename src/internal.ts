import type {
  Group,
  Matrix4,
  Object3D,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from "three";
import type { Emitter } from "./events";
import type {
  AlignmentNudge,
  AlignmentState,
  ARAlignment,
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
  /** In-headset text panel (src/hud.ts). */
  hud: HudController;
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
  /** Set before the session starts: on-site alignment instead of table-top placement (null clears). */
  setAlignment(alignment: ARAlignment | null): void;
  realign(): void;
  nudge(nudge: AlignmentNudge): void;
  saveAlignment(): Promise<boolean>;
  forgetAlignment(id: string): Promise<void>;
  readonly alignmentState: AlignmentState | null;
}

/** Result of the two-point solve (src/align.ts). */
export interface TwoPointSolution {
  /**
   * Rigid world transform to apply to the model's resting world matrix: a turn about up and a
   * translation, no scale. It maps the model points onto the measured points.
   */
  matrix: Matrix4;
  /** Heading of the correction, degrees about up (positive turns left). */
  yawDeg: number;
  /** | distance(a, b) in the model - distance(a, b) on the ground |, metres. */
  errorM: number;
}

/**
 * Alignments saved on the device (src/persist.ts): WebXR persistent anchors at the two real points
 * (Quest Browser), their handles kept in localStorage under the alignment id.
 */
export interface AlignmentStore {
  /** The session can create and restore persistent anchors. */
  supported(session: XRSession): boolean;
  /** Replaces the saved anchors of `id` by these two (A, B); false when anything failed. */
  save(session: XRSession, id: string, a: XRAnchor, b: XRAnchor): Promise<boolean>;
  /** The two anchors saved for `id`, restored in this session, or null (none saved, or not found here). */
  restore(session: XRSession, id: string): Promise<{ a: XRAnchor; b: XRAnchor } | null>;
  /** Deletes the saved anchors of `id` (from the device and from storage). */
  forget(session: XRSession | null, id: string): Promise<void>;
}

/** A head-locked text panel in the headset (src/hud.ts): instructions and the accuracy readout. */
export interface HudController extends KitModule {
  /** Shows a title and up to three detail lines; replaces what was shown. */
  show(title: string, lines?: readonly string[]): void;
  hide(): void;
}

/** Factory signature every module file exports. */
export type ModuleFactory<T extends KitModule = KitModule> = (ctx: KitContext) => T;

/** Re-exported for modules that need the camera type without importing three in full. */
export type { PerspectiveCamera };
