import { expect, test } from "@playwright/test";
import { lookDown, openHarness, poseController, pullTrigger, thumbstick } from "./helpers";

// Proves the harness itself: the page loads, WebGL works and the emulated headset answers.
// It runs against the module stubs, so it touches the kit only to check it was created.

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.waitForFunction(() => document.body.dataset.ready === "true");
  expect(errors).toEqual([]);
});

test("the page renders with WebGL and exposes the kit", async ({ page }) => {
  const state = await page.evaluate(() => ({
    webgl2: window.__renderer.getContext() instanceof WebGL2RenderingContext,
    kit: typeof window.__kit?.update === "function",
    events: Array.isArray(window.__events),
    device: window.__xrDevice?.name,
  }));
  expect(state).toEqual({ webgl2: true, kit: true, events: true, device: "Meta Quest 3" });
});

test("the emulator is installed and supports immersive-vr", async ({ page }) => {
  const supported = await page.evaluate(() => navigator.xr?.isSessionSupported("immersive-vr"));
  expect(supported).toBe(true);
});

test("a raw immersive-vr session starts from a click and ends", async ({ page }) => {
  // WebXR wants user activation, so the request runs in a real click handler.
  await page.evaluate(() => {
    const button = document.createElement("button");
    button.id = "raw-enter";
    button.textContent = "raw enter";
    button.style.cssText = "position:fixed;top:8px;left:8px;z-index:2147483647";
    button.addEventListener("click", async () => {
      try {
        const session = await navigator.xr!.requestSession("immersive-vr", {
          requiredFeatures: ["local-floor"],
        });
        (window as any).__rawSession = session;
        button.dataset.state = "started";
      } catch (e) {
        button.dataset.state = `error: ${(e as Error).message}`;
      }
    });
    document.body.appendChild(button);
  });
  await page.click("#raw-enter");
  await expect(page.locator("#raw-enter")).toHaveAttribute("data-state", "started");

  const space = await page.evaluate(async () => {
    const session: XRSession = (window as any).__rawSession;
    const ref = await session.requestReferenceSpace("local-floor");
    return { space: ref instanceof XRReferenceSpace };
  });
  expect(space.space).toBe(true);

  const ended = await page.evaluate(async () => {
    const session: XRSession = (window as any).__rawSession;
    const done = new Promise<boolean>((resolve) =>
      session.addEventListener("end", () => resolve(true), { once: true }),
    );
    await session.end();
    return done;
  });
  expect(ended).toBe(true);
  expect(await page.evaluate(() => window.__xrDevice.activeSession ?? null)).toBeNull();
});

