// End-to-end harness: a small scene, the kit, and an emulated Quest 3. Specs drive it
// through the globals at the bottom of this file.
// Relative, not the package name: typecheck runs before a build, so the package exports
// (dist/) do not exist yet. The dev server config aliases the package name to the same file.
import { createXRButtons, createXRKit, type KitEvents, type Viewpoint } from "../../../src/index";
import { metaQuest3, XRDevice } from "iwer";
import {
  AmbientLight,
  BoxGeometry,
  DirectionalLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  WebGLRenderer,
} from "three";

/** What the harness records for every kit event: plain JSON, so specs can read it back. */
export interface HarnessEvent {
  type: keyof KitEvents;
  time: number;
  payload: Record<string, unknown>;
}

const params = new URLSearchParams(location.search);
const mode = params.get("mode") === "ar" ? "ar" : "vr";

// The browser exposes a native navigator.xr on localhost; the emulator must replace it.
const xrDevice = new XRDevice(metaQuest3);
xrDevice.installRuntime({ forceInstall: true });

// IWER 2.7 takes a raw matrix in getOffsetReferenceSpace, while the WebXR spec (and every
// browser) takes an XRRigidTransform. Hand the emulator the transform's matrix so offsets work.
{
  const target = (globalThis as any).XRReferenceSpace.prototype;
  const original = target.getOffsetReferenceSpace;
  target.getOffsetReferenceSpace = function (offset: any) {
    return original.call(this, offset && "matrix" in offset ? offset.matrix : offset);
  };
}

// AR needs a synthetic room for hit-test; loaded only for ?mode=ar to keep VR runs lean.
const environmentReady: Promise<void> =
  mode === "ar"
    ? import("@iwer/sem").then(async ({ SyntheticEnvironmentModule }) => {
        xrDevice.installSEM(SyntheticEnvironmentModule);
        await xrDevice.sem?.loadDefaultEnvironment("living_room");
      })
    : Promise.resolve();

const scene = new Scene();
scene.add(new AmbientLight(0xffffff, 0.6));
const sun = new DirectionalLight(0xffffff, 1.2);
sun.position.set(5, 10, 5);
scene.add(sun);

const ground = new Mesh(new PlaneGeometry(20, 20), new MeshStandardMaterial({ color: 0x8a8f86 }));
ground.name = "ground";
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

// A 3 m high block whose top is the floor of the "mezzanine" viewpoint.
const mezzanine = new Mesh(new BoxGeometry(4, 3, 4), new MeshStandardMaterial({ color: 0xc9b38f }));
mezzanine.name = "mezzanine";
mezzanine.position.set(0, 1.5, -6);
scene.add(mezzanine);
scene.updateMatrixWorld(true);

const viewpoints: Viewpoint[] = [
  { id: "entrance", label: "Entrance", position: [0, 1.6, 5], yaw: 0 },
  { id: "mezzanine", label: "Mezzanine", position: [0, 4.6, -6], yaw: 180 },
];

const camera = new PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 200);
camera.position.set(0, 1.6, 5);
camera.lookAt(0, 1.6, 0);

const renderer = new WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.appendChild(renderer.domElement);

const kit = createXRKit({
  renderer,
  scene,
  camera,
  viewpoints,
  // Controller and hand models come from a CDN; the harness stays offline.
  controllerModels: false,
  hands: false,
});
createXRButtons(kit, document.body);

const events: HarnessEvent[] = [];
const record = <K extends keyof KitEvents>(type: K, toJSON: (p: KitEvents[K]) => object) =>
  kit.on(type, (p) => {
    events.push({ type, time: performance.now(), payload: { ...toJSON(p) } });
  });
record("sessionstart", (p) => p);
record("sessionend", (p) => p);
record("teleport", (p) => ({ position: p.position.toArray() }));
record("viewpoint", (p) => p);
record("placed", (p) => ({ matrix: [...p.matrix.elements] }));
record("select", (p) => ({
  object: p.object?.name ?? null,
  point: p.point?.toArray() ?? null,
  source: p.source,
}));

renderer.setAnimationLoop((_time, frame) => {
  kit.update(frame);
  renderer.render(scene, camera);
});

addEventListener("resize", () => {
  if (kit.presenting) return;
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

declare global {
  interface Window {
    __kit: typeof kit;
    __xrDevice: XRDevice;
    __events: HarnessEvent[];
    __renderer: WebGLRenderer;
    __scene: Scene;
    __camera: PerspectiveCamera;
    __mode: "vr" | "ar";
    /** Resolves once the harness (and, in AR, the synthetic room) is ready. */
    __ready: Promise<void>;
  }
}

window.__kit = kit;
window.__xrDevice = xrDevice;
window.__events = events;
window.__renderer = renderer;
window.__scene = scene;
window.__camera = camera;
window.__mode = mode;
window.__ready = environmentReady.then(() => {
  document.body.dataset.ready = "true";
});
