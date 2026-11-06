import { Group, PerspectiveCamera, Scene, Vector3 } from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Emitter } from "../../src/events";
import type { KitContext, SessionHooks } from "../../src/internal";
import { resolveOptions } from "../../src/index";
import { applyTargetFrameRate, createSessionController, pickFrameRate } from "../../src/session";

/** The browser's session: an EventTarget whose end() fires 'end' once. */
class FakeSession extends EventTarget {
  ended = false;
  enabledFeatures: string[] | undefined;
  floorGranted: boolean;
  constructor(features: string[] | undefined, floorGranted = true) {
    super();
    this.enabledFeatures = features;
    this.floorGranted = floorGranted;
  }
  async end(): Promise<void> {
    if (this.ended) throw new Error("InvalidStateError");
    this.ended = true;
    this.dispatchEvent(new Event("end"));
  }
  async requestReferenceSpace(type: string): Promise<object> {
    if (type === "local-floor" && !this.floorGranted) throw new Error("NotSupportedError");
    return { type };
  }
}

interface Setup {
  calls: string[];
  requests: { mode: string; init: XRSessionInit }[];
  session: FakeSession;
  xr: any;
  renderer: any;
  ctx: KitContext;
  hooks: SessionHooks & { onStart: ReturnType<typeof vi.fn>; onEnd: ReturnType<typeof vi.fn> };
  base: object;
}

function setup(
  opts: {
    features?: string[] | undefined;
    floorGranted?: boolean;
    hands?: boolean;
    reject?: Error;
    parent?: object | null;
  } = {},
): Setup {
  const calls: string[] = [];
  const requests: Setup["requests"] = [];
  const session = new FakeSession(
    "features" in opts ? opts.features : ["local-floor"],
    opts.floorGranted ?? true,
  );
  const base = { sentinel: "base" };
  const xr = {
    isSessionSupported: vi.fn(async (mode: string) => mode === "immersive-vr"),
    requestSession: vi.fn(async (mode: string, init: XRSessionInit) => {
      calls.push(`requestSession:${mode}`);
      requests.push({ mode, init });
      if (opts.reject) throw opts.reject;
      return session;
    }),
  };
  vi.stubGlobal("navigator", { xr });

  const renderer = {
    domElement: { parentElement: "parent" in opts ? opts.parent : { id: "host" } },
    xr: {
      enabled: false,
      isPresenting: false,
      setFramebufferScaleFactor: (v: number) => calls.push(`framebufferScale:${v}`),
      setReferenceSpaceType: (t: string) => calls.push(`referenceSpaceType:${t}`),
      setSession: async (s: FakeSession) => {
        calls.push("setSession");
        // Mirrors three.js: its own end listener is registered when setSession is called.
        s.addEventListener("end", () => {
          renderer.xr.isPresenting = false;
          calls.push("three:end");
        });
        renderer.xr.isPresenting = true;
      },
      setFoveation: (v: number) => calls.push(`foveation:${v}`),
      getReferenceSpace: () => base,
    },
  };

  const scene = new Scene();
  const camera = new PerspectiveCamera(50, 1, 0.1, 1000);
  camera.position.set(1, 2, 3);
  camera.lookAt(0, 0, 0);
  const options = resolveOptions({
    renderer: renderer as any,
    scene,
    camera,
    hands: opts.hands,
    performance: { framebufferScale: 0.8, foveation: 0.5 },
  });
  const ctx = {
    renderer,
    scene,
    camera,
    options,
    events: new Emitter(),
    root: new Group(),
    up: new Vector3(0, 1, 0),
    mode: null,
    session: null,
  } as unknown as KitContext;

  const hooks = {
    onStart: vi.fn((_s: XRSession, mode: string) => {
      calls.push(`onStart:${mode}`);
      expect(renderer.xr.enabled).toBe(true);
    }),
    onEnd: vi.fn((mode: string) => {
      calls.push(`onEnd:${mode}`);
    }),
  };
  return { calls, requests, session, xr, renderer, ctx, hooks, base };
}

