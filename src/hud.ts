// K4 replaces this stub: a head-locked text panel in the headset.
import type { HudController, KitContext } from "./internal";

export function createHud(_ctx: KitContext): HudController {
  return {
    show(_title: string, _lines?: readonly string[]): void {},
    hide(): void {},
    start(): void {},
    update(_frame: XRFrame, _dt: number): void {},
    stop(): void {},
    dispose(): void {},
  };
}
