import { expect, type Page, test } from "@playwright/test";
import {
  angleDelta,
  clickXRButton,
  events,
  frames,
  head,
  lookDown,
  openHarness,
  poseController,
  pullTrigger,
  thumbstick,
  waitForEvent,
} from "./helpers";

// The kit's own behaviour under the emulated Quest 3. Written against the contracts in
// src/types.ts; the module stubs cannot pass them yet.

const ENTER_VR = /enter vr|open in vr/i;
const ENTER_AR = /view in ar|enter ar/i;

async function enterVR(page: Page): Promise<void> {
  await clickXRButton(page, ENTER_VR);
  await waitForEvent(page, "sessionstart");
  await frames(page, 3);
}

test("supports() reports VR and Enter VR starts a session", async ({ page }) => {
  await openHarness(page);
  const support = await page.evaluate(() => window.__kit.supports());
  expect(support.vr).toBe(true);

  await enterVR(page);
  expect(await page.evaluate(() => window.__kit.presenting)).toBe("vr");
  const [start] = await events(page, "sessionstart");
  expect(start.payload).toEqual({ mode: "vr" });
});

test("exit restores the desktop view and camera", async ({ page }) => {
  await openHarness(page);
  const before = await page.evaluate(() => window.__camera.position.toArray());
  await enterVR(page);

  await page.evaluate(() => window.__kit.exit());
  await waitForEvent(page, "sessionend");
  await frames(page, 2);
  expect(await page.evaluate(() => window.__kit.presenting)).toBeNull();
  const [end] = await events(page, "sessionend");
  expect(end.payload).toEqual({ mode: "vr" });
  const after = await page.evaluate(() => window.__camera.position.toArray());
  for (let i = 0; i < 3; i++) expect(after[i]).toBeCloseTo(before[i], 5);
});

test("teleport: a trigger pull on the floor moves the user there", async ({ page }) => {
  await openHarness(page);
  await enterVR(page);
  const start = await head(page);

  // In local-floor the head is at (0, 1.6, 0). The right controller is 1.5 m up, 0.25 m right and
  // 0.4 m ahead of it, pitched 30 degrees down. Controllers aim with a parabolic arc (7 m/s under
  // 9.81 m/s^2), so the landing point is where that arc meets the floor.
  const pitchDeg = -30;
  await poseController(page, "right", { position: [0.25, 1.5, -0.4], pitchDeg });
  await pullTrigger(page, "right");

  const teleport = await waitForEvent(page, "teleport");
  const [x, y, z] = teleport.payload.position as number[];
  const v = 7;
  const g = 9.81;
  const vUp = v * Math.sin((pitchDeg * Math.PI) / 180);
  const vAhead = v * Math.cos((pitchDeg * Math.PI) / 180);
  const t = (vUp + Math.sqrt(vUp * vUp + 2 * g * 1.5)) / g;
  const ahead = 0.4 + vAhead * t;
  // The same offset in the scene, turned by the user's yaw.
  const yaw = (start.yawDeg * Math.PI) / 180;
  const forward = [-Math.sin(yaw), -Math.cos(yaw)];
  const right = [Math.cos(yaw), -Math.sin(yaw)];
  const expected = [
    start.position[0] + 0.25 * right[0] + ahead * forward[0],
    start.position[2] + 0.25 * right[1] + ahead * forward[1],
  ];
  expect(y).toBeCloseTo(0, 1);
  expect(Math.hypot(x - expected[0], z - expected[1])).toBeLessThan(0.3);
});

test("snap turn: the right thumbstick turns the head by 30 degrees", async ({ page }) => {
  await openHarness(page);
  await enterVR(page);
  const before = await head(page);

  await thumbstick(page, "right", 1);
  await thumbstick(page, "right", 0);
  await frames(page, 3);

  const after = await head(page);
  // Right is clockwise seen from above: the counter-clockwise yaw drops by one snap.
  expect(angleDelta(before.yawDeg, after.yawDeg)).toBeCloseTo(-30, 0);
  // Turning happens about the head, so it stays in place.
  expect(
    Math.hypot(after.position[0] - before.position[0], after.position[2] - before.position[2]),
  ).toBeLessThan(0.05);
});

test("goTo('mezzanine') puts the head above the mezzanine floor", async ({ page }) => {
  await openHarness(page);
  await enterVR(page);

  await page.evaluate(() => window.__kit.goTo("mezzanine"));
  await waitForEvent(page, "viewpoint");
  await frames(page, 3);

  const { position } = await head(page);
  expect(position[1]).toBeGreaterThan(3);
  expect(position[0]).toBeCloseTo(0, 1);
  expect(position[2]).toBeCloseTo(-6, 1);
  const viewpoint = (await events(page, "viewpoint")).at(-1)!;
  expect(viewpoint.payload).toEqual({ id: "mezzanine" });
});

test("AR: a select on the floor places the model", async ({ page }) => {
  // The emulator ships no phone profile, so AR runs on the Quest 3 profile (passthrough AR) in the
  // synthetic living room; the harness spec checks that its hit-test answers.
  await openHarness(page, "ar");
  expect((await page.evaluate(() => window.__kit.supports())).ar).toBe(true);

  await clickXRButton(page, ENTER_AR);
  await waitForEvent(page, "sessionstart");
  expect(await page.evaluate(() => window.__kit.presenting)).toBe("ar");

  // Head and controller both aim at the floor, whichever ray the kit hit-tests from.
  await lookDown(page, 45);
  await poseController(page, "right", { position: [0.25, 1.5, -0.4], pitchDeg: -45 });
  await frames(page, 5);
  await pullTrigger(page, "right");

  const placed = await waitForEvent(page, "placed");
  const m = placed.payload.matrix as number[];
  // The model's origin lands on the floor in front of the user.
  expect(m[13]).toBeCloseTo(0, 1);
  expect(m[14]).toBeLessThan(0);
});

test("VR starts on the floor exactly below the desktop camera", async ({ page }) => {
  await openHarness(page);
  await enterVR(page);
  const { position } = await head(page);
  // The desktop camera stands at (0, 1.6, 5); the head lands on its floor point, eye height from the device.
  // The kit places the viewer pose; the rendered eye cameras sit about 2 cm ahead of it.
  expect(Math.abs(position[0])).toBeLessThan(0.05);
  expect(Math.abs(position[2] - 5)).toBeLessThan(0.05);
});

test("enter('vr', { viewpoint }) starts at that viewpoint, and an unknown one falls back", async ({
  page,
}) => {
  await openHarness(page);
  await page.evaluate(() => window.__kit.enter("vr", { viewpoint: "mezzanine" }));
  await waitForEvent(page, "sessionstart");
  await frames(page, 3);
  let { position } = await head(page);
  expect(position[1]).toBeGreaterThan(3);
  expect(position[2]).toBeCloseTo(-6, 1);
  await page.evaluate(() => window.__kit.exit());
  await waitForEvent(page, "sessionend");

  await page.evaluate(() => window.__kit.enter("vr", { viewpoint: "nowhere" }));
  await frames(page, 3);
  expect(await page.evaluate(() => window.__kit.presenting)).toBe("vr");
  ({ position } = await head(page));
  expect(position[2]).toBeCloseTo(5, 1);
});

test("dispose during a session ends it and leaves the desktop view", async ({ page }) => {
  await openHarness(page);
  await enterVR(page);
  await page.evaluate(() => window.__kit.dispose());
  await frames(page, 2);
  expect(await page.evaluate(() => window.__xrDevice.activeSession ?? null)).toBeNull();
  expect((await events(page, "sessionend")).length).toBe(1);
});
