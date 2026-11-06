// The viewer's VR side panels (?panels=1), also used by the e2e harness: settings and an about
// text on the left, viewpoints and walk/fly on the right, wired to the kit.
import type { LocomotionMode, Viewpoint, XRKit } from "../../src/index";

export interface ViewerPanelHooks {
  /** The Scale slider moved (0.5 to 2). */
  scale?: (value: number) => void;
}

/** Sets the panels on `kit` and wires them; returns the function that unwires them. */
export function setViewerPanels(
  kit: XRKit,
  viewpoints: readonly Viewpoint[],
  hooks: ViewerPanelHooks = {},
): () => void {
  kit.setPanels([
    {
      id: "left",
      side: "left",
      rows: [
        { id: "settings", kind: "section", label: "Settings", value: true },
        {
          id: "diagnostics",
          kind: "toggle",
          label: "Diagnostics",
          value: kit.diagnostics,
          section: "settings",
        },
        {
          id: "scale",
          kind: "slider",
          label: "Scale",
          value: 1,
          min: 0.5,
          max: 2,
          step: 0.05,
          format: (v) => `${v.toFixed(2)}x`,
          section: "settings",
        },
        { id: "about", kind: "section", label: "About" },
        {
          id: "about-text",
          kind: "text",
          label:
            "Point at a row and pull the trigger. Hold the trigger on a slider and move the " +
            "ray to drag it. B or Y opens and closes these panels.",
          section: "about",
        },
      ],
    },
    {
      id: "right",
      side: "right",
      rows: [
        { id: "viewpoints", kind: "section", label: "Viewpoints", value: true },
        ...viewpoints.map((vp) => ({
          id: `vp:${vp.id}`,
          kind: "action" as const,
          label: vp.label ?? vp.id,
          section: "viewpoints",
        })),
        { id: "navigation", kind: "section", label: "Navigation" },
        {
          id: "locomotion",
          kind: "choice",
          label: "Move",
          value: kit.locomotion.mode,
          options: [
            { value: "walk", label: "Walk" },
            { value: "fly", label: "Fly" },
          ],
          section: "navigation",
        },
      ],
    },
  ]);
  const offs = [
    kit.on("panel-input", ({ id, value }) => {
      if (id.startsWith("vp:")) kit.goTo(id.slice(3));
      else if (id === "diagnostics") kit.setDiagnostics(value === true);
      else if (id === "scale" && typeof value === "number") hooks.scale?.(value);
      else if (id === "locomotion") kit.setLocomotion({ mode: value as LocomotionMode });
    }),
    // Changes made elsewhere (the browser page, the kit) show in the headset too.
    kit.on("locomotion", ({ mode }) => kit.updatePanelRow("right", "locomotion", { value: mode })),
  ];
  return () => {
    for (const off of offs) off();
  };
}