test("the emulator drives the right controller through three.js's XR loop", async ({ page }) => {
  // The same pose and trigger the kit specs use, checked here on a plain three.js session so
  // the driving itself is known to work before the kit modules land.
  await page.evaluate(() => {
    const renderer = window.__renderer;
    renderer.xr.enabled = true;
    const button = document.createElement("button");
    button.id = "three-enter";
    button.textContent = "three enter";
    button.style.cssText = "position:fixed;top:8px;left:8px;z-index:2147483647";
    button.addEventListener("click", async () => {
      const session = await navigator.xr!.requestSession("immersive-vr", {
        optionalFeatures: ["local-floor"],
      });
      const selects: string[] = [];
      session.addEventListener("select", (e) => selects.push(e.inputSource.handedness));
      (window as any).__selects = selects;
      await renderer.xr.setSession(session);
      button.dataset.state = "started";
    });
    document.body.appendChild(button);
  });
  await page.click("#three-enter");
  await expect(page.locator("#three-enter")).toHaveAttribute("data-state", "started");
  expect(await page.evaluate(() => window.__renderer.xr.isPresenting)).toBe(true);

  // Ray from 1.5 m high, 0.4 m ahead of the head, tilted to meet the floor 3 m ahead of it.
  const pitch = -(Math.atan2(1.5, 2.6) * 180) / Math.PI;
  await poseController(page, "right", { position: [0.25, 1.5, -0.4], pitchDeg: pitch });
  const hit = await page.evaluate(
    () =>
      new Promise<number[] | null>((resolve) => {
        const renderer = window.__renderer;
        const session = renderer.xr.getSession()!;
        session.requestAnimationFrame((_t, frame) => {
          const source = [...session.inputSources].find((s) => s.handedness === "right");
          const pose =
            source && frame.getPose(source.targetRaySpace, renderer.xr.getReferenceSpace()!);
          if (!pose) return resolve(null);
          const m = pose.transform.matrix;
          const [ox, oy, oz] = [m[12], m[13], m[14]];
          const [dx, dy, dz] = [-m[8], -m[9], -m[10]];
          const t = -oy / dy;
          resolve([ox + t * dx, oy + t * dy, oz + t * dz]);
        });
      }),
  );
  expect(hit).not.toBeNull();
  expect(hit![0]).toBeCloseTo(0.25, 2);
  expect(hit![2]).toBeCloseTo(-3, 2);

  await pullTrigger(page, "right");
  expect(await page.evaluate(() => (window as any).__selects)).toEqual(["right"]);

  await thumbstick(page, "right", 1);
  const axes = await page.evaluate(() => {
    const session = window.__renderer.xr.getSession()!;
    const source = [...session.inputSources].find((s) => s.handedness === "right");
    return source?.gamepad ? [...source.gamepad.axes] : null;
  });
  // xr-standard mapping: the thumbstick is axes 2 (x) and 3 (y).
  expect(axes?.[2]).toBe(1);
  await thumbstick(page, "right", 0);

  await page.evaluate(() => window.__renderer.xr.getSession()!.end());
  await expect.poll(() => page.evaluate(() => window.__renderer.xr.isPresenting)).toBe(false);
});

test("AR: the synthetic room answers hit-test on the floor", async ({ page }) => {
  await openHarness(page, "ar");
  expect(await page.evaluate(() => navigator.xr!.isSessionSupported("immersive-ar"))).toBe(true);
  await page.evaluate(() => {
    const button = document.createElement("button");
    button.id = "ar-enter";
    button.textContent = "ar enter";
    button.style.cssText = "position:fixed;top:8px;left:8px;z-index:2147483647";
    button.addEventListener("click", async () => {
      const renderer = window.__renderer;
      renderer.xr.enabled = true;
      const session = await navigator.xr!.requestSession("immersive-ar", {
        requiredFeatures: ["hit-test"],
        optionalFeatures: ["local-floor"],
      });
      await renderer.xr.setSession(session);
      const viewer = await session.requestReferenceSpace("viewer");
      (window as any).__hitSource = await session.requestHitTestSource!({ space: viewer });
      button.dataset.state = "started";
    });
    document.body.appendChild(button);
  });
  await page.click("#ar-enter");
  await expect(page.locator("#ar-enter")).toHaveAttribute("data-state", "started");

  // Look 45 degrees down from 1.6 m: the gaze meets the floor 1.6 m ahead.
  await lookDown(page, 45);
  const hits = await page.evaluate(
    () =>
      new Promise<number[][]>((resolve) => {
        const renderer = window.__renderer;
        const session = renderer.xr.getSession()!;
        session.requestAnimationFrame((_t, frame) => {
          const ref = renderer.xr.getReferenceSpace()!;
          const results = frame.getHitTestResults((window as any).__hitSource);
          resolve(
            results.map((r) => {
              const p = r.getPose(ref)!.transform.position;
              return [p.x, p.y, p.z];
            }),
          );
        });
      }),
  );
  expect(hits.length).toBeGreaterThan(0);
  expect(hits[0][1]).toBeCloseTo(0, 1);
  expect(hits[0][2]).toBeCloseTo(-1.6, 1);
  await page.evaluate(() => window.__renderer.xr.getSession()!.end());
});
