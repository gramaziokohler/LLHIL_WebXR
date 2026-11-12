// @vitest-environment happy-dom
import { Group, type Mesh, type MeshBasicMaterial, Object3D, type Texture, Vector3 } from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Emitter } from "../../src/events";
import { resolveOptions } from "../../src/index";
import type { AllEvents, KitContext, RaySource } from "../../src/internal";
import { upVector } from "../../src/math";
import { createMenu } from "../../src/menu";
import {
  createPanels,
  measurer,
  PANEL_ANGLE,
  PANEL_CANVAS_WIDTH,
  PANEL_DISTANCE,
  PANEL_DROP,
  PANEL_MARGIN,
  PANEL_MPP,
  PANEL_OFF,
  PANEL_TEXT_LINES,
  PANEL_TILT,
  PANEL_VISIBLE_ROWS,
  type PanelEntry,
  type PanelLayout,
  panelHit,
  panelLayout,
  snapSlider,
  wrapText,
} from "../../src/panels";
import { createTeleport } from "../../src/teleport";
import { DEFAULT_THEME, mergeTheme } from "../../src/theme";
import type { KitEvents, PanelRow, PanelSpec, RaycastFn } from "../../src/types";

const frame = {} as XRFrame;
const DT = 1 / 72;
const EYE = new Vector3(0, 1.6, 0);
const { padding: PAD, rowHeight: ROW } = DEFAULT_THEME;
const W = PANEL_CANVAS_WIDTH;

interface TextCall {
  text: string;
  x: number;
  y: number;
  font: string;
  fillStyle: string;
}

/** A 2D context that records text and fills; widths are 0.5 em per character. */
function recordingContext() {
  const texts: TextCall[] = [];
  const fills: string[] = [];
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
    rect: noop,
    clip: noop,
    save: noop,
    restore: noop,
    fill() {
      fills.push(g.fillStyle);
    },
    stroke: noop,
    drawImage: noop,
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
  };
  return { g, texts, fills, reset };
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

function makeRay(id = "right", kind: RaySource["kind"] = "controller"): RaySource {
  return {
    id,
    kind,
    handedness: "right",
    origin: new Vector3(0.2, 1.2, -0.2),
    // Down at the floor, away from the panels.
    direction: new Vector3(0, -1, 0),
    selecting: false,
  };
}

function stick(x: number, y: number): Gamepad {
  return { axes: [0, 0, x, y], buttons: [] } as unknown as Gamepad;
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

const actions = (n: number, section?: string): PanelRow[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `a${i}`,
    kind: "action" as const,
    label: `Action ${i}`,
    section,
  }));

/** The viewer's two panels, in short. */
function specs(): PanelSpec[] {
  return [
    {
      id: "left",
      side: "left",
      rows: [
        { id: "settings", kind: "section", label: "Settings", value: true },
        { id: "diag", kind: "toggle", label: "Diagnostics", value: false, section: "settings" },
        {
          id: "scale",
          kind: "slider",
          label: "Scale",
          value: 1,
          min: 0.5,
          max: 2,
          step: 0.1,
          format: (v) => `x${v.toFixed(1)}`,
          section: "settings",
        },
        { id: "about", kind: "section", label: "About" },
        { id: "blurb", kind: "text", label: "A short paragraph.", section: "about" },
      ],
    },
    {
      id: "right",
      side: "right",
      rows: [
        { id: "viewpoints", kind: "section", label: "Viewpoints", value: true },
        { id: "vp0", kind: "action", label: "Entrance", section: "viewpoints" },
        { id: "vp1", kind: "action", label: "Mezzanine", section: "viewpoints" },
        { id: "nav", kind: "section", label: "Navigation" },
        {
          id: "mode",
          kind: "choice",
          label: "Mode",
          value: "walk",
          options: [
            { value: "walk", label: "Walk" },
            { value: "fly", label: "Fly" },
          ],
          section: "nav",
        },
      ],
    },
  ];
}