/** What three.js does to the user camera every XR frame. */
function moveCameraLikeXR(camera: PerspectiveCamera): void {
  camera.position.set(9, 1.6, -4);
  camera.quaternion.set(0, Math.SQRT1_2, 0, Math.SQRT1_2);
  camera.scale.set(1, 1, 1);
  camera.fov = 100;
  camera.near = 0.01;
  camera.far = 50;
  camera.zoom = 1;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("supports", () => {
  it("asks navigator.xr for each mode", async () => {
    const { ctx, hooks } = setup();
    const c = createSessionController(ctx, hooks);
    expect(await c.supports()).toEqual({ vr: true, ar: false });
  });

  it("treats a rejecting check as unsupported", async () => {
    const { ctx, hooks, xr } = setup();
    xr.isSessionSupported = vi.fn(async (mode: string) => {
      if (mode === "immersive-ar") throw new Error("SecurityError");
      return true;
    });
    const c = createSessionController(ctx, hooks);
    expect(await c.supports()).toEqual({ vr: true, ar: false });
  });

  it("is all false without navigator.xr", async () => {
    const { ctx, hooks } = setup();
    vi.stubGlobal("navigator", {});
    const c = createSessionController(ctx, hooks);
    expect(await c.supports()).toEqual({ vr: false, ar: false });
  });
});

describe("enter VR", () => {
  it("requests immersive-vr and configures renderer.xr in order", async () => {
    const { ctx, hooks, calls, requests, renderer, session, base } = setup();
    const c = createSessionController(ctx, hooks);
    await c.enter("vr");
    expect(requests[0]).toEqual({
      mode: "immersive-vr",
      init: {
        requiredFeatures: ["local-floor"],
        optionalFeatures: ["bounded-floor", "hand-tracking", "layers"],
      },
    });
    expect(calls).toEqual([
      "framebufferScale:0.8",
      "requestSession:immersive-vr",
      "referenceSpaceType:local-floor",
      "setSession",
      "foveation:0.5",
      "onStart:vr",
    ]);
    expect(renderer.xr.enabled).toBe(true);
    expect(hooks.onStart).toHaveBeenCalledWith(session, "vr", base);
  });

  it("leaves hand-tracking out when hands are off", async () => {
    const { ctx, hooks, requests } = setup({ hands: false });
    await createSessionController(ctx, hooks).enter("vr");
    expect(requests[0].init.optionalFeatures).toEqual(["bounded-floor", "layers"]);
  });

  it("calls requestSession synchronously, inside the user gesture", () => {
    const { ctx, hooks, xr } = setup();
    void createSessionController(ctx, hooks).enter("vr");
    expect(xr.requestSession).toHaveBeenCalledTimes(1);
  });

  it("rejects a second enter while one is in flight or a session runs", async () => {
    const { ctx, hooks, xr } = setup();
    const c = createSessionController(ctx, hooks);
    const first = c.enter("vr");
    await expect(c.enter("ar")).rejects.toThrow(/already starting/);
    await first;
    await expect(c.enter("vr")).rejects.toThrow(/session is active/);
    expect(xr.requestSession).toHaveBeenCalledTimes(1);
  });

  it("wraps a refused request, naming the mode and keeping the cause", async () => {
    const refusal = new Error("NotAllowedError");
    const { ctx, hooks, renderer } = setup({ reject: refusal });
    const c = createSessionController(ctx, hooks);
    const error = await c.enter("vr").catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/VR/);
    expect((error as Error).message).toMatch(/immersive-vr/);
    expect((error as Error).cause).toBe(refusal);
    expect(renderer.xr.enabled).toBe(false);
    expect(hooks.onStart).not.toHaveBeenCalled();
    // A failed enter does not block the next one.
    await expect(c.enter("vr")).rejects.toThrow(/immersive-vr/);
  });

  it("rejects without navigator.xr", async () => {
    const { ctx, hooks } = setup();
    vi.stubGlobal("navigator", {});
    await expect(createSessionController(ctx, hooks).enter("vr")).rejects.toThrow(/VR/);
  });
});

