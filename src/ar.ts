import {
  Box3,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  Quaternion,
  RingGeometry,
  type Scene,
  Vector3,
} from "three";
import type { ARController, KitContext, RaySource } from "./internal";
import type { AlignmentNudge, AlignmentState, ARAlignment } from "./types";

const DEG = Math.PI / 180;
/** Thumbstick turn: fire beyond this, re-arm below the second (hysteresis, one step per push). */
const TURN_FIRE = 0.6;
const TURN_REARM = 0.3;
/** Anchor drift below this (squared metres) is not worth recomputing the model's matrices. */
const ANCHOR_EPSILON_SQ = 1e-8;

/** `aiming`: never placed this session; `replacing`: placed, but the reticle is back for a new spot. */
type Phase = "aiming" | "placed" | "replacing";

interface ControllerHitSource {
  input: XRInputSource;
  source: XRHitTestSource;
}

/**
 * AR placement (T6). The user is never moved in AR: the model is placed on a real surface found
 * by WebXR hit-test, scaled about the placed point and turned about the up axis.
 *
 * AR shows the camera passthrough only where the canvas is transparent: the host must create its
 * renderer with `alpha: true`. While AR runs the scene background is set to null and the clear
 * alpha to 0; both come back on stop.
 *
 * When the model is the scene itself, its children (except the kit's root) move into a temporary
 * group for the session, since moving the scene would move the kit and the view with it.
 */