function setup(options: { withMenu?: boolean; mode?: "vr" | "ar"; skipRight?: boolean } = {}) {
  const up = upVector("y");
  const events = new Emitter<AllEvents>();
  const root = new Group();
  const rays: RaySource[] = [];
  const camera = new Object3D();
  const look = (eye: Vector3, yawDeg: number) => {
    const a = (yawDeg * Math.PI) / 180;
    const dir = new Vector3(-Math.sin(a), 0, -Math.cos(a));
    camera.matrixWorld.lookAt(eye, eye.clone().add(dir), up).setPosition(eye);
  };
  look(EYE, 0);
  const resolved = resolveOptions({ renderer: {} as any, scene: {} as any, camera: {} as any });
  const space = { placeUser: vi.fn(), snapTurn: vi.fn() };
  const ctx = {
    renderer: { xr: { getCamera: () => camera } },
    events,
    root,
    up,
    raycast: floor,
    space,
    input: { rays: () => rays },
    mode: options.mode ?? "vr",
    session: null,
    options: resolved,
    theme: mergeTheme(DEFAULT_THEME, {}),
    uiCapture: false,
  } as unknown as KitContext;
  // Wired as the kit wires them: the menu first, B/Y to the panels while any are set.
  let panels: ReturnType<typeof createPanels>;
  const menu = options.withMenu
    ? createMenu(ctx, {
        viewpoints: () => [],
        host: () => ({ goTo: vi.fn(), exit: vi.fn(() => Promise.resolve()) }),
        yieldButton: () => panels.hasPanels,
        otherCapture: () => panels.capturing,
      })
    : null;
  panels = createPanels(ctx, {
    otherCapture: () => menu?.capturing === true,
    skipButton: (hand) => options.skipRight === true && hand === "right",
  });
  menu?.start();
  panels.start();
  const inputs: KitEvents["panel-input"][] = [];
  const opened: boolean[] = [];
  events.on("panel-input", (p) => inputs.push(p));
  events.on("panels", ({ open }) => opened.push(open));

  const group = (side: "left" | "right") => root.getObjectByName(`llhil-webxr-panel-${side}`);
  const state = (side: "left" | "right") =>
    group(side)!.userData.panel as { layout: PanelLayout; scroll: number; open: string | null };
  const texture = (side: "left" | "right") =>
    ((group(side)!.children[0] as Mesh).material as MeshBasicMaterial).map as Texture;
  const entry = (side: "left" | "right", id: string): PanelEntry => {
    const e = state(side).layout.entries.find((x) => x.row.id === id);
    if (!e) throw new Error(`no row ${id} shown`);
    return e;
  };

  /** Points `ray` at a canvas point of a panel (content y, before scrolling). */
  function pointAtPx(ray: RaySource, side: "left" | "right", x: number, y: number) {
    const g = group(side)!;
    g.updateMatrixWorld(true);
    const { layout, scroll } = state(side);
    const local = new Vector3(
      (x - W / 2) * PANEL_MPP,
      (layout.canvasH / 2 - (layout.pad + y - scroll)) * PANEL_MPP,
      0,
    );
    const point = local.applyMatrix4(g.matrixWorld);
    const normal = new Vector3(0, 0, 1).transformDirection(g.matrixWorld);
    ray.origin.copy(point).addScaledVector(normal, 0.4);
    ray.direction.copy(normal).negate();
  }
  /** Points `ray` at a row's centre, or the centre of its pill `pill`. */
  function pointAt(ray: RaySource, side: "left" | "right", id: string, pill?: number) {
    const e = entry(side, id);
    if (pill !== undefined) {
      const r = e.parts[pill];
      pointAtPx(ray, side, r.x + r.w / 2, r.y + r.h / 2);
    } else pointAtPx(ray, side, W / 2, e.y + Math.min(e.h, ROW) / 2);
  }
  function pointAway(ray: RaySource) {
    ray.origin.set(0.2, 1.2, -0.2);
    ray.direction.set(0, -1, 0);
  }
  function trigger(ray: RaySource) {
    events.emit("selectstart", { ray });
    events.emit("selectend", { ray });
  }
  const step = (n = 1, dt = DT) => {
    for (let i = 0; i < n; i++) panels.update(frame, dt);
  };
  const labels = () => recorder.texts.map((t) => t.text);
  const centre = (side: "left" | "right") => {
    const g = group(side)!;
    g.updateMatrixWorld(true);
    return new Vector3().setFromMatrixPosition(g.matrixWorld);
  };
  return {
    ctx,
    events,
    root,
    rays,
    panels,
    menu,
    inputs,
    opened,
    space,
    group,
    state,
    texture,
    entry,
    pointAt,
    pointAtPx,
    pointAway,
    trigger,
    step,
    labels,
    look,
    centre,
  };
}

/** Sets the viewer's panels and opens them. */
function opened(options: { withMenu?: boolean } = {}) {
  const t = setup(options);
  t.panels.set(specs());
  t.panels.open();
  return t;
}

const measure = measurer(null, DEFAULT_THEME);

