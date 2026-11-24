import { expect, type Page } from "@playwright/test";
import type { AlignmentState } from "../../src/types";
import type { HarnessAlignmentEvent, HarnessEvent } from "./harness/harness";

type Vec3 = [number, number, number];

/**
 * Opens the harness and waits until it (and in AR, the synthetic room) is ready. With
 * `alignment`, AR offers the harness's on-site alignment (id "e2e") through its own button; with
 * `demo`, the scene is the example viewer's demo building; with `panels`, the kit has the example
 * viewer's VR side panels.
 */
export async function openHarness(
  page: Page,
  mode: "vr" | "ar" = "vr",
  options: { alignment?: boolean; demo?: boolean; panels?: boolean } = {},
): Promise<void> {
  let query = mode === "ar" ? (options.alignment ? "/?mode=ar&alignment=1" : "/?mode=ar") : "/";
  // The example viewer's demo building instead of the plain ground and block.
  if (options.demo) query += query.includes("?") ? "&scene=demo" : "?scene=demo";
  // The example viewer's VR side panels.
  if (options.panels) query += query.includes("?") ? "&panels=1" : "?panels=1";
  await page.goto(query);
  await page.waitForFunction(() => document.body.dataset.ready === "true");
}

/**
 * Waits for `count` frames: XR frames while a session runs (the emulator drives them from the
 * session), window frames otherwise. Button and pose changes land on the next frame.
 */
export async function frames(page: Page, count = 3): Promise<void> {
  await page.evaluate(async (n) => {
    for (let i = 0; i < n; i++) {
      const session = window.__xrDevice.activeSession;
      await new Promise<void>((resolve) => {
        if (session) session.requestAnimationFrame(() => resolve());
        else requestAnimationFrame(() => resolve());
      });
    }
  }, count);
}

/** The kit events recorded so far, optionally of one type. */
export async function events(page: Page, type?: HarnessEvent["type"]): Promise<HarnessEvent[]> {
  const all = await page.evaluate(() => window.__events);
  return type ? all.filter((e) => e.type === type) : all;
}

/** Waits until the harness has recorded an event of this type and returns the latest one. */
export async function waitForEvent(page: Page, type: HarnessEvent["type"]): Promise<HarnessEvent> {
  await page.waitForFunction((t) => window.__events.some((e) => e.type === t), type);
  const list = await events(page, type);
  return list[list.length - 1];
}

/**
 * Poses an emulated controller in the emulator's global space, which is the `local-floor` space.
 * `pitchDeg` tilts the ray up (positive) or down (negative); `yawDeg` turns it left.
 */
export async function poseController(
  page: Page,
  hand: "left" | "right",
  pose: { position: [number, number, number]; pitchDeg?: number; yawDeg?: number },
): Promise<void> {
  await page.evaluate(
    ({ hand, pose }) => {
      const c = window.__xrDevice.controllers[hand]!;
      const p = ((pose.pitchDeg ?? 0) * Math.PI) / 360;
      const y = ((pose.yawDeg ?? 0) * Math.PI) / 360;
      // q = yaw(Y) * pitch(X), both as half angles.
      const [sp, cp, sy, cy] = [Math.sin(p), Math.cos(p), Math.sin(y), Math.cos(y)];
      c.position.set(...pose.position);
      c.quaternion.set(cy * sp, sy * cp, -sy * sp, cy * cp);
    },
    { hand, pose },
  );
  await frames(page, 2);
}

/** Pitches the emulated headset down by `degrees`, keeping its position and yaw at zero. */
export async function lookDown(page: Page, degrees: number): Promise<void> {
  await page.evaluate((deg) => {
    const half = (-deg * Math.PI) / 360;
    window.__xrDevice.quaternion.set(Math.sin(half), 0, 0, Math.cos(half));
  }, degrees);
  await frames(page, 2);
}

/** Where the right controller aims from in the on-site specs: ahead of and below the head. */
export const CONTROLLER_ORIGIN: Vec3 = [0.25, 1.5, -0.4];

/** Yaw (left positive, 0 along -Z) and pitch (up positive) of the direction from `from` to `to`. */
function yawPitch(from: Vec3, to: Vec3): { yawDeg: number; pitchDeg: number } {
  const [dx, dy, dz] = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  return {
    yawDeg: (Math.atan2(-dx, -dz) * 180) / Math.PI,
    pitchDeg: (Math.atan2(dy, Math.hypot(dx, dz)) * 180) / Math.PI,
  };
}

/**
 * Turns the headset and the right controller (from `CONTROLLER_ORIGIN`) towards a point of the
 * emulator's global (`local-floor`) space, so whichever ray the kit hit-tests from meets it.
 */
export async function aimAt(page: Page, target: Vec3): Promise<void> {
  const headAt = await page.evaluate(() => {
    const p = window.__xrDevice.position;
    return [p.x, p.y, p.z] as Vec3;
  });
  const head = yawPitch(headAt, target);
  await page.evaluate(({ yawDeg, pitchDeg }) => {
    const [p, y] = [(pitchDeg * Math.PI) / 360, (yawDeg * Math.PI) / 360];
    const [sp, cp, sy, cy] = [Math.sin(p), Math.cos(p), Math.sin(y), Math.cos(y)];
    window.__xrDevice.quaternion.set(cy * sp, sy * cp, -sy * sp, cy * cp);
  }, head);
  await poseController(page, "right", {
    position: CONTROLLER_ORIGIN,
    ...yawPitch(CONTROLLER_ORIGIN, target),
  });
  // Hit-test results for the new ray arrive with the next frames.
  await frames(page, 3);
}