export function createAR(ctx: KitContext): ARController {
  let scale = ctx.options.ar.defaultScale;
  let active = false;
  // Bumped on start and stop, so late promises from an earlier session clean up after themselves.
  let generation = 0;
  let session: XRSession | null = null;
  let phase: Phase = "aiming";

  // What is transformed: the model, or the group standing in for the scene.
  let target: Object3D | null = null;
  let proxy: Group | null = null;
  let sceneOrder: Object3D[] = [];
  const saved = {
    position: new Vector3(),
    quaternion: new Quaternion(),
    scale: new Vector3(),
    matrix: new Matrix4(),
    visible: true,
    matrixAutoUpdate: true,
  };
  let savedBackground: Scene["background"] = null;
  let savedClearAlpha = 1;

  // Placement: world = T(placed) * R(up, turn) * S(k) * T(-base) * startWorld.
  const startWorld = new Matrix4();
  const base = new Vector3();
  const placedPoint = new Vector3();
  let turn = 0;

  // Hit-test.
  let viewerSource: XRHitTestSource | null = null;
  const controllerSources: ControllerHitSource[] = [];
  const pendingInputs = new Set<XRInputSource>();
  let hasHit = false;
  let hitResult: XRHitTestResult | null = null;
  const hitPoint = new Vector3();
  const hitMatrix = new Matrix4();
  let preferredHand: XRHandedness = "right";

  // Anchors.
  let anchor: XRAnchor | null = null;
  let anchorToken = 0;
  let wantAnchor = false;
  let anchorOffsetKnown = false;
  const anchorOffset = new Vector3();

  const armed = new Map<string, boolean>();

  const geometry = new RingGeometry(0.15, 0.2, 32).rotateX(-Math.PI / 2);
  const material = new MeshBasicMaterial({ color: 0xffffff });
  const reticle = new Mesh(geometry, material);
  reticle.name = "llhil-webxr-reticle";
  // Its matrix comes straight from the hit pose.
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;

  const box = new Box3();
  const m1 = new Matrix4();
  const m2 = new Matrix4();
  const v1 = new Vector3();

  function applyPlacement(): void {
    if (!target) return;
    const k = scale * ctx.options.metresPerUnit;
    m1.copy(startWorld);
    m1.premultiply(m2.makeTranslation(-base.x, -base.y, -base.z));
    m1.premultiply(m2.makeScale(k, k, k));
    m1.premultiply(m2.makeRotationAxis(ctx.up, turn));
    m1.premultiply(m2.makeTranslation(placedPoint.x, placedPoint.y, placedPoint.z));
    const parent = target.parent;
    if (parent) {
      parent.updateWorldMatrix(true, false);
      m1.premultiply(m2.copy(parent.matrixWorld).invert());
    }
    target.matrix.copy(m1);
    target.matrixWorldNeedsUpdate = true;
    target.updateMatrixWorld(true);
  }

  function place(): void {
    if (!target) return;
    placedPoint.copy(hitPoint);
    phase = "placed";
    reticle.visible = false;
    target.visible = true;
    applyPlacement();
    dropAnchor();
    // A hit result can only make an anchor while its frame is active, and select events fire
    // outside the frame callback: the anchor is made in the next update.
    wantAnchor = ctx.options.ar.anchors;
    ctx.events.emit("placed", { matrix: target.matrixWorld.clone() });
  }

  function onSelectEnd({ ray }: { ray: RaySource }): void {
    if (!active) return;
    if (ray.handedness !== "none") preferredHand = ray.handedness;
    if (phase === "placed") {
      phase = "replacing";
      reticle.visible = hasHit;
      return;
    }
    if (hasHit) place();
  }
  const offSelectEnd = ctx.events.on("selectend", onSelectEnd);

  async function requestViewerSource(gen: number): Promise<void> {
    const s = session;
    if (!s?.requestHitTestSource) return;
    try {
      const space = await s.requestReferenceSpace("viewer");
      if (gen !== generation) return;
      const source = await s.requestHitTestSource({ space });
      if (!source) return;
      if (gen !== generation) {
        source.cancel();
        return;
      }
      viewerSource = source;
    } catch (error) {
      console.warn("[llhil-webxr] AR hit-test from the viewer is unavailable", error);
    }
  }

  function addInput(input: XRInputSource): void {
    const s = session;
    // Controllers and hands on a headset; screen taps use the viewer source.
    if (!s?.requestHitTestSource || input.targetRayMode !== "tracked-pointer") return;
    if (pendingInputs.has(input) || controllerSources.some((e) => e.input === input)) return;
    const gen = generation;
    pendingInputs.add(input);
    let request: Promise<XRHitTestSource> | undefined;
    try {
      request = s.requestHitTestSource({ space: input.targetRaySpace });
    } catch {
      request = undefined;
    }
    if (!request) {
      pendingInputs.delete(input);
      return;
    }
    request.then(
      (source) => {
        // Removed while pending, or the session ended.
        if (gen !== generation || !pendingInputs.has(input)) {
          source.cancel();
          return;
        }
        pendingInputs.delete(input);
        controllerSources.push({ input, source });
      },
      () => {
        pendingInputs.delete(input);
      },
    );
  }

  function removeInput(input: XRInputSource): void {
    pendingInputs.delete(input);
    const i = controllerSources.findIndex((e) => e.input === input);
    if (i < 0) return;
    controllerSources[i].source.cancel();
    controllerSources.splice(i, 1);
  }

  function onInputSourcesChange(event: Event): void {
    const e = event as XRInputSourcesChangeEvent;
    for (const input of e.removed ?? []) removeInput(input);
    for (const input of e.added ?? []) addInput(input);
  }

  /** The preferred hand's results when it hits, else any controller's. */
  function controllerResults(frame: XRFrame): readonly XRHitTestResult[] | null {
    let fallback: readonly XRHitTestResult[] | null = null;
    for (const e of controllerSources) {
      const results = frame.getHitTestResults(e.source);
      if (results.length === 0) continue;
      if (e.input.handedness === preferredHand) return results;
      fallback ??= results;
    }
    return fallback;
  }

  function updateHit(frame: XRFrame, ref: XRReferenceSpace): void {
    hasHit = false;
    hitResult = null;
    // A headset's viewer source follows the gaze; once a controller exists it points instead.
    const results =
      controllerSources.length > 0
        ? controllerResults(frame)
        : viewerSource
          ? frame.getHitTestResults(viewerSource)
          : null;
    if (!results || results.length === 0) return;
    const pose = results[0].getPose(ref);
    if (!pose) return;
    hitMatrix.fromArray(pose.transform.matrix);
    const p = pose.transform.position;
    hitPoint.set(p.x, p.y, p.z);
    hitResult = results[0];
    hasHit = true;
  }

  function requestAnchor(result: XRHitTestResult): void {
    const token = ++anchorToken;
    let promise: Promise<XRAnchor> | undefined;
    try {
      promise = result.createAnchor?.();
    } catch {
      return;
    }
    promise?.then(
      (a) => {
        if (token !== anchorToken || !active) {
          a.delete();
          return;
        }
        anchor = a;
        anchorOffsetKnown = false;
      },
      // No anchors on this device: the model stays where it was placed.
      () => {},
    );
  }

  function dropAnchor(): void {
    anchorToken++;
    wantAnchor = false;
    anchor?.delete();
    anchor = null;
  }

  function updateAnchor(frame: XRFrame, ref: XRReferenceSpace): void {
    if (wantAnchor && hitResult) {
      wantAnchor = false;
      if (hitResult.createAnchor) requestAnchor(hitResult);
    }
    if (!anchor) return;
    if (frame.trackedAnchors && !frame.trackedAnchors.has(anchor)) return;
    const pose = frame.getPose(anchor.anchorSpace, ref);
    if (!pose) return;
    const p = pose.transform.position;
    v1.set(p.x, p.y, p.z);
    // The anchor comes from a later hit than the placing one: keep the offset, so it does not jump.
    if (!anchorOffsetKnown) {
      anchorOffset.copy(placedPoint).sub(v1);
      anchorOffsetKnown = true;
      return;
    }
    v1.add(anchorOffset);
    if (v1.distanceToSquared(placedPoint) < ANCHOR_EPSILON_SQ) return;
    placedPoint.copy(v1);
    applyPlacement();
  }

  function updateTurn(): void {
    const step = ctx.options.ar.rotateStepDegrees * DEG;
    for (const ray of ctx.input.rays()) {
      if (ray.kind !== "controller" || !ray.gamepad) continue;
      const axes = ray.gamepad.axes;
      // xr-standard mapping: thumbstick x is axis 2; a lone stick reports it at 0.
      const x = (axes.length >= 4 ? axes[2] : axes[0]) ?? 0;
      const isArmed = armed.get(ray.id) ?? true;
      if (isArmed && Math.abs(x) > TURN_FIRE) {
        armed.set(ray.id, false);
        if (phase === "aiming") continue;
        // Pushing right turns the model clockwise seen from above.
        turn -= Math.sign(x) * step;
        applyPlacement();
      } else if (!isArmed && Math.abs(x) < TURN_REARM) {
        armed.set(ray.id, true);
      }
    }
  }

  function updateReticle(): void {
    reticle.visible = hasHit && phase !== "placed";
    if (!reticle.visible) return;
    // The hit pose is in world coordinates; the reticle lives under the kit's root.
    ctx.root.updateWorldMatrix(true, false);
    reticle.matrix.multiplyMatrices(m2.copy(ctx.root.matrixWorld).invert(), hitMatrix);
    reticle.matrixWorldNeedsUpdate = true;
  }

  function captureTarget(): void {
    const model = ctx.options.model;
    if (model === ctx.scene) {
      sceneOrder = ctx.scene.children.slice();
      proxy = new Group();
      proxy.name = "llhil-webxr-ar-model";
      for (const child of sceneOrder) if (child !== ctx.root) proxy.add(child);
      ctx.scene.add(proxy);
      target = proxy;
    } else {
      target = model;
    }
    saved.position.copy(target.position);
    saved.quaternion.copy(target.quaternion);
    saved.scale.copy(target.scale);
    saved.matrix.copy(target.matrix);
    saved.visible = target.visible;
    saved.matrixAutoUpdate = target.matrixAutoUpdate;

    target.updateWorldMatrix(true, true);
    startWorld.copy(target.matrixWorld);
    // The bottom centre of the box, along up, is what lands on the surface.
    box.setFromObject(target);
    if (box.isEmpty()) {
      base.setFromMatrixPosition(startWorld);
    } else {
      box.getCenter(base);
      base.addScaledVector(ctx.up, box.min.dot(ctx.up) - base.dot(ctx.up));
    }
    target.visible = false;
    target.matrixAutoUpdate = false;
  }

  function releaseTarget(): void {
    if (proxy) {
      // Their world matrices still hold the placement until refreshed.
      for (const child of proxy.children.slice()) {
        ctx.scene.add(child);
        child.updateMatrixWorld(true);
      }
      ctx.scene.remove(proxy);
      const order = new Map(sceneOrder.map((o, i) => [o, i]));
      const last = Number.MAX_SAFE_INTEGER;
      // Stable sort: the original order, then anything the host added during the session.
      ctx.scene.children.sort((a, b) => (order.get(a) ?? last) - (order.get(b) ?? last));
      proxy = null;
      sceneOrder = [];
    } else if (target) {
      target.position.copy(saved.position);
      target.quaternion.copy(saved.quaternion);
      target.scale.copy(saved.scale);
      target.matrix.copy(saved.matrix);
      target.visible = saved.visible;
      target.matrixAutoUpdate = saved.matrixAutoUpdate;
      if (target.matrixAutoUpdate) target.updateMatrix();
      target.matrixWorldNeedsUpdate = true;
      target.updateMatrixWorld(true);
    }
    target = null;
  }

  function stop(): void {
    if (!active) return;
    active = false;
    generation++;
    session?.removeEventListener("inputsourceschange", onInputSourcesChange);
    viewerSource?.cancel();
    viewerSource = null;
    for (const e of controllerSources) e.source.cancel();
    controllerSources.length = 0;
    pendingInputs.clear();
    dropAnchor();
    reticle.visible = false;
    reticle.removeFromParent();
    releaseTarget();
    ctx.scene.background = savedBackground;
    ctx.renderer.setClearAlpha(savedClearAlpha);
    hasHit = false;
    hitResult = null;
    phase = "aiming";
    armed.clear();
    session = null;
  }

  // K2: on-site alignment (stub until K2 lands; table-top placement is unchanged).
  const alignmentState: AlignmentState | null = null;
  return {
    setAlignment(_alignment: ARAlignment | null): void {},
    realign(): void {},
    nudge(_nudge: AlignmentNudge): void {},
    saveAlignment: async () => false,
    forgetAlignment: async (_id: string) => {},
    get alignmentState() {
      return alignmentState;
    },
    /**
     * Model scale factor (1 = 1:1). Before a session it sets the initial scale; once placed it
     * rescales about the placed point. Non-positive values are ignored.
     */
    setScale(s: number): void {
      if (!(s > 0) || !Number.isFinite(s)) return;
      scale = s;
      if (active && phase !== "aiming") applyPlacement();
    },
    start(): void {
      if (active || ctx.mode !== "ar" || !ctx.session) return;
      active = true;
      generation++;
      session = ctx.session;
      phase = "aiming";
      turn = 0;
      hasHit = false;
      hitResult = null;

      savedBackground = ctx.scene.background;
      ctx.scene.background = null;
      savedClearAlpha = ctx.renderer.getClearAlpha();
      ctx.renderer.setClearAlpha(0);

      captureTarget();
      reticle.visible = false;
      ctx.root.add(reticle);

      void requestViewerSource(generation);
      for (const input of session.inputSources ?? []) addInput(input);
      session.addEventListener("inputsourceschange", onInputSourcesChange);
    },
    update(frame: XRFrame, _dt: number): void {
      if (!active) return;
      const ref = ctx.renderer.xr.getReferenceSpace();
      if (!ref) return;
      updateHit(frame, ref);
      updateAnchor(frame, ref);
      updateTurn();
      updateReticle();
    },
    stop,
    dispose(): void {
      stop();
      offSelectEnd();
      geometry.dispose();
      material.dispose();
    },
  };
}
