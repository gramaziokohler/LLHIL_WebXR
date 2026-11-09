import type { Matrix4, Object3D, PerspectiveCamera, Scene, Vector3, WebGLRenderer } from "three";
import type { UiTheme } from "./theme";

export type { UiTheme };

/** The two immersive modes the kit offers. */
export type XRMode = "vr" | "ar";

/**
 * Which scene axis points up. `"y"` is the glTF and three.js default; `"z"` is the convention of
 * COMPAS, Rhino and most CAD exports. WebXR itself is always Y up: for a Z-up scene the kit turns
 * the reference space, never the scene.
 */
export type UpAxis = "y" | "z";

/** The kind of input a ray comes from. */
export type RayKind = "controller" | "hand" | "transient" | "screen";

/**
 * A place to stand in VR.
 *
 * `position` is the eye in the scene's own coordinates and units. The kit keeps the horizontal
 * part, drops to the floor below it, and lets the headset supply the eye height.
 *
 * `yaw` is in degrees about the scene's up axis, counter-clockwise seen from above. Yaw 0 looks
 * along -Z in a Y-up scene and along +Y in a Z-up scene.
 */
export interface Viewpoint {
  id: string;
  label?: string;
  position: [number, number, number];
  yaw: number;
  /** Horizontal field of view in degrees; used by desktop viewers only. */
  fov?: number;
}

/** The viewpoints file format, version 1. */
export interface ViewpointsFile {
  version: 1;
  /** Relative or absolute URL of the model the viewpoints belong to. */
  model?: string;
  metresPerUnit?: number;
  up?: UpAxis;
  viewpoints: Viewpoint[];
}

/**
 * How the thumbsticks move the user in VR. Both controllers are identical, so everything works
 * with one hand: the stick walks (or flies), grip held plus stick left/right turns, the trigger
 * teleports.
 *
 * - `"walk"`: the stick moves the user horizontally, relative to where the head looks, kept on the
 *   floors (steps up to 0.35 m, falls smoothly down, never into the void) and stopped by walls.
 * - `"fly"`: the stick moves along the full head direction, up and down included; walls still stop.
 * - `"teleport"`: the stick does nothing but turning with the grip held.
 */
export type LocomotionMode = "walk" | "fly" | "teleport";

export interface LocomotionOptions {
  /** Default `"walk"`. */
  mode: LocomotionMode;
  /** Walking (and flying) speed at full stick, m/s. Default 1.4. */
  speed: number;
  /** Grip held plus stick left/right: snap turn in steps, or smooth turn. Default `"snap"`. */
  turn: "snap" | "smooth";
  /** Degrees per snap turn. Default `vr.snapDegrees` (30). */
  snapDegrees: number;
  /** Smooth turn rate at full stick, degrees per second. Default 90. */
  smoothDegreesPerSecond: number;
  /** Darken the edges of the view while moving or smooth-turning, for comfort. Default true. */
  vignette: boolean;
}

export interface VROptions {
  /** Turning (grip held plus stick left/right), or no turning. Default `"snap"`. */
  turn?: "snap" | "none";
  /** Degrees per snap. Default 30. */
  snapDegrees?: number;
  /** Eye height in metres, used when no floor is found below a viewpoint. Default 1.6. */
  eyeHeight?: number;
  /** Teleport on the floors with the trigger (pinch with hands). Default true. */
  teleport?: boolean;
  /** Thumbstick locomotion; see `LocomotionOptions` for the defaults. */
  locomotion?: Partial<LocomotionOptions>;
}

export interface AROptions {
  /** Scales the user can switch between, as model scale factors (1 = 1:1). Default [1, 1/50, 1/100, 1/200]. */
  scales?: number[];
  /** Scale used when the model is first placed. Default 1/100. */
  defaultScale?: number;
  /** Use WebXR anchors where the browser offers them. Default true. */
  anchors?: boolean;
  /** Degrees per turn step of the placed model. Default 15. */
  rotateStepDegrees?: number;
}

/**
 * 1:1 on site: two reference points of the model, in scene coordinates and units, that are marked
 * on the ground at the real place (survey points, building corners, column feet). The user
 * points at each mark and pulls the trigger; the kit then places the model at 1:1 so both points
 * coincide (heading and position from the two points, height from the ground hits).
 */
export interface ARAlignment {
  /** Stable id, e.g. the POI that holds the points. A saved alignment is kept per id on the device. */
  id: string;
  a: [number, number, number];
  b: [number, number, number];
  /** What the marks are called on site, shown in the headset ("north-west corner"). */
  labels?: { a?: string; b?: string };
}

