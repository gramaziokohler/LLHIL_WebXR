// A head-locked text panel in the headset: immersive sessions have no DOM overlay on the Quest,
// so instructions are drawn on a canvas and shown on a plane in the scene.
import {
  CanvasTexture,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  Vector3,
} from "three";
import type { HudController, KitContext } from "./internal";
import { applyLetterSpacing, DEFAULT_THEME, fillBackground, fontOf, type UiTheme } from "./theme";

/** Panel size in metres; the canvas has the same aspect ratio. */
export const HUD_WIDTH = 0.5;
export const HUD_HEIGHT = 0.2;
export const HUD_CANVAS_WIDTH = 1024;
export const HUD_CANVAS_HEIGHT = 410;
/** Distance in front of the head along its horizontal forward, metres. */
export const HUD_DISTANCE = 0.8;
/** Drop below eye height along up, metres. */
export const HUD_DROP = 0.25;
/** Time constant of the follow, seconds. */
export const HUD_FOLLOW_TAU = 0.3;
export const HUD_MAX_LINES = 3;
/** Draws after everything else, so real geometry never hides it. */
export const HUD_RENDER_ORDER = 10000;

/** The kit's own neutral type: the platform's sans-serif. */
export const FONT_FAMILY = "system-ui, sans-serif";
const TITLE_SIZE = 64;
const LINE_SIZE = 42;
const MIN_SCALE = 0.7;
const GAP = 22;
const LINE_GAP = 14;

export type Canvas2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** A canvas with a 2D context, or null where there is none (Node, or a stubbed DOM). */
export function createCanvas(
  width = HUD_CANVAS_WIDTH,
  height = HUD_CANVAS_HEIGHT,
): { canvas: HTMLCanvasElement | OffscreenCanvas; g: Canvas2D } | null {
  try {
    let canvas: HTMLCanvasElement | OffscreenCanvas | null = null;
    if (typeof document !== "undefined" && typeof document.createElement === "function") {
      canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
    } else if (typeof OffscreenCanvas !== "undefined") {
      canvas = new OffscreenCanvas(width, height);
    }
    if (!canvas) return null;
    const g = canvas.getContext("2d") as Canvas2D | null;
    return g ? { canvas, g } : null;
  } catch {
    return null;
  }
}

function noopHud(): HudController {
  return {
    show(): void {},
    hide(): void {},
    start(): void {},
    update(): void {},
    stop(): void {},
    dispose(): void {},
  };
}

export function roundedRect(
  g: Canvas2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  // arcTo rather than roundRect: older canvas implementations lack the latter.
  g.beginPath();
  g.moveTo(x + r, y);
  g.lineTo(x + w - r, y);
  g.arcTo(x + w, y, x + w, y + r, r);
  g.lineTo(x + w, y + h - r);
  g.arcTo(x + w, y + h, x + w - r, y + h, r);
  g.lineTo(x + r, y + h);
  g.arcTo(x, y + h, x, y + h - r, r);
  g.lineTo(x, y + r);
  g.arcTo(x, y, x + r, y, r);
  g.closePath();
}

/**
 * Shrinks the font to fit `maxWidth`, then cuts the text with an ellipsis if it still overflows.
 * `font` turns a size in px into a canvas font string; the fitted font is left set on `g`.
 */
export function fitText(
  g: Canvas2D,
  text: string,
  size: number,
  font: (sizePx: number) => string,
  maxWidth: number,
): string {
  g.font = font(size);
  if (typeof g.measureText !== "function") return text;
  let width = g.measureText(text).width;
  if (width <= maxWidth) return text;
  const s = Math.max(size * MIN_SCALE, (size * maxWidth) / width);
  g.font = font(s);
  width = g.measureText(text).width;
  if (width <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && g.measureText(cut + "…").width > maxWidth) cut = cut.slice(0, -1);
  return cut.trimEnd() + "…";
}

function draw(g: Canvas2D, theme: Readonly<UiTheme>, title: string, lines: readonly string[]) {
  const W = HUD_CANVAS_WIDTH;
  const H = HUD_CANVAS_HEIGHT;
  const PAD = 2 * theme.padding;
  const maxWidth = W - 2 * PAD;
  g.clearRect(0, 0, W, H);
  roundedRect(g, 4, 4, W - 8, H - 8, Math.min(theme.radius, (H - 8) / 2));
  fillBackground(g, theme);
  g.lineWidth = 4;
  g.strokeStyle = theme.accent;
  g.stroke();
  applyLetterSpacing(g, theme);
  const titleText = theme.uppercaseTitles ? title.toUpperCase() : title;
  const titleFont = (s: number) => fontOf(theme, theme.titleWeight, s);
  const lineFont = (s: number) => fontOf(theme, theme.fontWeight, s);

  // Centre the block of text vertically, whatever the number of lines.
  const block = TITLE_SIZE + (lines.length > 0 ? GAP : 0) + lines.length * (LINE_SIZE + LINE_GAP);
  let y = Math.max(PAD / 2, (H - block + (lines.length > 0 ? LINE_GAP : 0)) / 2);
  g.textAlign = "center";
  g.textBaseline = "top";
  g.fillStyle = theme.text;
  g.fillText(fitText(g, titleText, TITLE_SIZE, titleFont, maxWidth), W / 2, y);
  y += TITLE_SIZE + GAP;
  for (const line of lines) {
    g.fillStyle = theme.text;
    g.fillText(fitText(g, line, LINE_SIZE, lineFont, maxWidth), W / 2, y);
    y += LINE_SIZE + LINE_GAP;
  }
}

