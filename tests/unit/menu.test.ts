// @vitest-environment happy-dom
import { Group, type Mesh, type MeshBasicMaterial, Object3D, Vector3 } from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Emitter } from "../../src/events";
import { resolveOptions } from "../../src/index";
import type { AllEvents, KitContext, RaySource, ResolvedViewpoint } from "../../src/internal";
import { upVector } from "../../src/math";
import {
  createMenu,
  MENU_CANVAS_WIDTH,
  MENU_DISTANCE,
  MENU_DROP,
  MENU_MPP,
  MENU_VISIBLE_ROWS,
  type MenuHost,
  menuLayout,
  rowCentre,
  slotAt,
} from "../../src/menu";
import { createTeleport } from "../../src/teleport";
import { DEFAULT_THEME, mergeTheme, type UiTheme } from "../../src/theme";
import type { MenuItem, RaycastFn, UiOptions } from "../../src/types";

const frame = {} as XRFrame;
const DT = 1 / 72;
const EYE = new Vector3(0, 1.6, 0);

interface TextCall {
  text: string;
  x: number;
  y: number;
  font: string;
  fillStyle: string;
}

/** A 2D context that records text, fills and images; widths are 0.5 em per character. */
function recordingContext() {
  const texts: TextCall[] = [];
  const fills: string[] = [];
  const images: { image: unknown; x: number; y: number; w: number; h: number }[] = [];
  const noop = () => {};
  const g = {
    font: "10px sans-serif",
    fillStyle: "#000",
    strokeStyle: "#000",
    lineWidth: 1,
    globalAlpha: 1,
    letterSpacing: "0px",
    textAlign: "start",
    textBaseline: "alphabetic",
    clearRect: noop,
    beginPath: noop,
    moveTo: noop,
    lineTo: noop,
    arcTo: noop,
    closePath: noop,
    fill() {
      fills.push(g.fillStyle);
    },
    stroke: noop,
    drawImage(image: unknown, x: number, y: number, w: number, h: number) {
      images.push({ image, x, y, w, h });
    },
    fillText(text: string, x: number, y: number) {
      texts.push({ text, x, y, font: g.font, fillStyle: g.fillStyle });
    },
    measureText(text: string) {
      const size = Number(/(\d+)px/.exec(g.font)?.[1] ?? 10);
      return { width: text.length * size * 0.5 };
    },
  };
  const reset = () => {
    texts.length = 0;
    fills.length = 0;
    images.length = 0;
  };
  return { g, texts, fills, images, reset };
}

let recorder: ReturnType<typeof recordingContext>;

beforeEach(() => {
  recorder = recordingContext();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => recorder.g as unknown as CanvasRenderingContext2D,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

const viewpointsOf = (n: number): ResolvedViewpoint[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `vp${i}`,
    label: `View ${i}`,
    floorPoint: new Vector3(i, 0, 0),
    yaw: 0,
  }));

function gamepad(y: number): Gamepad {
  return { axes: [0, 0, 0, y], buttons: [] } as unknown as Gamepad;
}

function makeRay(id = "right", kind: RaySource["kind"] = "controller"): RaySource {
  return {
    id,
    kind,
    handedness: "right",
    origin: new Vector3(0.2, 1.2, -0.2),
    // Down at the floor, away from the panel.
    direction: new Vector3(0, -1, 0),
    selecting: false,
  };
}

/** A floor plane at height 0, for the teleport module. */
const floor: RaycastFn = (origin, direction, far) => {
  if (direction.y >= -1e-9) return null;
  const t = -origin.y / direction.y;
  if (t < 0 || t > far) return null;
  return {
    point: origin.clone().addScaledVector(direction, t),
    normal: new Vector3(0, 1, 0),
    object: new Object3D(),
    distance: t,
  };
};

interface SetupOptions {
  viewpoints?: number;
  host?: Partial<MenuHost>;
  ui?: UiOptions;
  theme?: Partial<UiTheme>;
}