/**
 * Where the on-site alignment stands. `restoring`: looking for an alignment saved on this device;
 * `pick-a` / `pick-b`: waiting for the user to point at a mark; `aligned`: placed, not yet saved;
 * `saved`: placed and saved on this device; `lost`: a saved alignment could not be found here.
 */
export type AlignmentState = "restoring" | "pick-a" | "pick-b" | "aligned" | "saved" | "lost";

/** A small correction of the alignment, by eye: a turn about up through point A, a move on the ground. */
export interface AlignmentNudge {
  /** Degrees, positive turns left (counter-clockwise seen from above). */
  turnDeg?: number;
  /** Metres on the ground, in the user's frame: [right, forward]. */
  move?: [number, number];
}

export interface PerformanceOptions {
  /** WebXR framebuffer scale factor. Default 1. */
  framebufferScale?: number;
  /** Fixed foveation, 0 (off) to 1 (maximum). Default 1. */
  foveation?: number;
  /**
   * Display refresh rate to ask for, Hz. Applied after the session starts where the browser
   * offers it (`supportedFrameRates`), else the nearest lower rate it offers. Default 72.
   */
  targetFrameRate?: number;
}

export interface DiagnosticsOptions {
  /** Show the diagnostics panel from the start. Default false. */
  enabled?: boolean;
  /** Extra lines for the panel, label to value. Called at most 4 times a second while it shows. */
  extra?: () => Record<string, string | number>;
}

/** Frame timing over the last second. */
export interface FrameStats {
  fps: number;
  /** Mean frame interval, milliseconds. */
  frameMs: number;
  /** Frames whose interval was over 1.5 times the target frame interval. */
  missed: number;
}

/** A ray hit against the scene. */
export interface RaycastHit {
  point: Vector3;
  /** World-space face normal, unit length, or null when unknown. */
  normal: Vector3 | null;
  object: Object3D;
  distance: number;
}

/**
 * Casts a ray in scene (world) coordinates. Hosts with an acceleration structure (a BVH) pass
 * their own; the default uses a three.js `Raycaster` against `floors` or `model`.
 */
export type RaycastFn = (
  origin: Vector3,
  direction: Vector3,
  far: number,
  targets: "floors" | "all",
) => RaycastHit | null;

/**
 * A host entry in the VR menu. `action` (the default) emits `menu-select` with its id; `toggle`
 * flips `value`, redraws and emits `menu-select` with the new value; `section` is a header row
 * that groups the entries below it and cannot be selected.
 */
export interface MenuItem {
  id: string;
  label: string;
  kind?: "action" | "toggle" | "section";
  value?: boolean;
  /** Drawn at the start of the row, `rowHeight - 2 * padding` square, untinted. */
  icon?: CanvasImageSource;
}

/** Which side of the view a VR side panel stands on. */
export type PanelSide = "left" | "right";

/** One segment of a `choice` row. */
export interface PanelOption {
  value: string;
  label: string;
}

/**
 * A row of a VR side panel.
 *
 * - `section`: a collapsible header; the rows whose `section` is its id follow it, shown only
 *   while it is open. One section is open per side; the open one has `value: true`. Tapping it
 *   emits `panel-input` with the new open state.
 * - `action`: the trigger emits `panel-input` with its id.
 * - `toggle`: an on/off switch; the trigger flips `value` (boolean) and emits the new value.
 * - `choice`: segmented pills from `options`; the trigger on a pill sets `value` to its value
 *   and emits it.
 * - `slider`: a track from `min` (default 0) to `max` (default 1), snapped to `step` (default a
 *   hundredth of the range). Hold the trigger on it and move the ray to drag; stick left/right
 *   while it is hovered steps it. `format` writes the value shown (default `String`).
 * - `text`: a paragraph, wrapped, at most six lines; never interactive.
 */
export interface PanelRow {
  id: string;
  kind: "section" | "action" | "toggle" | "choice" | "slider" | "text";
  label: string;
  /** toggle: boolean; choice: an option's value; slider: number; section: open. */
  value?: boolean | number | string;
  options?: PanelOption[];
  min?: number;
  max?: number;
  step?: number;
  format?: (v: number) => string;
  /** Section headers and actions: drawn at the start of the row, `rowHeight - 2 * padding` square. */
  icon?: CanvasImageSource;
  /** Id of the section row this row belongs to. */
  section?: string;
  /** Drawn faded, never interactive. */
  disabled?: boolean;
}

