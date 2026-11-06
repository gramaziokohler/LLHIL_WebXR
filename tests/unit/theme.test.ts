// @vitest-environment happy-dom
import { Group, Object3D, PerspectiveCamera, Scene } from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Emitter } from "../../src/events";
import { createHud } from "../../src/hud";
import { createXRKit, DEFAULT_THEME as EXPORTED, resolveOptions } from "../../src/index";
import type { AllEvents, KitContext } from "../../src/internal";
import { upVector } from "../../src/math";
import { DEFAULT_THEME, fontOf, mergeTheme } from "../../src/theme";

describe("theme", () => {
  it("defaults to the kit's neutral look: system sans-serif, white on dark", () => {
    expect(EXPORTED).toBe(DEFAULT_THEME);
    expect(DEFAULT_THEME.fontFamily).toBe("system-ui, sans-serif");
    expect(DEFAULT_THEME.text).toBe("#ffffff");
    expect(DEFAULT_THEME.backgroundOpacity).toBeGreaterThan(0);
    expect(DEFAULT_THEME.backgroundOpacity).toBeLessThan(1);
    expect(DEFAULT_THEME.uppercaseTitles).toBe(false);
    expect(Object.isFrozen(DEFAULT_THEME)).toBe(true);
  });

  it("merges a patch, ignoring undefined and mistyped values", () => {
    const merged = mergeTheme(DEFAULT_THEME, {
      fontFamily: "Inter, sans-serif",
      rowHeight: 90,
      text: undefined,
      radius: "big" as unknown as number,
    });
    expect(merged.fontFamily).toBe("Inter, sans-serif");
    expect(merged.rowHeight).toBe(90);
    expect(merged.text).toBe(DEFAULT_THEME.text);
    expect(merged.radius).toBe(DEFAULT_THEME.radius);
    expect(mergeTheme(merged, { accent: "#f00" })).toMatchObject({ rowHeight: 90, accent: "#f00" });
    expect(mergeTheme(DEFAULT_THEME)).toEqual(DEFAULT_THEME);
  });

  it("writes canvas fonts, with 400 and 700 as normal and bold", () => {
    expect(fontOf(DEFAULT_THEME, 700, 64)).toBe("bold 64px system-ui, sans-serif");
    expect(fontOf(DEFAULT_THEME, 400, 41.6)).toBe("normal 42px system-ui, sans-serif");
    expect(fontOf(DEFAULT_THEME, 300, 20)).toBe("300 20px system-ui, sans-serif");
  });

  it("resolves the ui options", () => {
    const base = { renderer: {} as any, scene: new Scene(), camera: new PerspectiveCamera() };
    expect(resolveOptions(base).ui).toEqual({
      icons: {},
      menu: {
        builtins: ["viewpoints", "locomotion", "diagnostics", "exit"],
        hostItemsFirst: false,
        title: null,
      },
    });
    const ui = resolveOptions({
      ...base,
      ui: { menu: { builtins: ["exit"], hostItemsFirst: true, title: "Menu" } },
    }).ui;
    expect(ui.menu).toEqual({ builtins: ["exit"], hostItemsFirst: true, title: "Menu" });
  });
});

describe("hud with a theme", () => {
  const texts: { text: string; font: string; fillStyle: string }[] = [];
  const g: any = {
    font: "",
    fillStyle: "",
    globalAlpha: 1,
    letterSpacing: "0px",
    fill() {},
    fillText(text: string) {
      texts.push({ text, font: g.font, fillStyle: g.fillStyle });
    },
    measureText: (t: string) => ({ width: t.length * 10 }),
  };
  for (const k of ["clearRect", "beginPath", "moveTo", "lineTo", "arcTo", "closePath", "stroke"]) {
    g[k] = () => {};
  }

  beforeEach(() => {
    texts.length = 0;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => g);
  });
  afterEach(() => vi.restoreAllMocks());

  function hudCtx() {
    const events = new Emitter<AllEvents>();
    const ctx = {
      renderer: { xr: { getCamera: () => new Object3D() } },
      root: new Group(),
      up: upVector("y"),
      events,
      theme: mergeTheme(DEFAULT_THEME, { fontFamily: "Inter", uppercaseTitles: true }),
    } as unknown as KitContext;
    return { ctx, events };
  }

  it("draws in the theme's font and case", () => {
    const { ctx } = hudCtx();
    createHud(ctx).show("Point A", ["Pull the trigger"]);
    expect(texts.map((t) => t.text)).toEqual(["POINT A", "Pull the trigger"]);
    expect(texts[0].font).toBe("bold 64px Inter");
    expect(texts[1].font).toBe("normal 42px Inter");
  });

  it("redraws what it shows when the theme changes", () => {
    const { ctx, events } = hudCtx();
    const hud = createHud(ctx);
    hud.show("Point A");
    texts.length = 0;
    ctx.theme = mergeTheme(ctx.theme, { text: "#123456" });
    events.emit("theme", { theme: ctx.theme });
    expect(texts).toEqual([{ text: "POINT A", font: "bold 64px Inter", fillStyle: "#123456" }]);
    hud.dispose();
    texts.length = 0;
    events.emit("theme", { theme: ctx.theme });
    expect(texts).toEqual([]);
  });

  it("draws nothing on a theme change before anything was shown", () => {
    const { ctx, events } = hudCtx();
    createHud(ctx);
    events.emit("theme", { theme: ctx.theme });
    expect(texts).toEqual([]);
  });
});

describe("kit menu and theme API", () => {
  it("is safe on the desktop", () => {
    const kit = createXRKit({
      renderer: { xr: { enabled: false } } as any,
      scene: new Scene(),
      camera: new PerspectiveCamera(),
      ui: { theme: { fontFamily: "Inter" } },
    });
    const opened: boolean[] = [];
    kit.on("menu", ({ open }) => opened.push(open));
    kit.setMenuItems([{ id: "a", label: "A", kind: "toggle", value: true }]);
    kit.openMenu();
    expect(kit.menuOpen).toBe(false);
    kit.closeMenu();
    expect(() => kit.setTheme({ text: "#000000" })).not.toThrow();
    expect(opened).toEqual([]);
    kit.dispose();
  });
});
