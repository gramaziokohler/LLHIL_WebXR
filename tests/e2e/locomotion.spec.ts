import { expect, type Page, test } from "@playwright/test";
import {
  angleDelta,
  clickXRButton,
  events,
  frames,
  gripTurn,
  head,
  holdStickUntil,
  lookDown,
  openHarness,
  poseController,
  pressButton,
  pullTrigger,
  setButton,
  thumbstick,
  waitForEvent,
} from "./helpers";

// Thumbstick locomotion in the emulated Quest 3. The harness scene: a 20 m ground plane centred
// on the origin, and a 3 m high block (x -2..2, z -8..-4) that is a wall at ground level. VR
// starts on the floor below the desktop camera, at (0, 0, 5), looking along -Z at the block.

async function enterVR(page: Page): Promise<void> {
  await clickXRButton(page, /enter vr|open in vr/i);
  await waitForEvent(page, "sessionstart");
  await frames(page, 3);
}

/** Head (eye) z, as the page sees it. */
const HEAD_Z = "window.__renderer.xr.getCamera().matrixWorld.elements[14]";

/** Waits until the head stops moving along z for a few frames, and returns it. */
async function settled(page: Page): Promise<number[]> {
  let last = (await head(page)).position;
  for (let i = 0; i < 20; i++) {
    await frames(page, 5);
    const now = (await head(page)).position;
    if (Math.abs(now[2] - last[2]) < 1e-4) return now;
    last = now;
  }
  return last;
}

test("walk is the default: the stick walks forward, on the ground at eye height", async ({
  page,
}) => {
  await openHarness(page);
  expect(await page.evaluate(() => window.__kit.locomotion.mode)).toBe("walk");
  await enterVR(page);
  const start = await head(page);

  await holdStickUntil(page, "right", { y: -1 }, `${HEAD_Z} < ${start.position[2] - 2}`);
  const after = await settled(page);
  expect(start.position[2] - after[2]).toBeGreaterThan(2);
  // Straight ahead, and the eye stays at the same height above the flat ground.
  expect(Math.abs(after[0] - start.position[0])).toBeLessThan(0.05);
  expect(after[1]).toBeCloseTo(start.position[1], 2);
  // Walking is not teleporting.
  expect(await events(page, "teleport")).toHaveLength(0);
});

test("walk: the left stick strafes, relative to where the head looks", async ({ page }) => {
  await openHarness(page);
  await enterVR(page);
  const start = await head(page);
  await holdStickUntil(
    page,
    "left",
    { x: 1 },
    `
    window.__renderer.xr.getCamera().matrixWorld.elements[12] > ${start.position[0] + 1}`,
  );
  const after = (await head(page)).position;
  expect(after[0] - start.position[0]).toBeGreaterThan(1);
  expect(Math.abs(after[2] - start.position[2])).toBeLessThan(0.05);
});

test("walk: the block's wall stops the user 0.25 m short of it", async ({ page }) => {
  await openHarness(page);
  await page.evaluate(() => window.__kit.setLocomotion({ speed: 6 }));
  await enterVR(page);

  // Push well past the wall's distance (9 m at 6 m/s), then let go.
  await thumbstick(page, "right", 0, -1);
  await page.waitForTimeout(2500);
  const stopped = await settled(page);
  await thumbstick(page, "right", 0, 0);
  // The wall face is at z = -4; the feet stop 0.25 m from it (the eye sits ~2 cm ahead).
  expect(stopped[2]).toBeGreaterThan(-4 + 0.15);
  expect(stopped[2]).toBeLessThan(-4 + 0.35);
  expect(stopped[1]).toBeGreaterThan(1);
  expect(stopped[1]).toBeLessThan(2);
});

test("walk: no walking off the ground's edge into the void", async ({ page }) => {
  await openHarness(page);
  await page.evaluate(() => window.__kit.setLocomotion({ speed: 6 }));
  await enterVR(page);
  const start = await head(page);
  // Backwards: the ground ends at z = 10, 5 m behind.
  await thumbstick(page, "right", 0, 1);
  await page.waitForTimeout(2000);
  const stopped = await settled(page);
  await thumbstick(page, "right", 0, 0);
  expect(stopped[2]).toBeGreaterThan(9.5);
  expect(stopped[2]).toBeLessThanOrEqual(10.1);
  expect(stopped[1]).toBeCloseTo(start.position[1], 2);
});

