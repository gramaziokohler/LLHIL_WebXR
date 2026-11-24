import { expect, type Page, test } from "@playwright/test";
import { Matrix4, Quaternion, Vector3 } from "three";
import { PANEL_CANVAS_WIDTH, PANEL_MPP } from "../../src/panels";
import { DEFAULT_THEME } from "../../src/theme";
import {
  aimAt,
  clickXRButton,
  events,
  frames,
  head,
  openHarness,
  pressButton,
  pullTrigger,
  waitForEvent,
} from "./helpers";

// The example viewer's VR side panels (?panels=1) under the emulated Quest 3. Left: Settings
// (Diagnostics, Scale) and About; right: Viewpoints (Entrance, Mezzanine) and Navigation (Walk /
// Fly). The Settings and Viewpoints sections start open.

type Side = "left" | "right";

async function enterVR(page: Page): Promise<void> {
  await clickXRButton(page, /enter vr|open in vr/i);
  await waitForEvent(page, "sessionstart");
  await frames(page, 3);
}

async function openPanels(page: Page): Promise<void> {
  // B on the right controller: with panels set, the panels open instead of the menu.
  await pressButton(page, "right", "b-button");
  await waitForEvent(page, "panels");
  await frames(page, 2);
}

/**
 * The emulator-global point of a panel row: its centre, the centre of pill `part`, or the point
 * at fraction `along` of a slider's track. The panel's pose and layout are read from the scene
 * (scene coordinates); the emulator poses controllers in its own (local-floor) space, so the point
 * is taken there through the head, which both know.
 */
async function panelPoint(
  page: Page,
  side: Side,
  rowId: string,
  at: { part?: number; along?: number } = {},
): Promise<[number, number, number]> {
  const m = await page.evaluate(
    ({ side, rowId }) => {
      const group = window.__scene.getObjectByName(`llhil-webxr-panel-${side}`)!;
      group.updateWorldMatrix(true, false);
      const panel = group.userData.panel;
      const entry = panel.layout.entries.find((e: any) => e.row.id === rowId);
      const p = window.__xrDevice.position;
      const q = window.__xrDevice.quaternion;
      return {
        panel: [...group.matrixWorld.elements],
        entry: { y: entry.y as number, h: entry.h as number, parts: entry.parts as any[] },
        scroll: panel.scroll as number,
        pad: panel.layout.pad as number,
        canvasH: panel.layout.canvasH as number,
        camera: [...window.__renderer.xr.getCamera().matrixWorld.elements],
        headPosition: [p.x, p.y, p.z] as [number, number, number],
        headQuaternion: [q.x, q.y, q.z, q.w] as [number, number, number, number],
      };
    },
    { side, rowId },
  );
  let x = PANEL_CANVAS_WIDTH / 2;
  // The first line of the row: a slider's label, a wrapped choice's label.
  let y = m.entry.y + Math.min(m.entry.h, DEFAULT_THEME.rowHeight) / 2;
  if (at.part !== undefined || at.along !== undefined) {
    const r = m.entry.parts[at.part ?? 0];
    x = r.x + (at.along !== undefined ? at.along * r.w : r.w / 2);
    y = r.y + r.h / 2;
  }
  const local = new Vector3(
    (x - PANEL_CANVAS_WIDTH / 2) * PANEL_MPP,
    (m.canvasH / 2 - (m.pad + y - m.scroll)) * PANEL_MPP,
    0,
  );
  const inScene = local.applyMatrix4(new Matrix4().fromArray(m.panel));
  const headGlobal = new Matrix4().compose(
    new Vector3(...m.headPosition),
    new Quaternion(...m.headQuaternion),
    new Vector3(1, 1, 1),
  );
  const sceneToGlobal = headGlobal.multiply(new Matrix4().fromArray(m.camera).invert());
  const p = inScene.applyMatrix4(sceneToGlobal);
  return [p.x, p.y, p.z];
}

async function trigger(page: Page, value: number): Promise<void> {
  await page.evaluate(
    (v) => window.__xrDevice.controllers.right!.updateButtonValue("trigger", v),
    value,
  );
  await frames(page, 3);
}