function setup(options: SetupOptions = {}) {
  const up = upVector("y");
  const events = new Emitter<AllEvents>();
  const root = new Group();
  const rays: RaySource[] = [];
  const camera = new Object3D();
  const look = (eye: Vector3, dir: Vector3) =>
    camera.matrixWorld.lookAt(eye, eye.clone().add(dir), up).setPosition(eye);
  look(EYE, new Vector3(0, 0, -1));
  let viewpoints = viewpointsOf(options.viewpoints ?? 2);
  // Copied with their getters, so a host's live state stays live.
  const host = Object.defineProperties(
    { goTo: vi.fn(), exit: vi.fn(() => Promise.resolve()) },
    Object.getOwnPropertyDescriptors(options.host ?? {}),
  ) as MenuHost;
  const resolved = resolveOptions({
    renderer: {} as any,
    scene: {} as any,
    camera: {} as any,
    ui: options.ui,
  });
  const space = { placeUser: vi.fn(), snapTurn: vi.fn() };
  const ctx = {
    renderer: { xr: { getCamera: () => camera } },
    events,
    root,
    up,
    raycast: floor,
    space,
    input: { rays: () => rays },
    mode: "vr",
    session: null,
    options: resolved,
    theme: mergeTheme(DEFAULT_THEME, options.theme),
    uiCapture: false,
  } as unknown as KitContext;
  const menu = createMenu(ctx, { viewpoints: () => viewpoints, host: () => host });
  menu.start();
  const menuEvents: boolean[] = [];
  const selects: AllEvents["menu-select"][] = [];
  events.on("menu", ({ open }) => menuEvents.push(open));
  events.on("menu-select", (p) => selects.push(p));
  const panel = () => root.getObjectByName("llhil-webxr-menu");
  const mesh = () => panel()?.children[0] as Mesh;
  const texture = () => (mesh().material as MeshBasicMaterial).map!;

  /** Points `ray` at the centre of visible slot `slot`, for a panel of `rowCount` rows. */
  function pointAt(ray: RaySource, slot: number, rowCount: number, title = false) {
    const p = panel()!;
    p.updateMatrixWorld(true);
    const layout = menuLayout(ctx.theme, rowCount, title);
    const c = rowCentre(layout, slot);
    const point = new Vector3(c.x, c.y, 0).applyMatrix4(p.matrixWorld);
    const normal = new Vector3(0, 0, 1).transformDirection(p.matrixWorld);
    ray.origin.copy(point).addScaledVector(normal, 0.4);
    ray.direction.copy(normal).negate();
  }
  function pointAway(ray: RaySource) {
    ray.origin.set(0.2, 1.2, -0.2);
    ray.direction.set(0, -1, 0);
  }
  /** Pulls the trigger: selectstart then selectend. */
  function trigger(ray: RaySource) {
    events.emit("selectstart", { ray });
    events.emit("selectend", { ray });
  }
  /** Pushes the stick (positive is down the list) for one frame, then releases it. */
  function flick(ray: RaySource, y: number) {
    ray.gamepad = gamepad(y);
    menu.update(frame, DT);
    ray.gamepad = gamepad(0);
    menu.update(frame, DT);
  }
  const labels = () => recorder.texts.map((t) => t.text);
  return {
    ctx,
    events,
    root,
    rays,
    host,
    menu,
    menuEvents,
    selects,
    space,
    panel,
    mesh,
    texture,
    pointAt,
    pointAway,
    trigger,
    flick,
    labels,
    look,
    setViewpoints: (n: number) => {
      viewpoints = viewpointsOf(n);
    },
  };
}

