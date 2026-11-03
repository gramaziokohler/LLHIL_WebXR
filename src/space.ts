// T2 replaces this stub: reference-space offsets, up axis, placing and turning the user.
import { Vector3 } from "three";
import type { KitContext, SpaceController } from "./internal";

export function createSpace(_ctx: KitContext): SpaceController {
  return {
    reset(_base: XRReferenceSpace): void {},
    placeUser(_floorPoint: Vector3, _yawDeg?: number): void {},
    snapTurn(_deltaDeg: number): void {},
    head() {
      return { eye: new Vector3(), floorPoint: new Vector3(), yawDeg: 0 };
    },
    start(): void {},
    update(_frame: XRFrame, _dt: number): void {},
    stop(): void {},
    dispose(): void {},
  };
}
