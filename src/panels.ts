// Side panels (VR, and AR on a table): two columns of collapsible sections, one left and one right of the view, with
// the controls of a browser side bar (actions, toggles, segmented choices, sliders, a paragraph).
// Body-locked: they open around the user and follow only large turns, never small head motions.
// B or Y (the `menu-button` event) opens and closes them while any are set.
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
import type { KitContext, PanelsController, RaySource } from "./internal";
import { drawIcon } from "./menu";
import { applyLetterSpacing, DEFAULT_THEME, fillBackground, fontOf, type UiTheme } from "./theme";
import type { KitEvents, PanelRow, PanelSide, PanelSpec } from "./types";

/** Panel width in metres; the canvas is PANEL_CANVAS_WIDTH px across it. */
export const PANEL_WIDTH = 0.5;
export const PANEL_CANVAS_WIDTH = 1024;
/** Metres per canvas pixel. */
export const PANEL_MPP = PANEL_WIDTH / PANEL_CANVAS_WIDTH;
/** Distance of each panel from the eye, metres. */
export const PANEL_DISTANCE = 0.75;
/** Drop of the panel centres below eye height, metres. */
export const PANEL_DROP = 0.3;
/** Degrees left and right of the panels' forward. */
export const PANEL_ANGLE = 40;
/** Degrees each panel leans back. */
export const PANEL_TILT = 10;
/** Head yaw away from the panels' forward, degrees, past which they re-centre. */
export const PANEL_RECENTRE = 60;
/** Seconds the re-centring takes. */
export const PANEL_EASE = 0.4;
/** Rows of the default height shown at once; longer panels scroll. */
export const PANEL_VISIBLE_ROWS = 9;
/** Lines of a text row; longer text ends in an ellipsis. */
export const PANEL_TEXT_LINES = 6;
/** Seconds between `panel-input` events while a slider is dragged, and between its redraws. */
export const PANEL_EMIT_EVERY = 0.1;
export const PANEL_DRAW_EVERY = 1 / 30;

/** Off the panel. */
export const PANEL_OFF = -2;
/** On the panel, but not on a row (margins). */
export const PANEL_MARGIN = -1;

const DEG = Math.PI / 180;
const REACH = 5;
/** The head moved this far (m, horizontally) from where the panels opened: they follow it. */
const FOLLOW_DISTANCE = 0.6;
/** ...and this far (a teleport): they jump there. */
const JUMP_DISTANCE = 2;
const STICK_PRESS = 0.6;
const STICK_RELEASE = 0.3;
const REPEAT_DELAY = 0.45;
const REPEAT_EVERY = 0.15;
const LABEL = 0.42;
const SMALL = 0.34;
const LINE = 1.35;

/** A rectangle in content pixels (y from the top of the first row, before scrolling). */
export interface PanelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PanelEntry {
  row: PanelRow;
  /** Top and height, content pixels. */
  y: number;
  h: number;
  /** choice: the pills; slider: the track; toggle: the switch. */
  parts: PanelRect[];
  /** choice: the pills are on lines of their own, below the label. */
  wrapped: boolean;
  /** text: the wrapped lines. */
  lines: string[];
}

export interface PanelLayout {
  pad: number;
  entries: PanelEntry[];
  /** Height of all shown rows, px. */
  total: number;
  /** Height of the rows' window, px. */
  viewH: number;
  /** Drawn height of the panel, px. */
  heightPx: number;
  /** Canvas height: the tallest panel, px. The panel hangs from its top. */
  canvasH: number;
}

/** Width of `text` at a size and weight, px. */
export type Measure = (text: string, size: number, weight: number) => number;

/** A measure on a canvas context, or an estimate (half an em per character) without one. */
export function measurer(g: Canvas2D | null, theme: Readonly<UiTheme>): Measure {
  return (text, size, weight) => {
    if (!g || typeof g.measureText !== "function") return text.length * size * 0.5;
    g.font = fontOf(theme, weight, size);
    return g.measureText(text).width;
  };
}

/** Rows of a panel in display order: each open section followed by its rows. */
function shownRows(rows: readonly PanelRow[], open: string | null): PanelRow[] {
  const sections = new Set<string>();
  for (const r of rows) if (r.kind === "section") sections.add(r.id);
  const out: PanelRow[] = [];
  for (const r of rows) {
    if (r.kind === "section") {
      out.push(r);
      if (r.id === open) {
        for (const c of rows) if (c.section === r.id && c.kind !== "section") out.push(c);
      }
    } else if (!r.section || !sections.has(r.section)) out.push(r);
  }
  return out;
}