export function createHud(ctx: KitContext): HudController {
  const surface = createCanvas();
  if (!surface) return noopHud();
  const { canvas, g } = surface;

  const texture = new CanvasTexture(canvas as HTMLCanvasElement);
  texture.colorSpace = SRGBColorSpace;
  const geometry = new PlaneGeometry(HUD_WIDTH, HUD_HEIGHT);
  const material = new MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  const mesh = new Mesh(geometry, material);
  mesh.name = "llhil-webxr-hud";
  mesh.renderOrder = HUD_RENDER_ORDER;
  // Placed in front of the head every frame, so culling can only lose it.
  mesh.frustumCulled = false;
  mesh.visible = false;
  // The pose is written as a matrix each frame.
  mesh.matrixAutoUpdate = false;

  let drawnKey: string | null = null;
  let shownTitle = "";
  let shownLines: readonly string[] = [];
  // Test contexts may omit the theme and the event bus.
  const theme = () => ctx.theme ?? DEFAULT_THEME;
  // kit.setTheme: redraw what is shown in the new look.
  const offTheme = ctx.events?.on("theme", () => {
    if (disposed || drawnKey === null) return;
    draw(g, theme(), shownTitle, shownLines);
    texture.needsUpdate = true;
  });
  let snap = true;
  let disposed = false;
  const position = new Vector3();

  const head = new Vector3();
  const forward = new Vector3(0, 0, -1);
  const lastForward = new Vector3();
  const target = new Vector3();
  const m = new Matrix4();
  const toRoot = new Matrix4();
  const tmp = new Vector3();

  /** Horizontal forward of the head; keeps the last one when looking straight up or down. */
  function horizontalForward(world: Matrix4): Vector3 {
    tmp.setFromMatrixColumn(world, 2).negate();
    tmp.addScaledVector(ctx.up, -tmp.dot(ctx.up));
    if (tmp.lengthSq() > 1e-6) lastForward.copy(tmp.normalize());
    else if (lastForward.lengthSq() === 0) {
      // No forward seen yet: any horizontal direction will do.
      lastForward.set(1, 1, 1).addScaledVector(ctx.up, -1).normalize();
    }
    return forward.copy(lastForward);
  }

  return {
    show(title: string, lines: readonly string[] = []): void {
      if (disposed) return;
      const shown = lines.slice(0, HUD_MAX_LINES);
      const key = JSON.stringify([title, shown]);
      if (key !== drawnKey) {
        shownTitle = title;
        shownLines = shown;
        draw(g, theme(), title, shown);
        texture.needsUpdate = true;
        drawnKey = key;
      }
      if (!mesh.visible) snap = true;
      mesh.visible = true;
    },
    hide(): void {
      mesh.visible = false;
    },
    start(): void {
      if (disposed) return;
      ctx.root.add(mesh);
      snap = true;
    },
    update(_frame: XRFrame, dt: number): void {
      if (disposed || !mesh.visible || !mesh.parent) return;
      // three keeps the XR camera's matrixWorld in scene coordinates.
      const world = ctx.renderer.xr.getCamera().matrixWorld;
      head.setFromMatrixPosition(world);
      horizontalForward(world);
      target.copy(head).addScaledVector(forward, HUD_DISTANCE).addScaledVector(ctx.up, -HUD_DROP);

      if (snap) {
        position.copy(target);
        snap = false;
      } else if (dt > 0) {
        // Exponential follow: small head motion barely moves it, large turns catch up in ~1 s.
        position.lerp(target, 1 - Math.exp(-dt / HUD_FOLLOW_TAU));
      }

      // Face the head, upright along the scene's up axis.
      m.lookAt(head, position, ctx.up);
      m.setPosition(position);
      // Into the root's frame (identity in practice, but stay correct if it ever moves).
      ctx.root.updateWorldMatrix(true, false);
      toRoot.copy(ctx.root.matrixWorld).invert();
      mesh.matrix.multiplyMatrices(toRoot, m);
      mesh.matrixWorldNeedsUpdate = true;
    },
    stop(): void {
      mesh.removeFromParent();
      // Instructions belong to one session; the next one shows its own.
      mesh.visible = false;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      offTheme?.();
      mesh.removeFromParent();
      geometry.dispose();
      material.dispose();
      texture.dispose();
    },
  };
}
