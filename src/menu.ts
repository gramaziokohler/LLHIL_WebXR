// The VR menu: a world-locked canvas panel the user opens with B or Y (the `menu-button` event)
// or the host opens with kit.openMenu(). Point a ray at a row and pull the trigger (or pinch),
// or move the highlight with the stick and pull the trigger anywhere.
import {
  CanvasTexture,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  Vector3,
} from "three";
import { type Canvas2D, createCanvas, fitText, HUD_RENDER_ORDER, roundedRect } from "./hud";
import type { KitContext, MenuController, RaySource, ResolvedViewpoint } from "./internal";
import { applyLetterSpacing, DEFAULT_THEME, fillBackground, fontOf, type UiTheme } from "./theme";
import type { MenuItem } from "./types";

/** Panel width in metres; the canvas is MENU_CANVAS_WIDTH px across it. */
export const MENU_WIDTH = 0.5;
export const MENU_CANVAS_WIDTH = 1024;
/** Metres per canvas pixel. */
export const MENU_MPP = MENU_WIDTH / MENU_CANVAS_WIDTH;
/** Distance in front of the head along its horizontal forward, metres. */
export const MENU_DISTANCE = 0.8;
/** Drop below eye height along up, metres: about chest height. */
export const MENU_DROP = 0.35;
/** Rows shown at once; longer lists scroll. */
export const MENU_VISIBLE_ROWS = 8;
/** How far a ray reaches the panel, metres. */
export const MENU_REACH = 5;
/** Stick travel that moves the highlight, and that re-arms it. */
const STICK_PRESS = 0.6;
const STICK_RELEASE = 0.3;
/** Holding the stick repeats after this long, then every REPEAT_EVERY seconds. */
const REPEAT_DELAY = 0.45;
const REPEAT_EVERY = 0.15;
const LABEL_RATIO = 0.42;
const SECTION_RATIO = 0.32;

/** Off the panel. */
const OFF = -2;
/** On the panel, but not on a row (margins, title). */
const MARGIN = -1;

export type LocomotionMode = "walk" | "fly";

/**
 * What the menu acts on: the kit. Locomotion and diagnostics come from sibling modules and are
 * used only when the kit has them.
 */
export interface MenuHost {
  goTo(id: string): void;
  exit(): Promise<void>;
  setLocomotion?(options: { mode: LocomotionMode }): void;
  readonly locomotion?: unknown;
  setDiagnostics?(on: boolean): void;
  readonly diagnostics?: unknown;
}

export interface MenuDeps {
  viewpoints: () => readonly ResolvedViewpoint[];
  host: () => MenuHost | null;
}

export type MenuRowKind = "section" | "viewpoint" | "locomotion" | "diagnostics" | "host" | "exit";

export interface MenuRow {
  kind: MenuRowKind;
  id: string;
  label: string;
  /** Right-aligned value ("On", "Fly"), or null. */
  value: string | null;
  /** The value reads as on (drawn in the text colour, else muted). */
  on: boolean;
  icon: CanvasImageSource | null;
  /** The host item behind a host row. */
  item: MenuItem | null;
}

/** Pixel layout of the panel for a theme. */
export interface MenuLayout {
  pad: number;
  rowH: number;
  titleH: number;
  visible: number;
  /** Drawn height of the panel, px. */
  heightPx: number;
  /** Canvas height that fits the most rows, px. */
  canvasH: number;
}

export function menuLayout(theme: Readonly<UiTheme>, rowCount: number, title: boolean): MenuLayout {
  const pad = theme.padding;
  const rowH = theme.rowHeight;
  const titleH = title ? rowH : 0;
  const visible = Math.min(MENU_VISIBLE_ROWS, Math.max(1, rowCount));
  return {
    pad,
    rowH,
    titleH,
    visible,
    heightPx: 2 * pad + titleH + visible * rowH,
    canvasH: 2 * pad + titleH + MENU_VISIBLE_ROWS * rowH,
  };
}