/** Wraps text into lines of at most `maxW` px, at most `maxLines`, the last cut with "…". */
export function wrapText(text: string, maxW: number, measure: (s: string) => number): string[] {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/)) {
      if (!word) continue;
      const next = line ? `${line} ${word}` : word;
      if (line && measure(next) > maxW) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    lines.push(line);
  }
  if (lines.length > PANEL_TEXT_LINES) {
    let last = lines[PANEL_TEXT_LINES - 1];
    while (last.length > 0 && measure(`${last}…`) > maxW) last = last.slice(0, -1);
    lines.length = PANEL_TEXT_LINES;
    lines[PANEL_TEXT_LINES - 1] = `${last.trimEnd()}…`;
  }
  return lines;
}

/** Pixel layout of a panel: rows, their parts and heights, for a theme and the open section. */
export function panelLayout(
  theme: Readonly<UiTheme>,
  rows: readonly PanelRow[],
  open: string | null,
  measure: Measure,
): PanelLayout {
  const pad = theme.padding;
  const rowH = theme.rowHeight;
  const left = 2 * pad;
  const right = PANEL_CANVAS_WIDTH - 2 * pad;
  const entries: PanelEntry[] = [];
  let y = 0;
  for (const row of shownRows(rows, open)) {
    const e: PanelEntry = { row, y, h: rowH, parts: [], wrapped: false, lines: [] };
    if (row.kind === "toggle") {
      const h = rowH * 0.5;
      e.parts.push({ x: right - 1.8 * h, y: y + (rowH - h) / 2, w: 1.8 * h, h });
    } else if (row.kind === "slider") {
      e.h = Math.round(rowH * 1.5);
      const h = rowH * 0.16;
      e.parts.push({
        x: left + rowH * 0.2,
        y: y + rowH * 1.05 - h / 2,
        w: right - left - rowH * 0.4,
        h,
      });
    } else if (row.kind === "choice") {
      const options = row.options ?? [];
      const n = options.length;
      const gap = pad / 2;
      const h = rowH * 0.7;
      let w = 0;
      for (const o of options)
        w = Math.max(w, measure(o.label, rowH * SMALL, theme.fontWeight) + 2 * pad);
      const inline = right - left - measure(row.label, rowH * LABEL, theme.fontWeight) - pad;
      let perLine = n;
      let x = right - n * w - (n - 1) * gap;
      if (n * w + (n - 1) * gap > inline) {
        // Below the label, filling the row's width, on as many lines as it takes.
        e.wrapped = true;
        perLine = Math.max(1, Math.min(n, Math.floor((right - left + gap) / (w + gap))));
        w = (right - left - (perLine - 1) * gap) / perLine;
        x = left;
        e.h = rowH * (1 + Math.ceil(n / perLine));
      }
      for (let i = 0; i < n; i++) {
        const line = Math.floor(i / perLine) + (e.wrapped ? 1 : 0);
        e.parts.push({
          x: x + (i % perLine) * (w + gap),
          y: y + line * rowH + (rowH - h) / 2,
          w,
          h,
        });
      }
    } else if (row.kind === "text") {
      const size = rowH * SMALL;
      e.lines = wrapText(row.label, right - left, (s) => measure(s, size, theme.fontWeight));
      e.h = e.lines.length * size * LINE + pad;
    }
    entries.push(e);
    y += e.h;
  }
  const viewH = Math.min(y, PANEL_VISIBLE_ROWS * rowH);
  return {
    pad,
    entries,
    total: y,
    viewH,
    heightPx: 2 * pad + viewH,
    canvasH: 2 * pad + PANEL_VISIBLE_ROWS * rowH,
  };
}

/**
 * What a canvas point is on: PANEL_OFF outside the panel, PANEL_MARGIN on it but on no row, else
 * `entry * 32` for a row, plus `1 + i` on the i-th pill of a choice.
 */
export function panelHit(layout: PanelLayout, scroll: number, x: number, y: number): number {
  const { pad, viewH } = layout;
  if (x < 0 || x > PANEL_CANVAS_WIDTH || y < 0 || y > layout.heightPx) return PANEL_OFF;
  if (x < pad || x > PANEL_CANVAS_WIDTH - pad || y < pad || y > pad + viewH) return PANEL_MARGIN;
  const cy = y - pad + scroll;
  for (let i = 0; i < layout.entries.length; i++) {
    const e = layout.entries[i];
    if (cy < e.y || cy >= e.y + e.h) continue;
    if (e.row.kind === "choice") {
      for (let k = 0; k < e.parts.length; k++) {
        const r = e.parts[k];
        if (x >= r.x && x <= r.x + r.w && cy >= r.y && cy <= r.y + r.h) return i * 32 + k + 1;
      }
    }
    return i * 32;
  }
  return PANEL_MARGIN;
}

