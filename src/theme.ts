// The look of the kit's in-headset panels (menu, HUD, diagnostics). The defaults are the kit's
// own neutral look; a host passes its own values at runtime so the panels match its browser UI.

/**
 * Colours are CSS colour strings. Lengths (`radius`, `rowHeight`, `padding`, `letterSpacing`)
 * are canvas pixels, at the resolution of the canvas of the panel that draws them: the menu and
 * the HUD draw on canvases 1024 px wide (0.5 m in the headset, about 0.5 mm per px), the
 * diagnostics panel on one 512 px wide.
 */
export interface UiTheme {
  /** CSS font family. */
  fontFamily: string;
  /** Weight of labels and detail lines (100 to 900). */
  fontWeight: number;
  /** Weight of titles and section headers. */
  titleWeight: number;
  text: string;
  /** Section headers and "off" values. */
  textMuted: string;
  /** Panel fill, drawn at `backgroundOpacity`. */
  background: string;
  /** 0 to 1. */
  backgroundOpacity: number;
  /** Fill of the highlighted row. */
  highlight: string;
  /** Panel border and scroll bar. */
  accent: string;
  /** Corner radius of panels and rows. */
  radius: number;
  /** Height of one menu row. */
  rowHeight: number;
  /** Inner padding of rows; panel margins are multiples of it. Icons are `rowHeight - 2 * padding`. */
  padding: number;
  /** Titles and section headers in capitals. */
  uppercaseTitles: boolean;
  /** Extra spacing between letters, px; ignored where the canvas lacks `letterSpacing`. */
  letterSpacing: number;
}

export const DEFAULT_THEME: Readonly<UiTheme> = Object.freeze({
  fontFamily: "system-ui, sans-serif",
  fontWeight: 400,
  titleWeight: 700,
  text: "#ffffff",
  textMuted: "rgba(255, 255, 255, 0.6)",
  background: "#0a0c10",
  backgroundOpacity: 0.85,
  highlight: "rgba(255, 255, 255, 0.18)",
  accent: "rgba(255, 255, 255, 0.35)",
  radius: 40,
  rowHeight: 104,
  padding: 24,
  uppercaseTitles: false,
  letterSpacing: 0,
});

/** `base` with the defined values of `patch` on top; undefined values are ignored. */
export function mergeTheme(base: Readonly<UiTheme>, patch?: Partial<UiTheme>): UiTheme {
  const out: UiTheme = { ...base };
  if (!patch) return out;
  for (const key of Object.keys(patch) as (keyof UiTheme)[]) {
    const value = patch[key];
    if (value !== undefined && typeof value === typeof base[key]) (out as any)[key] = value;
  }
  return out;
}

type Canvas2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** A canvas font string. 400 and 700 are written as "normal" and "bold". */
export function fontOf(theme: Readonly<UiTheme>, weight: number, sizePx: number): string {
  const w = weight === 400 ? "normal" : weight === 700 ? "bold" : String(weight);
  return `${w} ${Math.round(sizePx)}px ${theme.fontFamily}`;
}

/** Applies the theme's letter spacing where the canvas supports it. */
export function applyLetterSpacing(g: Canvas2D, theme: Readonly<UiTheme>): void {
  if ("letterSpacing" in g)
    (g as { letterSpacing: string }).letterSpacing = `${theme.letterSpacing}px`;
}

/** Fills the current path with the theme's background at its opacity. */
export function fillBackground(g: Canvas2D, theme: Readonly<UiTheme>): void {
  const alpha = g.globalAlpha ?? 1;
  g.globalAlpha = Math.min(1, Math.max(0, theme.backgroundOpacity));
  g.fillStyle = theme.background;
  g.fill();
  g.globalAlpha = alpha;
}