describe("menu layout and hit-testing", () => {
  const layout = menuLayout(DEFAULT_THEME, 4, false);

  it("sizes the panel to the rows, at most eight", () => {
    const { padding: pad, rowHeight: rowH } = DEFAULT_THEME;
    expect(layout.visible).toBe(4);
    expect(layout.heightPx).toBe(2 * pad + 4 * rowH);
    const long = menuLayout(DEFAULT_THEME, 40, true);
    expect(long.visible).toBe(MENU_VISIBLE_ROWS);
    expect(long.heightPx).toBe(2 * pad + rowH + MENU_VISIBLE_ROWS * rowH);
    expect(long.canvasH).toBe(long.heightPx);
  });

  it("maps canvas points to row slots, margins and outside", () => {
    const { padding: pad, rowHeight: rowH } = DEFAULT_THEME;
    const x = MENU_CANVAS_WIDTH / 2;
    expect(slotAt(layout, x, pad + 1)).toBe(0);
    expect(slotAt(layout, x, pad + rowH - 1)).toBe(0);
    expect(slotAt(layout, x, pad + rowH + 1)).toBe(1);
    expect(slotAt(layout, x, pad + 4 * rowH - 1)).toBe(3);
    // Margins are on the panel but not on a row.
    expect(slotAt(layout, x, pad / 2)).toBe(-1);
    expect(slotAt(layout, pad / 2, pad + 10)).toBe(-1);
    // Outside the panel.
    expect(slotAt(layout, x, -1)).toBe(-2);
    expect(slotAt(layout, x, layout.heightPx + 1)).toBe(-2);
    expect(slotAt(layout, MENU_CANVAS_WIDTH + 1, pad + 10)).toBe(-2);
  });

  it("offsets the rows below a title", () => {
    const titled = menuLayout(DEFAULT_THEME, 4, true);
    const x = MENU_CANVAS_WIDTH / 2;
    expect(slotAt(titled, x, DEFAULT_THEME.padding + 10)).toBe(-1);
    expect(slotAt(titled, x, DEFAULT_THEME.padding + DEFAULT_THEME.rowHeight + 10)).toBe(0);
  });

  it("row centres hit their own slot", () => {
    for (const l of [layout, menuLayout(DEFAULT_THEME, 12, true)]) {
      for (let s = 0; s < l.visible; s++) {
        const c = rowCentre(l, s);
        const y = l.heightPx / 2 - c.y / MENU_MPP;
        expect(slotAt(l, MENU_CANVAS_WIDTH / 2 + c.x / MENU_MPP, y)).toBe(s);
      }
    }
  });
});

describe("menu open and close", () => {
  it("toggles on the menu button of either hand and reports it", () => {
    const t = setup();
    expect(t.menu.isOpen).toBe(false);
    t.events.emit("menu-button", { hand: "left" });
    expect(t.menu.isOpen).toBe(true);
    expect(t.panel()).toBeDefined();
    expect(t.ctx.uiCapture).toBe(true);
    t.events.emit("menu-button", { hand: "right" });
    expect(t.menu.isOpen).toBe(false);
    expect(t.panel()).toBeUndefined();
    expect(t.ctx.uiCapture).toBe(false);
    expect(t.menuEvents).toEqual([true, false]);
  });

  it("open and close are idempotent", () => {
    const t = setup();
    t.menu.open();
    t.menu.open();
    t.menu.close();
    t.menu.close();
    expect(t.menuEvents).toEqual([true, false]);
  });

  it("does nothing outside a VR session, and closes when the session ends", () => {
    const t = setup();
    t.menu.stop();
    t.menu.open();
    expect(t.menu.isOpen).toBe(false);
    t.events.emit("menu-button", { hand: "left" });
    expect(t.menu.isOpen).toBe(false);

    t.menu.start();
    t.menu.open();
    t.menu.stop();
    expect(t.menu.isOpen).toBe(false);
    expect(t.panel()).toBeUndefined();
    expect(t.ctx.uiCapture).toBe(false);
    expect(t.menuEvents).toEqual([true, false]);
  });

  it("spawns 0.8 m ahead at chest height, faces the eye, and stays put", () => {
    const t = setup();
    t.menu.open();
    const p = t.panel()!;
    p.updateMatrixWorld(true);
    const centre = new Vector3().setFromMatrixPosition(p.matrixWorld);
    const expected = new Vector3(0, EYE.y - MENU_DROP, -MENU_DISTANCE);
    expect(centre.distanceTo(expected)).toBeLessThan(1e-6);
    const normal = new Vector3(0, 0, 1).transformDirection(p.matrixWorld);
    const toEye = EYE.clone().sub(centre).normalize();
    expect(normal.dot(toEye)).toBeGreaterThan(0.9999);

    // World-locked: turning the head does not move it.
    t.look(new Vector3(1, 1.6, 1), new Vector3(1, 0, 0));
    for (let i = 0; i < 10; i++) t.menu.update(frame, DT);
    p.updateMatrixWorld(true);
    expect(new Vector3().setFromMatrixPosition(p.matrixWorld).distanceTo(expected)).toBeLessThan(
      1e-6,
    );
  });

  it("draws the rows in order: viewpoints, then exit", () => {
    const t = setup();
    t.menu.open();
    expect(t.labels()).toEqual(["Viewpoints", "View 0", "View 1", "Exit VR"]);
    // White text on a dark, semi-transparent panel; the header muted.
    const header = recorder.texts[0];
    expect(header.fillStyle).toBe(DEFAULT_THEME.textMuted);
    expect(recorder.texts[1].fillStyle).toBe(DEFAULT_THEME.text);
    expect(recorder.fills[0]).toBe(DEFAULT_THEME.background);
  });

  it("leaves out the viewpoints section when there are none", () => {
    const t = setup({ viewpoints: 0 });
    t.menu.open();
    expect(t.labels()).toEqual(["Exit VR"]);
  });
});

