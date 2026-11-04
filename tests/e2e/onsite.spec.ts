import { expect, type Page, test } from "@playwright/test";
import {
  aimAt,
  alignmentEvents,
  angleDelta,
  distance,
  events,
  frames,
  modelMatrix,
  openHarness,
  pickPoint,
  transformPoint,
  waitForAlignmentState,
  yawOf,
} from "./helpers";

// 1:1 on site in the emulated Quest 3: the harness's alignment (id "e2e") has its marks at
// a = (0, 0, -1) and b = (0, 0, -2.2) in the scene. The user picks the real marks on the floor
// of the synthetic room, turned 10 degrees left about A and 0.3 m to the right of the model's,
// so the solve has a real turn and move to find.

type Vec3 = [number, number, number];

const TURN_DEG = 10;
const REAL_A: Vec3 = [0.3, 0, -1];
const REAL_B: Vec3 = [
  REAL_A[0] - 1.2 * Math.sin((TURN_DEG * Math.PI) / 180),
  0,
  REAL_A[2] - 1.2 * Math.cos((TURN_DEG * Math.PI) / 180),
];

async function alignment(page: Page): Promise<{ a: Vec3; b: Vec3 }> {
  return page.evaluate(() => {
    const { a, b } = window.__alignment!;
    return { a, b };
  });
}

/** Enters AR on site through the harness's button, as a user would. */
async function enterOnSite(page: Page): Promise<void> {
  const before = (await events(page, "sessionstart")).length;
  await page.click("#enter-on-site");
  await page.waitForFunction(
    (n) => window.__events.filter((e) => e.type === "sessionstart").length > n,
    before,
  );
  await frames(page, 3);
}

async function exitSession(page: Page): Promise<void> {
  const before = (await events(page, "sessionend")).length;
  await page.evaluate(() => window.__kit.exit());
  await page.waitForFunction(
    (n) => window.__events.filter((e) => e.type === "sessionend").length > n,
    before,
  );
}

/** Enters on site with nothing saved and picks both real marks. */
async function alignOnSite(page: Page): Promise<void> {
  await enterOnSite(page);
  await waitForAlignmentState(page, "pick-a");
  await pickPoint(page, REAL_A);
  await waitForAlignmentState(page, "pick-b");
  await pickPoint(page, REAL_B);
  await waitForAlignmentState(page, "aligned");
  await frames(page, 3);
}

