import type { Quaternion, Vector3 } from "three";
import type { KitContext, SessionController, SessionHooks } from "./internal";
import type { XRMode, XRSupport } from "./types";

const SESSION_TYPE: Record<XRMode, XRSessionMode> = {
  vr: "immersive-vr",
  ar: "immersive-ar",
};

/** The desktop camera as it was before the session; three.js overwrites it every XR frame. */
interface CameraState {
  position: Vector3;
  quaternion: Quaternion;
  scale: Vector3;
  fov: number;
  near: number;
  far: number;
  zoom: number;
}

interface Active {
  session: XRSession;
  mode: XRMode;
  camera: CameraState;
  /** `renderer.xr.enabled` before the kit switched it on. */
  xrWasEnabled: boolean;
  /** True once `hooks.onStart` ran: only then does `hooks.onEnd` run. */
  started: boolean;
  ended: boolean;
  onEnd: () => void;
  whenEnded: Promise<void>;
  resolveEnded: () => void;
}

function xrSystem(): XRSystem | undefined {
  return typeof navigator === "undefined" ? undefined : navigator.xr;
}

async function isSupported(xr: XRSystem, mode: XRSessionMode): Promise<boolean> {
  try {
    return (await xr.isSessionSupported(mode)) === true;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The target rate when the browser offers it, else the nearest lower one it offers, else null. */
export function pickFrameRate(
  supported: ArrayLike<number> | null | undefined,
  target: number,
): number | null {
  if (!supported || !(target > 0)) return null;
  let best: number | null = null;
  for (let i = 0; i < supported.length; i++) {
    const rate = supported[i];
    if (rate === target) return rate;
    if (rate < target && (best === null || rate > best)) best = rate;
  }
  return best;
}

/** Frame-rate members of XRSession, missing from older browsers and type definitions. */
type FrameRateSession = XRSession & {
  supportedFrameRates?: Float32Array | readonly number[] | null;
  frameRate?: number;
  updateTargetFrameRate?: (rate: number) => Promise<void>;
};

/**
 * Asks the session for `target` Hz (or the nearest lower rate it offers). Resolves with the rate
 * asked for, or null when the browser offers no choice or refused; `warn` runs on a refusal.
 */
export async function applyTargetFrameRate(
  session: XRSession,
  target: number,
  warn: (message: string) => void,
): Promise<number | null> {
  const s = session as FrameRateSession;
  if (typeof s.updateTargetFrameRate !== "function") return null;
  const rate = pickFrameRate(s.supportedFrameRates, target);
  if (rate === null) return null;
  try {
    await s.updateTargetFrameRate(rate);
    return rate;
  } catch (error) {
    warn(`[llhil-webxr] could not set the frame rate to ${rate} Hz: ${errorMessage(error)}`);
    return null;
  }
}

/**
 * Starts and ends WebXR sessions on the host's renderer, and puts the desktop camera back
 * where it was when a session ends.
 */
export function createSessionController(ctx: KitContext, hooks: SessionHooks): SessionController {
  const { renderer, camera } = ctx;
  let active: Active | null = null;
  let entering = false;
  let warnedFrameRate = false;
  const warnFrameRateOnce = (message: string) => {
    if (warnedFrameRate) return;
    warnedFrameRate = true;
    console.warn(message);
  };

  function saveCamera(): CameraState {
    return {
      position: camera.position.clone(),
      quaternion: camera.quaternion.clone(),
      scale: camera.scale.clone(),
      fov: camera.fov,
      near: camera.near,
      far: camera.far,
      zoom: camera.zoom,
    };
  }

  function restoreCamera(state: CameraState): void {
    camera.position.copy(state.position);
    camera.quaternion.copy(state.quaternion);
    camera.scale.copy(state.scale);
    camera.fov = state.fov;
    camera.near = state.near;
    camera.far = state.far;
    camera.zoom = state.zoom;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
  }

  /** Runs once per session, whoever ended it. */
  function finish(state: Active): void {
    if (state.ended) return;
    state.ended = true;
    state.session.removeEventListener("end", state.onEnd);
    if (active === state) active = null;
    restoreCamera(state.camera);
    renderer.xr.enabled = state.xrWasEnabled;
    try {
      if (state.started) hooks.onEnd(state.mode);
    } finally {
      state.resolveEnded();
    }
  }

  function endSession(state: Active): Promise<void> {
    if (!state.ended) {
      // end() rejects when the session is already over; either way the handling below runs.
      Promise.resolve()
        .then(() => state.session.end())
        .catch(() => {})
        .finally(() => finish(state));
    }
    return state.whenEnded;
  }

  async function referenceSpaceType(
    session: XRSession,
    mode: XRMode,
  ): Promise<XRReferenceSpaceType> {
    if (mode === "vr") return "local-floor";
    const granted = (session as XRSession & { enabledFeatures?: readonly string[] })
      .enabledFeatures;
    if (Array.isArray(granted)) return granted.includes("local-floor") ? "local-floor" : "local";
    // Without enabledFeatures, ask: three.js's setSession fails on a type the session lacks.
    try {
      await session.requestReferenceSpace("local-floor");
      return "local-floor";
    } catch {
      return "local";
    }
  }

  function sessionInit(mode: XRMode): XRSessionInit {
    const hands = ctx.options.hands ? ["hand-tracking"] : [];
    if (mode === "vr") {
      return {
        requiredFeatures: ["local-floor"],
        optionalFeatures: ["bounded-floor", ...hands, "layers"],
      };
    }
    const root = renderer.domElement.parentElement ?? document.body;
    return {
      requiredFeatures: ["hit-test"],
      optionalFeatures: ["local-floor", "anchors", "dom-overlay", ...hands],
      domOverlay: { root },
    };
  }

  async function start(mode: XRMode): Promise<void> {
    const xr = xrSystem();
    if (!xr)
      throw new Error(`[llhil-webxr] cannot start ${mode.toUpperCase()}: WebXR is not available`);

    const savedCamera = saveCamera();
    const xrWasEnabled = renderer.xr.enabled;
    renderer.xr.enabled = true;
    // Only takes effect before setSession: three.js ignores it while presenting.
    renderer.xr.setFramebufferScaleFactor(ctx.options.performance.framebufferScale);

    let session: XRSession;
    try {
      // Called before any await so the click's user activation still holds.
      session = await xr.requestSession(SESSION_TYPE[mode], sessionInit(mode));
    } catch (error) {
      renderer.xr.enabled = xrWasEnabled;
      throw new Error(
        `[llhil-webxr] could not start a ${mode.toUpperCase()} session (${SESSION_TYPE[mode]}): ${errorMessage(error)}`,
        { cause: error },
      );
    }

    let resolveEnded!: () => void;
    const whenEnded = new Promise<void>((resolve) => {
      resolveEnded = resolve;
    });
    const state: Active = {
      session,
      mode,
      camera: savedCamera,
      xrWasEnabled,
      started: false,
      ended: false,
      onEnd: () => finish(state),
      whenEnded,
      resolveEnded,
    };
    active = state;
    session.addEventListener("end", state.onEnd);

    try {
      const type = await referenceSpaceType(session, mode);
      if (state.ended) throw new Error("the session ended while starting");
      renderer.xr.setReferenceSpaceType(type);
      // Re-added after setSession registers three.js's own 'end' listener, so onEnd runs once
      // renderer.xr has stopped presenting (a host resizing on sessionend is not refused).
      session.removeEventListener("end", state.onEnd);
      const setting = renderer.xr.setSession(session);
      session.addEventListener("end", state.onEnd);
      await setting;
      if (state.ended) throw new Error("the session ended while starting");
      renderer.xr.setFoveation(ctx.options.performance.foveation);
      // Not awaited: the session runs at its default rate until the browser switches.
      void applyTargetFrameRate(
        session,
        ctx.options.performance.targetFrameRate,
        warnFrameRateOnce,
      );
      const base = renderer.xr.getReferenceSpace();
      if (!base) throw new Error("no reference space");
      state.started = true;
      hooks.onStart(session, mode, base);
    } catch (error) {
      await endSession(state);
      throw new Error(
        `[llhil-webxr] could not start a ${mode.toUpperCase()} session (${SESSION_TYPE[mode]}): ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  return {
    async supports(): Promise<XRSupport> {
      const xr = xrSystem();
      if (!xr) return { vr: false, ar: false };
      const [vr, ar] = await Promise.all([
        isSupported(xr, "immersive-vr"),
        isSupported(xr, "immersive-ar"),
      ]);
      return { vr, ar };
    },

    /**
     * Requests an immersive session and hands it to `renderer.xr`.
     *
     * Must be called from a user gesture (a click or tap handler): WebXR refuses
     * `requestSession` without user activation. The request is made synchronously, before the
     * first await, so a call straight from the handler keeps the activation.
     *
     * Rejects when a session is active or another `enter` is in flight, and when the browser
     * refuses the session; the error names the mode and keeps the browser's error as `cause`.
     */
    async enter(mode: XRMode): Promise<void> {
      if (active || entering) {
        throw new Error(
          `[llhil-webxr] cannot start ${mode.toUpperCase()}: ${active ? `a ${active.mode.toUpperCase()} session is active` : "a session is already starting"}`,
        );
      }
      entering = true;
      try {
        await start(mode);
      } finally {
        entering = false;
      }
    },

    /** Ends the session; resolves once the camera is restored and `onEnd` ran. */
    exit(): Promise<void> {
      return active ? endSession(active) : Promise.resolve();
    },

    /** Ends any session now: the camera is restored and `onEnd` runs synchronously. */
    dispose(): void {
      const state = active;
      if (!state) return;
      state.session.removeEventListener("end", state.onEnd);
      Promise.resolve()
        .then(() => state.session.end())
        .catch(() => {});
      finish(state);
    },
  };
}