describe("menu pointing", () => {
  it("highlights the row under the ray, and redraws only when it changes", () => {
    const t = setup();
    const ray = makeRay();
    t.rays.push(ray);
    t.menu.open();
    const texture = t.texture();
    const v0 = texture.version;
    for (let i = 0; i < 5; i++) t.menu.update(frame, DT);
    expect(texture.version).toBe(v0);

    t.pointAt(ray, 2, 4);
    recorder.reset();
    t.menu.update(frame, DT);
    expect(texture.version).toBe(v0 + 1);
    expect(recorder.fills).toContain(DEFAULT_THEME.highlight);
    for (let i = 0; i < 5; i++) t.menu.update(frame, DT);
    expect(texture.version).toBe(v0 + 1);

    // Off the panel: the highlight goes.
    t.pointAway(ray);
    recorder.reset();
    t.menu.update(frame, DT);
    expect(texture.version).toBe(v0 + 2);
    expect(recorder.fills).not.toContain(DEFAULT_THEME.highlight);
  });

  it("a section header is not highlighted", () => {
    const t = setup();
    const ray = makeRay();
    t.rays.push(ray);
    t.menu.open();
    t.pointAt(ray, 0, 4);
    recorder.reset();
    t.menu.update(frame, DT);
    expect(recorder.fills).not.toContain(DEFAULT_THEME.highlight);
  });

  it("selecting a viewpoint goes there and closes the menu", () => {
    const t = setup();
    const ray = makeRay();
    t.rays.push(ray);
    t.menu.open();
    t.pointAt(ray, 2, 4);
    t.trigger(ray);
    expect(t.host.goTo).toHaveBeenCalledExactlyOnceWith("vp1");
    expect(t.menu.isOpen).toBe(false);
    expect(t.menuEvents).toEqual([true, false]);
  });

  it("a pinch of a hand works like a trigger", () => {
    const t = setup();
    const hand = makeRay("hand-left", "hand");
    t.rays.push(hand);
    t.menu.open();
    t.pointAt(hand, 1, 4);
    t.trigger(hand);
    expect(t.host.goTo).toHaveBeenCalledExactlyOnceWith("vp0");
  });

  it("either controller works", () => {
    const t = setup();
    const right = makeRay("right");
    const left = makeRay("left");
    left.handedness = "left";
    t.rays.push(right, left);
    t.menu.open();
    t.pointAt(left, 2, 4);
    t.menu.update(frame, DT);
    t.trigger(left);
    expect(t.host.goTo).toHaveBeenCalledWith("vp1");
  });

  it("a trigger on the header, the margins or off the panel does nothing", () => {
    const t = setup();
    const ray = makeRay();
    t.rays.push(ray);
    t.menu.open();
    t.pointAt(ray, 0, 4);
    t.trigger(ray);
    t.pointAway(ray);
    t.trigger(ray);
    expect(t.host.goTo).not.toHaveBeenCalled();
    expect(t.host.exit).not.toHaveBeenCalled();
    expect(t.menu.isOpen).toBe(true);
  });

  it("the exit row ends the session", () => {
    const t = setup();
    const ray = makeRay();
    t.rays.push(ray);
    t.menu.open();
    t.pointAt(ray, 3, 4);
    t.trigger(ray);
    expect(t.host.exit).toHaveBeenCalledOnce();
    expect(t.menu.isOpen).toBe(false);
  });

  it("a ray from behind the panel does not hit it", () => {
    const t = setup();
    const ray = makeRay();
    t.rays.push(ray);
    t.menu.open();
    t.pointAt(ray, 2, 4);
    // The same line through the row, from behind the panel.
    ray.origin.addScaledVector(ray.direction, 0.8);
    ray.direction.negate();
    t.trigger(ray);
    expect(t.host.goTo).not.toHaveBeenCalled();
  });
});