test.describe("harness: on-site mode", () => {
  test("loads with ?mode=ar&alignment=1 and the emulator offers what on-site AR needs", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await openHarness(page, "ar", { alignment: true });
    expect(errors).toEqual([]);

    const state = await page.evaluate(async () => ({
      mode: window.__mode,
      alignment: window.__alignment,
      events: window.__alignmentEvents,
      button: !!document.getElementById("enter-on-site"),
      alignmentState: window.__kit.alignmentState,
      ar: await navigator.xr!.isSessionSupported("immersive-ar"),
      // The emulator's own session class; XRAnchor is checked on a real anchor below.
      restore: typeof XRSession.prototype.restorePersistentAnchor,
      remove: typeof XRSession.prototype.deletePersistentAnchor,
    }));
    expect(state.mode).toBe("ar");
    expect(state.alignment?.id).toBe("e2e");
    expect(distance(state.alignment!.a, state.alignment!.b)).toBeGreaterThan(1);
    expect(state.events).toEqual([]);
    expect(state.button).toBe(true);
    expect(state.alignmentState).toBeNull();
    expect(state.ar).toBe(true);
    expect(state.restore).toBe("function");
    expect(state.remove).toBe("function");
  });

  test("persistent anchors: made in a frame, kept across the session and a reload", async ({
    page,
  }) => {
    // The kit's on-site save and restore rest on this emulator behaviour; prove it on a raw
    // session so a regression in the emulator shows here, not as a kit failure.
    await openHarness(page, "ar", { alignment: true });
    await startRawAR(page);
    await page.evaluate(async () => {
      const session = window.__renderer.xr.getSession()!;
      const right = [...session.inputSources].find((s) => s.handedness === "right")!;
      (window as any).__hitSource = await session.requestHitTestSource!({
        space: right.targetRaySpace,
      });
    });
    await aimAt(page, REAL_A);

    const made = await page.evaluate(
      () =>
        new Promise<{ handle: string; hasHandleMethod: boolean; at: number[] }>(
          (resolve, reject) => {
            const renderer = window.__renderer;
            const session = renderer.xr.getSession()!;
            // A hit result makes an anchor only inside its own frame callback.
            session.requestAnimationFrame(async (_t, frame) => {
              try {
                const [hit] = frame.getHitTestResults((window as any).__hitSource);
                const anchor = await hit.createAnchor!();
                const hasHandleMethod =
                  typeof Object.getPrototypeOf(anchor).requestPersistentHandle === "function";
                const handle = await anchor.requestPersistentHandle!();
                session.requestAnimationFrame((_t2, f2) => {
                  const p = f2.getPose(anchor.anchorSpace, renderer.xr.getReferenceSpace()!)!
                    .transform.position;
                  resolve({ handle, hasHandleMethod, at: [p.x, p.y, p.z] });
                });
              } catch (error) {
                reject(error);
              }
            });
          },
        ),
    );
    expect(made.hasHandleMethod).toBe(true);
    expect(typeof made.handle).toBe("string");
    expect(distance(made.at, REAL_A)).toBeLessThan(0.005);
    await page.evaluate(() => window.__renderer.xr.getSession()!.end());

    await page.reload();
    await page.waitForFunction(() => document.body.dataset.ready === "true");
    await startRawAR(page);
    const restored = await page.evaluate(async (handle) => {
      const renderer = window.__renderer;
      const session = renderer.xr.getSession()! as XRSession & {
        persistentAnchors: readonly string[];
      };
      const anchor = await session.restorePersistentAnchor!(handle);
      return new Promise<{ listed: boolean; at: number[] }>((resolve) => {
        session.requestAnimationFrame((_t, frame) => {
          const p = frame.getPose(anchor.anchorSpace, renderer.xr.getReferenceSpace()!)!.transform
            .position;
          resolve({ listed: session.persistentAnchors.includes(handle), at: [p.x, p.y, p.z] });
        });
      });
    }, made.handle);
    expect(restored.listed).toBe(true);
    expect(distance(restored.at, made.at)).toBeLessThan(0.001);
    await page.evaluate(() => window.__renderer.xr.getSession()!.end());
  });
});

/** A plain three.js AR session with hit-test and anchors, started from a click. */
async function startRawAR(page: Page): Promise<void> {
  await page.evaluate(() => {
    const button = document.createElement("button");
    button.id = "raw-ar";
    button.textContent = "raw ar";
    button.style.cssText = "position:fixed;top:8px;left:8px;z-index:2147483647";
    button.addEventListener("click", async () => {
      const renderer = window.__renderer;
      renderer.xr.enabled = true;
      const session = await navigator.xr!.requestSession("immersive-ar", {
        requiredFeatures: ["hit-test", "anchors"],
        optionalFeatures: ["local-floor"],
      });
      await renderer.xr.setSession(session);
      button.dataset.state = "started";
    });
    document.body.appendChild(button);
  });
  await page.click("#raw-ar");
  await expect(page.locator("#raw-ar")).toHaveAttribute("data-state", "started");
  await frames(page, 2);
}