describe("panel layout", () => {
  it("shows each section's rows only while it is open", () => {
    const rows = specs()[0].rows;
    const l = panelLayout(DEFAULT_THEME, rows, "settings", measure);
    expect(l.entries.map((e) => e.row.id)).toEqual(["settings", "diag", "scale", "about"]);
    const closed = panelLayout(DEFAULT_THEME, rows, null, measure);
    expect(closed.entries.map((e) => e.row.id)).toEqual(["settings", "about"]);
    const about = panelLayout(DEFAULT_THEME, rows, "about", measure);
    expect(about.entries.map((e) => e.row.id)).toEqual(["settings", "about", "blurb"]);
  });

  it("puts rows after their section, and keeps rows without one where they are", () => {
    const rows: PanelRow[] = [
      { id: "x", kind: "action", label: "Loose" },
      { id: "late", kind: "action", label: "Late", section: "s" },
      { id: "s", kind: "section", label: "S" },
      { id: "orphan", kind: "action", label: "Orphan", section: "missing" },
    ];
    const l = panelLayout(DEFAULT_THEME, rows, "s", measure);
    expect(l.entries.map((e) => e.row.id)).toEqual(["x", "s", "late", "orphan"]);
  });

  it("sizes rows per kind and stacks them", () => {
    const l = panelLayout(DEFAULT_THEME, specs()[0].rows, "settings", measure);
    const [section, toggle, slider] = l.entries;
    expect(section.h).toBe(ROW);
    expect(toggle.h).toBe(ROW);
    expect(slider.h).toBe(Math.round(ROW * 1.5));
    expect(toggle.y).toBe(ROW);
    expect(slider.y).toBe(2 * ROW);
    expect(l.total).toBe(3 * ROW + slider.h);
    expect(l.heightPx).toBe(2 * PAD + l.total);
    expect(l.canvasH).toBe(2 * PAD + PANEL_VISIBLE_ROWS * ROW);
    // The switch sits at the right end of its row, the track across the slider's lower part.
    const sw = toggle.parts[0];
    expect(sw.x + sw.w).toBeCloseTo(W - 2 * PAD, 6);
    const track = slider.parts[0];
    expect(track.y).toBeGreaterThan(slider.y + ROW / 2);
    expect(track.y + track.h).toBeLessThan(slider.y + slider.h);
  });

  it("shows at most nine rows, then scrolls", () => {
    const l = panelLayout(DEFAULT_THEME, actions(20), null, measure);
    expect(l.total).toBe(20 * ROW);
    expect(l.viewH).toBe(PANEL_VISIBLE_ROWS * ROW);
    expect(l.heightPx).toBe(l.canvasH);
  });

  it("lays out a choice's pills in its row, or on lines of their own when they do not fit", () => {
    const two: PanelRow = {
      id: "c",
      kind: "choice",
      label: "Mode",
      options: [
        { value: "a", label: "Walk" },
        { value: "b", label: "Fly" },
      ],
    };
    const inline = panelLayout(DEFAULT_THEME, [two], null, measure).entries[0];
    expect(inline.wrapped).toBe(false);
    expect(inline.h).toBe(ROW);
    expect(inline.parts).toHaveLength(2);
    const [a, b] = inline.parts;
    expect(a.w).toBe(b.w);
    expect(b.x + b.w).toBeCloseTo(W - 2 * PAD, 6);
    expect(a.y).toBe(b.y);

    const many: PanelRow = {
      ...two,
      label: "A rather long label for a choice",
      options: Array.from({ length: 6 }, (_, i) => ({ value: `${i}`, label: `Option ${i}` })),
    };
    const wrapped = panelLayout(DEFAULT_THEME, [many], null, measure).entries[0];
    expect(wrapped.wrapped).toBe(true);
    // Below the label, on two lines.
    expect(wrapped.parts[0].y).toBeGreaterThan(ROW);
    const lines = new Set(wrapped.parts.map((p) => p.y));
    expect(lines.size).toBe(2);
    expect(wrapped.h).toBe(3 * ROW);
    expect(wrapped.parts[0].x).toBe(2 * PAD);
  });

  it("wraps a text row onto at most six lines, the last ending in an ellipsis", () => {
    const words = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
    const lines = wrapText(words, 400, (s) => s.length * 10);
    expect(lines).toHaveLength(PANEL_TEXT_LINES);
    for (const line of lines) expect(line.length * 10).toBeLessThanOrEqual(400);
    expect(lines.at(-1)!.endsWith("…")).toBe(true);
    expect(wrapText("one two\nthree", 1000, (s) => s.length)).toEqual(["one two", "three"]);
    const row: PanelRow = { id: "t", kind: "text", label: words };
    const e = panelLayout(DEFAULT_THEME, [row], null, measure).entries[0];
    expect(e.lines).toHaveLength(PANEL_TEXT_LINES);
    expect(e.h).toBeGreaterThan(2 * ROW);
  });

  it("snaps slider values to the step and clamps them to the range", () => {
    const row: PanelRow = { id: "s", kind: "slider", label: "S", min: 0.5, max: 2, step: 0.1 };
    expect(snapSlider(row, 1.234)).toBe(1.2);
    expect(snapSlider(row, 1.26)).toBe(1.3);
    expect(snapSlider(row, 0)).toBe(0.5);
    expect(snapSlider(row, 9)).toBe(2);
    expect(snapSlider({ id: "d", kind: "slider", label: "D" }, 0.123)).toBe(0.12);
  });
});

describe("panel hit-testing", () => {
  const l = panelLayout(DEFAULT_THEME, specs()[1].rows, "nav", measure);
  // Viewpoints, Navigation, Mode (a choice of two pills).

  it("maps canvas points to rows, margins and outside", () => {
    const x = W / 2;
    expect(panelHit(l, 0, x, PAD + 1)).toBe(0);
    expect(panelHit(l, 0, x, PAD + ROW + 1)).toBe(32);
    expect(panelHit(l, 0, x, PAD / 2)).toBe(PANEL_MARGIN);
    expect(panelHit(l, 0, PAD / 2, PAD + 10)).toBe(PANEL_MARGIN);
    expect(panelHit(l, 0, x, -1)).toBe(PANEL_OFF);
    expect(panelHit(l, 0, x, l.heightPx + 1)).toBe(PANEL_OFF);
    expect(panelHit(l, 0, W + 1, PAD + 10)).toBe(PANEL_OFF);
  });

  it("finds the pills of a choice, and the row between them", () => {
    const [walk, fly] = l.entries[2].parts;
    expect(panelHit(l, 0, walk.x + 5, PAD + walk.y + 5)).toBe(2 * 32 + 1);
    expect(panelHit(l, 0, fly.x + fly.w - 5, PAD + fly.y + fly.h - 5)).toBe(2 * 32 + 2);
    // The label part of the row.
    expect(panelHit(l, 0, 3 * PAD, PAD + 2 * ROW + ROW / 2)).toBe(2 * 32);
  });

  it("follows the scroll", () => {
    const long = panelLayout(DEFAULT_THEME, actions(20), null, measure);
    expect(panelHit(long, 3 * ROW, W / 2, PAD + 1)).toBe(3 * 32);
    expect(panelHit(long, 3 * ROW, W / 2, PAD + 8 * ROW + 1)).toBe(11 * 32);
  });
});