/** The visible row slot at a canvas point, MARGIN (-1) on the panel elsewhere, OFF (-2) outside. */
export function slotAt(layout: MenuLayout, x: number, y: number): number {
  if (x < 0 || x > MENU_CANVAS_WIDTH || y < 0 || y > layout.heightPx) return OFF;
  if (x < layout.pad || x > MENU_CANVAS_WIDTH - layout.pad) return MARGIN;
  const slot = Math.floor((y - layout.pad - layout.titleH) / layout.rowH);
  return slot >= 0 && slot < layout.visible ? slot : MARGIN;
}

/**
 * Centre of a visible row slot in the panel's own frame: metres, origin at the panel centre,
 * +X right, +Y up, +Z towards the user.
 */
export function rowCentre(layout: MenuLayout, slot: number): { x: number; y: number } {
  const yPx = layout.pad + layout.titleH + (slot + 0.5) * layout.rowH;
  return { x: 0, y: (layout.heightPx / 2 - yPx) * MENU_MPP };
}

/** Thumbstick forward/back: axes[3] on xr-standard gamepads, axes[1] when only two exist. */
function stickY(gamepad: Gamepad | undefined): number {
  if (!gamepad) return 0;
  const axes = gamepad.axes;
  return (axes.length >= 4 ? axes[3] : axes[1]) ?? 0;
}

const selectable = (row: MenuRow | undefined) => row !== undefined && row.kind !== "section";

function drawIcon(g: Canvas2D, icon: CanvasImageSource, x: number, y: number, size: number) {
  // An image that has not loaded (or failed) draws nothing rather than throwing.
  if ((icon as HTMLImageElement).complete === false) return;
  try {
    g.drawImage(icon, x, y, size, size);
  } catch {
    // A broken image source: leave the space empty.
  }
}

