// T5 replaces this stub: validating the viewpoints file, resolving floors, goTo.
import type { KitContext, ResolvedViewpoint, ViewpointsController } from "./internal";
import type { Viewpoint, ViewpointsFile } from "./types";

/** Validates and returns a viewpoints file; throws with a readable message when it is invalid. */
export function parseViewpointsFile(json: unknown): ViewpointsFile {
  const file = json as ViewpointsFile;
  if (!file || file.version !== 1 || !Array.isArray(file.viewpoints)) {
    throw new Error("[llhil-webxr] viewpoints: expected { version: 1, viewpoints: [...] }");
  }
  return file;
}

export function createViewpoints(_ctx: KitContext): ViewpointsController {
  let resolved: ResolvedViewpoint[] = [];
  return {
    set(_viewpoints: Viewpoint[]): void {
      resolved = [];
    },
    list: () => resolved,
    goTo(id: string): void {
      throw new Error(`[llhil-webxr] viewpoints: unknown viewpoint "${id}"`);
    },
    start(): void {},
    update(_frame: XRFrame, _dt: number): void {},
    stop(): void {},
    dispose(): void {},
  };
}