describe("panels open, close and placement", () => {
  it("runs in AR too; on site the right hand's button is not the panels', the left one is", () => {
    const table = setup({ mode: "ar" });
    table.panels.set(specs());
    table.events.emit("menu-button", { hand: "right" });
    expect(table.panels.isOpen).toBe(true);
    expect(table.ctx.uiCapture).toBe(true);

    const site = setup({ mode: "ar", skipRight: true });
    site.panels.set(specs());
    site.events.emit("menu-button", { hand: "right" });
    expect(site.panels.isOpen).toBe(false);
    site.events.emit("menu-button", { hand: "left" });
    expect(site.panels.isOpen).toBe(true);
  });

  it("B or Y opens and closes the panels while any are set, and reports it", () => {
    const t = setup();
    t.events.emit("menu-button", { hand: "left" });
    expect(t.panels.isOpen).toBe(false);
    t.panels.set(specs());
    t.events.emit("menu-button", { hand: "left" });
    expect(t.panels.isOpen).toBe(true);
    expect(t.group("left")).toBeDefined();
    expect(t.group("right")).toBeDefined();
    t.events.emit("menu-button", { hand: "right" });
    expect(t.panels.isOpen).toBe(false);
    expect(t.group("left")).toBeUndefined();
    expect(t.opened).toEqual([true, false]);
  });

  it("B or Y opens the menu when no panels are set, and the panels instead when set", () => {
    const t = setup({ withMenu: true });
    t.events.emit("menu-button", { hand: "left" });
    expect(t.menu!.isOpen).toBe(true);
    expect(t.panels.isOpen).toBe(false);
    t.events.emit("menu-button", { hand: "left" });
    expect(t.menu!.isOpen).toBe(false);

    t.panels.set(specs());
    t.events.emit("menu-button", { hand: "left" });
    expect(t.panels.isOpen).toBe(true);
    expect(t.menu!.isOpen).toBe(false);
    expect(t.ctx.uiCapture).toBe(true);
    t.events.emit("menu-button", { hand: "left" });
    expect(t.panels.isOpen).toBe(false);
    expect(t.ctx.uiCapture).toBe(false);

    // [] = none: the centre menu again; it closes and opens the panels' way while set.
    t.panels.set([]);
    t.events.emit("menu-button", { hand: "left" });
    expect(t.menu!.isOpen).toBe(true);
    t.panels.set(specs());
    t.events.emit("menu-button", { hand: "left" });
    expect(t.menu!.isOpen).toBe(false);
    expect(t.panels.isOpen).toBe(true);
  });

  it("setting no panels while open closes them", () => {
    const t = opened();
    t.panels.set([]);
    expect(t.panels.isOpen).toBe(false);
    expect(t.group("left")).toBeUndefined();
    expect(t.opened).toEqual([true, false]);
  });

  it("does nothing outside a VR session, and closes when the session ends", () => {
    const t = setup();
    t.panels.set(specs());
    t.panels.stop();
    t.panels.open();
    expect(t.panels.isOpen).toBe(false);
    t.panels.start();
    t.panels.open();
    expect(t.panels.isOpen).toBe(true);
    t.panels.stop();
    expect(t.panels.isOpen).toBe(false);
    expect(t.group("right")).toBeUndefined();
    expect(t.ctx.uiCapture).toBe(false);
  });

  it("one panel per side", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = setup();
    const [left] = specs();
    t.panels.set([left, { ...left, id: "other" }]);
    t.panels.open();
    expect(warn).toHaveBeenCalledOnce();
    expect(t.group("right")).toBeUndefined();
    expect(t.group("left")).toBeDefined();
  });

  it("stands 40 degrees left and right, 0.75 m away, 0.3 m below the eye, facing it, leaning back", () => {
    const t = opened();
    for (const side of ["left", "right"] as const) {
      const c = t.centre(side);
      expect(c.y).toBeCloseTo(EYE.y - PANEL_DROP, 6);
      const flat = new Vector3(c.x - EYE.x, 0, c.z - EYE.z);
      expect(flat.length()).toBeCloseTo(PANEL_DISTANCE, 6);
      // Yaw: left is counter-clockwise from -Z.
      const yaw = (Math.atan2(-flat.x, -flat.z) * 180) / Math.PI;
      expect(yaw).toBeCloseTo(side === "left" ? PANEL_ANGLE : -PANEL_ANGLE, 6);
      const g = t.group(side)!;
      const normal = new Vector3(0, 0, 1).transformDirection(g.matrixWorld);
      const towards = flat.clone().negate().normalize();
      // Faces the user horizontally, tilted up by the lean.
      expect(new Vector3(normal.x, 0, normal.z).normalize().dot(towards)).toBeCloseTo(1, 6);
      expect((Math.asin(normal.y) * 180) / Math.PI).toBeCloseTo(PANEL_TILT, 6);
      const upAxis = new Vector3(0, 1, 0).transformDirection(g.matrixWorld);
      expect(upAxis.dot(towards)).toBeLessThan(0);
    }
  });

  it("stays put for small head motions and re-centres smoothly after a 60 degree turn", () => {
    const t = opened();
    const left0 = t.centre("left");
    const right0 = t.centre("right");
    // A look around and a lean: nothing moves.
    t.look(new Vector3(0.2, 1.5, 0.1), 55);
    t.step(72);
    t.look(new Vector3(-0.2, 1.6, 0), -55);
    t.step(72);
    expect(t.centre("left").distanceTo(left0)).toBeLessThan(1e-9);
    expect(t.centre("right").distanceTo(right0)).toBeLessThan(1e-9);

    // Turned around: they follow, eased over 0.4 s.
    t.look(EYE, 90);
    t.step(1);
    const early = t.centre("left");
    t.step(Math.round(0.15 * 72));
    const mid = t.centre("left");
    const target = new Vector3(
      -Math.sin(130 * (Math.PI / 180)),
      0,
      -Math.cos(130 * (Math.PI / 180)),
    )
      .multiplyScalar(PANEL_DISTANCE)
      .add(new Vector3(EYE.x, EYE.y - PANEL_DROP, EYE.z));
    expect(mid.distanceTo(early)).toBeGreaterThan(0.01);
    expect(mid.distanceTo(target)).toBeGreaterThan(0.05);
    t.step(Math.round(0.4 * 72));
    expect(t.centre("left").distanceTo(target)).toBeLessThan(1e-6);
    // And still afterwards.
    t.step(72);
    expect(t.centre("left").distanceTo(target)).toBeLessThan(1e-6);
  });

  it("jumps with the user after a teleport", () => {
    const t = opened();
    t.look(new Vector3(10, 1.6, 0), 0);
    t.step(1);
    expect(t.centre("left").x).toBeCloseTo(10 - PANEL_DISTANCE * Math.sin((40 * Math.PI) / 180), 6);
  });
});