/** A VR side panel: a column of rows on one side of the view. One panel per side is shown. */
export interface PanelSpec {
  id: string;
  side: PanelSide;
  rows: PanelRow[];
}

/** Built-in sections of the VR menu. */
export type MenuBuiltin = "viewpoints" | "locomotion" | "diagnostics" | "exit";

/** Built-in menu rows a host can give an icon. */
export type MenuIconSlot = "viewpoint" | "walk" | "fly" | "diagnostics" | "exit";

export interface MenuOptions {
  /**
   * Built-in sections, in this order; leave one out to hide it. Default
   * `["viewpoints", "locomotion", "diagnostics", "exit"]`. Locomotion and diagnostics show only
   * where the kit offers them.
   */
  builtins?: MenuBuiltin[];
  /**
   * Host items (`setMenuItems`) before the built-in sections. Default false: after them, but
   * before "exit" when "exit" is last.
   */
  hostItemsFirst?: boolean;
  /** A title row above the list. Default none. */
  title?: string;
}

/** Styling and structure of the in-headset panels, so they can match the host's own UI. */
export interface UiOptions {
  /** Overrides of the kit's neutral look; see `kit.setTheme` to change it later. */
  theme?: Partial<UiTheme>;
  /** Icons for the built-in menu rows. No icons by default. */
  icons?: Partial<Record<MenuIconSlot, CanvasImageSource>>;
  menu?: MenuOptions;
}

export interface XRKitOptions {
  renderer: WebGLRenderer;
  scene: Scene;
  /** The host's desktop camera. Its pose is restored when a session ends. */
  camera: PerspectiveCamera;
  /** What AR places and scales, and what `floors: "auto"` searches. Default: `scene`. */
  model?: Object3D;
  /** Metres per scene unit. glTF is metres (1); a millimetre scene is 0.001. Default 1. */
  metresPerUnit?: number;
  /** Default `"y"`. */
  up?: UpAxis;
  /**
   * Teleport targets. `"auto"` accepts every surface of `model` whose normal is within 30 degrees
   * of up; an array restricts teleport to those objects. Default `"auto"`.
   */
  floors?: "auto" | Object3D[];
  viewpoints?: Viewpoint[];
  vr?: VROptions;
  ar?: AROptions;
  performance?: PerformanceOptions;
  /** Show controller models, loaded from the WebXR input profiles CDN. Default true. */
  controllerModels?: boolean;
  /** Show hand models where hand tracking is available. Default true. */
  hands?: boolean;
  /** Replace the default raycast, for example with the host's BVH. */
  raycast?: RaycastFn;
  /**
   * Whether `raycast` can find the floors yet, for hosts that build them after the session
   * starts. While it returns false, a user placed at the fallback height (no floor found) is
   * moved onto the floor once it is found, for up to 10 s, unless they moved meanwhile.
   */
  floorsReady?: () => boolean;
  /** An in-headset panel with frame timing. Off by default. */
  diagnostics?: DiagnosticsOptions;
  /** Look and structure of the in-headset menu and panels. */
  ui?: UiOptions;
}

export interface XRSupport {
  vr: boolean;
  ar: boolean;
}

export interface EnterVROptions {
  /** Start at this viewpoint instead of below the desktop camera. */
  viewpoint?: string;
}

export interface EnterAROptions {
  /** Initial model scale for table-top placement; one of `ar.scales`. Ignored with `alignment`. */
  scale?: number;
  /** 1:1 on site: align by two reference points instead of placing on a table. */
  alignment?: ARAlignment;
}