/** `v` clamped to the slider's range and snapped to its step. */
export function snapSlider(row: PanelRow, v: number): number {
  const min = row.min ?? 0;
  const max = row.max ?? 1;
  const step = row.step ?? (max - min) / 100;
  let s = Math.min(max, Math.max(min, v));
  if (step > 0) s = Math.min(max, min + Math.round((s - min) / step) * step);
  return Number.parseFloat(s.toPrecision(12));
}

const interactive = (row: PanelRow) => !row.disabled && row.kind !== "text";

interface View {
  group: Group;
  mesh: Mesh;
  material: MeshBasicMaterial;
  texture: CanvasTexture | null;
  canvas: HTMLCanvasElement | OffscreenCanvas | null;
  g: Canvas2D | null;
  /** World to panel frame. */
  inverse: Matrix4;
}

interface Panel {
  id: string;
  side: PanelSide;
  rows: PanelRow[];
  /** Id of the open section, or null. */
  open: string | null;
  layout: PanelLayout;
  /** Content pixels scrolled. */
  scroll: number;
  /** Hit code of the highlighted row or pill, or -1. */
  hover: number;
  hoverRay: string | null;
  dirty: boolean;
  drawnAt: number;
  view: View;
}

interface RayState {
  panel: Panel | null;
  code: number;
  /** Stick direction held: ±1 up/down, ±2 left/right, 0 none. */
  dir: number;
  held: number;
}

export interface PanelsDeps {
  /** Another UI (the menu) holds `uiCapture` too, so the panels do not release it. */
  otherCapture?: () => boolean;
  /** The session has no panels (AR on site): B and Y are taken. */
  blocked?: () => boolean;
}