describe("panel sections", () => {
  it("opens the section with value true first", () => {
    const t = opened();
    expect(t.state("left").open).toBe("settings");
    expect(t.state("right").open).toBe("viewpoints");
    expect(t.labels()).toContain("Diagnostics");
    expect(t.labels()).not.toContain("A short paragraph.");
  });

  it("a tap on a header opens it and closes the other on that side only", () => {
    const t = opened();
    const ray = makeRay();
    t.rays.push(ray);
    t.pointAt(ray, "left", "about");
    recorder.reset();
    t.trigger(ray);
    expect(t.state("left").open).toBe("about");
    expect(t.state("right").open).toBe("viewpoints");
    expect(t.inputs).toEqual([{ panel: "left", id: "about", value: true }]);
    expect(t.labels()).toContain("A short paragraph.");
    expect(t.labels()).not.toContain("Diagnostics");
    expect(t.entry("left", "about").y).toBe(ROW);

    t.pointAt(ray, "left", "about");
    t.trigger(ray);
    expect(t.state("left").open).toBeNull();
    expect(t.inputs[1]).toEqual({ panel: "left", id: "about", value: false });
    expect(t.state("left").layout.entries).toHaveLength(2);
  });

  it("the host opens a section with updatePanelRow", () => {
    const t = opened();
    t.panels.updateRow("right", "nav", { value: true });
    expect(t.state("right").open).toBe("nav");
    expect(t.state("right").layout.entries.map((e) => e.row.id)).toEqual([
      "viewpoints",
      "nav",
      "mode",
    ]);
  });
});