describe("enter AR", () => {
  it("requests immersive-ar with hit-test and a DOM overlay on the canvas parent", async () => {
    const { ctx, hooks, requests, renderer } = setup();
    await createSessionController(ctx, hooks).enter("ar");
    expect(requests[0]).toEqual({
      mode: "immersive-ar",
      init: {
        requiredFeatures: ["hit-test"],
        optionalFeatures: ["local-floor", "anchors", "dom-overlay", "hand-tracking"],
        domOverlay: { root: renderer.domElement.parentElement },
      },
    });
  });

  it("falls back to document.body as the overlay root", async () => {
    const body = { id: "body" };
    const { ctx, hooks, requests } = setup({ parent: null });
    vi.stubGlobal("document", { body });
    await createSessionController(ctx, hooks).enter("ar");
    expect(requests[0].init.domOverlay).toEqual({ root: body });
  });

  it("uses local-floor when granted, before setSession", async () => {
    const { ctx, hooks, calls } = setup({ features: ["hit-test", "local-floor"] });
    await createSessionController(ctx, hooks).enter("ar");
    expect(calls.indexOf("referenceSpaceType:local-floor")).toBeGreaterThan(-1);
    expect(calls.indexOf("referenceSpaceType:local-floor")).toBeLessThan(
      calls.indexOf("setSession"),
    );
  });

  it("uses local when local-floor was not granted", async () => {
    const { ctx, hooks, calls } = setup({ features: ["hit-test"] });
    await createSessionController(ctx, hooks).enter("ar");
    expect(calls).toContain("referenceSpaceType:local");
    expect(calls.indexOf("referenceSpaceType:local")).toBeLessThan(calls.indexOf("setSession"));
  });

  it("probes for local-floor where enabledFeatures is missing", async () => {
    const granted = setup({ features: undefined, floorGranted: true });
    await createSessionController(granted.ctx, granted.hooks).enter("ar");
    expect(granted.calls).toContain("referenceSpaceType:local-floor");

    const refused = setup({ features: undefined, floorGranted: false });
    await createSessionController(refused.ctx, refused.hooks).enter("ar");
    expect(refused.calls).toContain("referenceSpaceType:local");
  });
});

describe("session end", () => {
  it("restores the desktop camera when the browser ends the session, and calls onEnd once", async () => {
    const { ctx, hooks, session, calls, renderer } = setup();
    const camera = ctx.camera;
    const before = {
      position: camera.position.clone(),
      quaternion: camera.quaternion.clone(),
      scale: camera.scale.clone(),
      fov: camera.fov,
      near: camera.near,
      far: camera.far,
      zoom: camera.zoom,
    };
    const projection = camera.projectionMatrix.clone();
    const c = createSessionController(ctx, hooks);
    await c.enter("vr");
    moveCameraLikeXR(camera);
    camera.projectionMatrix.identity();

    await session.end();
    expect(camera.position.equals(before.position)).toBe(true);
    expect(camera.quaternion.equals(before.quaternion)).toBe(true);
    expect(camera.scale.equals(before.scale)).toBe(true);
    expect([camera.fov, camera.near, camera.far, camera.zoom]).toEqual([
      before.fov,
      before.near,
      before.far,
      before.zoom,
    ]);
    expect(camera.projectionMatrix.equals(projection)).toBe(true);
    expect(renderer.xr.enabled).toBe(false);
    expect(hooks.onEnd).toHaveBeenCalledTimes(1);
    expect(hooks.onEnd).toHaveBeenCalledWith("vr");
    // three.js cleans up first, so renderer.xr no longer presents when onEnd runs.
    expect(calls.indexOf("three:end")).toBeGreaterThan(-1);
    expect(calls.indexOf("three:end")).toBeLessThan(calls.indexOf("onEnd:vr"));

    session.dispatchEvent(new Event("end"));
    await c.exit();
    expect(hooks.onEnd).toHaveBeenCalledTimes(1);
  });

  it("exit() ends the session and resolves after the end handling", async () => {
    const { ctx, hooks, session } = setup();
    const c = createSessionController(ctx, hooks);
    await c.enter("ar");
    const saved = ctx.camera.position.clone();
    moveCameraLikeXR(ctx.camera);
    await c.exit();
    expect(session.ended).toBe(true);
    expect(hooks.onEnd).toHaveBeenCalledTimes(1);
    expect(hooks.onEnd).toHaveBeenCalledWith("ar");
    expect(ctx.camera.position.equals(saved)).toBe(true);
    // A new session can start afterwards.
    await c.enter("vr");
    expect(hooks.onStart).toHaveBeenCalledTimes(2);
  });

  it("exit() handles a session whose end event never comes", async () => {
    const { ctx, hooks, session } = setup();
    const c = createSessionController(ctx, hooks);
    await c.enter("vr");
    session.end = async () => {};
    await c.exit();
    expect(hooks.onEnd).toHaveBeenCalledTimes(1);
  });

  it("exit() without a session is a no-op", async () => {
    const { ctx, hooks } = setup();
    await createSessionController(ctx, hooks).exit();
    expect(hooks.onEnd).not.toHaveBeenCalled();
  });

  it("dispose() ends the session, restores the camera and stops listening", async () => {
    const { ctx, hooks, session } = setup();
    const c = createSessionController(ctx, hooks);
    await c.enter("vr");
    const saved = ctx.camera.position.clone();
    moveCameraLikeXR(ctx.camera);
    c.dispose();
    expect(ctx.camera.position.equals(saved)).toBe(true);
    expect(hooks.onEnd).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(session.ended).toBe(true));
    expect(hooks.onEnd).toHaveBeenCalledTimes(1);
  });

  it("ends the session and calls onEnd when onStart throws", async () => {
    const { ctx, hooks, session } = setup();
    hooks.onStart.mockImplementation(() => {
      throw new Error("module failed");
    });
    const c = createSessionController(ctx, hooks);
    await expect(c.enter("vr")).rejects.toThrow(/module failed/);
    expect(session.ended).toBe(true);
    expect(hooks.onEnd).toHaveBeenCalledTimes(1);
  });
});