/** Events the kit emits, with their payloads. */
export interface KitEvents {
  sessionstart: { mode: XRMode };
  sessionend: { mode: XRMode };
  /** The user was moved; `position` is the floor point below the head, in scene coordinates. */
  teleport: { position: Vector3 };
  viewpoint: { id: string };
  /** The model was placed in AR; `matrix` is its new world matrix. */
  placed: { matrix: Matrix4 };
  /**
   * The on-site alignment changed state. `errorM` is the mismatch between the distance of the two
   * reference points in the model and on the ground (null until both are picked); `restored` is
   * true when the placement came from an alignment saved on this device.
   */
  alignment: { state: AlignmentState; errorM: number | null; restored: boolean };
  /** A select (trigger, pinch, tap) on the scene. */
  select: { object: Object3D | null; point: Vector3 | null; source: RayKind };
  /** A host menu item was selected; `value` is the new value of a toggle. */
  "menu-select": { id: string; value?: boolean };
  /** The VR menu opened or closed. */
  menu: { open: boolean };
  /** The locomotion mode changed (`kit.setLocomotion`). */
  locomotion: { mode: LocomotionMode };
  /**
   * VR: the top face button of a controller was pressed (B on the right, Y on the left;
   * xr-standard `buttons[5]`). Reserved for a menu; the kit itself does nothing else with it.
   */
  "menu-button": { hand: "left" | "right" };
  /**
   * A row of a VR side panel was used: an action (no value), a toggle, choice or section (its new
   * value), a slider (while dragging, at most about ten times a second, with `final: false`; on
   * release, and for each stick step, with `final: true`).
   */
  "panel-input": { panel: string; id: string; value?: boolean | number | string; final?: boolean };
  /** The VR side panels opened or closed. */
  panels: { open: boolean };
}

export interface XRKit {
  /** What this browser and device can do. Show buttons only for what is true. */
  supports(): Promise<XRSupport>;
  /** Start a session. Must be called from a click or tap handler (WebXR user activation). */
  enter(mode: "vr", options?: EnterVROptions): Promise<void>;
  enter(mode: "ar", options?: EnterAROptions): Promise<void>;
  /** End the session; the desktop camera returns to where it was. */
  exit(): Promise<void>;
  /** Teleport to a viewpoint (VR only). */
  goTo(id: string): void;
  /** Replace the viewpoints. */
  setViewpoints(viewpoints: Viewpoint[]): void;
  /** AR only: set the model scale, applied around the placed point. */
  setScale(scale: number): void;
  /** AR on site: start the alignment again (point at A, then B), dropping any saved one in use. */
  realign(): void;
  /** AR on site: a small correction by eye after aligning. */
  nudge(nudge: AlignmentNudge): void;
  /** AR on site: save the current alignment on this device (resolves false where unsupported). */
  saveAlignment(): Promise<boolean>;
  /** Forget an alignment saved on this device. */
  forgetAlignment(id: string): Promise<void>;
  /** The on-site alignment state, or null outside an on-site AR session. */
  readonly alignmentState: AlignmentState | null;
  /**
   * Changes the VR locomotion, now or for the next session; emits `locomotion` when the mode
   * changes. Invalid values are ignored with a warning.
   */
  setLocomotion(patch: Partial<LocomotionOptions>): void;
  /** The VR locomotion in use, every default applied. */
  readonly locomotion: Readonly<LocomotionOptions>;
  /** Call once per frame from the host's own animation loop, passing the XRFrame when there is one. */
  update(frame?: XRFrame): void;
  /** The active mode, or null on the desktop. */
  readonly presenting: XRMode | null;
  /** Show or hide the diagnostics panel (shown only while presenting). */
  setDiagnostics(on: boolean): void;
  /** Whether the diagnostics panel is on. */
  readonly diagnostics: boolean;
  /** Frame timing over the last second, or null outside a session. */
  readonly frameStats: FrameStats | null;
  /** VR: open the in-headset menu in front of the user (world-locked where it opens). */
  openMenu(): void;
  closeMenu(): void;
  /** The VR menu is open. */
  readonly menuOpen: boolean;
  /** Replace the host's entries in the VR menu; redraws it when open. */
  setMenuItems(items: MenuItem[]): void;
  /**
   * VR side panels, replacing any set before; `[]` removes them. While any are set, B and Y open
   * and close the panels instead of the menu. Rows are copied: use `updatePanelRow` to change them.
   */
  setPanels(panels: PanelSpec[]): void;
  /** Changes one row of a side panel (value, label, disabled, ...); redraws only that panel. */
  updatePanelRow(panelId: string, rowId: string, patch: Partial<PanelRow>): void;
  /** VR: open the side panels around the user (body-locked: they follow large turns only). */
  openPanels(): void;
  closePanels(): void;
  /** The VR side panels are open. */
  readonly panelsOpen: boolean;
  /** Change the look of the in-headset panels (merged into the current theme); redraws open ones. */
  setTheme(patch: Partial<UiTheme>): void;
  /** Subscribe to an event; returns the unsubscribe function. */
  on<K extends keyof KitEvents>(event: K, listener: (payload: KitEvents[K]) => void): () => void;
  /** End any session and remove everything the kit added. */
  dispose(): void;
}
