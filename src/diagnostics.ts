// Frame timing and an in-headset panel that shows it: on the left wrist where a left controller
// (or hand) is tracked, else low on the left of the view. Drawn on a canvas like the HUD, redrawn
// at most 4 times a second; nothing is allocated per frame.
import {
  CanvasTexture,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  Vector3,
} from "three";
import type { Emitter } from "./events";
import {
  type Canvas2D,
  createCanvas,
  FONT_FAMILY,
  fitText,
  HUD_RENDER_ORDER,
  roundedRect,
} from "./hud";
import type { DiagnosticsController, KitContext } from "./internal";
import type { FrameStats } from "./types";

/** Panel size on the wrist, metres; the canvas has the same aspect ratio. */
export const DIAG_WIDTH = 0.14;
export const DIAG_HEIGHT = 0.1225;
export const DIAG_CANVAS_WIDTH = 512;
export const DIAG_CANVAS_HEIGHT = 448;
export const DIAG_MAX_ROWS = 10;
/** Shortest time between two redraws of the canvas (and calls of `extra`), milliseconds. */
export const DIAG_REDRAW_MS = 250;
/** Window of the frame statistics, milliseconds. */
export const STATS_WINDOW_MS = 1000;
/** A frame is missed when its interval is over this many target frame intervals. */
export const MISSED_FACTOR = 1.5;
/** On the wrist: from the grip towards the forearm (+Z) and above it (+Y), grip space, metres. */
export const DIAG_WRIST_OFFSET: readonly [number, number, number] = [0, 0.05, 0.1];
/** Without a left grip: low on the left of the view, head space, metres. */
export const DIAG_HEAD_OFFSET: readonly [number, number, number] = [-0.22, -0.16, -0.6];
/** Without a left grip the panel is further away, so larger. */
export const DIAG_HEAD_SCALE = 1.5;

/**
 * How the panel is drawn. Field names match the kit's UI theme; lengths are canvas pixels. A
 * host theme on `ctx.theme` (when the kit has one) overrides these field by field.
 */
export interface PanelStyle {
  fontFamily: string;
  fontWeight: number;
  text: string;
  textMuted: string;
  background: string;
  backgroundOpacity: number;
  radius: number;
  padding: number;
  letterSpacing: number;
}

/** The kit's own neutral look: plain sans-serif, white on translucent near-black. */
export const DEFAULT_PANEL_STYLE: PanelStyle = {
  fontFamily: FONT_FAMILY,
  fontWeight: 400,
  text: "#ffffff",
  textMuted: "rgba(255, 255, 255, 0.7)",
  background: "#0a0c10",
  backgroundOpacity: 0.8,
  radius: 28,
  padding: 28,
  letterSpacing: 0,
};

/** The default style with each well-typed field of `theme` over it. */
export function panelStyle(theme: unknown): PanelStyle {
  const style = { ...DEFAULT_PANEL_STYLE };
  if (typeof theme !== "object" || theme === null) return style;
  const t = theme as Record<string, unknown>;
  for (const key of Object.keys(style) as (keyof PanelStyle)[]) {
    const value = t[key];
    if (typeof value === typeof style[key] && (typeof value !== "number" || Number.isFinite(value)))
      (style as Record<string, unknown>)[key] = value;
  }
  return style;
}

/** Frame intervals of the last second, in a fixed ring: no allocation per frame. */
export function createFrameStats(capacity = 512) {
  const ends = new Float64Array(capacity);
  const intervals = new Float64Array(capacity);
  const missedFlags = new Uint8Array(capacity);
  let first = 0;
  let count = 0;
  let sum = 0;
  let missed = 0;
  let clock = 0;

  function dropOldest(): void {
    sum -= intervals[first];
    missed -= missedFlags[first];
    first = (first + 1) % capacity;
    count--;
  }

  return {
    /** Adds one frame interval; `thresholdMs` decides whether it was missed. */
    push(intervalMs: number, thresholdMs: number): void {
      if (!(intervalMs > 0)) return;
      clock += intervalMs;
      if (count === capacity) dropOldest();
      const i = (first + count) % capacity;
      ends[i] = clock;
      intervals[i] = intervalMs;
      missedFlags[i] = intervalMs > thresholdMs ? 1 : 0;
      count++;
      sum += intervalMs;
      missed += missedFlags[i];
      while (count > 1 && ends[first] <= clock - STATS_WINDOW_MS) dropOldest();
    },
    /** Writes the statistics into `out`; false when there is no interval yet. */
    read(out: FrameStats): boolean {
      if (count === 0 || sum <= 0) return false;
      out.frameMs = sum / count;
      out.fps = 1000 / out.frameMs;
      out.missed = missed;
      return true;
    },
    reset(): void {
      first = 0;
      count = 0;
      sum = 0;
      missed = 0;
      clock = 0;
    },
  };
}