describe("panel rows", () => {
  it("an action reports its id; a toggle flips and reports its value", () => {
    const t = opened();
    const ray = makeRay();
    t.rays.push(ray);
    t.pointAt(ray, "right", "vp1");
    t.trigger(ray);
    expect(t.inputs).toEqual([{ panel: "right", id: "vp1" }]);
    expect(t.panels.isOpen).toBe(true);

    t.pointAt(ray, "left", "diag");
    t.trigger(ray);
    t.trigger(ray);
    expect(t.inputs.slice(1)).toEqual([
      { panel: "left", id: "diag", value: true },
      { panel: "left", id: "diag", value: false },
    ]);
  });

  it("a choice selects the pill under the ray, never its label", () => {
    const t = opened();
    t.panels.updateRow("right", "nav", { value: true });
    const ray = makeRay();
    t.rays.push(ray);
    t.pointAtPx(ray, "right", 3 * PAD, t.entry("right", "mode").y + ROW / 2);
    t.trigger(ray);
    expect(t.inputs).toEqual([]);
    t.pointAt(ray, "right", "mode", 1);
    recorder.reset();
    t.trigger(ray);
    expect(t.inputs).toEqual([{ panel: "right", id: "mode", value: "fly" }]);
    // The selected pill is filled with the text colour, its label in the background colour.
    expect(recorder.texts.find((x) => x.text === "Fly")!.fillStyle).toBe(DEFAULT_THEME.background);
    expect(recorder.texts.find((x) => x.text === "Walk")!.fillStyle).toBe(DEFAULT_THEME.text);
  });

  it("disabled rows and text rows are not interactive", () => {
    const t = setup();
    t.panels.set([
      {
        id: "p",
        side: "right",
        rows: [
          { id: "off", kind: "action", label: "Off", disabled: true },
          { id: "txt", kind: "text", label: "Words" },
        ],
      },
    ]);
    t.panels.open();
    const ray = makeRay();
    t.rays.push(ray);
    t.pointAt(ray, "right", "off");
    recorder.reset();
    t.step();
    t.trigger(ray);
    t.pointAt(ray, "right", "txt");
    t.step();
    t.trigger(ray);
    expect(t.inputs).toEqual([]);
    expect(recorder.fills).not.toContain(DEFAULT_THEME.highlight);
  });

  it("highlights the hovered row or pill, redrawing only when it changes", () => {
    const t = opened();
    t.panels.updateRow("right", "nav", { value: true });
    const ray = makeRay();
    t.rays.push(ray);
    const tex = t.texture("right");
    const v0 = tex.version;
    t.step(5);
    expect(tex.version).toBe(v0);
    t.pointAt(ray, "right", "nav");
    recorder.reset();
    t.step();
    expect(tex.version).toBe(v0 + 1);
    expect(recorder.fills).toContain(DEFAULT_THEME.highlight);
    t.step(5);
    expect(tex.version).toBe(v0 + 1);
    t.pointAt(ray, "right", "mode", 1);
    t.step();
    expect(tex.version).toBe(v0 + 2);
    t.pointAway(ray);
    recorder.reset();
    t.step();
    expect(tex.version).toBe(v0 + 3);
    expect(recorder.fills).not.toContain(DEFAULT_THEME.highlight);
  });

  it("either controller and a hand pinch work", () => {
    const t = opened();
    const left = makeRay("left");
    left.handedness = "left";
    const hand = makeRay("hand", "hand");
    t.rays.push(left, hand);
    t.pointAt(left, "right", "vp0");
    t.trigger(left);
    t.pointAt(hand, "left", "diag");
    t.trigger(hand);
    expect(t.inputs).toEqual([
      { panel: "right", id: "vp0" },
      { panel: "left", id: "diag", value: true },
    ]);
  });

  it("a ray from behind a panel does not hit it", () => {
    const t = opened();
    const ray = makeRay();
    t.rays.push(ray);
    t.pointAt(ray, "right", "vp0");
    ray.origin.addScaledVector(ray.direction, 0.8);
    ray.direction.negate();
    t.trigger(ray);
    expect(t.inputs).toEqual([]);
  });
});

