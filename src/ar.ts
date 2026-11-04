// T6 replaces this stub: hit-test, reticle, placing and scaling the model.
import type { ARController, KitContext } from "./internal";

export function createAR(_ctx: KitContext): ARController {
  return {
    setScale(_scale: number): void {},
    start(): void {},
    update(_frame: XRFrame, _dt: number): void {},
    stop(): void {},
    dispose(): void {},
  };
}
