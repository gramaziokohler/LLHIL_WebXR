import { type Intersection, type Object3D, Raycaster, type Vector3 } from "three";
import type { RaycastFn, RaycastHit } from "./types";

/**
 * The default raycast: a three.js Raycaster against the floors (or the model for "all"),
 * skipping invisible objects and everything under the kit's own root.
 */
export function createDefaultRaycast(
  floorsOrModel: () => Object3D[],
  model: () => Object3D,
  kitRoot: Object3D,
): RaycastFn {
  const raycaster = new Raycaster();
  return (origin, direction, far, targets): RaycastHit | null => {
    raycaster.set(origin, direction);
    raycaster.far = far;
    raycaster.near = 0;
    const objects = targets === "floors" ? floorsOrModel() : [model()];
    const hits: Intersection[] = raycaster.intersectObjects(objects, true);
    for (const hit of hits) {
      if (!isVisible(hit.object) || isUnder(hit.object, kitRoot)) continue;
      let normal: Vector3 | null = null;
      if (hit.face) {
        normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize();
      }
      return { point: hit.point.clone(), normal, object: hit.object, distance: hit.distance };
    }
    return null;
  };
}

export function isVisible(object: Object3D): boolean {
  let o: Object3D | null = object;
  while (o) {
    if (!o.visible) return false;
    o = o.parent;
  }
  return true;
}

export function isUnder(object: Object3D, ancestor: Object3D): boolean {
  let o: Object3D | null = object;
  while (o) {
    if (o === ancestor) return true;
    o = o.parent;
  }
  return false;
}