export function createPanels(ctx: KitContext, deps: PanelsDeps = {}): PanelsController {
  const geometry = new PlaneGeometry(1, 1);
  const views: Partial<Record<PanelSide, View>> = {};
  let panels: Panel[] = [];
  let open = false;
  let running = false;
  let disposed = false;
  let releaseId: string | null = null;
  let unsubscribe: (() => void)[] = [];
  const rayStates = new Map<string, RayState>();
  /** Seconds of panel time, from the frames' dt. */
  let clock = 0;
  // The slider being dragged.
  let dragPanel: Panel | null = null;
  let dragRow: PanelRow | null = null;
  let dragRay: string | null = null;
  let dragSent: unknown;
  let dragAt = 0;
  // Last hit of hitBest: panel and canvas point.
  let hitPanel: Panel | null = null;
  let px = 0;
  let py = 0;
  // Body lock: the panels' forward and the eye they stand around; the re-centring between.
  const base = new Vector3();
  const anchor = new Vector3();
  const from = new Vector3();
  const fromAnchor = new Vector3();
  /** Progress of the re-centring, 0 to 1; 1 when still. */
  let eased = 1;

  const head = new Vector3();
  const forward = new Vector3();
  const lastForward = new Vector3();
  const dir = new Vector3();
  const pos = new Vector3();
  const bx = new Vector3();
  const by = new Vector3();
  const bz = new Vector3();
  const tmp = new Vector3();
  const pose = new Matrix4();
  const toRoot = new Matrix4();
  const o = new Vector3();
  const d = new Vector3();

  const theme = (): Readonly<UiTheme> => ctx.theme ?? DEFAULT_THEME;

  function viewFor(side: PanelSide): View {
    const existing = views[side];
    if (existing) return existing;
    const surface = createCanvas(PANEL_CANVAS_WIDTH, 2);
    const texture = surface ? new CanvasTexture(surface.canvas as HTMLCanvasElement) : null;
    if (texture) texture.colorSpace = SRGBColorSpace;
    const material = new MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const mesh = new Mesh(geometry, material);
    mesh.renderOrder = HUD_RENDER_ORDER;
    mesh.frustumCulled = false;
    const group = new Group();
    group.name = `llhil-webxr-panel-${side}`;
    group.matrixAutoUpdate = false;
    group.add(mesh);
    const view: View = {
      group,
      mesh,
      material,
      texture,
      canvas: surface?.canvas ?? null,
      g: surface?.g ?? null,
      inverse: new Matrix4(),
    };
    views[side] = view;
    return view;
  }

  function setCapture(): void {
    ctx.uiCapture = open || releaseId !== null || deps.otherCapture?.() === true;
  }

  function relayout(p: Panel): void {
    p.layout = panelLayout(theme(), p.rows, p.open, measurer(p.view.g, theme()));
    p.scroll = Math.max(0, Math.min(p.scroll, p.layout.total - p.layout.viewH));
    p.hover = -1;
    p.dirty = true;
    // Rays over it look again on the next frame.
    for (const s of rayStates.values()) if (s.panel === p) s.panel = null;
    // For specs and debugging: the layout and scroll of what is shown.
    p.view.group.userData.panel = p;
  }

  function draw(p: Panel): void {
    p.dirty = false;
    p.drawnAt = clock;
    const { mesh, g, texture, canvas } = p.view;
    const l = p.layout;
    mesh.scale.set(PANEL_WIDTH, l.heightPx * PANEL_MPP, 1);
    // Hangs from the top of the tallest panel, so opening a section grows it downwards.
    mesh.position.y = ((l.canvasH - l.heightPx) / 2) * PANEL_MPP;
    mesh.updateMatrix();
    if (!g || !texture || !canvas) return;
    if (canvas.height !== l.canvasH) {
      canvas.height = l.canvasH;
      texture.dispose();
    }
    const t = theme();
    const W = PANEL_CANVAS_WIDTH;
    const { pad, viewH, heightPx } = l;
    const rowH = t.rowHeight;
    const f = heightPx / l.canvasH;
    texture.repeat.set(1, f);
    texture.offset.set(0, 1 - f);

    g.clearRect(0, 0, W, l.canvasH);
    roundedRect(g, 4, 4, W - 8, heightPx - 8, Math.min(t.radius, (heightPx - 8) / 2));
    fillBackground(g, t);
    g.lineWidth = 4;
    g.strokeStyle = t.accent;
    g.stroke();
    applyLetterSpacing(g, t);
    g.textBaseline = "middle";
    g.save();
    g.beginPath();
    g.rect(0, pad, W, viewH);
    g.clip();

    const iconSize = Math.max(0, rowH - 2 * t.padding);
    let anyIcon = false;
    for (const r of p.rows)
      if (r.icon && (r.kind === "section" || r.kind === "action")) anyIcon = true;
    const radius = Math.min(t.radius, rowH / 2);
    const font = (weight: number) => (s: number) => fontOf(t, weight, s);
    const right = W - 2 * pad;
    const hoverEntry = p.hover >= 0 ? p.hover >> 5 : -1;
    const hoverPart = p.hover & 31;

    for (let i = 0; i < l.entries.length; i++) {
      const e = l.entries[i];
      const row = e.row;
      const y0 = pad - p.scroll + e.y;
      if (y0 + e.h <= pad || y0 >= pad + viewH) continue;
      const dy = y0 - e.y;
      const cy = y0 + rowH / 2;
      const on = interactive(row);
      g.globalAlpha = row.disabled ? 0.45 : 1;
      if (on && ((i === hoverEntry && row.kind !== "choice") || row === dragRow)) {
        roundedRect(g, pad, y0, W - 2 * pad, e.h, radius);
        g.fillStyle = t.highlight;
        g.fill();
      }
      let x = 2 * pad;
      let labelRight = right;
      g.fillStyle = t.text;
      if (row.kind === "text") {
        g.textAlign = "left";
        const size = rowH * SMALL;
        g.font = fontOf(t, t.fontWeight, size);
        for (let k = 0; k < e.lines.length; k++) {
          g.fillText(e.lines[k], x, y0 + pad / 2 + (k + 0.5) * size * LINE);
        }
        continue;
      }
      if (anyIcon && (row.kind === "section" || row.kind === "action") && iconSize > 0) {
        if (row.icon) drawIcon(g, row.icon, x, y0 + t.padding, iconSize);
        x += iconSize + t.padding;
      }
      const part = e.parts[0];
      if (row.kind === "section") {
        // A chevron: right when closed, down when open.
        const s = rowH * 0.1;
        const cx = right - s;
        g.beginPath();
        if (row.id === p.open) {
          g.moveTo(cx - s, cy - s / 2);
          g.lineTo(cx + s, cy - s / 2);
          g.lineTo(cx, cy + s / 2);
        } else {
          g.moveTo(cx - s / 2, cy - s);
          g.lineTo(cx + s / 2, cy);
          g.lineTo(cx - s / 2, cy + s);
        }
        g.closePath();
        g.fillStyle = t.textMuted;
        g.fill();
        labelRight = cx - 2 * s;
      } else if (row.kind === "toggle") {
        const value = row.value === true;
        const ry = part.y + dy;
        roundedRect(g, part.x, ry, part.w, part.h, part.h / 2);
        g.fillStyle = value ? t.text : t.highlight;
        g.fill();
        const k = part.h * 0.76;
        const kx = value ? part.x + part.w - part.h / 2 : part.x + part.h / 2;
        roundedRect(g, kx - k / 2, ry + (part.h - k) / 2, k, k, k / 2);
        g.fillStyle = value ? t.background : t.text;
        g.fill();
        labelRight = part.x - t.padding;
      } else if (row.kind === "slider") {
        const value = typeof row.value === "number" ? row.value : (row.min ?? 0);
        const min = row.min ?? 0;
        const max = row.max ?? 1;
        const frac = max > min ? (value - min) / (max - min) : 0;
        const ry = part.y + dy;
        roundedRect(g, part.x, ry, part.w, part.h, part.h / 2);
        g.fillStyle = t.highlight;
        g.fill();
        roundedRect(g, part.x, ry, Math.max(part.h, frac * part.w), part.h, part.h / 2);
        g.fillStyle = t.text;
        g.fill();
        const k = rowH * 0.36;
        roundedRect(g, part.x + frac * part.w - k / 2, ry + part.h / 2 - k / 2, k, k, k / 2);
        g.fill();
        const text = (row.format ?? String)(value);
        g.textAlign = "right";
        g.font = fontOf(t, t.fontWeight, rowH * LABEL);
        g.fillText(text, right, y0 + rowH * 0.45);
        labelRight =
          right - (typeof g.measureText === "function" ? g.measureText(text).width : 0) - t.padding;
      } else if (row.kind === "choice") {
        const options = row.options ?? [];
        for (let k = 0; k < e.parts.length; k++) {
          const r = e.parts[k];
          const ry = r.y + dy;
          const selected = row.value === options[k].value;
          roundedRect(g, r.x, ry, r.w, r.h, r.h / 2);
          if (selected) {
            g.fillStyle = t.text;
            g.fill();
          } else {
            if (on && i === hoverEntry && hoverPart === k + 1) {
              g.fillStyle = t.highlight;
              g.fill();
            }
            g.lineWidth = 3;
            g.strokeStyle = t.accent;
            g.stroke();
          }
          g.fillStyle = selected ? t.background : t.text;
          g.textAlign = "center";
          const label = fitText(
            g,
            options[k].label,
            rowH * SMALL,
            font(t.fontWeight),
            r.w - t.padding,
          );
          g.fillText(label, r.x + r.w / 2, ry + r.h / 2);
        }
        if (!e.wrapped && part) labelRight = part.x - t.padding;
      }
      g.textAlign = "left";
      g.fillStyle = row.disabled ? t.textMuted : t.text;
      const section = row.kind === "section";
      const text = section && t.uppercaseTitles ? row.label.toUpperCase() : row.label;
      const weight = section ? t.titleWeight : t.fontWeight;
      const labelY = row.kind === "slider" ? y0 + rowH * 0.45 : cy;
      g.fillText(
        fitText(g, text, rowH * LABEL, font(weight), Math.max(1, labelRight - x)),
        x,
        labelY,
      );
    }
    g.globalAlpha = 1;
    g.restore();

    if (l.total > viewH) {
      const w = pad * 0.4;
      const thumbH = Math.max(w, (viewH * viewH) / l.total);
      const thumbY = pad + ((viewH - thumbH) * p.scroll) / (l.total - viewH);
      roundedRect(g, W - pad * 0.7, thumbY, w, thumbH, w / 2);
      g.fillStyle = t.accent;
      g.fill();
    }
    texture.needsUpdate = true;
  }

  /** Horizontal forward of the head into `forward`; keeps the last one when looking straight up. */
  function readHead(): void {
    const world = ctx.renderer.xr.getCamera().matrixWorld;
    head.setFromMatrixPosition(world);
    forward.setFromMatrixColumn(world, 2).negate();
    forward.addScaledVector(ctx.up, -forward.dot(ctx.up));
    if (forward.lengthSq() > 1e-6) lastForward.copy(forward.normalize());
    else if (lastForward.lengthSq() === 0) {
      lastForward.set(1, 1, 1).addScaledVector(ctx.up, -1).normalize();
    }
    forward.copy(lastForward);
  }

  /** Stands each panel around `anchor`, facing it, at ±PANEL_ANGLE of `base`, leaning back. */
  function place(): void {
    ctx.root.updateWorldMatrix(true, false);
    toRoot.copy(ctx.root.matrixWorld).invert();
    const up = ctx.up;
    const c = Math.cos(PANEL_TILT * DEG);
    const s = Math.sin(PANEL_TILT * DEG);
    for (const p of panels) {
      dir.copy(base).applyAxisAngle(up, (p.side === "left" ? 1 : -1) * PANEL_ANGLE * DEG);
      pos.copy(anchor).addScaledVector(dir, PANEL_DISTANCE).addScaledVector(up, -PANEL_DROP);
      // +X right, +Y up leaning away, +Z towards the user and a little up.
      bx.crossVectors(dir, up).normalize();
      by.copy(up).multiplyScalar(c).addScaledVector(dir, s);
      bz.copy(up).multiplyScalar(s).addScaledVector(dir, -c);
      pose.makeBasis(bx, by, bz).setPosition(pos);
      p.view.inverse.copy(pose).invert();
      p.view.group.matrix.multiplyMatrices(toRoot, pose);
      p.view.group.matrixWorldNeedsUpdate = true;
    }
  }

  /** Body lock: re-centre on a large turn or a walk away, smoothly; jump after a teleport. */
  function follow(dt: number): void {
    readHead();
    const up = ctx.up;
    if (eased < 1) {
      eased = Math.min(1, eased + dt / PANEL_EASE);
      const k = eased * eased * (3 - 2 * eased);
      const angle = Math.atan2(tmp.crossVectors(from, forward).dot(up), from.dot(forward));
      base.copy(from).applyAxisAngle(up, angle * k);
      anchor.lerpVectors(fromAnchor, head, k);
      place();
      return;
    }
    tmp.subVectors(head, anchor);
    const away = tmp.addScaledVector(up, -tmp.dot(up)).length();
    if (away > JUMP_DISTANCE) {
      base.copy(forward);
      anchor.copy(head);
      place();
    } else if (base.dot(forward) < Math.cos(PANEL_RECENTRE * DEG) || away > FOLLOW_DISTANCE) {
      from.copy(base);
      fromAnchor.copy(anchor);
      eased = 0;
    }
  }

  /** Projects a ray onto a panel's plane into (px, py); its distance, or -1 when it misses. */
  function project(p: Panel, ray: RaySource): number {
    o.copy(ray.origin).applyMatrix4(p.view.inverse);
    d.copy(ray.direction).transformDirection(p.view.inverse);
    // From the front only.
    if (o.z <= 0 || d.z > -1e-6) return -1;
    const t = -o.z / d.z;
    if (t > REACH) return -1;
    px = PANEL_CANVAS_WIDTH / 2 + (o.x + d.x * t) / PANEL_MPP;
    py = p.layout.canvasH / 2 - (o.y + d.y * t) / PANEL_MPP;
    return t;
  }

  /** The nearest panel a ray is on (into hitPanel, px, py) and what it is on there. */
  function hitBest(ray: RaySource): number {
    let best = Number.POSITIVE_INFINITY;
    let code = PANEL_OFF;
    let hx = 0;
    let hy = 0;
    hitPanel = null;
    for (const p of panels) {
      const t = project(p, ray);
      if (t < 0 || t >= best) continue;
      const c = panelHit(p.layout, p.scroll, px, py);
      if (c === PANEL_OFF) continue;
      best = t;
      code = c;
      hitPanel = p;
      hx = px;
      hy = py;
    }
    px = hx;
    py = hy;
    return code;
  }

  /** The hit code as a highlight: a usable row, or a pill of a choice; else -1. */
  function target(p: Panel, code: number): number {
    if (code < 0) return -1;
    const row = p.layout.entries[code >> 5].row;
    return interactive(row) && (row.kind !== "choice" || (code & 31) > 0) ? code : -1;
  }

  function setHover(p: Panel, code: number, rayId: string | null): void {
    if (p.hover !== code) {
      p.hover = code;
      p.dirty = true;
    }
    p.hoverRay = rayId;
  }

  function emit(p: Panel, row: PanelRow, value?: PanelRow["value"], final?: boolean): void {
    const payload: KitEvents["panel-input"] = { panel: p.id, id: row.id };
    if (value !== undefined) payload.value = value;
    if (final !== undefined) payload.final = final;
    ctx.events.emit("panel-input", payload);
  }

  function entryOf(p: Panel, row: PanelRow): PanelEntry | undefined {
    for (const e of p.layout.entries) if (e.row === row) return e;
    return undefined;
  }

  /** Sets a dragged slider from a canvas x; true when the value changed. */
  function slide(p: Panel, row: PanelRow, x: number): boolean {
    const track = entryOf(p, row)?.parts[0];
    if (!track) return false;
    const min = row.min ?? 0;
    const max = row.max ?? 1;
    const frac = Math.min(1, Math.max(0, (x - track.x) / track.w));
    const value = snapSlider(row, min + frac * (max - min));
    if (value === row.value) return false;
    row.value = value;
    p.dirty = true;
    return true;
  }

  function syncSections(p: Panel): void {
    for (const r of p.rows) if (r.kind === "section") r.value = r.id === p.open;
  }

  function endDrag(): void {
    const p = dragPanel;
    const row = dragRow;
    dragPanel = null;
    dragRow = null;
    dragRay = null;
    if (!p || !row) return;
    if (open) draw(p);
    emit(p, row, row.value, true);
  }

  function onSelectStart({ ray }: { ray: RaySource }): void {
    if (!open) return;
    // The select is the panels', wherever the ray points: no teleport on its release either.
    releaseId = ray.id;
    setCapture();
    const code = hitBest(ray);
    const p = hitPanel;
    if (!p || target(p, code) < 0) return;
    const row = p.layout.entries[code >> 5].row;
    setHover(p, code, ray.id);
    let value: PanelRow["value"];
    let final: boolean | undefined;
    switch (row.kind) {
      case "section":
        p.open = p.open === row.id ? null : row.id;
        syncSections(p);
        relayout(p);
        value = row.value;
        break;
      case "toggle":
        row.value = row.value !== true;
        value = row.value;
        p.dirty = true;
        break;
      case "choice":
        row.value = row.options![(code & 31) - 1].value;
        value = row.value;
        p.dirty = true;
        break;
      case "slider":
        if (dragRow) endDrag();
        dragPanel = p;
        dragRow = row;
        dragRay = ray.id;
        slide(p, row, px);
        p.dirty = true;
        value = dragSent = row.value;
        dragAt = clock;
        final = false;
        break;
    }
    if (p.dirty) draw(p);
    emit(p, row, value, final);
  }

  function onSelectEnd({ ray }: { ray: RaySource }): void {
    if (releaseId === ray.id) {
      releaseId = null;
      setCapture();
    }
    if (dragRay !== ray.id || !dragPanel || !dragRow) return;
    if (project(dragPanel, ray) >= 0) slide(dragPanel, dragRow, px);
    endDrag();
  }

  /** Hover: each controller or hand ray highlights what it is on, when that changes. */
  function hover(): void {
    for (const ray of ctx.input.rays()) {
      if (ray.kind !== "controller" && ray.kind !== "hand") continue;
      let s = rayStates.get(ray.id);
      if (!s) {
        s = { panel: null, code: PANEL_OFF, dir: 0, held: 0 };
        rayStates.set(ray.id, s);
      }
      const code = hitBest(ray);
      const p = hitPanel;
      if (p === s.panel && code === s.code) continue;
      if (s.panel && s.panel !== p && s.panel.hoverRay === ray.id) setHover(s.panel, -1, null);
      s.panel = p;
      s.code = code;
      if (p) setHover(p, target(p, code), ray.id);
    }
  }

  /** Scrolls a panel to the next (+1) or previous (-1) row start. */
  function scroll(p: Panel, step: number): void {
    const l = p.layout;
    const max = Math.max(0, l.total - l.viewH);
    let next = step > 0 ? max : 0;
    for (const e of l.entries) {
      if (step > 0 && e.y > p.scroll + 0.5) {
        next = e.y;
        break;
      }
      if (step < 0 && e.y < p.scroll - 0.5) next = e.y;
    }
    next = Math.min(max, Math.max(0, next));
    if (next === p.scroll) return;
    p.scroll = next;
    p.dirty = true;
  }

  /** Over a panel: stick up/down scrolls it, left/right steps a hovered slider; both repeat. */
  function sticks(dt: number): void {
    for (const ray of ctx.input.rays()) {
      const s = rayStates.get(ray.id);
      const axes = ray.gamepad?.axes;
      if (!s || !axes) continue;
      const four = axes.length >= 4;
      const x = (four ? axes[2] : axes[0]) ?? 0;
      const y = (four ? axes[3] : axes[1]) ?? 0;
      const sideways = Math.abs(x) > Math.abs(y);
      const v = sideways ? x : y;
      const p = s.panel;
      if (!p || Math.abs(v) < STICK_RELEASE) {
        s.dir = 0;
        continue;
      }
      if (Math.abs(v) < STICK_PRESS) continue;
      const next = (v > 0 ? 1 : -1) * (sideways ? 2 : 1);
      if (next !== s.dir) {
        s.dir = next;
        s.held = 0;
      } else {
        s.held += dt;
        if (s.held < REPEAT_DELAY) continue;
        s.held = REPEAT_DELAY - REPEAT_EVERY;
      }
      if (!sideways) {
        // xr-standard: forward (up) is negative and shows the rows above.
        scroll(p, next);
        continue;
      }
      const code = target(p, s.code);
      const row = code >= 0 ? p.layout.entries[code >> 5].row : null;
      if (!row || row.kind !== "slider" || row === dragRow) continue;
      const min = row.min ?? 0;
      const step = row.step ?? ((row.max ?? 1) - min) / 100;
      const now = typeof row.value === "number" ? row.value : min;
      const value = snapSlider(row, now + (next > 0 ? step : -step));
      if (value === row.value) continue;
      row.value = value;
      p.dirty = true;
      emit(p, row, value, true);
    }
  }

  function drag(): void {
    if (!dragPanel || !dragRow) return;
    let ray: RaySource | null = null;
    for (const r of ctx.input.rays()) if (r.id === dragRay) ray = r;
    // Off the plane (behind it, too far): the value stays.
    if (ray && project(dragPanel, ray) >= 0) slide(dragPanel, dragRow, px);
    if (dragRow.value !== dragSent && clock - dragAt >= PANEL_EMIT_EVERY - 1e-9) {
      dragSent = dragRow.value;
      dragAt = clock;
      emit(dragPanel, dragRow, dragRow.value, false);
    }
  }

  function openPanels(): void {
    if (disposed || !running || open || panels.length === 0) return;
    open = true;
    rayStates.clear();
    readHead();
    base.copy(forward);
    anchor.copy(head);
    eased = 1;
    for (const p of panels) {
      relayout(p);
      ctx.root.add(p.view.group);
      draw(p);
    }
    place();
    setCapture();
    ctx.events.emit("panels", { open: true });
  }

  function closePanels(): void {
    if (!open) return;
    endDrag();
    open = false;
    for (const view of Object.values(views)) view!.group.removeFromParent();
    rayStates.clear();
    setCapture();
    ctx.events.emit("panels", { open: false });
  }

  const offTheme = ctx.events?.on("theme", () => {
    if (!open) return;
    for (const p of panels) {
      relayout(p);
      draw(p);
    }
  });

  const controller: PanelsController = {
    open: openPanels,
    close: closePanels,
    get isOpen() {
      return open;
    },
    get hasPanels() {
      return panels.length > 0;
    },
    get capturing() {
      return open || releaseId !== null;
    },
    set(list: PanelSpec[]): void {
      if (disposed) return;
      if (dragRow) endDrag();
      const next: Panel[] = [];
      for (const spec of list) {
        if (next.some((p) => p.side === spec.side)) {
          console.warn(`[llhil-webxr] panels: one panel per side; "${spec.id}" is not shown`);
          continue;
        }
        const rows = spec.rows.map((r) => ({ ...r }));
        const first = rows.find((r) => r.kind === "section" && r.value === true);
        const p: Panel = {
          id: spec.id,
          side: spec.side,
          rows,
          open: first ? first.id : null,
          layout: undefined as unknown as PanelLayout,
          scroll: 0,
          hover: -1,
          hoverRay: null,
          dirty: true,
          drawnAt: 0,
          view: viewFor(spec.side),
        };
        syncSections(p);
        relayout(p);
        next.push(p);
      }
      panels = next;
      if (!open) return;
      if (panels.length === 0) {
        closePanels();
        return;
      }
      for (const view of Object.values(views)) view!.group.removeFromParent();
      rayStates.clear();
      for (const p of panels) {
        ctx.root.add(p.view.group);
        draw(p);
      }
      place();
    },
    updateRow(panelId: string, rowId: string, patch: Partial<PanelRow>): void {
      const p = panels.find((x) => x.id === panelId);
      const row = p?.rows.find((r) => r.id === rowId);
      if (!p || !row) return;
      const next = { ...patch };
      // The user's drag wins over a host echoing an older value.
      if (row === dragRow) delete next.value;
      Object.assign(row, next);
      if (row.kind === "section" && "value" in next) {
        if (next.value === true) p.open = row.id;
        else if (p.open === row.id) p.open = null;
        syncSections(p);
      }
      relayout(p);
      if (open) draw(p);
    },
    start(): void {
      if (disposed) return;
      running = ctx.mode !== null && deps.blocked?.() !== true;
      if (!running) return;
      unsubscribe = [
        ctx.events.on("menu-button", () => {
          if (panels.length > 0) (open ? closePanels : openPanels)();
        }),
        ctx.events.on("selectstart", onSelectStart),
        ctx.events.on("selectend", onSelectEnd),
      ];
    },
    update(_frame: XRFrame, dt: number): void {
      if (!open) return;
      clock += dt;
      follow(dt);
      hover();
      sticks(dt);
      drag();
      for (const p of panels) {
        // A drag redraws at most PANEL_DRAW_EVERY.
        if (p.dirty && (p !== dragPanel || clock - p.drawnAt >= PANEL_DRAW_EVERY - 1e-9)) draw(p);
      }
    },
    stop(): void {
      closePanels();
      for (const off of unsubscribe) off();
      unsubscribe = [];
      running = false;
      releaseId = null;
      setCapture();
    },
    dispose(): void {
      if (disposed) return;
      controller.stop();
      disposed = true;
      offTheme?.();
      for (const view of Object.values(views)) {
        view!.group.removeFromParent();
        view!.material.dispose();
        view!.texture?.dispose();
      }
      geometry.dispose();
      panels = [];
    },
  };
  return controller;
}
