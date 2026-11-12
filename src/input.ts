// Controllers, hands, transient pointers and screen taps as rays in scene coordinates.
import {
  BufferGeometry,
  type Group,
  Line,
  LineBasicMaterial,
  type Material,
  type Mesh,
  type Object3D,
  Vector3,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { XRControllerModelFactory } from "three/examples/jsm/webxr/XRControllerModelFactory.js";
import { XRHandModelFactory } from "three/examples/jsm/webxr/XRHandModelFactory.js";
import type { InputController, KitContext, RaySource } from "./internal";
import type { RayKind } from "./types";

/**
 * three.js only assigns input sources to controller slots that already exist, and ignores sources
 * beyond them. Four covers two controllers or hands plus two transient pointers (Vision Pro).
 */
export const SLOT_COUNT = 4;

/** Length of the visual ray, in scene units (metres while presenting). */
const RAY_LENGTH = 5;

// Same path XRHandMeshModel uses by default; repeated because a custom loader skips it.
const HAND_MESH_PATH =
  "https://cdn.jsdelivr.net/npm/@webxr-input-profiles/assets@1.0/dist/profiles/generic-hand/";

const FORWARD = new Vector3(0, 0, -1);

/** xr-standard index of the top face button: B on the right controller, Y on the left. */
export const MENU_BUTTON = 5;
/** A press within this many milliseconds of the last reported one is contact bounce, not a press. */
export const MENU_DEBOUNCE_MS = 250;

type SpaceEvent = { data?: XRInputSource };

interface Slot {
  index: number;
  controller: Group;
  grip: Group;
  hand: Group | null;
  line: Line;
  source: XRInputSource | null;
  ray: RaySource | null;
  controllerModel: Object3D | null;
  handMesh: Object3D | null;
  handSpheres: Object3D | null;
  listeners: Array<[string, (event: SpaceEvent) => void]>;
  /** The menu button was down on the last poll. */
  menuDown: boolean;
  /** When the last `menu-button` was emitted (performance.now()), or -Infinity. */
  menuAt: number;
}

/** Maps a WebXR input source to the kind of ray the kit reports. */
export function rayKindOf(source: XRInputSource): RayKind {
  switch (source.targetRayMode) {
    case "screen":
      return "screen";
    case "tracked-pointer":
      return source.hand ? "hand" : "controller";
    default:
      // "transient-pointer" (gaze and pinch) and "gaze": both only point while selecting.
      return "transient";
  }
}

export function createInput(ctx: KitContext): InputController {
  const slots: Slot[] = [];
  // Stable array: mutated in place on connect, disconnect, start and stop, never per frame.
  const rays: RaySource[] = [];
  const sourceIds = new WeakMap<XRInputSource, number>();
  let nextSourceId = 1;
  let active = false;
  let disposed = false;
  let handMeshFailed = false;

  const lineGeometry = new BufferGeometry().setFromPoints([
    new Vector3(0, 0, 0),
    new Vector3(0, 0, -RAY_LENGTH),
  ]);
  const lineMaterial = new LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 });

  function sourceId(slot: Slot, source: XRInputSource): string {
    let n = sourceIds.get(source);
    if (n === undefined) {
      n = nextSourceId++;
      sourceIds.set(source, n);
    }
    return `input-${slot.index}-${n}`;
  }

  /** Copies the controller's world pose into the ray; allocation-free. */
  function refresh(slot: Slot): void {
    const ray = slot.ray;
    if (!ray) return;
    // Its matrix is set by three before frame callbacks and select events, its matrixWorld only
    // at render time: recompute it so the ray matches the pose of this frame or event.
    slot.controller.updateWorldMatrix(true, false);
    const m = slot.controller.matrixWorld;
    ray.origin.setFromMatrixPosition(m);
    ray.direction.copy(FORWARD).transformDirection(m);
    ray.gamepad = slot.source?.gamepad ?? undefined;
  }

  /** Emits `menu-button` on the press edge of the top face button; allocation-free. */
  function pollMenu(slot: Slot): void {
    const ray = slot.ray;
    const pad = ray?.kind === "controller" ? ray.gamepad : undefined;
    const pressed = pad?.buttons?.[MENU_BUTTON]?.pressed === true;
    if (pressed && !slot.menuDown && ctx.mode && ray) {
      const hand = ray.handedness;
      const now = performance.now();
      if (hand !== "none" && now - slot.menuAt >= MENU_DEBOUNCE_MS) {
        slot.menuAt = now;
        ctx.events.emit("menu-button", { hand });
      }
    }
    slot.menuDown = pressed;
  }

  function rebuildRays(): void {
    rays.length = 0;
    if (!active) return;
    for (const slot of slots) if (slot.ray) rays.push(slot.ray);
  }

  function updateLine(slot: Slot): void {
    const kind = slot.ray?.kind;
    slot.line.visible = active && (kind === "controller" || kind === "hand");
  }

  function connect(slot: Slot, source: XRInputSource): void {
    if (slot.source === source && slot.ray) return;
    if (slot.source) disconnect(slot, slot.source);
    slot.source = source;
    slot.ray = {
      id: sourceId(slot, source),
      kind: rayKindOf(source),
      handedness: source.handedness,
      origin: new Vector3(),
      direction: new Vector3(0, 0, -1),
      selecting: false,
      gamepad: source.gamepad ?? undefined,
    };
    slot.menuDown = false;
    refresh(slot);
    updateLine(slot);
    rebuildRays();
  }

  function disconnect(slot: Slot, source: XRInputSource | undefined): void {
    if (source && slot.source !== source) return;
    const ray = slot.ray;
    // A source can vanish mid-select (a transient pointer removed before its selectend reaches
    // three); end the select so listeners are not left waiting.
    if (ray?.selecting) {
      ray.selecting = false;
      if (active) ctx.events.emit("selectend", { ray });
    }
    slot.source = null;
    slot.ray = null;
    updateLine(slot);
    rebuildRays();
  }

  function onSelectStart(slot: Slot, source: XRInputSource | undefined): void {
    // Defensive: a select for a source three never reported as connected still gets a ray.
    if (source && slot.source !== source) connect(slot, source);
    const ray = slot.ray;
    if (!active || !ray) return;
    refresh(slot);
    ray.selecting = true;
    ctx.events.emit("selectstart", { ray });
  }

  function onSelectEnd(slot: Slot): void {
    const ray = slot.ray;
    if (!active || !ray) return;
    refresh(slot);
    ray.selecting = false;
    ctx.events.emit("selectend", { ray });
  }

  function onSelect(slot: Slot): void {
    const ray = slot.ray;
    if (!active || !ray) return;
    refresh(slot);
    const hit = ctx.raycast(ray.origin, ray.direction, 1e5, "all");
    ctx.events.emit("select", {
      object: hit ? hit.object : null,
      point: hit ? hit.point : null,
      source: ray.kind,
    });
  }

  /** A loader that reports a failed hand mesh, so the hands fall back to spheres. */
  function createHandLoader(): GLTFLoader {
    const loader = new GLTFLoader().setPath(HAND_MESH_PATH);
    const load = loader.load.bind(loader);
    loader.load = (url, onLoad, onProgress, onError) => {
      const fail = (error: unknown) => {
        onHandMeshFailed();
        onError?.(error);
      };
      if (handMeshFailed) {
        fail(new Error("hand mesh unavailable"));
        return;
      }
      load(url, onLoad, onProgress, fail);
    };
    return loader;
  }

  function onHandMeshFailed(): void {
    if (handMeshFailed) return;
    handMeshFailed = true;
    console.warn("[llhil-webxr] hand mesh failed to load; showing sphere hands");
    for (const slot of slots) {
      if (!slot.hand || !slot.handMesh || !slot.handSpheres) continue;
      slot.hand.remove(slot.handMesh);
      slot.hand.add(slot.handSpheres);
    }
  }

  /**
   * Creates the slots once, as early as the renderer allows, so connections that arrive before
   * `start()` are not missed. Listeners and model factories stay attached to three's groups for
   * the kit's lifetime, which is what keeps a second `start()` from duplicating them.
   */
  function ensureSlots(): boolean {
    if (slots.length > 0) return true;
    if (disposed) return false;
    const xr = ctx.renderer?.xr as Partial<typeof ctx.renderer.xr> | undefined;
    if (typeof xr?.getController !== "function" || typeof xr.getControllerGrip !== "function") {
      return false;
    }
    const { controllerModels, hands } = ctx.options;
    const controllerFactory = controllerModels ? new XRControllerModelFactory() : null;
    let handFactory: XRHandModelFactory | null = null;
    if (hands && typeof xr.getHand === "function") {
      handFactory = new XRHandModelFactory(createHandLoader());
    }

    for (let index = 0; index < SLOT_COUNT; index++) {
      const controller = xr.getController(index) as unknown as Group;
      const grip = xr.getControllerGrip(index) as unknown as Group;
      const hand = handFactory && xr.getHand ? (xr.getHand(index) as unknown as Group) : null;
      const line = new Line(lineGeometry, lineMaterial);
      line.name = "llhil-webxr-ray";
      line.visible = false;
      controller.add(line);

      const slot: Slot = {
        index,
        controller,
        grip,
        hand,
        line,
        source: null,
        ray: null,
        controllerModel: null,
        handMesh: null,
        handSpheres: null,
        listeners: [],
        menuDown: false,
        menuAt: Number.NEGATIVE_INFINITY,
      };

      if (controllerFactory) {
        slot.controllerModel = controllerFactory.createControllerModel(grip);
        grip.add(slot.controllerModel);
      }
      if (handFactory && hand) {
        // Both are kept in sync by their factory listeners; only one is attached at a time.
        slot.handMesh = handFactory.createHandModel(hand, "mesh");
        slot.handSpheres = handFactory.createHandModel(hand, "spheres");
        hand.add(handMeshFailed ? slot.handSpheres : slot.handMesh);
      }

      slot.listeners = [
        ["connected", (e) => e.data && connect(slot, e.data)],
        ["disconnected", (e) => disconnect(slot, e.data)],
        ["selectstart", (e) => onSelectStart(slot, e.data)],
        ["selectend", () => onSelectEnd(slot)],
        ["select", () => onSelect(slot)],
      ];
      for (const [type, fn] of slot.listeners) controller.addEventListener(type as any, fn as any);
      slots.push(slot);
    }
    return true;
  }

  ensureSlots();

  function objectsOf(slot: Slot): Object3D[] {
    return slot.hand ? [slot.controller, slot.grip, slot.hand] : [slot.controller, slot.grip];
  }

  const input: InputController = {
    /** Connected sources only, ordered by slot. The same array every call, updated in place. */
    rays: () => rays,

    start(): void {
      if (disposed || !ensureSlots()) return;
      active = true;
      for (const slot of slots) {
        for (const object of objectsOf(slot)) ctx.root.add(object);
        if (slot.ray) refresh(slot);
        updateLine(slot);
      }
      rebuildRays();
    },

    update(_frame: XRFrame, _dt: number): void {
      if (!active) return;
      for (const slot of slots) {
        if (!slot.ray) continue;
        refresh(slot);
        pollMenu(slot);
      }
    },

    stop(): void {
      active = false;
      for (const slot of slots) {
        for (const object of objectsOf(slot)) ctx.root.remove(object);
        // The session's sources are gone with it; three disconnects them too, in either order.
        if (slot.ray) slot.ray.selecting = false;
        slot.menuDown = false;
        slot.source = null;
        slot.ray = null;
        updateLine(slot);
      }
      rebuildRays();
    },

    dispose(): void {
      if (disposed) return;
      input.stop();
      disposed = true;
      for (const slot of slots) {
        for (const [type, fn] of slot.listeners) {
          slot.controller.removeEventListener(type as any, fn as any);
        }
        slot.controller.remove(slot.line);
        // The factories' own listeners cannot be removed; detaching and freeing the models is
        // the most that can be done.
        for (const model of [slot.controllerModel, slot.handMesh, slot.handSpheres]) {
          if (!model) continue;
          model.removeFromParent();
          disposeObject(model);
        }
      }
      slots.length = 0;
      lineGeometry.dispose();
      lineMaterial.dispose();
    },
  };
  return input;
}

function disposeObject(root: Object3D): void {
  root.traverse((o) => {
    const mesh = o as Mesh;
    mesh.geometry?.dispose();
    const material = mesh.material as Material | Material[] | undefined;
    if (Array.isArray(material)) for (const m of material) m.dispose();
    else material?.dispose();
  });
}
