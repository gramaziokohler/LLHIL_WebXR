// T4 replaces this stub: the teleport arc, floor targets, the marker and snap turn.
import type { KitContext, KitModule } from "./internal";

export function createTeleport(_ctx: KitContext): KitModule {
  return {
    start(): void {},
    update(_frame: XRFrame, _dt: number): void {},
    stop(): void {},
    dispose(): void {},
  };
}