type Row = readonly [label: string, value: string];

function drawPanel(g: Canvas2D, rows: readonly Row[], style: PanelStyle): void {
  const W = DIAG_CANVAS_WIDTH;
  const H = DIAG_CANVAS_HEIGHT;
  const pad = Math.max(0, style.padding);
  g.clearRect(0, 0, W, H);
  roundedRect(g, 2, 2, W - 4, H - 4, Math.max(0, Math.min(style.radius, H / 2 - 2)));
  g.globalAlpha = Math.max(0, Math.min(1, style.backgroundOpacity));
  g.fillStyle = style.background;
  g.fill();
  g.globalAlpha = 1;
  if ("letterSpacing" in g) g.letterSpacing = `${style.letterSpacing}px`;

  const rowHeight = (H - 2 * pad) / DIAG_MAX_ROWS;
  const size = rowHeight * 0.7;
  const weight = String(style.fontWeight);
  const labelWidth = (W - 2 * pad) * 0.5;
  g.textBaseline = "middle";
  rows.slice(0, DIAG_MAX_ROWS).forEach(([label, value], i) => {
    const y = pad + (i + 0.5) * rowHeight;
    g.textAlign = "left";
    g.fillStyle = style.textMuted;
    g.fillText(
      fitText(
        g,
        label,
        size,
        (px) => `${weight} ${Math.round(px)}px ${style.fontFamily}`,
        labelWidth - 12,
      ),
      pad,
      y,
    );
    g.textAlign = "right";
    g.fillStyle = style.text;
    g.fillText(
      fitText(
        g,
        value,
        size,
        (px) => `${weight} ${Math.round(px)}px ${style.fontFamily}`,
        W - 2 * pad - labelWidth,
      ),
      W - pad,
      y,
    );
  });
}

const format = (v: string | number): string =>
  typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : v;