describe("menu stick navigation and scrolling", () => {
  it("moves the highlight by rows, skipping headers; the trigger selects it anywhere", () => {
    const t = setup();
    const ray = makeRay();
    t.rays.push(ray);
    t.menu.open();
    t.flick(ray, 1); // View 0
    t.flick(ray, 1); // View 1
    t.flick(ray, 1); // Exit VR
    t.flick(ray, 1); // stays at the end
    t.flick(ray, -1); // View 1
    t.trigger(ray);
    expect(t.host.goTo).toHaveBeenCalledExactlyOnceWith("vp1");
  });

  it("scrolls a long list to keep the highlight in view", () => {
    const t = setup({ viewpoints: 30 });
    const ray = makeRay();
    t.rays.push(ray);
    t.menu.open();
    // 32 rows: header, 30 viewpoints, exit. Eight shown.
    expect(t.labels()).toHaveLength(MENU_VISIBLE_ROWS);
    expect(t.labels()[0]).toBe("Viewpoints");
    for (let i = 0; i < 12; i++) t.flick(ray, 1);
    recorder.reset();
    t.flick(ray, 1); // View 12, index 13: rows 6..13 shown
    expect(t.labels()).toEqual(Array.from({ length: 8 }, (_, i) => `View ${i + 5}`));
    // A scroll bar is drawn in the accent colour.
    expect(recorder.fills.at(-1)).toBe(DEFAULT_THEME.accent);
    t.trigger(ray);
    expect(t.host.goTo).toHaveBeenCalledExactlyOnceWith("vp12");
  });

  it("holding the stick repeats", () => {
    const t = setup({ viewpoints: 30 });
    const ray = makeRay();
    t.rays.push(ray);
    t.menu.open();
    ray.gamepad = gamepad(1);
    // One second: the first step, then a repeat every 0.15 s after 0.45 s.
    for (let i = 0; i < 72; i++) t.menu.update(frame, DT);
    ray.gamepad = gamepad(0);
    t.menu.update(frame, DT);
    t.trigger(ray);
    const id = (t.host.goTo as any).mock.calls[0][0] as string;
    const steps = Number(id.slice(2)) + 1;
    expect(steps).toBeGreaterThanOrEqual(4);
    expect(steps).toBeLessThanOrEqual(6);
  });

  it("scrolling back up shows the section header again", () => {
    const t = setup({ viewpoints: 30 });
    const ray = makeRay();
    t.rays.push(ray);
    t.menu.open();
    for (let i = 0; i < 12; i++) t.flick(ray, 1);
    for (let i = 0; i < 10; i++) t.flick(ray, -1);
    recorder.reset();
    t.flick(ray, -1); // back at View 0
    expect(t.labels()[0]).toBe("Viewpoints");
  });

  it("pointing at a scrolled list selects the row shown under the ray", () => {
    const t = setup({ viewpoints: 30 });
    const stick = makeRay("left");
    const pointer = makeRay("right");
    t.rays.push(stick, pointer);
    t.menu.open();
    for (let i = 0; i < 13; i++) t.flick(stick, 1);
    // Rows 6..13 are shown; slot 0 is View 5.
    t.pointAt(pointer, 0, 32);
    t.menu.update(frame, DT);
    t.trigger(pointer);
    expect(t.host.goTo).toHaveBeenCalledExactlyOnceWith("vp5");
  });
});