describe("panel sliders", () => {
  /** The slider's track in canvas px and the ray on it at fraction `f`. */
  function onTrack(t: ReturnType<typeof opened>, ray: RaySource, f: number) {
    const e = t.entry("left", "scale");
    const track = e.parts[0];
    t.pointAtPx(ray, "left", track.x + f * track.w, track.y + track.h / 2);
  }

  it("drags with the ray, snapped to the step, throttled to ~10 events a second, then final", () => {
    const t = opened();
    const ray = makeRay();
    t.rays.push(ray);
    onTrack(t, ray, 0);
    t.events.emit("selectstart", { ray });
    expect(t.inputs).toEqual([{ panel: "left", id: "scale", value: 0.5, final: false }]);
    const tex = t.texture("left");
    const v0 = tex.version;
    // One second along the track, at 72 frames a second.
    for (let i = 1; i <= 72; i++) {
      onTrack(t, ray, i / 72);
      t.step();
    }
    const during = t.inputs.slice(1);
    expect(during.length).toBeGreaterThanOrEqual(9);
    expect(during.length).toBeLessThanOrEqual(11);
    for (let i = 0; i < during.length; i++) {
      const v = during[i].value as number;
      expect(during[i].final).toBe(false);
      expect(Math.abs(v * 10 - Math.round(v * 10))).toBeLessThan(1e-9);
      if (i > 0) expect(v).toBeGreaterThan(during[i - 1].value as number);
    }
    // Redraws at most ~30 a second while dragging.
    expect(tex.version - v0).toBeGreaterThan(5);
    expect(tex.version - v0).toBeLessThanOrEqual(31);
    // Pointing away from the panel's plane the value holds; released: one final event.
    ray.direction.set(0, 1, 0);
    t.step();
    recorder.reset();
    t.events.emit("selectend", { ray });
    expect(t.inputs.at(-1)).toEqual({ panel: "left", id: "scale", value: 2, final: true });
    expect(t.labels()).toContain("x2.0");
    // Released: the ray moving along no longer drags.
    const count = t.inputs.length;
    onTrack(t, ray, 0.5);
    t.step(20);
    expect(t.inputs).toHaveLength(count);
  });

  it("a press anywhere on the slider row sets it, and the label shows format(v)", () => {
    const t = opened();
    const ray = makeRay();
    t.rays.push(ray);
    onTrack(t, ray, 0.5);
    recorder.reset();
    t.trigger(ray);
    // 0.5 + 0.5 * 1.5 = 1.25, snapped to a step of 0.1.
    expect(t.inputs.map((e) => e.value)).toEqual([1.3, 1.3]);
    expect(t.inputs.map((e) => e.final)).toEqual([false, true]);
    expect(t.labels()).toContain("x1.3");
  });

  it("stick left/right on a hovered slider steps it", () => {
    const t = opened();
    const ray = makeRay();
    t.rays.push(ray);
    onTrack(t, ray, 1 / 3); // 1.0
    t.step();
    ray.gamepad = stick(0.9, 0);
    t.step();
    ray.gamepad = stick(0, 0);
    t.step();
    ray.gamepad = stick(0.9, 0);
    t.step();
    ray.gamepad = stick(0, 0);
    t.step();
    ray.gamepad = stick(-0.9, 0);
    t.step();
    expect(t.inputs).toEqual([
      { panel: "left", id: "scale", value: 1.1, final: true },
      { panel: "left", id: "scale", value: 1.2, final: true },
      { panel: "left", id: "scale", value: 1.1, final: true },
    ]);
    // Not on a slider: nothing.
    ray.gamepad = stick(0, 0);
    t.pointAt(ray, "left", "diag");
    t.step();
    ray.gamepad = stick(0.9, 0);
    t.step();
    expect(t.inputs).toHaveLength(3);
  });

  it("a host value echoed during a drag does not move the slider", () => {
    const t = opened();
    const ray = makeRay();
    t.rays.push(ray);
    onTrack(t, ray, 1);
    t.events.emit("selectstart", { ray });
    t.panels.updateRow("left", "scale", { value: 0.5, label: "Size" });
    t.events.emit("selectend", { ray });
    expect(t.inputs.at(-1)).toEqual({ panel: "left", id: "scale", value: 2, final: true });
    expect(t.entry("left", "scale").row.label).toBe("Size");
  });
});

describe("panel scrolling", () => {
  function long() {
    const t = setup();
    t.panels.set([
      {
        id: "list",
        side: "right",
        rows: [{ id: "s", kind: "section", label: "Many", value: true }, ...actions(20, "s")],
      },
    ]);
    t.panels.open();
    return t;
  }

  it("draws nine rows and a scroll bar; stick down over the panel scrolls a row", () => {
    const t = long();
    expect(t.labels().slice(0, 2)).toEqual(["Many", "Action 0"]);
    expect(recorder.fills.at(-1)).toBe(DEFAULT_THEME.accent);
    const ray = makeRay();
    t.rays.push(ray);
    // Away from the panel the stick does nothing.
    ray.gamepad = stick(0, 0.9);
    t.step();
    expect(t.state("right").scroll).toBe(0);
    ray.gamepad = stick(0, 0);
    t.pointAt(ray, "right", "a3");
    t.step();
    ray.gamepad = stick(0, 0.9);
    recorder.reset();
    t.step();
    expect(t.state("right").scroll).toBe(ROW);
    expect(t.labels()[0]).toBe("Action 0");
    // Held: repeats.
    t.step(72);
    const scrolled = t.state("right").scroll / ROW;
    expect(scrolled).toBeGreaterThanOrEqual(4);
    expect(scrolled).toBeLessThanOrEqual(6);
    // Up again; never past the ends.
    ray.gamepad = stick(0, -0.9);
    t.step(400);
    expect(t.state("right").scroll).toBe(0);
    ray.gamepad = stick(0, 0.9);
    t.step(800);
    expect(t.state("right").scroll).toBe(21 * ROW - PANEL_VISIBLE_ROWS * ROW);
  });

  it("selects the row shown under the ray after scrolling", () => {
    const t = long();
    const ray = makeRay();
    t.rays.push(ray);
    t.pointAt(ray, "right", "a0");
    t.step();
    ray.gamepad = stick(0, 0.9);
    t.step();
    ray.gamepad = stick(0, 0);
    t.step();
    // The same spot now shows the next row.
    t.trigger(ray);
    expect(t.inputs).toEqual([{ panel: "list", id: "a1" }]);
  });
});