export function createDiagnostics(ctx: KitContext): DiagnosticsController {
  const timing = createFrameStats();
  const stats: FrameStats = { fps: 0, frameMs: 0, missed: 0 };
  let enabled = ctx.options.diagnostics.enabled;
  let started = false;
  let disposed = false;
  let warnedExtra = false;

  const surface = createCanvas(DIAG_CANVAS_WIDTH, DIAG_CANVAS_HEIGHT);
  let mesh: Mesh | null = null;
  let texture: CanvasTexture | null = null;
  let geometry: PlaneGeometry | null = null;
  let material: MeshBasicMaterial | null = null;
  if (surface) {
    texture = new CanvasTexture(surface.canvas as HTMLCanvasElement);
    texture.colorSpace = SRGBColorSpace;
    geometry = new PlaneGeometry(DIAG_WIDTH, DIAG_HEIGHT);
    material = new MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    mesh = new Mesh(geometry, material);
    mesh.name = "llhil-webxr-diagnostics";
    mesh.renderOrder = HUD_RENDER_ORDER;
    mesh.frustumCulled = false;
    mesh.visible = false;
    mesh.matrixAutoUpdate = false;
  }

  let sinceDraw = 0;
  let redraw = true;
  let drawnKey = "";

  // A theme change from the host (or the kit's menu) redraws the panel.
  const unsubscribeTheme = (ctx.events as unknown as Emitter<{ theme: unknown }>).on(
    "theme",
    () => {
      redraw = true;
      drawnKey = "";
    },
  );

  const headM = new Matrix4();
  const gripM = new Matrix4();
  const m = new Matrix4();
  const toRoot = new Matrix4();
  const headPos = new Vector3();
  const panelPos = new Vector3();
  const wristOffset = new Vector3(...DIAG_WRIST_OFFSET);
  /** The head-locked pose in head space: at the offset, facing the eye. */
  const headLocal = new Matrix4()
    .lookAt(new Vector3(), new Vector3(...DIAG_HEAD_OFFSET), new Vector3(0, 1, 0))
    .setPosition(...DIAG_HEAD_OFFSET)
    .scale(new Vector3(DIAG_HEAD_SCALE, DIAG_HEAD_SCALE, DIAG_HEAD_SCALE));

  const displayRate = (): number | null => {
    const rate = (ctx.session as (XRSession & { frameRate?: number }) | null)?.frameRate;
    return typeof rate === "number" && rate > 0 ? rate : null;
  };

  function rows(): Row[] {
    const has = timing.read(stats);
    const out: Row[] = [
      ["fps", has ? stats.fps.toFixed(0) : "–"],
      ["frame", has ? `${stats.frameMs.toFixed(1)} ms` : "–"],
      ["missed", has ? `${stats.missed} /s` : "–"],
    ];
    const rate = displayRate();
    if (rate !== null) out.push(["display", `${format(rate)} Hz`]);
    out.push(["scale", format(ctx.options.performance.framebufferScale)]);
    const extra = ctx.options.diagnostics.extra;
    if (extra) {
      try {
        for (const [label, value] of Object.entries(extra() ?? {})) {
          out.push([label, format(value)]);
        }
      } catch (error) {
        if (!warnedExtra) {
          warnedExtra = true;
          console.warn("[llhil-webxr] diagnostics.extra threw", error);
        }
      }
    }
    return out;
  }

  function draw(): void {
    if (!surface || !texture) return;
    const list = rows();
    const key = list.map((r) => `${r[0]}\u0000${r[1]}`).join("\u0001");
    if (key === drawnKey) return;
    drawPanel(surface.g, list, panelStyle((ctx as { theme?: unknown }).theme));
    texture.needsUpdate = true;
    drawnKey = key;
  }

  /** Writes the panel's pose for this frame; false when the head is not tracked. */
  function place(frame: XRFrame): boolean {
    if (!mesh) return false;
    const ref = ctx.renderer.xr.getReferenceSpace?.();
    const viewer = ref ? frame.getViewerPose(ref) : null;
    if (!ref || !viewer) return false;
    headM.fromArray(viewer.transform.matrix);

    let grip: XRPose | null | undefined = null;
    const sources = ctx.session?.inputSources;
    if (sources) {
      for (let i = 0; i < sources.length; i++) {
        const source = sources[i];
        if (source.handedness === "left" && source.gripSpace) {
          grip = frame.getPose(source.gripSpace, ref);
          break;
        }
      }
    }
    if (grip) {
      // On the wrist, facing the eye, upright along the scene's up axis.
      gripM.fromArray(grip.transform.matrix);
      panelPos.copy(wristOffset).applyMatrix4(gripM);
      headPos.setFromMatrixPosition(headM);
      m.lookAt(headPos, panelPos, ctx.up).setPosition(panelPos);
    } else {
      m.multiplyMatrices(headM, headLocal);
    }
    ctx.root.updateWorldMatrix(true, false);
    toRoot.copy(ctx.root.matrixWorld).invert();
    mesh.matrix.multiplyMatrices(toRoot, m);
    mesh.matrixWorldNeedsUpdate = true;
    return true;
  }

  return {
    setEnabled(on: boolean): void {
      enabled = on;
      // Shown again from the next frame, once its pose is written.
      if (mesh && !on) mesh.visible = false;
      if (on) redraw = true;
    },
    get enabled() {
      return enabled;
    },
    get stats(): FrameStats | null {
      if (!started || !timing.read(stats)) return null;
      return { fps: stats.fps, frameMs: stats.frameMs, missed: stats.missed };
    },
    start(): void {
      if (disposed) return;
      started = true;
      timing.reset();
      if (mesh) ctx.root.add(mesh);
      redraw = true;
      drawnKey = "";
    },
    update(frame: XRFrame, dt: number): void {
      if (!started) return;
      const rate = displayRate() ?? ctx.options.performance.targetFrameRate;
      timing.push(dt * 1000, (MISSED_FACTOR * 1000) / rate);
      if (!mesh || !enabled) return;
      sinceDraw += dt * 1000;
      if (redraw || sinceDraw >= DIAG_REDRAW_MS) {
        draw();
        redraw = false;
        sinceDraw = 0;
      }
      // Kept where it was when the head is briefly not tracked; hidden until the first pose.
      if (place(frame)) mesh.visible = true;
    },
    stop(): void {
      started = false;
      mesh?.removeFromParent();
      if (mesh) mesh.visible = false;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      started = false;
      unsubscribeTheme();
      mesh?.removeFromParent();
      geometry?.dispose();
      material?.dispose();
      texture?.dispose();
    },
  };
}