describe("menu toggles", () => {
  function withSiblings() {
    const state = { mode: "walk" as "walk" | "fly", diag: false };
    const host: Partial<MenuHost> = {
      setLocomotion: vi.fn(({ mode }) => {
        state.mode = mode;
      }),
      get locomotion() {
        return { mode: state.mode };
      },
      setDiagnostics: vi.fn((on: boolean) => {
        state.diag = on;
      }),
      get diagnostics() {
        return state.diag;
      },
    };
    return { state, host };
  }

  it("leaves out walk/fly and diagnostics when the kit has neither", () => {
    const t = setup();
    t.menu.open();
    expect(t.labels()).not.toContain("Walk / Fly");
    expect(t.labels()).not.toContain("Diagnostics");
  });

  it("shows and switches walk/fly and diagnostics", () => {
    const { state, host } = withSiblings();
    const t = setup({ host });
    const ray = makeRay();
    t.rays.push(ray);
    t.menu.open();
    expect(t.labels()).toEqual([
      "Viewpoints",
      "View 0",
      "View 1",
      "Walk",
      "Walk / Fly",
      "Off",
      "Diagnostics",
      "Exit VR",
    ]);
    t.pointAt(ray, 3, 6);
    recorder.reset();
    t.trigger(ray);
    expect(host.setLocomotion).toHaveBeenCalledExactlyOnceWith({ mode: "fly" });
    expect(state.mode).toBe("fly");
    expect(t.labels()).toContain("Fly");
    expect(t.menu.isOpen).toBe(true);

    t.pointAt(ray, 4, 6);
    recorder.reset();
    t.trigger(ray);
    expect(host.setDiagnostics).toHaveBeenCalledExactlyOnceWith(true);
    expect(t.labels()).toContain("On");
  });

  it("follows a change made elsewhere while open", () => {
    const { state, host } = withSiblings();
    const t = setup({ host });
    t.menu.open();
    const texture = t.texture();
    const v0 = texture.version;
    t.menu.update(frame, DT);
    expect(texture.version).toBe(v0);
    state.mode = "fly";
    recorder.reset();
    t.menu.update(frame, DT);
    expect(texture.version).toBe(v0 + 1);
    expect(t.labels()).toContain("Fly");
  });
});

describe("menu host items", () => {
  const items: MenuItem[] = [
    { id: "tools", label: "Tools", kind: "section" },
    { id: "marks", label: "Show marks", kind: "toggle", value: true },
    { id: "reset", label: "Reset model" },
  ];

  it("come before exit by default and redraw when replaced", () => {
    const t = setup();
    t.menu.setItems(items);
    t.menu.open();
    expect(t.labels()).toEqual([
      "Viewpoints",
      "View 0",
      "View 1",
      "Tools",
      "On",
      "Show marks",
      "Reset model",
      "Exit VR",
    ]);
    recorder.reset();
    t.menu.setItems([{ id: "x", label: "Only" }]);
    expect(t.labels()).toEqual(["Viewpoints", "View 0", "View 1", "Only", "Exit VR"]);
  });

  it("a toggle flips its value, redraws and reports it; an action reports its id", () => {
    const t = setup();
    const ray = makeRay();
    t.rays.push(ray);
    t.menu.setItems(items);
    t.menu.open();
    t.pointAt(ray, 4, 7);
    recorder.reset();
    t.trigger(ray);
    expect(t.selects).toEqual([{ id: "marks", value: false }]);
    expect(t.labels()).toContain("Off");
    t.trigger(ray);
    expect(t.selects[1]).toEqual({ id: "marks", value: true });

    t.pointAt(ray, 5, 7);
    t.trigger(ray);
    expect(t.selects[2]).toEqual({ id: "reset" });
    expect("value" in t.selects[2]).toBe(false);
    expect(t.menu.isOpen).toBe(true);
    // The host's own objects are not changed.
    expect(items[1].value).toBe(true);
  });

  it("a host section row is a header: muted, never selected", () => {
    const t = setup();
    const ray = makeRay();
    t.rays.push(ray);
    t.menu.setItems(items);
    t.menu.open();
    const tools = recorder.texts.find((x) => x.text === "Tools")!;
    expect(tools.fillStyle).toBe(DEFAULT_THEME.textMuted);
    t.pointAt(ray, 3, 7);
    t.trigger(ray);
    expect(t.selects).toEqual([]);
  });
});