describe("panels capture the controllers", () => {
  function both() {
    const t = setup();
    (t.ctx.options as any).vr = { turn: "snap", snapDegrees: 30, eyeHeight: 1.6, teleport: true };
    const teleport = createTeleport(t.ctx);
    teleport.start();
    const teleports: Vector3[] = [];
    t.events.on("teleport", ({ position }) => teleports.push(position));
    const ray = makeRay();
    ray.direction.set(0, -0.5, -1).normalize();
    t.rays.push(ray);
    t.panels.set(specs());
    return { ...t, teleport, teleports, ray };
  }

  it("sets uiCapture while open; the trigger does not teleport", () => {
    const t = both();
    t.panels.open();
    expect(t.ctx.uiCapture).toBe(true);
    t.events.emit("selectstart", { ray: t.ray });
    t.teleport.update(frame, DT);
    t.events.emit("selectend", { ray: t.ray });
    expect(t.teleports).toEqual([]);
    t.panels.close();
    expect(t.ctx.uiCapture).toBe(false);
  });

  it("the release of a trigger held as the panels closed does not teleport", () => {
    const t = both();
    t.panels.open();
    t.pointAt(t.ray, "right", "vp0");
    t.events.emit("selectstart", { ray: t.ray });
    t.panels.close();
    expect(t.ctx.uiCapture).toBe(true);
    t.ray.direction.set(0, -0.5, -1).normalize();
    t.teleport.update(frame, DT);
    t.events.emit("selectend", { ray: t.ray });
    expect(t.ctx.uiCapture).toBe(false);
    expect(t.teleports).toEqual([]);
    // Closed: the next pull teleports again.
    t.ray.origin.set(0, 1.2, 0);
    t.events.emit("selectstart", { ray: t.ray });
    t.teleport.update(frame, DT);
    t.events.emit("selectend", { ray: t.ray });
    expect(t.teleports).toHaveLength(1);
  });

  it("the menu and the panels share uiCapture", () => {
    const t = setup({ withMenu: true });
    const ray = makeRay();
    t.rays.push(ray);
    t.panels.set(specs());
    t.panels.open();
    t.pointAt(ray, "right", "vp0");
    t.events.emit("selectstart", { ray });
    // Host code opens the menu meanwhile; the panels' trigger is still down.
    t.panels.close();
    t.menu!.open();
    t.menu!.close();
    expect(t.ctx.uiCapture).toBe(true);
    t.events.emit("selectend", { ray });
    expect(t.ctx.uiCapture).toBe(false);
  });
});

describe("panel redraws", () => {
  it("updatePanelRow redraws only that panel, with the new value and label", () => {
    const t = opened();
    const left = t.texture("left");
    const right = t.texture("right");
    const [l0, r0] = [left.version, right.version];
    recorder.reset();
    t.panels.updateRow("left", "diag", { value: true, label: "Stats" });
    expect(left.version).toBe(l0 + 1);
    expect(right.version).toBe(r0);
    expect(t.labels()).toContain("Stats");
    t.panels.updateRow("left", "nope", { label: "x" });
    t.panels.updateRow("nope", "diag", { label: "x" });
    expect(left.version).toBe(l0 + 1);
    t.panels.updateRow("left", "scale", { disabled: true });
    expect(left.version).toBe(l0 + 2);
    expect(right.version).toBe(r0);
  });

  it("rows are copies: the host's objects do not change", () => {
    const t = setup();
    const list = specs();
    t.panels.set(list);
    t.panels.open();
    const ray = makeRay();
    t.rays.push(ray);
    t.pointAt(ray, "left", "diag");
    t.trigger(ray);
    expect(list[0].rows[1].value).toBe(false);
  });

  it("redraws open panels on a theme change, with the theme; not closed ones", () => {
    const t = opened();
    const left = t.texture("left");
    const right = t.texture("right");
    const [l0, r0] = [left.version, right.version];
    t.ctx.theme = mergeTheme(t.ctx.theme, { fontFamily: "Inter, sans-serif", text: "#00ff00" });
    recorder.reset();
    t.events.emit("theme", { theme: t.ctx.theme });
    expect(left.version).toBe(l0 + 1);
    expect(right.version).toBe(r0 + 1);
    const label = recorder.texts.find((x) => x.text === "Entrance")!;
    expect(label.fillStyle).toBe("#00ff00");
    expect(label.font).toMatch(/Inter, sans-serif$/);
    t.panels.close();
    recorder.reset();
    t.events.emit("theme", { theme: t.ctx.theme });
    expect(recorder.texts).toEqual([]);
  });

  it("a taller row height grows the canvas", () => {
    const t = opened();
    t.ctx.theme = mergeTheme(t.ctx.theme, { rowHeight: 140 });
    t.events.emit("theme", { theme: t.ctx.theme });
    const canvas = t.texture("left").image as HTMLCanvasElement;
    expect(canvas.height).toBe(2 * PAD + PANEL_VISIBLE_ROWS * 140);
  });
});

describe("panels dispose", () => {
  it("frees the panels and stops listening", () => {
    const t = opened();
    const mesh = t.group("left")!.children[0] as Mesh;
    const material = mesh.material as MeshBasicMaterial;
    const spies = [
      vi.spyOn(mesh.geometry, "dispose"),
      vi.spyOn(material, "dispose"),
      vi.spyOn(material.map!, "dispose"),
    ];
    t.panels.dispose();
    for (const s of spies) expect(s).toHaveBeenCalled();
    expect(t.group("left")).toBeUndefined();
    t.events.emit("menu-button", { hand: "left" });
    expect(t.panels.isOpen).toBe(false);
    expect(t.ctx.uiCapture).toBe(false);
  });
});