test.describe("on site", () => {
  // enabled at integration when K1 to K4 land
  test("entering on site with nothing saved waits for mark A", async ({ page }) => {
    await openHarness(page, "ar", { alignment: true });
    await enterOnSite(page);
    expect(await page.evaluate(() => window.__kit.presenting)).toBe("ar");
    await waitForAlignmentState(page, "pick-a");
    const states = (await alignmentEvents(page)).map((e) => e.state);
    // Looking for a saved alignment first is allowed; finding one is not.
    expect([["pick-a"], ["restoring", "pick-a"]]).toContainEqual(states);
    expect((await alignmentEvents(page)).every((e) => !e.restored && e.errorM === null)).toBe(true);
  });

  // enabled at integration when K1 to K4 land
  test("picking A then B aligns the model on the real marks", async ({ page }) => {
    await openHarness(page, "ar", { alignment: true });
    await enterOnSite(page);
    await waitForAlignmentState(page, "pick-a");

    await pickPoint(page, REAL_A);
    await waitForAlignmentState(page, "pick-b");
    await pickPoint(page, REAL_B);
    await waitForAlignmentState(page, "aligned");
    await frames(page, 3);

    const last = (await alignmentEvents(page)).at(-1)!;
    expect(last.state).toBe("aligned");
    expect(last.restored).toBe(false);
    expect(last.errorM).not.toBeNull();
    expect(last.errorM!).toBeLessThan(0.05);

    const { a, b } = await alignment(page);
    const m = await modelMatrix(page);
    expect(distance(transformPoint(m, a), REAL_A)).toBeLessThan(0.02);
    expect(distance(transformPoint(m, b), REAL_B)).toBeLessThan(0.02);
    // 1:1 and upright: a turn about up only.
    expect(Math.hypot(m[0], m[1], m[2])).toBeCloseTo(1, 3);
    expect(m[5]).toBeCloseTo(1, 3);
    expect(angleDelta(0, yawOf(m))).toBeCloseTo(TURN_DEG, 0);
  });

  // enabled at integration when K1 to K4 land
  test("nudge({ turnDeg: 1 }) turns the model about point A", async ({ page }) => {
    await openHarness(page, "ar", { alignment: true });
    await alignOnSite(page);
    const { a, b } = await alignment(page);
    const before = await modelMatrix(page);

    await page.evaluate(() => window.__kit.nudge({ turnDeg: 1 }));
    await frames(page, 3);
    const after = await modelMatrix(page);

    expect(distance(transformPoint(after, a), transformPoint(before, a))).toBeLessThan(0.001);
    expect(angleDelta(yawOf(before), yawOf(after))).toBeCloseTo(1, 1);
    // B, 1.2 m from A, swings by about 1.2 m * 1 degree.
    const swing = distance(transformPoint(after, b), transformPoint(before, b));
    expect(swing).toBeGreaterThan(0.015);
    expect(swing).toBeLessThan(0.027);
  });

  // enabled at integration when K1 to K4 land
  test("a saved alignment is restored in the next session", async ({ page }) => {
    await openHarness(page, "ar", { alignment: true });
    await alignOnSite(page);
    expect(await page.evaluate(() => window.__kit.saveAlignment())).toBe(true);
    await waitForAlignmentState(page, "saved");
    expect((await alignmentEvents(page)).at(-1)!.state).toBe("saved");
    const saved = await modelMatrix(page);
    await exitSession(page);

    const from = (await alignmentEvents(page)).length;
    await enterOnSite(page);
    await waitForAlignmentState(page, "saved");
    await frames(page, 3);
    const after = await alignmentEvents(page, from);
    expect(after.map((e) => e.state)).toEqual(["restoring", "saved"]);
    expect(after.at(-1)!.restored).toBe(true);

    const restored = await modelMatrix(page);
    const { a, b } = await alignment(page);
    expect(distance(transformPoint(restored, a), transformPoint(saved, a))).toBeLessThan(0.01);
    expect(distance(transformPoint(restored, b), transformPoint(saved, b))).toBeLessThan(0.01);
  });

  // enabled at integration when K1 to K4 land
  test("forgetAlignment drops the saved alignment", async ({ page }) => {
    await openHarness(page, "ar", { alignment: true });
    await alignOnSite(page);
    expect(await page.evaluate(() => window.__kit.saveAlignment())).toBe(true);
    await exitSession(page);

    await page.evaluate(() => window.__kit.forgetAlignment("e2e"));
    const from = (await alignmentEvents(page)).length;
    await enterOnSite(page);
    await waitForAlignmentState(page, "pick-a");
    // Long enough for a late restore to show up, were one still pending.
    await frames(page, 10);
    expect(await page.evaluate(() => window.__kit.alignmentState)).toBe("pick-a");
    const after = await alignmentEvents(page, from);
    expect(after.some((e) => e.state === "saved" || e.restored)).toBe(false);
  });
});