describe("menu structure options", () => {
  const items: MenuItem[] = [{ id: "a", label: "Host A" }];

  it("orders and hides the built-in sections", () => {
    const t = setup({ ui: { menu: { builtins: ["exit", "viewpoints"] } } });
    t.menu.setItems(items);
    t.menu.open();
    // Exit is not last, so host items go at the end.
    expect(t.labels()).toEqual(["Exit VR", "Viewpoints", "View 0", "View 1", "Host A"]);
  });

  it("hides exit and viewpoints when left out", () => {
    const t = setup({ ui: { menu: { builtins: [] } } });
    t.menu.setItems(items);
    t.menu.open();
    expect(t.labels()).toEqual(["Host A"]);
  });

  it("puts host items first on request", () => {
    const t = setup({ ui: { menu: { hostItemsFirst: true } } });
    t.menu.setItems(items);
    t.menu.open();
    expect(t.labels()).toEqual(["Host A", "Viewpoints", "View 0", "View 1", "Exit VR"]);
  });

  it("draws a title above the rows, and the rows below it are hit", () => {
    const t = setup({ ui: { menu: { title: "Model" } }, theme: { uppercaseTitles: true } });
    const ray = makeRay();
    t.rays.push(ray);
    t.menu.open();
    expect(t.labels()).toEqual(["MODEL", "VIEWPOINTS", "View 0", "View 1", "Exit VR"]);
    t.pointAt(ray, 1, 4, true);
    t.trigger(ray);
    expect(t.host.goTo).toHaveBeenCalledExactlyOnceWith("vp0");
  });
});

describe("menu icons", () => {
  const image = (complete = true) => {
    const img = document.createElement("img") as HTMLImageElement;
    Object.defineProperty(img, "complete", { value: complete });
    return img;
  };

  it("draws no icons by default", () => {
    const t = setup();
    t.menu.open();
    expect(recorder.images).toEqual([]);
    const label = recorder.texts.find((x) => x.text === "View 0")!;
    expect(label.x).toBe(2 * DEFAULT_THEME.padding);
  });

  it("draws host and built-in icons at row height minus twice the padding", () => {
    const vp = image();
    const exit = image();
    const own = image();
    const t = setup({ ui: { icons: { viewpoint: vp, exit } } });
    t.menu.setItems([{ id: "a", label: "Host A", icon: own }]);
    t.menu.open();
    const size = DEFAULT_THEME.rowHeight - 2 * DEFAULT_THEME.padding;
    expect(recorder.images.map((i) => i.image)).toEqual([vp, vp, own, exit]);
    for (const i of recorder.images) {
      expect(i.w).toBe(size);
      expect(i.h).toBe(size);
    }
    // Labels make room for the icons, also on rows without one.
    const header = recorder.texts.find((x) => x.text === "Viewpoints")!;
    const label = recorder.texts.find((x) => x.text === "View 0")!;
    expect(label.x).toBe(2 * DEFAULT_THEME.padding + size + DEFAULT_THEME.padding);
    expect(header.x).toBe(label.x);
  });

  it("shows the walk or fly icon of the current mode", () => {
    const walk = image();
    const fly = image();
    let mode = "walk";
    const t = setup({
      ui: { icons: { walk, fly } },
      host: {
        setLocomotion: (o) => {
          mode = o.mode;
        },
        get locomotion() {
          return mode;
        },
      },
    });
    t.menu.open();
    expect(recorder.images.map((i) => i.image)).toEqual([walk]);
    mode = "fly";
    recorder.reset();
    t.menu.update(frame, DT);
    expect(recorder.images.map((i) => i.image)).toEqual([fly]);
  });

  it("skips an image that has not loaded", () => {
    const t = setup();
    t.menu.setItems([{ id: "a", label: "Host A", icon: image(false) }]);
    t.menu.open();
    expect(recorder.images).toEqual([]);
    expect(t.labels()).toContain("Host A");
  });
});

