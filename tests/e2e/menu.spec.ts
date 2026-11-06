import { expect, type Page, test } from "@playwright/test";
import { Matrix4, Quaternion, Vector3 } from "three";
import { MENU_VISIBLE_ROWS, menuLayout, rowCentre } from "../../src/menu";
import { DEFAULT_THEME } from "../../src/theme";
import {
  aimAt,
  clickXRButton,
  events,
  frames,
  head,
  openHarness,
  pullTrigger,
  waitForEvent,
} from "./helpers";

// The VR menu under the emulated Quest 3. The harness has two viewpoints and one host toggle,
// and the kit has locomotion and diagnostics, so the menu reads: Viewpoints, Entrance, Mezzanine,
// Walk / Fly, Diagnostics, Show marks, Exit VR.
const ROWS = 7;
const SLOT = { entrance: 1, mezzanine: 2, locomotion: 3, diagnostics: 4, marks: 5, exit: 6 };

async function enterVR(page: Page): Promise<void> {
  await clickXRButton(page, /enter vr|open in vr/i);
  await waitForEvent(page, "sessionstart");
  await frames(page, 3);
}

async function openMenu(page: Page): Promise<void> {
  // The host call opens the same menu as B/Y (the menu-button event, covered in locomotion.spec).
  await page.evaluate(() => window.__kit.openMenu());
  await waitForEvent(page, "menu");
  await frames(page, 2);
}

/**
 * Aims the right controller at the centre of a menu row. The panel's pose is in scene
 * coordinates; the emulator poses controllers in its own (local-floor) space, so the point is
 * taken there through the head, which both know.
 */
async function aimAtRow(page: Page, slot: number): Promise<void> {
  expect(ROWS).toBeLessThanOrEqual(MENU_VISIBLE_ROWS);
  const c = rowCentre(menuLayout(DEFAULT_THEME, ROWS, false), slot);
  const m = await page.evaluate(() => {
    const panel = window.__scene.getObjectByName("llhil-webxr-menu")!;
    panel.updateWorldMatrix(true, false);
    const p = window.__xrDevice.position;
    const q = window.__xrDevice.quaternion;
    return {
      panel: [...panel.matrixWorld.elements],
      camera: [...window.__renderer.xr.getCamera().matrixWorld.elements],
      headPosition: [p.x, p.y, p.z],
      headQuaternion: [q.x, q.y, q.z, q.w],
    };
  });
  const inScene = new Vector3(c.x, c.y, 0).applyMatrix4(new Matrix4().fromArray(m.panel));
  const headGlobal = new Matrix4().compose(
    new Vector3(...m.headPosition),
    new Quaternion(...m.headQuaternion),
    new Vector3(1, 1, 1),
  );
  const sceneToGlobal = headGlobal.multiply(new Matrix4().fromArray(m.camera).invert());
  const p = inScene.applyMatrix4(sceneToGlobal);
  await aimAt(page, [p.x, p.y, p.z]);
}

test("the menu opens in front of the user and reports it", async ({ page }) => {
  await openHarness(page);
  await enterVR(page);
  await openMenu(page);
  expect(await page.evaluate(() => window.__kit.menuOpen)).toBe(true);
  expect((await events(page, "menu")).map((e) => e.payload)).toEqual([{ open: true }]);
  const panel = await page.evaluate(() => {
    const p = window.__scene.getObjectByName("llhil-webxr-menu");
    return p ? [...p.matrixWorld.elements.slice(12, 15)] : null;
  });
  const { position } = await head(page);
  expect(panel).not.toBeNull();
  // About 0.8 m ahead and below the eye.
  const ahead = Math.hypot(panel![0] - position[0], panel![2] - position[2]);
  expect(ahead).toBeGreaterThan(0.7);
  expect(ahead).toBeLessThan(0.9);
  expect(panel![1]).toBeLessThan(position[1]);
});

test("selecting a viewpoint moves the user there and closes the menu", async ({ page }) => {
  await openHarness(page);
  await enterVR(page);
  await openMenu(page);

  await aimAtRow(page, SLOT.mezzanine);
  await pullTrigger(page, "right");
  await waitForEvent(page, "viewpoint");
  await frames(page, 3);

  const { position } = await head(page);
  expect(position[1]).toBeGreaterThan(3);
  expect(position[0]).toBeCloseTo(0, 1);
  expect(position[2]).toBeCloseTo(-6, 1);
  expect((await events(page, "viewpoint")).at(-1)!.payload).toEqual({ id: "mezzanine" });
  expect(await page.evaluate(() => window.__kit.menuOpen)).toBe(false);
  expect((await events(page, "menu")).map((e) => e.payload)).toEqual([
    { open: true },
    { open: false },
  ]);
  // The trigger that chose the viewpoint did not teleport too.
  expect(await events(page, "teleport")).toEqual([]);
});

test("a host toggle reports its new value; the exit row ends the session", async ({ page }) => {
  await openHarness(page);
  await enterVR(page);
  await openMenu(page);

  await aimAtRow(page, SLOT.marks);
  await pullTrigger(page, "right");
  await waitForEvent(page, "menu-select");
  expect((await events(page, "menu-select")).map((e) => e.payload)).toEqual([
    { id: "marks", value: false },
  ]);
  expect(await page.evaluate(() => window.__kit.menuOpen)).toBe(true);
  expect(await events(page, "teleport")).toEqual([]);

  await aimAtRow(page, SLOT.exit);
  await pullTrigger(page, "right");
  await waitForEvent(page, "sessionend");
  expect(await page.evaluate(() => window.__kit.presenting)).toBeNull();
  expect(await page.evaluate(() => window.__kit.menuOpen)).toBe(false);
});