test("B opens the side panels left and right of the user, not the menu", async ({ page }) => {
  await openHarness(page, "vr", { panels: true });
  await enterVR(page);
  await openPanels(page);
  expect(await page.evaluate(() => window.__kit.panelsOpen)).toBe(true);
  expect(await page.evaluate(() => window.__kit.menuOpen)).toBe(false);
  expect((await events(page, "panels")).map((e) => e.payload)).toEqual([{ open: true }]);
  const { position } = await head(page);
  for (const side of ["left", "right"] as const) {
    const c = await page.evaluate((s) => {
      const g = window.__scene.getObjectByName(`llhil-webxr-panel-${s}`)!;
      g.updateWorldMatrix(true, false);
      return [...g.matrixWorld.elements.slice(12, 15)];
    }, side);
    const dx = c[0] - position[0];
    expect(Math.hypot(dx, c[2] - position[2])).toBeCloseTo(1.1, 1);
    expect(c[1]).toBeCloseTo(position[1] - 0.12, 1);
    // The emulator's head looks along -Z: left is -X.
    expect(Math.sign(dx)).toBe(side === "left" ? -1 : 1);
  }
  await pressButton(page, "left", "y-button");
  await waitForEvent(page, "panels");
  expect(await page.evaluate(() => window.__kit.panelsOpen)).toBe(false);
});

test("a viewpoint action on the right panel moves the user there", async ({ page }) => {
  await openHarness(page, "vr", { panels: true });
  await enterVR(page);
  await openPanels(page);

  await aimAt(page, await panelPoint(page, "right", "vp:mezzanine"));
  await pullTrigger(page, "right");
  await waitForEvent(page, "viewpoint");
  await frames(page, 3);

  const { position } = await head(page);
  expect(position[1]).toBeGreaterThan(3);
  expect(position[2]).toBeCloseTo(-6, 1);
  expect((await events(page, "panel-input")).map((e) => e.payload)).toEqual([
    { panel: "right", id: "vp:mezzanine" },
  ]);
  // The trigger that chose it did not teleport too; the panels stay open and came along.
  expect(await events(page, "teleport")).toEqual([]);
  expect(await page.evaluate(() => window.__kit.panelsOpen)).toBe(true);
  const right = await page.evaluate(() => {
    const g = window.__scene.getObjectByName("llhil-webxr-panel-right")!;
    g.updateWorldMatrix(true, false);
    return [...g.matrixWorld.elements.slice(12, 15)];
  });
  expect(Math.hypot(right[0] - position[0], right[2] - position[2])).toBeCloseTo(1.1, 1);
});

test("dragging the Scale slider reports rising values, then a final one", async ({ page }) => {
  await openHarness(page, "vr", { panels: true });
  await enterVR(page);
  await openPanels(page);

  await aimAt(page, await panelPoint(page, "left", "scale", { along: 0.05 }));
  await trigger(page, 1);
  for (const along of [0.2, 0.4, 0.6, 0.8, 0.95]) {
    await aimAt(page, await panelPoint(page, "left", "scale", { along }));
  }
  await trigger(page, 0);
  await frames(page, 3);

  const inputs = (await events(page, "panel-input")).map((e) => e.payload);
  expect(inputs.length).toBeGreaterThanOrEqual(3);
  for (const input of inputs) expect(input.id).toBe("scale");
  const during = inputs.slice(0, -1);
  for (const input of during) expect(input.final).toBe(false);
  const values = during.map((e) => e.value as number);
  for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThan(values[i - 1]);
  const last = inputs.at(-1)!;
  expect(last.final).toBe(true);
  expect(last.value as number).toBeGreaterThan(1.8);
  // Snapped to the step of 0.05.
  for (const v of values) expect(Math.abs(v * 20 - Math.round(v * 20))).toBeLessThan(1e-9);
  expect(await events(page, "teleport")).toEqual([]);
});

test("Navigation opens its section and Fly switches the locomotion", async ({ page }) => {
  await openHarness(page, "vr", { panels: true });
  await enterVR(page);
  await openPanels(page);
  expect(await page.evaluate(() => window.__kit.locomotion.mode)).toBe("walk");

  await aimAt(page, await panelPoint(page, "right", "navigation"));
  await pullTrigger(page, "right");
  await aimAt(page, await panelPoint(page, "right", "locomotion", { part: 1 }));
  await pullTrigger(page, "right");
  await waitForEvent(page, "locomotion");

  expect((await events(page, "panel-input")).map((e) => e.payload)).toEqual([
    { panel: "right", id: "navigation", value: true },
    { panel: "right", id: "locomotion", value: "fly" },
  ]);
  expect(await page.evaluate(() => window.__kit.locomotion.mode)).toBe("fly");
  expect(await events(page, "teleport")).toEqual([]);
});