export function createMenu(ctx: KitContext, deps: MenuDeps): MenuController {
  const surface = createCanvas(MENU_CANVAS_WIDTH, menuLayout(theme(), 1, false).canvasH);
  const g = surface?.g ?? null;
  const texture = surface ? new CanvasTexture(surface.canvas as HTMLCanvasElement) : null;
  if (texture) texture.colorSpace = SRGBColorSpace;
  // A unit plane, scaled to the panel's size in metres.
  const geometry = new PlaneGeometry(1, 1);
  const material = new MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const mesh = new Mesh(geometry, material);
  mesh.name = "llhil-webxr-menu-panel";
  mesh.renderOrder = HUD_RENDER_ORDER;
  mesh.frustumCulled = false;
  /** Holds the pose: world-locked where the menu opened. The mesh inside only scales. */
  const panel = new Group();
  panel.name = "llhil-webxr-menu";
  panel.matrixAutoUpdate = false;
  panel.add(mesh);

  const rows: MenuRow[] = [];
  let items: MenuItem[] = [];
  let layout = menuLayout(theme(), 1, false);
  let open = false;
  let running = false;
  let disposed = false;
  let scroll = 0;
  let highlight = -1;
  let highlightBy: "ray" | "stick" | null = null;
  let hoverRayId: string | null = null;
  /** The select that the menu took: its selectend is the menu's too, even after it closes. */
  let releaseId: string | null = null;
  let unsubscribe: (() => void)[] = [];
  const lastSlot = new Map<string, number>();
  let stickDir = 0;
  let stickHeld = 0;
  // What the rows were built from, to rebuild when it changes.
  let builtFrom: readonly ResolvedViewpoint[] | null = null;
  let builtLoco: LocomotionMode | null = null;
  let builtDiag: boolean | null = null;

  const head = new Vector3();
  const forward = new Vector3();
  const lastForward = new Vector3();
  const target = new Vector3();
  const pose = new Matrix4();
  const inverse = new Matrix4();
  const toRoot = new Matrix4();
  const o = new Vector3();
  const d = new Vector3();

  function theme(): Readonly<UiTheme> {
    return ctx.theme ?? DEFAULT_THEME;
  }
  const options = () =>
    ctx.options.ui?.menu ?? {
      builtins: ["viewpoints", "locomotion", "diagnostics", "exit"],
      hostItemsFirst: false,
      title: null,
    };
  const icons = () => ctx.options.ui?.icons ?? {};

  function hasLocomotion(): boolean {
    return typeof deps.host()?.setLocomotion === "function";
  }
  function hasDiagnostics(): boolean {
    return typeof deps.host()?.setDiagnostics === "function";
  }
  function locoMode(): LocomotionMode {
    const l = deps.host()?.locomotion as unknown;
    const mode = typeof l === "string" ? l : (l as { mode?: unknown } | undefined)?.mode;
    return mode === "fly" ? "fly" : "walk";
  }
  function diagOn(): boolean {
    const v = deps.host()?.diagnostics as unknown;
    if (typeof v === "boolean") return v;
    const state = v as { enabled?: unknown; on?: unknown } | undefined;
    return Boolean(state?.enabled ?? state?.on);
  }

  function row(
    kind: MenuRowKind,
    id: string,
    label: string,
    icon: CanvasImageSource | undefined,
    value: string | null = null,
    on = false,
    item: MenuItem | null = null,
  ): MenuRow {
    return { kind, id, label, value, on, icon: icon ?? null, item };
  }

  function pushHostItems(): void {
    for (const item of items) {
      const kind = item.kind ?? "action";
      if (kind === "section") rows.push(row("section", item.id, item.label, item.icon, null));
      else if (kind === "toggle") {
        const on = item.value === true;
        rows.push(row("host", item.id, item.label, item.icon, on ? "On" : "Off", on, item));
      } else rows.push(row("host", item.id, item.label, item.icon, null, false, item));
    }
  }

  /** Rebuilds the rows (on open and on change only) and keeps the highlight and scroll valid. */
  function buildRows(): void {
    rows.length = 0;
    const { builtins, hostItemsFirst } = options();
    const exitLast = builtins[builtins.length - 1] === "exit";
    const icon = icons();
    builtFrom = deps.viewpoints();
    builtLoco = null;
    builtDiag = null;
    if (hostItemsFirst) pushHostItems();
    for (const b of builtins) {
      if (b === "viewpoints") {
        if (builtFrom.length === 0) continue;
        rows.push(row("section", "viewpoints", "Viewpoints", undefined));
        for (const vp of builtFrom) rows.push(row("viewpoint", vp.id, vp.label, icon.viewpoint));
      } else if (b === "locomotion") {
        if (!hasLocomotion()) continue;
        builtLoco = locoMode();
        const label = builtLoco === "fly" ? "Fly" : "Walk";
        rows.push(row("locomotion", "locomotion", "Walk / Fly", icon[builtLoco], label, true));
      } else if (b === "diagnostics") {
        if (!hasDiagnostics()) continue;
        builtDiag = diagOn();
        const value = builtDiag ? "On" : "Off";
        rows.push(
          row("diagnostics", "diagnostics", "Diagnostics", icon.diagnostics, value, builtDiag),
        );
      } else if (b === "exit") {
        if (!hostItemsFirst && exitLast) pushHostItems();
        rows.push(row("exit", "exit", "Exit VR", icon.exit));
      }
    }
    if (!hostItemsFirst && !exitLast) pushHostItems();

    layout = menuLayout(theme(), rows.length, options().title !== null);
    scroll = Math.max(0, Math.min(scroll, rows.length - layout.visible));
    if (!selectable(rows[highlight])) {
      highlight = -1;
      highlightBy = null;
    }
  }

  function ensureVisible(index: number): void {
    if (index < scroll) {
      // Show the section header above the first entry of a section.
      scroll = index > 0 && rows[index - 1].kind === "section" ? index - 1 : index;
    } else if (index >= scroll + layout.visible) {
      scroll = index - layout.visible + 1;
    }
    scroll = Math.max(0, Math.min(scroll, rows.length - layout.visible));
  }

  /** Resizes the canvas when the theme needs more room; the GPU texture is then rebuilt. */
  function fitCanvas(): void {
    if (!surface || !texture) return;
    if (surface.canvas.height === layout.canvasH) return;
    surface.canvas.height = layout.canvasH;
    texture.dispose();
  }

  function draw(): void {
    // The panel's size in metres follows the number of rows.
    mesh.scale.set(MENU_WIDTH, layout.heightPx * MENU_MPP, 1);
    if (!g || !texture) return;
    fitCanvas();
    const t = theme();
    const W = MENU_CANVAS_WIDTH;
    const H = surface!.canvas.height;
    const { pad, rowH, titleH, visible, heightPx } = layout;
    const f = heightPx / H;
    texture.repeat.set(1, f);
    texture.offset.set(0, 1 - f);

    g.clearRect(0, 0, W, H);
    roundedRect(g, 4, 4, W - 8, heightPx - 8, Math.min(t.radius, (heightPx - 8) / 2));
    fillBackground(g, t);
    g.lineWidth = 4;
    g.strokeStyle = t.accent;
    g.stroke();
    applyLetterSpacing(g, t);
    g.textBaseline = "middle";

    const title = options().title;
    if (title !== null) {
      g.textAlign = "left";
      g.fillStyle = t.text;
      const text = t.uppercaseTitles ? title.toUpperCase() : title;
      const font = (s: number) => fontOf(t, t.titleWeight, s);
      g.fillText(
        fitText(g, text, rowH * LABEL_RATIO, font, W - 4 * pad),
        2 * pad,
        pad + titleH / 2,
      );
    }

    const scrolling = rows.length > visible;
    const barW = scrolling ? pad : 0;
    const rowX = pad;
    const rowW = W - 2 * pad - barW;
    const iconSize = Math.max(0, rowH - 2 * t.padding);
    let anyIcon = false;
    for (const r of rows) if (r.icon) anyIcon = true;
    const radius = Math.min(t.radius, rowH / 2);

    for (let s = 0; s < visible; s++) {
      const i = scroll + s;
      const r = rows[i];
      if (!r) break;
      const y0 = pad + titleH + s * rowH;
      const cy = y0 + rowH / 2;
      if (i === highlight) {
        roundedRect(g, rowX, y0, rowW, rowH, radius);
        g.fillStyle = t.highlight;
        g.fill();
      }
      let x = rowX + t.padding;
      if (anyIcon && iconSize > 0) {
        if (r.icon) drawIcon(g, r.icon, x, y0 + t.padding, iconSize);
        x += iconSize + t.padding;
      }
      const right = rowX + rowW - t.padding;
      let valueW = 0;
      if (r.value !== null) {
        g.font = fontOf(t, t.fontWeight, rowH * LABEL_RATIO);
        valueW = typeof g.measureText === "function" ? g.measureText(r.value).width : 0;
        g.textAlign = "right";
        g.fillStyle = r.on ? t.text : t.textMuted;
        g.fillText(r.value, right, cy);
      }
      const maxW = Math.max(1, right - x - (r.value !== null ? valueW + t.padding : 0));
      g.textAlign = "left";
      if (r.kind === "section") {
        const text = t.uppercaseTitles ? r.label.toUpperCase() : r.label;
        const font = (sz: number) => fontOf(t, t.titleWeight, sz);
        g.fillStyle = t.textMuted;
        g.fillText(fitText(g, text, rowH * SECTION_RATIO, font, maxW), x, cy);
      } else {
        const font = (sz: number) => fontOf(t, t.fontWeight, sz);
        g.fillStyle = t.text;
        g.fillText(fitText(g, r.label, rowH * LABEL_RATIO, font, maxW), x, cy);
      }
    }

    if (scrolling) {
      const trackX = W - pad - barW * 0.7;
      const trackY = pad + titleH;
      const trackH = visible * rowH;
      const w = barW * 0.4;
      const thumbH = Math.max(w, (trackH * visible) / rows.length);
      const thumbY = trackY + ((trackH - thumbH) * scroll) / (rows.length - visible);
      roundedRect(g, trackX, thumbY, w, thumbH, w / 2);
      g.fillStyle = t.accent;
      g.fill();
    }
    texture.needsUpdate = true;
  }

  /** Horizontal forward of the head; keeps the last one when looking straight up or down. */
  function horizontalForward(world: Matrix4): Vector3 {
    forward.setFromMatrixColumn(world, 2).negate();
    forward.addScaledVector(ctx.up, -forward.dot(ctx.up));
    if (forward.lengthSq() > 1e-6) lastForward.copy(forward.normalize());
    else if (lastForward.lengthSq() === 0) {
      lastForward.set(1, 1, 1).addScaledVector(ctx.up, -1).normalize();
    }
    return forward.copy(lastForward);
  }

  /** World-locks the panel in front of the head, at chest height, facing the eye. */
  function place(): void {
    const world = ctx.renderer.xr.getCamera().matrixWorld;
    head.setFromMatrixPosition(world);
    horizontalForward(world);
    target.copy(head).addScaledVector(forward, MENU_DISTANCE).addScaledVector(ctx.up, -MENU_DROP);
    pose.lookAt(head, target, ctx.up);
    pose.setPosition(target);
    inverse.copy(pose).invert();
    ctx.root.updateWorldMatrix(true, false);
    toRoot.copy(ctx.root.matrixWorld).invert();
    panel.matrix.multiplyMatrices(toRoot, pose);
    panel.matrixWorldNeedsUpdate = true;
  }

  /** The visible slot a ray points at, MARGIN on the panel elsewhere, OFF when it misses. */
  function hitSlot(ray: RaySource): number {
    o.copy(ray.origin).applyMatrix4(inverse);
    d.copy(ray.direction).transformDirection(inverse);
    // From the front only.
    if (o.z <= 0 || d.z > -1e-6) return OFF;
    const t = -o.z / d.z;
    if (t > MENU_REACH) return OFF;
    const x = MENU_CANVAS_WIDTH / 2 + (o.x + d.x * t) / MENU_MPP;
    const y = layout.heightPx / 2 - (o.y + d.y * t) / MENU_MPP;
    return slotAt(layout, x, y);
  }

  function setCapture(): void {
    ctx.uiCapture = open || releaseId !== null;
  }

  function openMenu(): void {
    if (disposed || !running || open) return;
    open = true;
    scroll = 0;
    highlight = -1;
    highlightBy = null;
    hoverRayId = null;
    lastSlot.clear();
    stickDir = 0;
    buildRows();
    place();
    ctx.root.add(panel);
    setCapture();
    draw();
    ctx.events.emit("menu", { open: true });
  }

  function closeMenu(): void {
    if (!open) return;
    open = false;
    panel.removeFromParent();
    setCapture();
    ctx.events.emit("menu", { open: false });
  }

  function activate(index: number): void {
    const r = rows[index];
    if (!selectable(r)) return;
    const host = deps.host();
    switch (r.kind) {
      case "viewpoint":
        try {
          host?.goTo(r.id);
        } catch (error) {
          console.warn(`[llhil-webxr] menu: ${(error as Error).message}`);
        }
        closeMenu();
        return;
      case "locomotion":
        host?.setLocomotion?.({ mode: locoMode() === "fly" ? "walk" : "fly" });
        break;
      case "diagnostics":
        host?.setDiagnostics?.(!diagOn());
        break;
      case "host": {
        const item = r.item!;
        if (item.kind === "toggle") {
          item.value = !(item.value === true);
          ctx.events.emit("menu-select", { id: item.id, value: item.value });
        } else {
          ctx.events.emit("menu-select", { id: item.id });
        }
        break;
      }
      case "exit":
        closeMenu();
        host?.exit().catch(() => {});
        return;
    }
    if (!open) return;
    buildRows();
    draw();
  }

  function onSelectStart({ ray }: { ray: RaySource }): void {
    if (!open) return;
    // The select is the menu's, wherever the ray points: no teleport on its release either.
    releaseId = ray.id;
    setCapture();
    const slot = hitSlot(ray);
    if (slot >= 0) {
      const index = scroll + slot;
      if (!selectable(rows[index])) return;
      if (highlight !== index) {
        highlight = index;
        highlightBy = "ray";
        draw();
      }
      activate(index);
    } else if (slot === OFF && highlightBy === "stick" && highlight >= 0) {
      activate(highlight);
    }
  }

  function onSelectEnd({ ray }: { ray: RaySource }): void {
    if (releaseId !== ray.id) return;
    releaseId = null;
    setCapture();
  }

  /** Moves the highlight one selectable row up (-1) or down (+1); false at the end. */
  function step(dir: number): boolean {
    let i = highlight;
    if (i < 0) {
      // Nothing highlighted: start from the first selectable row in view.
      i = scroll - 1;
      dir = 1;
    }
    for (let j = i + dir; j >= 0 && j < rows.length; j += dir) {
      if (selectable(rows[j])) {
        highlight = j;
        highlightBy = "stick";
        ensureVisible(j);
        return true;
      }
    }
    return false;
  }

  /** Hover: the highlight follows a ray when the row slot under it changes. */
  function updateHover(): boolean {
    let changed = false;
    for (const ray of ctx.input.rays()) {
      if (ray.kind !== "controller" && ray.kind !== "hand") continue;
      const slot = hitSlot(ray);
      const prev = lastSlot.get(ray.id) ?? OFF;
      if (slot === prev) continue;
      lastSlot.set(ray.id, slot);
      if (slot >= 0) {
        const index = scroll + slot;
        const next = selectable(rows[index]) ? index : -1;
        hoverRayId = ray.id;
        if (next !== highlight || highlightBy !== "ray") changed = true;
        highlight = next;
        highlightBy = next >= 0 ? "ray" : null;
      } else if (hoverRayId === ray.id) {
        hoverRayId = null;
        if (highlightBy === "ray") {
          if (highlight !== -1) changed = true;
          highlight = -1;
          highlightBy = null;
        }
      }
    }
    return changed;
  }

  /** Stick up/down moves the highlight by a row, repeating while held. */
  function updateStick(dt: number): boolean {
    let y = 0;
    for (const ray of ctx.input.rays()) {
      const v = stickY(ray.gamepad);
      if (Math.abs(v) > Math.abs(y)) y = v;
    }
    if (Math.abs(y) < STICK_RELEASE) {
      stickDir = 0;
      return false;
    }
    if (Math.abs(y) < STICK_PRESS) return false;
    // xr-standard: forward (up) is negative.
    const dir = y > 0 ? 1 : -1;
    if (dir !== stickDir) {
      stickDir = dir;
      stickHeld = 0;
      return step(dir);
    }
    stickHeld += dt;
    if (stickHeld < REPEAT_DELAY) return false;
    stickHeld = REPEAT_DELAY - REPEAT_EVERY;
    return step(dir);
  }

  /** Rebuild when what the rows show changed elsewhere (viewpoints, locomotion, diagnostics). */
  function sourcesChanged(): boolean {
    if (deps.viewpoints() !== builtFrom) return true;
    if (builtLoco !== null && locoMode() !== builtLoco) return true;
    if (builtDiag !== null && diagOn() !== builtDiag) return true;
    return false;
  }

  const offTheme = ctx.events?.on("theme", () => {
    if (!open) return;
    buildRows();
    draw();
  });

  const menu: MenuController = {
    open: openMenu,
    close: closeMenu,
    get isOpen() {
      return open;
    },
    setItems(next: MenuItem[]): void {
      items = next.map((item) => ({ ...item }));
      if (!open) return;
      buildRows();
      draw();
    },
    start(): void {
      if (disposed) return;
      running = ctx.mode === "vr";
      if (!running) return;
      unsubscribe = [
        ctx.events.on("menu-button", () => (open ? closeMenu() : openMenu())),
        ctx.events.on("selectstart", onSelectStart),
        ctx.events.on("selectend", onSelectEnd),
      ];
    },
    update(_frame: XRFrame, dt: number): void {
      if (!open) return;
      let dirty = false;
      if (sourcesChanged()) {
        buildRows();
        dirty = true;
      }
      if (updateHover()) dirty = true;
      if (updateStick(dt)) dirty = true;
      if (dirty) draw();
    },
    stop(): void {
      closeMenu();
      for (const off of unsubscribe) off();
      unsubscribe = [];
      running = false;
      releaseId = null;
      setCapture();
      lastSlot.clear();
    },
    dispose(): void {
      if (disposed) return;
      menu.stop();
      disposed = true;
      offTheme?.();
      panel.removeFromParent();
      geometry.dispose();
      material.dispose();
      texture?.dispose();
    },
  };
  return menu;
}