describe("target frame rate", () => {
  it("picks the target, else the nearest lower rate offered", () => {
    expect(pickFrameRate(new Float32Array([72, 90, 120]), 72)).toBe(72);
    expect(pickFrameRate([60, 80, 90], 72)).toBe(60);
    expect(pickFrameRate([90, 120], 72)).toBeNull();
    expect(pickFrameRate([], 72)).toBeNull();
    expect(pickFrameRate(undefined, 72)).toBeNull();
    expect(pickFrameRate([72], 0)).toBeNull();
  });

  /** A session offering `rates`, whose updateTargetFrameRate resolves or rejects. */
  function rateSession(rates: number[] | undefined, reject?: Error) {
    const updateTargetFrameRate = vi.fn(async (_rate: number) => {
      if (reject) throw reject;
    });
    const session = {
      supportedFrameRates: rates && new Float32Array(rates),
      updateTargetFrameRate,
    };
    return { session: session as unknown as XRSession, updateTargetFrameRate };
  }

  it("asks for the target rate when it is offered", async () => {
    const { session, updateTargetFrameRate } = rateSession([72, 80, 90, 120]);
    const warn = vi.fn();
    await expect(applyTargetFrameRate(session, 72, warn)).resolves.toBe(72);
    expect(updateTargetFrameRate).toHaveBeenCalledWith(72);
    expect(warn).not.toHaveBeenCalled();
  });

  it("asks for the nearest lower rate, and nothing when none is lower or none is listed", async () => {
    const a = rateSession([60, 90]);
    await expect(applyTargetFrameRate(a.session, 72, vi.fn())).resolves.toBe(60);
    expect(a.updateTargetFrameRate).toHaveBeenCalledWith(60);
    const b = rateSession([90, 120]);
    await expect(applyTargetFrameRate(b.session, 72, vi.fn())).resolves.toBeNull();
    const c = rateSession(undefined);
    await expect(applyTargetFrameRate(c.session, 72, vi.fn())).resolves.toBeNull();
    expect(b.updateTargetFrameRate).not.toHaveBeenCalled();
    expect(c.updateTargetFrameRate).not.toHaveBeenCalled();
  });

  it("does nothing where the method is missing", async () => {
    const session = { supportedFrameRates: new Float32Array([72]) } as unknown as XRSession;
    const warn = vi.fn();
    await expect(applyTargetFrameRate(session, 72, warn)).resolves.toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });

  it("catches a refusal and warns", async () => {
    const { session } = rateSession([72], new Error("NotSupportedError"));
    const warn = vi.fn();
    await expect(applyTargetFrameRate(session, 72, warn)).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/72 Hz.*NotSupportedError/));
  });

  it("enter() applies performance.targetFrameRate after setSession, warning once per kit", async () => {
    const { ctx, hooks, session, calls } = setup();
    ctx.options.performance.targetFrameRate = 90;
    const s = session as unknown as Record<string, unknown>;
    s.supportedFrameRates = new Float32Array([72, 90]);
    s.updateTargetFrameRate = vi.fn(async (rate: number) => {
      calls.push(`frameRate:${rate}`);
      throw new Error("busy");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = createSessionController(ctx, hooks);
    await c.enter("vr");
    expect(calls.indexOf("frameRate:90")).toBeGreaterThan(calls.indexOf("setSession"));
    await c.exit();
    session.ended = false;
    await c.enter("vr");
    await vi.waitFor(() => expect(s.updateTargetFrameRate).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