test("fly: looking up, the stick rises; switching back to walk lands on the ground", async ({
  page,
}) => {
  await openHarness(page);
  await enterVR(page);
  await page.evaluate(() => window.__kit.setLocomotion({ mode: "fly", speed: 3 }));
  expect((await events(page, "locomotion")).at(-1)?.payload).toEqual({ mode: "fly" });
  const start = await head(page);

  // Look 45 degrees up.
  await lookDown(page, -45);
  await holdStickUntil(
    page,
    "right",
    { y: -1 },
    `
    window.__renderer.xr.getCamera().matrixWorld.elements[13] > ${start.position[1] + 1}`,
  );
  const high = (await head(page)).position;
  expect(high[1] - start.position[1]).toBeGreaterThan(1);
  expect(start.position[2] - high[2]).toBeGreaterThan(0.7);

  await page.evaluate(() => window.__kit.setLocomotion({ mode: "walk" }));
  await page.waitForFunction(
    `window.__renderer.xr.getCamera().matrixWorld.elements[13] < ${start.position[1] + 0.05}`,
  );
  const landed = await settled(page);
  expect(landed[1]).toBeCloseTo(start.position[1], 1);
});

test("teleport mode: the stick does not move the user, the trigger still teleports", async ({
  page,
}) => {
  await openHarness(page);
  await enterVR(page);
  await page.evaluate(() => window.__kit.setLocomotion({ mode: "teleport" }));
  const start = await head(page);
  await thumbstick(page, "right", 0, -1);
  await frames(page, 30);
  await thumbstick(page, "right", 0, 0);
  const after = (await head(page)).position;
  expect(Math.hypot(after[0] - start.position[0], after[2] - start.position[2])).toBeLessThan(0.01);
  expect(await events(page, "teleport")).toHaveLength(0);

  // The trigger is the way to move: aim at the floor ahead and pull.
  await poseController(page, "right", { position: [0.25, 1.5, -0.4], pitchDeg: -30 });
  await pullTrigger(page, "right");
  const teleport = await waitForEvent(page, "teleport");
  expect((teleport.payload.position as number[])[2]).toBeLessThan(start.position[2] - 1);
});

test("turn: grip + stick snap turns with either hand; the stick alone does not turn", async ({
  page,
}) => {
  await openHarness(page);
  await enterVR(page);
  const before = await head(page);
  await gripTurn(page, "left", -1);
  await frames(page, 3);
  const after = await head(page);
  expect(angleDelta(before.yawDeg, after.yawDeg)).toBeCloseTo(30, 0);

  // Sideways without the grip strafes; the facing stays.
  await thumbstick(page, "right", 1);
  await thumbstick(page, "right", 0);
  expect(angleDelta(after.yawDeg, (await head(page)).yawDeg)).toBeCloseTo(0, 0);
});

test("turn: smooth turn while grip + stick are held", async ({ page }) => {
  await openHarness(page);
  await page.evaluate(() =>
    window.__kit.setLocomotion({ turn: "smooth", smoothDegreesPerSecond: 90 }),
  );
  await enterVR(page);
  const before = await head(page);
  await setButton(page, "right", "squeeze", 1);
  const t0 = Date.now();
  await thumbstick(page, "right", 1);
  await page.waitForTimeout(500);
  await thumbstick(page, "right", 0);
  const held = (Date.now() - t0) / 1000;
  await setButton(page, "right", "squeeze", 0);
  const turned = angleDelta(before.yawDeg, (await head(page)).yawDeg);
  // Right (negative), at no more than 90 degrees per second of holding; loaded runs drop frames.
  expect(turned).toBeLessThan(-20);
  expect(-turned).toBeLessThanOrEqual(90 * held + 5);
});

test("menu-button: B and Y emit it with the hand, once per press", async ({ page }) => {
  await openHarness(page);
  await enterVR(page);
  await pressButton(page, "right", "b-button");
  await page.waitForTimeout(300);
  await pressButton(page, "left", "y-button");
  // A and X are not the menu button.
  await pressButton(page, "right", "a-button");
  await pressButton(page, "left", "x-button");
  await frames(page, 3);
  const menu = await events(page, "menu-button");
  expect(menu.map((e) => e.payload)).toEqual([{ hand: "right" }, { hand: "left" }]);
});

test("demo scene: walk from room 1 through its door and stop at room 2's north wall", async ({
  page,
}) => {
  await openHarness(page, "vr", { demo: true });
  await page.evaluate(() => window.__kit.setLocomotion({ speed: 6 }));
  // Room 1 stands at plan (-7, -4.5), facing north (-Z); the door in the wall at north 0 is at
  // east -7, 0.9 m wide; room 2's north wall has its inner face at north 5.925 (z = -5.925).
  await page.evaluate(() => window.__kit.enter("vr", { viewpoint: "room-1" }));
  await waitForEvent(page, "sessionstart");
  await frames(page, 5);
  const start = await head(page);
  expect(start.position[2]).toBeCloseTo(4.5, 1);

  await thumbstick(page, "right", 0, -1);
  await page.waitForTimeout(3000);
  const stopped = await settled(page);
  await thumbstick(page, "right", 0, 0);
  // Through the door (past the wall at z = 0) and 0.25 m short of the north wall.
  expect(stopped[2]).toBeLessThan(-5.925 + 0.35);
  expect(stopped[2]).toBeGreaterThan(-5.925 + 0.15);
  expect(stopped[0]).toBeCloseTo(-7, 1);
  expect(stopped[1]).toBeCloseTo(start.position[1], 2);
});
