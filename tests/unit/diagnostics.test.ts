// @vitest-environment happy-dom
import { Group, Matrix4, type Mesh, Vector3 } from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDiagnostics,
  createFrameStats,
  DEFAULT_PANEL_STYLE,
  DIAG_HEAD_OFFSET,
  DIAG_WRIST_OFFSET,
  panelStyle,
} from "../../src/diagnostics";
import { Emitter } from "../../src/events";
import type { KitContext } from "../../src/internal";
import type { FrameStats } from "../../src/types";

interface TextCall {
  text: string;
  font: string;
  fillStyle: string;
}

/** A 2D context that records the text it is asked to draw; widths are 0.5 em per character. */
function recordingContext() {
  const texts: TextCall[] = [];
  const noop = () => {};
  const g = {
    font: "10px sans-serif",
    fillStyle: "#000",
    strokeStyle: "#000",
    globalAlpha: 1,
    lineWidth: 1,
    letterSpacing: "0px",
    textAlign: "start",
    textBaseline: "alphabetic",
    clearRect: noop,
    beginPath: noop,
    moveTo: noop,
    lineTo: noop,
    arcTo: noop,
    closePath: noop,
    fill: noop,
    stroke: noop,
    fillText(text: string) {
      texts.push({ text, font: g.font, fillStyle: g.fillStyle });
    },
    measureText(text: string) {
      const size = Number(/(\d+)px/.exec(g.font)?.[1] ?? 10);
      return { width: text.length * size * 0.5 };
    },
  };
  return { g, texts };
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

const translation = (x: number, y: number, z: number) =>
  ({
    transform: { matrix: new Float32Array(new Matrix4().makeTranslation(x, y, z).elements) },
  }) as unknown as XRPose;

function setup(
  opts: {
    enabled?: boolean;
    extra?: () => Record<string, string | number>;
    frameRate?: number;
    leftGrip?: [number, number, number] | null;
  } = {},
) {
  const ref = { id: "ref" };
  const gripSpace = { id: "grip" };
  const root = new Group();
  const events = new Emitter<any>();
  const session = {
    frameRate: opts.frameRate,
    inputSources: opts.leftGrip
      ? [
          { handedness: "right", gripSpace: { id: "right" } },
          { handedness: "left", gripSpace },
        ]
      : [],
  };
  const ctx = {
    renderer: { xr: { getReferenceSpace: () => ref } },
    root,
    up: new Vector3(0, 1, 0),
    events,
    session,
    options: {
      performance: { framebufferScale: 0.85, foveation: 1, targetFrameRate: 72 },
      diagnostics: { enabled: opts.enabled ?? false, extra: opts.extra ?? null },
    },
  } as unknown as KitContext;
  const frame = {
    getViewerPose: (space: unknown) => (space === ref ? translation(0, 1.6, 0) : null),
    getPose: (space: unknown, base: unknown) =>
      space === gripSpace && base === ref && opts.leftGrip ? translation(...opts.leftGrip) : null,
  } as unknown as XRFrame;
  const diag = createDiagnostics(ctx);
  const mesh = () => root.getObjectByName("llhil-webxr-diagnostics") as Mesh | undefined;
  const run = (n: number, dt = 1 / 72) => {
    for (let i = 0; i < n; i++) diag.update(frame, dt);
  };
  return { ctx, diag, root, events, mesh, run, session };
}

const labels = () => recorder.texts.map((t) => t.text);
const position = (m: Mesh) => new Vector3().setFromMatrixPosition(m.matrix);

describe("frame stats", () => {
  it("measures fps, mean frame time and missed frames over the last second", () => {
    const stats = createFrameStats();
    const out: FrameStats = { fps: 0, frameMs: 0, missed: 0 };
    expect(stats.read(out)).toBe(false);
    const threshold = (1.5 * 1000) / 72;
    for (let i = 0; i < 72; i++) stats.push(1000 / 72, threshold);
    expect(stats.read(out)).toBe(true);
    expect(out.fps).toBeCloseTo(72, 3);
    expect(out.frameMs).toBeCloseTo(13.889, 2);
    expect(out.missed).toBe(0);
    // Two dropped frames (each shown twice as long).
    stats.push(2000 / 72, threshold);
    stats.push(2000 / 72, threshold);
    stats.read(out);
    expect(out.missed).toBe(2);
    // A second later they are out of the window.
    for (let i = 0; i < 80; i++) stats.push(1000 / 72, threshold);
    stats.read(out);
    expect(out.missed).toBe(0);
    expect(out.fps).toBeCloseTo(72, 3);
  });

  it("ignores empty intervals and survives more frames than its ring holds", () => {
    const stats = createFrameStats(8);
    const out: FrameStats = { fps: 0, frameMs: 0, missed: 0 };
    stats.push(0, 20);
    expect(stats.read(out)).toBe(false);
    for (let i = 0; i < 50; i++) stats.push(5, 20);
    stats.read(out);
    expect(out.frameMs).toBe(5);
    expect(out.fps).toBe(200);
  });
});

describe("diagnostics", () => {
  it("has stats only while started, as a fresh copy", () => {
    const { diag, run } = setup();
    expect(diag.stats).toBeNull();
    diag.start();
    expect(diag.stats).toBeNull();
    run(36);
    const a = diag.stats!;
    expect(a.fps).toBeCloseTo(72, 3);
    expect(a.missed).toBe(0);
    a.fps = 1;
    expect(diag.stats!.fps).toBeCloseTo(72, 3);
    diag.stop();
    expect(diag.stats).toBeNull();
  });

  it("counts missed frames against the session's own frame rate when it exposes one", () => {
    const { diag, run } = setup({ frameRate: 120 });
    diag.start();
    // 13.9 ms is over 1.5 x 8.3 ms.
    run(10, 1 / 72);
    expect(diag.stats!.missed).toBe(10);
  });

  it("stays hidden while off, and shows on the wrist of a tracked left grip", () => {
    const { diag, mesh, run } = setup({ leftGrip: [0.3, 1.0, -0.2] });
    diag.start();
    run(2);
    expect(mesh()!.visible).toBe(false);
    diag.setEnabled(true);
    expect(diag.enabled).toBe(true);
    run(1);
    expect(mesh()!.visible).toBe(true);
    const [x, y, z] = DIAG_WRIST_OFFSET;
    const p = position(mesh()!);
    expect(p.x).toBeCloseTo(0.3 + x, 6);
    expect(p.y).toBeCloseTo(1.0 + y, 6);
    expect(p.z).toBeCloseTo(-0.2 + z, 6);
    diag.setEnabled(false);
    expect(mesh()!.visible).toBe(false);
  });

  it("falls back to low on the left of the view without a left grip", () => {
    const { diag, mesh, run } = setup({ enabled: true });
    diag.start();
    run(1);
    const [x, y, z] = DIAG_HEAD_OFFSET;
    const p = position(mesh()!);
    expect(p.x).toBeCloseTo(x, 6);
    expect(p.y).toBeCloseTo(1.6 + y, 6);
    expect(p.z).toBeCloseTo(z, 6);
    // Faces the eye: its normal (+Z) points back at the head.
    const normal = new Vector3(0, 0, 1).transformDirection(mesh()!.matrix);
    const toHead = new Vector3(0, 1.6, 0).sub(p).normalize();
    expect(normal.dot(toHead)).toBeCloseTo(1, 6);
  });

  it("shows timing, the display rate, the framebuffer scale and the host's lines", () => {
    const { diag, run } = setup({
      enabled: true,
      frameRate: 72,
      extra: () => ({ triangles: 120000, "draw calls": 41, quality: "high", ms: 1.234 }),
    });
    diag.start();
    run(1);
    run(30);
    const shown = labels();
    for (const text of ["fps", "frame", "missed", "display", "72 Hz", "scale", "0.85"]) {
      expect(shown).toContain(text);
    }
    for (const text of ["triangles", "120000", "draw calls", "41", "quality", "high", "1.23"]) {
      expect(shown).toContain(text);
    }
  });

  it("redraws at most 4 times a second and calls extra no more often", () => {
    const extra = vi.fn(() => ({ n: Math.random() }));
    const { diag, mesh, run } = setup({ enabled: true, extra });
    diag.start();
    run(1);
    const material = mesh()!.material as unknown as { map: { version: number } };
    const before = material.map.version;
    run(70);
    expect(extra.mock.calls.length).toBeLessThanOrEqual(4);
    expect(material.map.version - before).toBeLessThanOrEqual(3);
  });

  it("does not upload the canvas when nothing changed", () => {
    const { diag, mesh, run } = setup({ enabled: true });
    diag.start();
    run(80);
    const material = mesh()!.material as unknown as { map: { version: number } };
    const before = material.map.version;
    run(72);
    expect(material.map.version).toBe(before);
  });

  it("warns once when extra throws, and keeps drawing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { diag, run } = setup({
      enabled: true,
      extra: () => {
        throw new Error("host bug");
      },
    });
    diag.start();
    run(72);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(labels()).toContain("fps");
  });

  it("is neutral by default: system sans-serif, white text", () => {
    const { diag, run } = setup({ enabled: true });
    diag.start();
    run(1);
    const value = recorder.texts.find((t) => t.text === "0.85")!;
    expect(value.font).toContain("system-ui, sans-serif");
    expect(value.fillStyle).toBe("#ffffff");
  });

  it("takes the host theme from ctx.theme and redraws on a theme event", () => {
    const { ctx, diag, events, run } = setup({ enabled: true });
    diag.start();
    run(1);
    (ctx as unknown as { theme: object }).theme = {
      fontFamily: "Host Sans",
      fontWeight: 300,
      text: "#112233",
      padding: "wide",
    };
    recorder.texts.length = 0;
    events.emit("theme", {});
    run(1);
    const value = recorder.texts.find((t) => t.text === "0.85")!;
    expect(value.font).toMatch(/^300 \d+px Host Sans$/);
    expect(value.fillStyle).toBe("#112233");
  });

  it("panelStyle keeps the defaults for missing or ill-typed fields", () => {
    expect(panelStyle(undefined)).toEqual(DEFAULT_PANEL_STYLE);
    expect(panelStyle({ radius: Number.NaN, text: 3, background: "#000" })).toEqual({
      ...DEFAULT_PANEL_STYLE,
      background: "#000",
    });
  });

  it("removes the panel on stop and frees it on dispose", () => {
    const { diag, root, run } = setup({ enabled: true });
    diag.start();
    run(1);
    expect(root.children).toHaveLength(1);
    diag.stop();
    expect(root.children).toHaveLength(0);
    diag.dispose();
    diag.start();
    expect(root.children).toHaveLength(0);
  });
});
