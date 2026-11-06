import { expect, test } from "@playwright/test";
import { events, frames, head, openHarness, waitForEvent } from "./helpers";

// Diagnostics panel and late floors under the emulated Quest 3.

test("setDiagnostics shows the panel in the headset and frame stats are measured", async ({
  page,
}) => {
  await openHarness(page);
  await page.evaluate(() => window.__kit.enter("vr"));
  await waitForEvent(page, "sessionstart");
  expect(await page.evaluate(() => window.__kit.diagnostics)).toBe(false);

  const panel = () =>
    page.evaluate(() => {
      const mesh = window.__scene.getObjectByName("llhil-webxr-diagnostics");
      return mesh ? { visible: mesh.visible, matrix: [...mesh.matrix.elements] } : null;
    });
  await frames(page, 3);
  expect((await panel())?.visible ?? false).toBe(false);

  await page.evaluate(() => window.__kit.setDiagnostics(true));
  await frames(page, 5);
  const shown = await panel();
  expect(shown?.visible).toBe(true);
  expect(shown!.matrix.every(Number.isFinite)).toBe(true);
  expect(await page.evaluate(() => window.__kit.diagnostics)).toBe(true);

  const stats = await page.evaluate(() => window.__kit.frameStats);
  expect(stats).not.toBeNull();
  expect(stats!.fps).toBeGreaterThan(0);
  expect(stats!.frameMs).toBeGreaterThan(0);
  expect(stats!.missed).toBeGreaterThanOrEqual(0);

  await page.evaluate(() => window.__kit.setDiagnostics(false));
  await frames(page, 2);
  expect((await panel())?.visible).toBe(false);

  await page.evaluate(() => window.__kit.exit());
  await waitForEvent(page, "sessionend");
  expect(await page.evaluate(() => window.__kit.frameStats)).toBeNull();
});

test("late floors: the user starts at the fallback height and lands on the floor once it exists", async ({
  page,
}) => {
  await page.goto("/?floors=late");
  await page.waitForFunction(() => document.body.dataset.ready === "true");
  await page.evaluate(() => window.__kit.enter("vr", { viewpoint: "mezzanine" }));
  await waitForEvent(page, "sessionstart");
  await frames(page, 5);

  // No floors yet: eye 4.6 minus the harness's eye height of 1 m, so the floor is taken at 3.6.
  const before = await head(page);
  expect(before.position[2]).toBeCloseTo(-6, 1);
  expect((await events(page, "teleport")).length).toBe(0);

  await page.evaluate(() => window.__buildFloors());
  await waitForEvent(page, "teleport");
  await frames(page, 3);
  const after = await head(page);
  // The mezzanine top is at 3 m: 0.6 m lower, same place on it.
  expect(before.position[1] - after.position[1]).toBeCloseTo(0.6, 2);
  expect(after.position[0]).toBeCloseTo(before.position[0], 2);
  expect(after.position[2]).toBeCloseTo(before.position[2], 2);
  const [teleport] = await events(page, "teleport");
  expect((teleport.payload.position as number[])[1]).toBeCloseTo(3, 3);
});