describe("menu theme", () => {
  it("draws with the theme", () => {
    const t = setup({
      theme: {
        fontFamily: "Inter, sans-serif",
        fontWeight: 500,
        text: "#111111",
        background: "#fafafa",
        backgroundOpacity: 0.5,
        letterSpacing: 2,
      },
    });
    t.menu.open();
    const label = recorder.texts.find((x) => x.text === "View 0")!;
    expect(label.font).toMatch(/^500 \d+px Inter, sans-serif$/);
    expect(label.fillStyle).toBe("#111111");
    expect(recorder.fills[0]).toBe("#fafafa");
    expect(recorder.g.globalAlpha).toBe(1);
    expect(recorder.g.letterSpacing).toBe("2px");
  });

  it("redraws an open menu when the theme changes, not a closed one", () => {
    const t = setup();
    t.menu.open();
    const texture = t.texture();
    const v0 = texture.version;
    t.ctx.theme = mergeTheme(t.ctx.theme, { text: "#00ff00" });
    recorder.reset();
    t.events.emit("theme", { theme: t.ctx.theme });
    expect(texture.version).toBe(v0 + 1);
    expect(recorder.texts.find((x) => x.text === "View 0")!.fillStyle).toBe("#00ff00");

    t.menu.close();
    recorder.reset();
    t.events.emit("theme", { theme: t.ctx.theme });
    expect(recorder.texts).toEqual([]);
  });

  it("a taller row height grows the panel and the canvas", () => {
    const t = setup();
    t.menu.open();
    const h0 = t.mesh().scale.y;
    t.ctx.theme = mergeTheme(t.ctx.theme, { rowHeight: 140 });
    t.events.emit("theme", { theme: t.ctx.theme });
    expect(t.mesh().scale.y).toBeCloseTo(h0 * ((2 * 24 + 4 * 140) / (2 * 24 + 4 * 104)), 6);
    const canvas = t.texture().image as HTMLCanvasElement;
    expect(canvas.height).toBe(2 * 24 + MENU_VISIBLE_ROWS * 140);
  });
});

describe("menu and teleport", () => {
  function both() {
    const t = setup();
    (t.ctx.options as any).vr = { turn: "snap", snapDegrees: 30, eyeHeight: 1.6, teleport: true };
    const teleport = createTeleport(t.ctx);
    teleport.start();
    // Teleport subscribes after the menu here: the order must not matter.
    const teleports: Vector3[] = [];
    t.events.on("teleport", ({ position }) => teleports.push(position));
    const ray = makeRay();
    ray.direction.set(0, -0.5, -1).normalize();
    t.rays.push(ray);
    return { ...t, teleport, teleports, ray };
  }

  it("the trigger does not teleport while the menu is open", () => {
    const t = both();
    t.menu.open();
    t.events.emit("selectstart", { ray: t.ray });
    t.teleport.update(frame, DT);
    t.events.emit("selectend", { ray: t.ray });
    expect(t.space.placeUser).not.toHaveBeenCalled();
    expect(t.teleports).toEqual([]);
  });

  it("the stick neither aims nor turns while the menu is open", () => {
    const t = both();
    t.menu.open();
    t.ray.gamepad = { axes: [0, 0, 0.9, -0.9], buttons: [] } as unknown as Gamepad;
    for (let i = 0; i < 5; i++) t.teleport.update(frame, DT);
    t.ray.gamepad = { axes: [0, 0, 0, 0], buttons: [] } as unknown as Gamepad;
    t.teleport.update(frame, DT);
    expect(t.space.placeUser).not.toHaveBeenCalled();
    expect(t.space.snapTurn).not.toHaveBeenCalled();
  });

  it("the release of the trigger that closed the menu does not teleport", () => {
    const t = both();
    t.menu.open();
    t.pointAt(t.ray, 1, 4);
    t.events.emit("selectstart", { ray: t.ray });
    expect(t.menu.isOpen).toBe(false);
    expect(t.ctx.uiCapture).toBe(true);
    t.teleport.update(frame, DT);
    t.events.emit("selectend", { ray: t.ray });
    expect(t.ctx.uiCapture).toBe(false);
    expect(t.space.placeUser).not.toHaveBeenCalled();
    expect(t.host.goTo).toHaveBeenCalledWith("vp0");

    // Closed: the next pull teleports again.
    t.ray.origin.set(0, 1.2, 0);
    t.ray.direction.set(0, -0.5, -1).normalize();
    t.events.emit("selectstart", { ray: t.ray });
    t.teleport.update(frame, DT);
    t.events.emit("selectend", { ray: t.ray });
    expect(t.teleports).toHaveLength(1);
  });
});

describe("menu dispose", () => {
  it("frees the panel and stops listening", () => {
    const t = setup();
    t.menu.open();
    const mesh = t.mesh();
    const material = mesh.material as MeshBasicMaterial;
    const spies = [
      vi.spyOn(mesh.geometry, "dispose"),
      vi.spyOn(material, "dispose"),
      vi.spyOn(material.map!, "dispose"),
    ];
    t.menu.dispose();
    for (const s of spies) expect(s).toHaveBeenCalled();
    expect(t.panel()).toBeUndefined();
    t.events.emit("menu-button", { hand: "left" });
    expect(t.menu.isOpen).toBe(false);
  });
});