/** Aims at a real (emulated) floor point and pulls the right trigger there. */
export async function pickPoint(page: Page, point: Vec3): Promise<void> {
  await aimAt(page, point);
  await pullTrigger(page, "right");
}

/** The alignment events recorded so far, from index `from` on. */
export async function alignmentEvents(page: Page, from = 0): Promise<HarnessAlignmentEvent[]> {
  return (await page.evaluate(() => window.__alignmentEvents)).slice(from);
}

/** Waits until the kit's alignment state is `state`. */
export async function waitForAlignmentState(page: Page, state: AlignmentState): Promise<void> {
  await page.waitForFunction((s) => window.__kit.alignmentState === s, state);
}

/**
 * The model's world matrix (column-major). The harness model is the scene, which the kit cannot
 * move; it moves the scene's content instead, so this is the world matrix of the ground's parent.
 */
export async function modelMatrix(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const parent = window.__scene.getObjectByName("ground")!.parent!;
    parent.updateWorldMatrix(true, false);
    return [...parent.matrixWorld.elements];
  });
}

/** Applies a column-major 4x4 matrix to a point. */
export function transformPoint(m: readonly number[], p: readonly number[]): Vec3 {
  const [x, y, z] = p;
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

/** Yaw in degrees of a column-major matrix's turn about Y, the convention of `head()`. */
export function yawOf(m: readonly number[]): number {
  const [fx, fz] = [-m[8], -m[10]];
  return (Math.atan2(-fx, -fz) * 180) / Math.PI;
}

/** Distance between two points. */
export function distance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Presses and releases the trigger through the emulator, holding it for a few frames. */
export async function pullTrigger(page: Page, hand: "left" | "right" = "right"): Promise<void> {
  const set = (value: number) =>
    page.evaluate(
      ({ hand, value }) => window.__xrDevice.controllers[hand]!.updateButtonValue("trigger", value),
      { hand, value },
    );
  await set(1);
  await frames(page, 5);
  await set(0);
  await frames(page, 5);
}

/** Sets a button of an emulated controller ("squeeze", "b-button", "y-button", ...). */
export async function setButton(
  page: Page,
  hand: "left" | "right",
  id: string,
  value: number,
): Promise<void> {
  await page.evaluate(
    ({ hand, id, value }) => window.__xrDevice.controllers[hand]!.updateButtonValue(id, value),
    { hand, id, value },
  );
  await frames(page, 3);
}

/** Presses and releases a button of an emulated controller, holding it for a few frames. */
export async function pressButton(page: Page, hand: "left" | "right", id: string): Promise<void> {
  await setButton(page, hand, id, 1);
  await setButton(page, hand, id, 0);
}

/** Snap turn as the kit maps it: grip held, stick pushed sideways and back, grip released. */
export async function gripTurn(page: Page, hand: "left" | "right", x: number): Promise<void> {
  await setButton(page, hand, "squeeze", 1);
  await thumbstick(page, hand, x);
  await thumbstick(page, hand, 0);
  await setButton(page, hand, "squeeze", 0);
}

/**
 * Holds a thumbstick at (x, y) until `done` (evaluated in the page) is true or `timeoutMs` passes,
 * then centres it and lets a few frames settle.
 */
export async function holdStickUntil(
  page: Page,
  hand: "left" | "right",
  stick: { x?: number; y?: number },
  done: string,
  timeoutMs = 15_000,
): Promise<void> {
  await thumbstick(page, hand, stick.x ?? 0, stick.y ?? 0);
  try {
    await page.waitForFunction(done, undefined, { timeout: timeoutMs, polling: 50 });
  } finally {
    await thumbstick(page, hand, 0, 0);
    await frames(page, 3);
  }
}

/** Moves a thumbstick through the emulator and holds it for a few frames. */
export async function thumbstick(
  page: Page,
  hand: "left" | "right",
  x: number,
  y = 0,
): Promise<void> {
  await page.evaluate(
    ({ hand, x, y }) => window.__xrDevice.controllers[hand]!.updateAxes("thumbstick", x, y),
    { hand, x, y },
  );
  await frames(page, 5);
}

/**
 * The head in scene coordinates, from three.js's XR camera: position and yaw in degrees
 * (counter-clockwise seen from above, 0 along -Z), the convention of the kit's math.ts.
 */
export async function head(page: Page): Promise<{ position: number[]; yawDeg: number }> {
  return page.evaluate(() => {
    const e = window.__renderer.xr.getCamera().matrixWorld.elements;
    // A camera looks along its local -Z: the negated third column.
    const [fx, fz] = [-e[8], -e[10]];
    return { position: [e[12], e[13], e[14]], yawDeg: (Math.atan2(-fx, -fz) * 180) / Math.PI };
  });
}

/** Signed smallest difference b - a between two angles in degrees. */
export function angleDelta(a: number, b: number): number {
  return ((((b - a + 180) % 360) + 360) % 360) - 180;
}

/** Clicks the kit's button whose label matches, as a user would. */
export async function clickXRButton(page: Page, name: RegExp): Promise<void> {
  const button = page.getByRole("button", { name });
  await expect(button).toBeVisible();
  await button.click();
}
