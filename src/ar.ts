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
import { nudgeMatrix, solveTwoPoint } from "./align";
import type { ARController, KitContext, RaySource } from "./internal";
import { forwardAtYawZero } from "./math";
import { createAlignmentStore } from "./persist";
import type { AlignmentNudge, AlignmentState, ARAlignment } from "./types";
import { ANCHOR_TIMEOUT_MS, withTimeout } from "./timeout";

const DEG = Math.PI / 180;
/** Thumbstick deflection below this does nothing; above it the speed grows to full at 1. */
const STICK_DEAD = 0.15;
/** On site: a trigger pulled with the controller this close to the floor (metres) touches a mark. */
const TOUCH_HEIGHT = 0.3;
/** Two touched marks closer than this (metres) give no direction. */
const TOUCH_MIN_SPAN = 0.5;
/** A hit this close to a controller (metres) is the hand holding it. */
const HAND_CLEARANCE = 0.3;
/** xr-standard gamepad: the grip (squeeze). */
const BUTTON_GRIP = 1;
/** Anchor drift below this (squared metres) is not worth recomputing the model's matrices. */
const ANCHOR_EPSILON_SQ = 1e-8;

/** On site, fine-tuning at full deflection: degrees and metres a second (the response is squared). */
const NUDGE_TURN_DEG_S = 20;
const NUDGE_MOVE_M_S = 0.5;
const NUDGE_LIFT_M_S = 0.2;
/** Restored anchors that give no pose for this long count as not found here. */
const RESTORE_TIMEOUT_S = 3;
/** How long `lost` stays on the panel before picking starts. */
const LOST_HOLD_S = 1.5;
/** xr-standard gamepad buttons: A/X saves, B/Y aligns again. */
const BUTTON_SAVE = 4;
const BUTTON_REALIGN = 5;
const CONTROLS_HINT = "Stick: turn · Grip + stick: move · A: save · B: again";
const LIFT_HINT = "Left stick: up and down";
const TOUCH_HINT = "Floor marks: touch each, pull the trigger";
const SAVE_UNAVAILABLE = "Saving is not available on this device";

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
 *
 * With an alignment set before the session (on site, K2) the model is not placed on a table: the
 * user points at two marks on the ground, the two-point solve places the model at 1:1 so both
 * reference points coincide, and the result can be fine-tuned by eye and saved on the device as
 * persistent anchors, restored on the next visit.
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

  // On site (K2): alignment by two reference points instead of table-top placement.
  const store = createAlignmentStore();
  let requestedAlignment: ARAlignment | null = null;
  /** The alignment of the running session, or null for table-top placement. */
  let onsite: ARAlignment | null = null;
  let state: AlignmentState | null = null;
  let errorM: number | null = null;
  let restored = false;
  /** Model points A and B in metres (the model is at metresPerUnit, i.e. 1:1). */
  const modelA = new Vector3();
  const modelB = new Vector3();
  const realA = new Vector3();
  /** The two-point correction, nudges included, applied to the resting world matrix. */
  const correction = new Matrix4();
  /** Anchors at the real points A and B, in use this session. */
  let anchorA: XRAnchor | null = null;
  let anchorB: XRAnchor | null = null;
  /** Anchors saved on (or restored from) the device: never deleted here, the store owns them. */
  const persistent = new Set<XRAnchor>();
  /** Picks waiting for the next frame to make their anchor from its hit result. */
  let wantAnchorA = false;
  let wantAnchorB = false;
  /** Bumped by realign and stop: anchors, restores and saves started before are stale. */
  let pickToken = 0;
  /** Moved by hand since the anchors in use were placed: they no longer sit at the real points. */
  let nudged = false;
  /** Bumped by every nudge, so a save that finishes after one does not claim `saved`. */
  let revision = 0;
  let restoredAnchors: { a: XRAnchor; b: XRAnchor } | null = null;
  let restoreClock = 0;
  let lostClock = 0;
  let pendingSave: { resolve: (ok: boolean) => void; promise: Promise<boolean> } | null = null;
  /** `stand`: place from the head on the next frame that has its pose. */
  let wantStand = false;
  /** `stand`: the first floor mark touched with a controller, waiting for the second. */
  let touchA: Vector3 | null = null;
  const pressed = new Map<string, boolean>();
  let hudPending: { title: string; lines: string[] } | null = null;

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
  const v2 = new Vector3();
  /** A stick axis past the dead zone, rescaled to -1..1. */
  const stick = (v: number): number =>
    Math.abs(v) < STICK_DEAD ? 0 : (v - Math.sign(v) * STICK_DEAD) / (1 - STICK_DEAD);

  function applyPlacement(): void {
    if (!target) return;
    if (onsite) {
      // On site: world = correction * S(metresPerUnit) * startWorld, always 1:1.
      const k = ctx.options.metresPerUnit;
      m1.copy(startWorld);
      m1.premultiply(m2.makeScale(k, k, k));
      m1.premultiply(correction);
    } else {
      const k = scale * ctx.options.metresPerUnit;
      m1.copy(startWorld);
      m1.premultiply(m2.makeTranslation(-base.x, -base.y, -base.z));
      m1.premultiply(m2.makeScale(k, k, k));
      m1.premultiply(m2.makeRotationAxis(ctx.up, turn));
      m1.premultiply(m2.makeTranslation(placedPoint.x, placedPoint.y, placedPoint.z));
    }
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
    // A trigger a panel took is the panel's.
    if (!active || ctx.uiCapture) return;
    if (ray.handedness !== "none") preferredHand = ray.handedness;
    if (onsite) {
      if (onsite.start === "stand") touchMark(ray);
      else onsitePick();
      return;
    }
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
    if (!results) return;
    // The nearest surface that is not a hand: a headset's depth sensing reports the hands too.
    for (const result of results) {
      const pose = result.getPose(ref);
      if (!pose) continue;
      const p = pose.transform.position;
      hitPoint.set(p.x, p.y, p.z);
      if (nearController(hitPoint)) continue;
      hitMatrix.fromArray(pose.transform.matrix);
      hitResult = result;
      hasHit = true;
      return;
    }
  }

  /** Within HAND_CLEARANCE of a controller: the hand holding it, not a surface. */
  function nearController(point: Vector3): boolean {
    for (const ray of ctx.input.rays()) {
      if (ray.kind === "controller" && ray.origin.distanceToSquared(point) < HAND_CLEARANCE ** 2) {
        return true;
      }
    }
    return false;
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

  /**
   * Table-top: the thumbstick turns the placed model, smoothly (left/right, `ar.rotateSpeed` at
   * full deflection); with the grip held it slides the model on its plane instead (the way the
   * user looks is forward, `ar.moveSpeed`). Nothing moves while a panel has the controllers.
   */
  function updateSticks(dt: number): void {
    if (phase === "aiming" || ctx.uiCapture) return;
    let moved = false;
    for (const ray of ctx.input.rays()) {
      if (ray.kind !== "controller" || !ray.gamepad) continue;
      const axes = ray.gamepad.axes;
      // xr-standard mapping: the thumbstick is axes 2 and 3; a lone stick reports at 0 and 1.
      const four = axes.length >= 4;
      const x = stick((four ? axes[2] : axes[0]) ?? 0);
      const y = stick((four ? axes[3] : axes[1]) ?? 0);
      if (ray.gamepad.buttons?.[BUTTON_GRIP]?.pressed) {
        if (!x && !y) continue;
        const world = ctx.renderer.xr.getCamera().matrixWorld;
        v1.setFromMatrixColumn(world, 2).negate();
        v1.addScaledVector(ctx.up, -v1.dot(ctx.up));
        if (v1.lengthSq() < 1e-6) continue;
        v1.normalize();
        v2.crossVectors(v1, ctx.up);
        const k = ctx.options.ar.moveSpeed * dt;
        // Forward on the stick is negative.
        v2.multiplyScalar(x * k).addScaledVector(v1, -y * k);
        placedPoint.add(v2);
        // The anchor keeps holding the model, from its new spot.
        anchorOffset.add(v2);
      } else if (x) {
        // Pushing right turns the model clockwise seen from above.
        turn -= x * ctx.options.ar.rotateSpeed * DEG * dt;
      } else continue;
      moved = true;
    }
    if (moved) applyPlacement();
  }

  function updateReticle(): void {
    reticle.visible =
      hasHit && (onsite ? state === "pick-a" || state === "pick-b" : phase !== "placed");
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

  // --- On site ---------------------------------------------------------------------------------

  const cm = (m: number | null) => `${((m ?? 0) * 100).toFixed(1)} cm`;

  /** The panel is written from `update`, once the panel module runs, so the first text is not lost. */
  function showHud(title: string, lines: string[] = []): void {
    hudPending = { title, lines: lines.slice(0, 3) };
  }

  function flushHud(): void {
    if (!hudPending) return;
    ctx.hud.show(hudPending.title, hudPending.lines);
    hudPending = null;
  }

  function pickHud(mark: "a" | "b", notice?: string): void {
    const label = onsite?.labels?.[mark];
    const lines = [notice, label, "Pull the trigger"].filter((l): l is string => !!l);
    showHud(`Point at mark ${mark.toUpperCase()}`, lines);
  }

  function placedHud(): void {
    if (state === "saved") {
      showHud(`${restored ? "Restored" : "Saved"}, error ${cm(errorM)}`, [CONTROLS_HINT]);
    } else {
      showHud(
        `Aligned, error ${cm(errorM)}`,
        onsite?.start === "stand"
          ? [CONTROLS_HINT, LIFT_HINT, TOUCH_HINT]
          : [CONTROLS_HINT, LIFT_HINT],
      );
    }
  }

  function setState(next: AlignmentState, notice?: string): void {
    if (next === "pick-a" || next === "pick-b") pickHud(next === "pick-a" ? "a" : "b", notice);
    else if (next === "restoring") showHud("Looking for the saved alignment");
    else if (next === "lost") {
      showHud("Saved alignment not found here", ["Align again: point at mark A, then B"]);
    }
    if (next === state) return;
    state = next;
    if (next === "aligned" || next === "saved") placedHud();
    ctx.events.emit("alignment", { state: next, errorM, restored });
  }

  function deleteAnchor(a: XRAnchor | null): void {
    if (!a || persistent.has(a)) return;
    try {
      a.delete();
    } catch {
      // Already gone.
    }
  }

  /** Drops the anchors in use and everything pending; the saved alignment stays on the device. */
  function dropOnsiteAnchors(): void {
    pickToken++;
    wantAnchorA = false;
    wantAnchorB = false;
    deleteAnchor(anchorA);
    deleteAnchor(anchorB);
    anchorA = null;
    anchorB = null;
    restoredAnchors = null;
    pendingSave?.resolve(false);
    pendingSave = null;
  }

  function startOnsite(alignment: ARAlignment): void {
    onsite = alignment;
    const k = ctx.options.metresPerUnit;
    modelA.fromArray(alignment.a).multiplyScalar(k);
    modelB.fromArray(alignment.b).multiplyScalar(k);
    correction.identity();
    state = null;
    wantStand = false;
    touchA = null;
    errorM = null;
    restored = false;
    nudged = false;
    restoreClock = 0;
    lostClock = 0;
    const s = session;
    let supported = false;
    try {
      supported = !!s && ctx.options.ar.anchors && store.supported(s);
    } catch {
      supported = false;
    }
    // Nothing saved on this device: ask for the marks straight away instead of a "lost".
    let saved = false;
    try {
      saved = supported && store.has(alignment.id);
    } catch {
      saved = false;
    }
    if (!s || !supported || !saved) {
      beginPlacing();
      return;
    }
    setState("restoring");
    const token = pickToken;
    let request: Promise<{ a: XRAnchor; b: XRAnchor } | null>;
    try {
      request = store.restore(s, alignment.id);
    } catch (error) {
      request = Promise.reject(error);
    }
    request.then(
      (r) => {
        if (token !== pickToken || !active || state !== "restoring") return;
        if (!r) {
          lose();
          return;
        }
        persistent.add(r.a);
        persistent.add(r.b);
        restoredAnchors = r;
        restoreClock = 0;
      },
      (error) => {
        if (token !== pickToken || !active || state !== "restoring") return;
        console.warn("[llhil-webxr] the saved alignment could not be restored", error);
        lose();
      },
    );
  }

  function lose(): void {
    restoredAnchors = null;
    lostClock = 0;
    errorM = null;
    restored = false;
    setState("lost");
  }

  function stopOnsite(): void {
    dropOnsiteAnchors();
    hudPending = null;
    ctx.hud.hide();
    persistent.clear();
    onsite = null;
    state = null;
    wantStand = false;
    pressed.clear();
  }

  function anchorPosition(frame: XRFrame, ref: XRReferenceSpace, a: XRAnchor): Vector3 | null {
    if (frame.trackedAnchors && !frame.trackedAnchors.has(a)) return null;
    const pose = frame.getPose(a.anchorSpace, ref);
    if (!pose) return null;
    const p = pose.transform.position;
    return new Vector3(p.x, p.y, p.z);
  }

  /** Solves and places the model; false (and back to `pick-a`) when the points do not solve. */
  function solveAndPlace(ra: Vector3, rb: Vector3): boolean {
    let solution: ReturnType<typeof solveTwoPoint>;
    try {
      solution = solveTwoPoint(modelA, modelB, ra, rb, ctx.up);
    } catch (error) {
      dropOnsiteAnchors();
      errorM = null;
      restored = false;
      setState("pick-a", (error as Error).message);
      return false;
    }
    realA.copy(ra);
    correction.copy(solution.matrix);
    errorM = solution.errorM;
    nudged = false;
    reticle.visible = false;
    if (target) {
      target.visible = true;
      applyPlacement();
      ctx.events.emit("placed", { matrix: target.matrixWorld.clone() });
    }
    return true;
  }

  function onsitePick(): void {
    if ((state !== "pick-a" && state !== "pick-b") || !hasHit) return;
    const point = hitPoint.clone();
    const anchors = ctx.options.ar.anchors && !!hitResult?.createAnchor;
    if (state === "pick-a") {
      realA.copy(point);
      wantAnchorA = anchors;
      setState("pick-b");
      return;
    }
    wantAnchorB = anchors;
    if (!solveAndPlace(realA.clone(), point)) return;
    restored = false;
    setState("aligned");
  }

  /** An anchor from this frame's hit result, for the pick that asked for it. */
  function requestPickAnchor(which: "a" | "b", result: XRHitTestResult): void {
    const token = pickToken;
    let promise: Promise<XRAnchor> | undefined;
    try {
      promise = result.createAnchor?.();
    } catch {
      return;
    }
    promise?.then(
      (a) => {
        if (token !== pickToken || !active) {
          a.delete();
          return;
        }
        if (which === "a") {
          deleteAnchor(anchorA);
          anchorA = a;
        } else {
          deleteAnchor(anchorB);
          anchorB = a;
        }
      },
      // No anchors here: the alignment works, it just cannot be saved.
      () => {},
    );
  }

  function realign(): void {
    dropOnsiteAnchors();
    correction.identity();
    errorM = null;
    restored = false;
    nudged = false;
    if (target) target.visible = false;
    beginPlacing();
  }

  /** Nothing to restore: the marks, or (`stand`) the model placed from where the user stands. */
  function beginPlacing(): void {
    if (onsite?.start === "stand") {
      touchA = null;
      wantStand = true;
      showHud("Stand on the point, face its direction");
    } else setState("pick-a");
  }

  /** The flat forward of a pose matrix (it looks along its -Z; straight down: its top). */
  function flatForward(e: ArrayLike<number>, out: Vector3): boolean {
    out.set(-e[8], -e[9], -e[10]);
    out.addScaledVector(ctx.up, -out.dot(ctx.up));
    if (out.lengthSq() < 1e-8) {
      out.set(e[4], e[5], e[6]);
      out.addScaledVector(ctx.up, -out.dot(ctx.up));
    }
    if (out.lengthSq() < 1e-8) return false;
    out.normalize();
    return true;
  }

  /** `stand`: point A under the head, point B ahead of it; then it is the user's to adjust. */
  function standPlace(frame: XRFrame, ref: XRReferenceSpace): void {
    const pose = frame.getViewerPose?.(ref);
    const f = new Vector3();
    if (!pose || !flatForward(pose.transform.matrix, f)) return;
    wantStand = false;
    const p = pose.transform.position;
    const ra = new Vector3(p.x, p.y, p.z);
    // The floor is the origin's height where the space has one; else an eye height below the head.
    const h = ra.dot(ctx.up);
    ra.addScaledVector(ctx.up, -(h > 0.5 ? h : ctx.options.vr.eyeHeight));
    placeFrom(ra, f);
  }

  /** `stand`: point A at `ra`, point B along the flat unit direction `f`; the user's to adjust. */
  function placeFrom(ra: Vector3, f: Vector3): void {
    const d = v1.subVectors(modelB, modelA);
    const rise = d.dot(ctx.up);
    const span = Math.max(1, d.addScaledVector(ctx.up, -rise).length());
    const rb = ra.clone().addScaledVector(f, span).addScaledVector(ctx.up, rise);
    if (!solveAndPlace(ra, rb)) return;
    // No anchors yet: a save makes them where the model stands then.
    nudged = true;
    errorM = 0;
    restored = false;
    if (state === "aligned") placedHud();
    else setState("aligned");
  }

  /**
   * `stand`, the precise way: two marks on the floor, touched with a controller. The trigger
   * pulled with the controller down at the floor takes its position: the first touch is point
   * A, the second gives the direction to point B (anywhere along that line, the farther the
   * better). Controller tracking is the headset's most exact measure, and needs no camera.
   */
  function touchMark(ray: RaySource): void {
    if (ray.kind !== "controller" || (state !== "aligned" && state !== "saved" && !wantStand)) {
      return;
    }
    const p = ray.origin;
    const h = p.dot(ctx.up);
    if (h > TOUCH_HEIGHT) return;
    // On the floor itself, whatever the controller's own height above it.
    const point = p.clone().addScaledVector(ctx.up, -h);
    if (!touchA) {
      touchA = point;
      showHud("First mark taken", ["Touch the second mark, pull the trigger"]);
      return;
    }
    const f = point.clone().sub(touchA);
    if (f.lengthSq() < TOUCH_MIN_SPAN ** 2) {
      showHud("The marks are too close", ["Touch the second mark, pull the trigger"]);
      return;
    }
    const ra = touchA;
    touchA = null;
    wantStand = false;
    placeFrom(ra, f.normalize());
  }

  /** Where model point A sits now: the pivot of turns, so a turn never moves mark A. */
  function pivotA(out = new Vector3()): Vector3 {
    return out.copy(modelA).applyMatrix4(correction);
  }

  /** The head's forward on the ground, in scene coordinates. */
  function headForward(out = new Vector3()): Vector3 {
    // Its world matrix is written by three.js on render, so it is at most a frame old.
    const camera = ctx.renderer.xr.getCamera?.();
    if (camera && flatForward(camera.matrixWorld.elements, out)) return out;
    return forwardAtYawZero(ctx.options.up, out);
  }

  function applyNudge(turnDeg: number, right: number, forward: number, lift = 0): void {
    if (state !== "aligned" && state !== "saved") return;
    if (turnDeg === 0 && right === 0 && forward === 0 && lift === 0) return;
    const f = headForward();
    // Right-handed: forward x up points right.
    const r = new Vector3().crossVectors(f, ctx.up).normalize();
    const move = r.multiplyScalar(right).addScaledVector(f, forward).addScaledVector(ctx.up, lift);
    correction.copy(nudgeMatrix(correction, pivotA(), ctx.up, turnDeg, move));
    applyPlacement();
    nudged = true;
    revision++;
    setState("aligned");
  }

  function updateGamepads(dt: number): void {
    const controllers = ctx.input.rays().filter((r) => r.kind === "controller" && r.gamepad);
    const rights = controllers.filter((r) => r.handedness === "right");
    const sticks = rights.length > 0 ? rights : controllers.slice(0, 1);
    for (const ray of controllers) {
      const buttons = ray.gamepad?.buttons ?? [];
      for (const index of [BUTTON_SAVE, BUTTON_REALIGN]) {
        const key = `${ray.id}:${index}`;
        const down = !!buttons[index]?.pressed;
        const was = pressed.get(key) ?? false;
        pressed.set(key, down);
        if (!down || was) continue;
        if (index === BUTTON_SAVE) void saveAlignment();
        else realign();
      }
    }
    if (state !== "aligned" && state !== "saved") return;
    for (const ray of sticks) {
      const axes = ray.gamepad?.axes ?? [];
      // xr-standard mapping: the thumbstick is axes 2 and 3; a lone stick reports 0 and 1.
      const four = axes.length >= 4;
      // Squared: a light push is a fine correction.
      const x = stick((four ? axes[2] : axes[0]) ?? 0);
      const y = stick((four ? axes[3] : axes[1]) ?? 0);
      const sx = x * Math.abs(x);
      const sy = y * Math.abs(y);
      const k = NUDGE_MOVE_M_S * dt;
      // With the grip: slide (forward on the stick is negative). Without: right turns clockwise.
      if (ray.gamepad?.buttons?.[BUTTON_GRIP]?.pressed) applyNudge(0, sx * k, -sy * k);
      else applyNudge(-sx * NUDGE_TURN_DEG_S * dt, 0, 0);
    }
    // The other hand's stick, forward and back: the model up and down, onto the real floor.
    if (rights.length === 0) return;
    for (const ray of controllers) {
      if (ray.handedness !== "left") continue;
      const axes = ray.gamepad?.axes ?? [];
      const y = stick((axes.length >= 4 ? axes[3] : axes[1]) ?? 0);
      applyNudge(0, 0, 0, -y * Math.abs(y) * NUDGE_LIFT_M_S * dt);
    }
  }

  function updateOnsite(frame: XRFrame, ref: XRReferenceSpace, dt: number): void {
    if (wantAnchorA && hitResult) {
      wantAnchorA = false;
      requestPickAnchor("a", hitResult);
    }
    if (wantAnchorB && hitResult) {
      wantAnchorB = false;
      requestPickAnchor("b", hitResult);
    }
    if (pendingSave) saveAtCorrectedPoints(frame, ref);
    if (state === "restoring" && restoredAnchors) {
      const ra = anchorPosition(frame, ref, restoredAnchors.a);
      const rb = anchorPosition(frame, ref, restoredAnchors.b);
      if (ra && rb) {
        const r = restoredAnchors;
        restoredAnchors = null;
        anchorA = r.a;
        anchorB = r.b;
        if (solveAndPlace(ra, rb)) {
          restored = true;
          setState("saved");
        }
      } else {
        restoreClock += dt;
        if (restoreClock >= RESTORE_TIMEOUT_S) lose();
      }
    } else if (state === "lost") {
      lostClock += dt;
      if (lostClock >= LOST_HOLD_S) beginPlacing();
    }
    if (wantStand) standPlace(frame, ref);
    updateGamepads(dt);
  }

  function saveUnavailable(): boolean {
    if (state === "aligned" || state === "saved") showHud(SAVE_UNAVAILABLE, [CONTROLS_HINT]);
    return false;
  }

  /**
   * Saves the alignment on the device. Anchors from the picks are saved as they are; after a
   * nudge they no longer sit at the real points, so new ones are made at the corrected points.
   */
  function saveAlignment(): Promise<boolean> {
    if (!active || !onsite || (state !== "aligned" && state !== "saved")) {
      return Promise.resolve(false);
    }
    if (state === "saved") return Promise.resolve(true);
    if (pendingSave) return pendingSave.promise;
    const s = session;
    let supported = false;
    try {
      supported = !!s && ctx.options.ar.anchors && store.supported(s);
    } catch {
      supported = false;
    }
    if (!s || !supported) return Promise.resolve(saveUnavailable());
    if (!nudged && anchorA && anchorB) return commitSave(anchorA, anchorB, false);
    // New anchors need an active frame: they are made in the next update.
    let resolve: (ok: boolean) => void = () => {};
    const promise = new Promise<boolean>((r) => {
      resolve = r;
    });
    pendingSave = { resolve, promise };
    return promise;
  }

  function saveAtCorrectedPoints(frame: XRFrame, ref: XRReferenceSpace): void {
    const request = pendingSave;
    if (!request) return;
    pendingSave = null;
    const create = frame.createAnchor?.bind(frame);
    if (!create || typeof XRRigidTransform === "undefined") {
      request.resolve(saveUnavailable());
      return;
    }
    const pa = pivotA();
    const pb = modelB.clone().applyMatrix4(correction);
    const token = pickToken;
    let made: Promise<XRAnchor>[];
    try {
      made = [pa, pb].map((p) =>
        withTimeout(
          create(new XRRigidTransform({ x: p.x, y: p.y, z: p.z }), ref),
          ANCHOR_TIMEOUT_MS,
          "anchor creation",
        ),
      );
    } catch {
      request.resolve(saveUnavailable());
      return;
    }
    Promise.allSettled(made).then((results) => {
      const anchors = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      if (anchors.length < 2 || token !== pickToken || !active) {
        for (const a of anchors) a.delete();
        request.resolve(token === pickToken && active ? saveUnavailable() : false);
        return;
      }
      commitSave(anchors[0], anchors[1], true).then(request.resolve);
    });
  }

  async function commitSave(a: XRAnchor, b: XRAnchor, fresh: boolean): Promise<boolean> {
    const s = session;
    const alignment = onsite;
    if (!s || !alignment) return false;
    const token = pickToken;
    const rev = revision;
    let ok = false;
    try {
      ok = await store.save(s, alignment.id, a, b);
    } catch (error) {
      console.warn("[llhil-webxr] the alignment could not be saved", error);
      ok = false;
    }
    if (!ok) {
      if (fresh) {
        a.delete();
        b.delete();
      }
      if (token === pickToken && active) saveUnavailable();
      return false;
    }
    persistent.add(a);
    persistent.add(b);
    if (token !== pickToken || !active) return true;
    if (fresh) {
      deleteAnchor(anchorA);
      deleteAnchor(anchorB);
      anchorA = a;
      anchorB = b;
    }
    // A nudge while saving: the saved points are a step behind, so it stays unsaved.
    if (rev === revision) {
      nudged = false;
      setState("saved");
    }
    return true;
  }

  async function forgetAlignment(id: string): Promise<void> {
    await store.forget(session, id);
    if (!active || onsite?.id !== id) return;
    // The anchors in use were the saved ones: they are no longer kept, so saving makes new ones.
    for (const a of [anchorA, anchorB]) if (a) persistent.delete(a);
    nudged = true;
    if (state === "saved") setState("aligned");
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
    if (onsite) stopOnsite();
    reticle.visible = false;
    reticle.removeFromParent();
    releaseTarget();
    ctx.scene.background = savedBackground;
    ctx.renderer.setClearAlpha(savedClearAlpha);
    hasHit = false;
    hitResult = null;
    phase = "aiming";
    session = null;
  }

  return {
    /** Takes effect at the next session start; a running session keeps its mode. */
    setAlignment(alignment: ARAlignment | null): void {
      requestedAlignment = alignment;
    },
    realign(): void {
      if (active && onsite) realign();
    },
    nudge(n: AlignmentNudge): void {
      if (!active || !onsite) return;
      const turnDeg = Number.isFinite(n.turnDeg) ? (n.turnDeg as number) : 0;
      const right = Number.isFinite(n.move?.[0]) ? (n.move?.[0] as number) : 0;
      const forward = Number.isFinite(n.move?.[1]) ? (n.move?.[1] as number) : 0;
      applyNudge(turnDeg, right, forward, Number.isFinite(n.lift) ? (n.lift as number) : 0);
    },
    saveAlignment,
    forgetAlignment,
    get alignmentState() {
      return active && onsite ? state : null;
    },
    /** Table-top: the model's turn about up, degrees (positive turns left seen from above). */
    get rotation(): number {
      return turn / DEG;
    },
    setRotation(degrees: number): void {
      if (!Number.isFinite(degrees)) return;
      turn = degrees * DEG;
      if (active && !onsite && phase !== "aiming") applyPlacement();
    },
    /**
     * Model scale factor (1 = 1:1). Before a session it sets the initial scale; once placed it
     * rescales about the placed point. Non-positive values are ignored.
     */
    setScale(s: number): void {
      if (!(s > 0) || !Number.isFinite(s)) return;
      scale = s;
      // On site the model stays at 1:1.
      if (active && !onsite && phase !== "aiming") applyPlacement();
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
      if (requestedAlignment) startOnsite(requestedAlignment);
    },
    update(frame: XRFrame, dt: number): void {
      if (!active) return;
      const ref = ctx.renderer.xr.getReferenceSpace();
      if (!ref) return;
      updateHit(frame, ref);
      if (onsite) {
        updateOnsite(frame, ref, dt);
      } else {
        updateAnchor(frame, ref);
        updateSticks(dt);
      }
      updateReticle();
      flushHud();
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
