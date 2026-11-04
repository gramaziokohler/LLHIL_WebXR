// T3 replaces this stub: controllers, hands, transient pointers and screen taps as rays.
import type { InputController, KitContext, RaySource } from "./internal";

export function createInput(_ctx: KitContext): InputController {
  const none: RaySource[] = [];
  return {
    rays: () => none,
    start(): void {},
    update(_frame: XRFrame, _dt: number): void {},
    stop(): void {},
    dispose(): void {},
  };
}
