import {
  Box3,
  Color,
  type Material,
  Mesh,
  type Object3D,
  PerspectiveCamera,
  Raycaster,
  Scene,
  SRGBColorSpace,
  Texture,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
// The published name resolves through the Vite alias; tsc has no path mapping for it, so the
// viewer imports the package entry relatively. Only the public API is used.
import {
  type ARAlignment,
  createXRButtons,
  createXRKit,
  directionFromYaw,
  type KitEvents,
  type LocomotionMode,
  parseViewpointsFile,
  parseViewpointsFileAR,
  type ViewpointsFileAR,
  type UpAxis,
  type Viewpoint,
  type ViewpointsFile,
  type XRButtons,
  type XRKit,
} from "../../src/index";
import { createDemoScene, createLights, DEMO } from "./demo-scene";

const params = new URLSearchParams(location.search);
const up: UpAxis = params.get("up") === "z" ? "z" : "y";
/** ?diag=1: the in-headset diagnostics panel from the start. */
const diag = params.get("diag") === "1";
const upVector = up === "z" ? new Vector3(0, 0, 1) : new Vector3(0, 1, 0);
// VR thumbstick locomotion: walk by default, ?loco=fly or ?loco=teleport otherwise.
const locoParam = params.get("loco");
const loco: LocomotionMode = locoParam === "fly" || locoParam === "teleport" ? locoParam : "walk";
const DEFAULT_FOV = 50;

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  xr: el("xr"),
  viewpoints: el<HTMLUListElement>("viewpoints"),
  status: el("status"),
  fps: el("fps"),
  upToggle: el<HTMLAnchorElement>("up-toggle"),
  drop: el("drop"),
  onsite: el("onsite"),
  onsiteEnter: el<HTMLButtonElement>("onsite-enter"),
  alignmentState: el("alignment-state"),
  forget: el<HTMLAnchorElement>("forget"),
  onsiteHint: el("onsite-hint"),
};

const ONSITE_LABEL = "View in AR on site (1:1)";

// --- Renderer, scene, desktop camera -----------------------------------------------------------

const renderer = new WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = SRGBColorSpace;
renderer.xr.enabled = true;
document.body.prepend(renderer.domElement);

const scene = new Scene();
scene.background = new Color(0xdbe7f1);

const camera = new PerspectiveCamera(
  DEFAULT_FOV,
  window.innerWidth / window.innerHeight,
  0.05,
  2000,
);
// OrbitControls reads camera.up once, when it is created.
camera.up.copy(upVector);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

function onResize(): void {
  // three.js owns the drawing buffer size while a session runs.
  if (kit?.presenting) return;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
window.addEventListener("resize", onResize);

// --- What is shown ------------------------------------------------------------------------------

interface Content {
  model: Object3D;
  floors: Object3D[] | "auto";
  /** Added to the scene beside the model, for models that bring no lights of their own. */
  extra: Object3D | null;
}

let content: Content | null = null;
let viewpoints: Viewpoint[] = [];
let viewpointsFromFile = false;
let metresPerUnit = 1;
let kit: XRKit | null = null;
let buttons: XRButtons | null = null;
/** On site: the demo's marks, or the loaded viewpoints file's `ar` section, which wins. */
let demoAlignment: ARAlignment | null = null;
let fileAR: ViewpointsFileAR | null = null;
let arSupported = false;

/** Whether the floor markers under the viewpoints (`marker-*`) are shown. */
let marksVisible = true;

function setMarksVisible(visible: boolean): void {
  marksVisible = visible;
  content?.model.traverse((o) => {
    if (o.name.startsWith("marker-")) o.visible = visible;
  });
}

/** The kit takes its model, floors and units at creation, so a new model means a new kit. */
function rebuildKit(): void {
  if (!content) return;
  buttons?.dispose();
  kit?.dispose();
  renderer.xr.enabled = true;
  kit = createXRKit({
    renderer,
    scene,
    camera,
    model: content.model,
    up,
    metresPerUnit,
    floors: content.floors,
    viewpoints,
    diagnostics: { enabled: diag },
    vr: { locomotion: { mode: loco } },
  });
  kit.on("sessionend", onResize);
  kit.on("sessionstart", renderOnsite);
  kit.on("sessionend", () => {
    showHidden();
    onsiteActive = false;
    renderOnsite();
  });
  kit.on("alignment", onAlignment);
  // The VR menu: one host item, a toggle for the floor markers under the viewpoints.
  kit.setMenuItems([{ id: "marks", label: "Show marks", kind: "toggle", value: marksVisible }]);
  kit.on("menu-select", ({ id, value }) => {
    if (id === "marks") setMarksVisible(value === true);
  });
  buttons = createXRButtons(kit, ui.xr);
  ui.alignmentState.textContent = "";
  arSupported = false;
  renderOnsite();
  const current = kit;
  current
    .supports()
    .catch(() => ({ vr: false, ar: false }))
    .then((support) => {
      if (kit !== current) return;
      arSupported = support.ar;
      renderOnsite();
    });
}

function setContent(next: Content): void {
  if (content) {
    scene.remove(content.model);
    if (content.extra) scene.remove(content.extra);
    disposeObject(content.model);
  }
  content = next;
  scene.add(next.model);
  if (next.extra) scene.add(next.extra);
  next.model.updateMatrixWorld(true);
  setMarksVisible(marksVisible);
  fitCamera(new Box3().setFromObject(next.model));
  rebuildKit();
  renderViewpoints();
}

function showDemo(): void {
  const demo = createDemoScene({ up });
  if (!viewpointsFromFile) viewpoints = demo.viewpoints;
  demoAlignment = demo.alignment;
  setContent({ model: demo.root, floors: demo.floors, extra: null });
}

function showModel(model: Object3D, name: string): void {
  if (new Box3().setFromObject(model).isEmpty()) {
    throw new Error(`"${name}" contains no geometry.`);
  }
  // Viewpoints of the demo do not belong to another model.
  if (!viewpointsFromFile) viewpoints = [];
  demoAlignment = null;
  setContent({ model, floors: "auto", extra: createLights(up) });
  setStatus(`Showing ${name}.`);
}

function disposeObject(root: Object3D): void {
  root.traverse((o) => {
    if (!(o instanceof Mesh)) return;
    o.geometry.dispose();
    const materials: Material[] = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of materials) {
      for (const value of Object.values(m)) if (value instanceof Texture) value.dispose();
      m.dispose();
    }
  });
}

// --- Desktop camera -----------------------------------------------------------------------------

/** Frames the bounds from the south-east, looking down at 35 degrees. */
function fitCamera(bounds: Box3): void {
  const center = bounds.getCenter(new Vector3());
  const radius = Math.max(bounds.getSize(new Vector3()).length() / 2, 1e-3);
  const distance = radius / Math.sin(((DEFAULT_FOV / 2) * Math.PI) / 180);
  const elevation = (35 * Math.PI) / 180;
  const towardsCamera = directionFromYaw(30, up)
    .negate()
    .multiplyScalar(Math.cos(elevation))
    .addScaledVector(upVector, Math.sin(elevation));
  camera.fov = DEFAULT_FOV;
  camera.near = radius / 1000;
  camera.far = radius * 100;
  camera.updateProjectionMatrix();
  camera.position.copy(center).addScaledVector(towardsCamera, distance);
  controls.target.copy(center);
  controls.maxDistance = radius * 20;
  controls.update();
}

const raycaster = new Raycaster();

/** Desktop: stands the orbit camera at eye height above the floor below the viewpoint. */
function viewFrom(vp: Viewpoint): void {
  const position = new Vector3(...vp.position);
  const targets = content?.floors === "auto" ? [content.model] : (content?.floors ?? []);
  raycaster.set(position, upVector.clone().negate());
  const hit = raycaster.intersectObjects(targets, true)[0];
  const eye = hit
    ? hit.point.clone().addScaledVector(upVector, DEMO.eyeHeight / metresPerUnit)
    : position;
  camera.position.copy(eye);
  // Orbiting around a point one metre ahead reads as turning the head.
  controls.target.copy(eye).addScaledVector(directionFromYaw(vp.yaw, up), 1 / metresPerUnit);
  const hfov = vp.fov ?? null;
  camera.fov = hfov
    ? (2 * Math.atan(Math.tan((hfov * Math.PI) / 360) / camera.aspect) * 180) / Math.PI
    : DEFAULT_FOV;
  camera.updateProjectionMatrix();
  controls.update();
}

function goTo(vp: Viewpoint): void {
  if (kit?.presenting === "vr") kit.goTo(vp.id);
  else viewFrom(vp);
}

function renderViewpoints(): void {
  ui.viewpoints.replaceChildren();
  if (viewpoints.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "None. Drop a viewpoints .json.";
    ui.viewpoints.append(li);
    return;
  }
  for (const vp of viewpoints) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = vp.label ?? vp.id;
    button.addEventListener("click", () => goTo(vp));
    li.append(button);
    ui.viewpoints.append(li);
  }
}

// --- AR on site (1:1) ---------------------------------------------------------------------------

/** True while the running session was entered on site, so its button reads "Exit". */
let onsiteActive = false;
let onsiteBusy = false;
/** Objects hidden for the on-site session, shown again when it ends. */
let hidden: Object3D[] = [];

const currentAlignment = (): ARAlignment | null => fileAR?.alignment ?? demoAlignment;

/** A kit method that throws synchronously still lands in the rejection handler. */
function attempt<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return fn();
  } catch (error) {
    return Promise.reject(error);
  }
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** "A, south-west corner" stays as it is; "gate" becomes "B: gate". */
function markName(key: "a" | "b", alignment: ARAlignment): string {
  const letter = key.toUpperCase();
  const label = alignment.labels?.[key];
  if (!label) return letter;
  return new RegExp(`^${letter}\\b`).test(label) ? label : `${letter}: ${label}`;
}

function renderOnsite(): void {
  const alignment = currentAlignment();
  ui.onsite.hidden = !(alignment && arSupported);
  const presenting = kit?.presenting ?? null;
  ui.onsiteEnter.textContent = onsiteActive && presenting ? "Exit" : ONSITE_LABEL;
  ui.onsiteEnter.disabled = onsiteBusy || (presenting !== null && !onsiteActive);
  ui.onsiteHint.hidden = !alignment;
  if (!alignment) return;
  const crosses = alignment === demoAlignment ? " (the orange crosses)" : "";
  ui.onsiteHint.textContent =
    `On site (1:1), two marks place the model: ${markName("a", alignment)}; ` +
    `${markName("b", alignment)}${crosses}. Mark both on the real ground at exactly those ` +
    "model positions, then in AR point at A, then at B, and pull the trigger.";
}

/**
 * Hides the file's `ar.hide` objects, by name, anywhere under the model. On the demo's own marks
 * the demo hides its ground slab, so the real ground stays visible through passthrough.
 */
function hideForSite(): void {
  showHidden();
  const names = new Set(fileAR?.hide ?? (fileAR?.alignment ? [] : ["ground"]));
  if (!content || names.size === 0) return;
  const found = new Set<string>();
  content.model.traverse((o) => {
    if (!names.has(o.name)) return;
    found.add(o.name);
    if (o.visible) hidden.push(o);
  });
  for (const o of hidden) o.visible = false;
  const missing = [...names].filter((name) => !found.has(name));
  if (missing.length > 0) {
    console.warn(`[viewer] ar.hide: nothing named ${missing.map((n) => `"${n}"`).join(", ")}`);
  }
}

function showHidden(): void {
  for (const o of hidden) o.visible = true;
  hidden = [];
}

function onOnsiteClick(): void {
  if (!kit || onsiteBusy) return;
  if (onsiteActive && kit.presenting) {
    attempt(() => kit!.exit()).catch((err) => setStatus(messageOf(err), true));
    return;
  }
  const alignment = currentAlignment();
  if (!alignment || kit.presenting) return;
  hideForSite();
  onsiteActive = true;
  onsiteBusy = true;
  renderOnsite();
  // Called inside the click handler: WebXR needs the user activation.
  const current = kit;
  attempt(() => current.enter("ar", { alignment }))
    .catch((err) => {
      showHidden();
      onsiteActive = false;
      setStatus(`Could not start AR on site. ${messageOf(err)}`, true);
    })
    .finally(() => {
      onsiteBusy = false;
      renderOnsite();
    });
}
ui.onsiteEnter.addEventListener("click", onOnsiteClick);

function onAlignment({ state, errorM, restored }: KitEvents["alignment"]): void {
  const error = errorM === null ? "" : `, error ${(errorM * 100).toFixed(1)} cm`;
  const text = `Alignment: ${state}${error}${restored ? " (restored from this device)" : ""}`;
  ui.alignmentState.textContent = text;
  // The page is not visible inside a headset.
  if (kit?.presenting) console.info(`[viewer] ${text}`);
}

ui.forget.addEventListener("click", (event) => {
  event.preventDefault();
  const alignment = currentAlignment();
  if (!kit || !alignment) return;
  const { id } = alignment;
  const current = kit;
  attempt(() => current.forgetAlignment(id)).then(
    () => setStatus(`Forgot the alignment saved on this device for "${id}".`),
    (err) => setStatus(`Could not forget the saved alignment. ${messageOf(err)}`, true),
  );
});

// --- Loading ------------------------------------------------------------------------------------

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);

function setStatus(text: string, error = false): void {
  ui.status.textContent = text;
  ui.status.classList.toggle("error", error);
  if (error) console.warn(`[viewer] ${text}`);
}

/** Turns loader and fetch failures into a sentence a visitor can act on. */
function explain(err: unknown, kind: "model" | "json"): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/\b404\b/.test(message)) return "The file was not found (404).";
  if (err instanceof TypeError && /fetch/i.test(message)) {
    return "The server did not answer, or it does not allow loading from this page (CORS).";
  }
  if (err instanceof SyntaxError) {
    // Static hosts often answer a wrong path with their HTML page rather than a 404.
    if (message.includes("<")) {
      return "The server sent a web page instead of the file; check the URL.";
    }
    return kind === "model" ? "The file is not a GLB model." : "The file is not valid JSON.";
  }
  return message;
}

const nameOf = (url: string) => decodeURIComponent(url.split(/[?#]/)[0].split("/").pop() || url);

async function loadModelUrl(url: string): Promise<boolean> {
  setStatus(`Loading ${nameOf(url)}…`);
  try {
    const gltf = await loader.loadAsync(url);
    showModel(gltf.scene, nameOf(url));
    return true;
  } catch (err) {
    setStatus(`Could not load the model ${nameOf(url)}. ${explain(err, "model")}`, true);
    return false;
  }
}

async function loadModelFile(file: File): Promise<void> {
  setStatus(`Loading ${file.name}…`);
  try {
    const gltf = await loader.parseAsync(await file.arrayBuffer(), "");
    showModel(gltf.scene, file.name);
  } catch (err) {
    setStatus(`Could not read ${file.name} as a GLB model. ${explain(err, "model")}`, true);
  }
}

/** Validates and applies a viewpoints file; returns it, or null after showing why not. */
function applyViewpoints(json: unknown, source: string): ViewpointsFile | null {
  let file: ViewpointsFile;
  let ar: ViewpointsFileAR | null;
  try {
    file = parseViewpointsFile(json);
    ar = parseViewpointsFileAR(json);
  } catch (err) {
    setStatus(`${source} is not a valid viewpoints file. ${explain(err, "json")}`, true);
    return null;
  }
  viewpoints = file.viewpoints;
  viewpointsFromFile = true;
  fileAR = ar;
  const units = file.metresPerUnit ?? 1;
  if (units !== metresPerUnit) {
    metresPerUnit = units;
    rebuildKit();
  } else {
    kit?.setViewpoints(viewpoints);
  }
  renderViewpoints();
  renderOnsite();
  const count =
    `${viewpoints.length} viewpoint${viewpoints.length === 1 ? "" : "s"}` +
    (ar?.alignment ? " and an on-site alignment" : "");
  if (file.up && file.up !== up) {
    setStatus(
      `${source}: ${count}, written for a ${file.up.toUpperCase()}-up scene; this page is ` +
        `${up.toUpperCase()}-up. Use the link below to switch.`,
      true,
    );
  } else {
    setStatus(`${count} from ${source}.`);
  }
  return file;
}

async function loadViewpointsUrl(url: string): Promise<ViewpointsFile | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return applyViewpoints(await response.json(), nameOf(url));
  } catch (err) {
    setStatus(`Could not load the viewpoints ${nameOf(url)}. ${explain(err, "json")}`, true);
    return null;
  }
}

async function loadViewpointsFile(file: File): Promise<void> {
  try {
    applyViewpoints(JSON.parse(await file.text()), file.name);
  } catch (err) {
    setStatus(`Could not read ${file.name}. ${explain(err, "json")}`, true);
  }
}

// --- Drag and drop ------------------------------------------------------------------------------

let dragDepth = 0;
window.addEventListener("dragenter", (event) => {
  event.preventDefault();
  dragDepth++;
  ui.drop.hidden = false;
});
window.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) ui.drop.hidden = true;
});
window.addEventListener("dragover", (event) => event.preventDefault());
window.addEventListener("drop", (event) => {
  event.preventDefault();
  dragDepth = 0;
  ui.drop.hidden = true;
  if (kit?.presenting) return;
  for (const file of Array.from(event.dataTransfer?.files ?? [])) {
    const name = file.name.toLowerCase();
    if (name.endsWith(".glb")) void loadModelFile(file);
    else if (name.endsWith(".json")) void loadViewpointsFile(file);
    else if (name.endsWith(".gltf")) {
      setStatus(`${file.name}: drop a single-file .glb; a .gltf needs its other files.`, true);
    } else setStatus(`${file.name}: drop a .glb model or a viewpoints .json.`, true);
  }
});

// --- Up-axis link -------------------------------------------------------------------------------

{
  const other: UpAxis = up === "z" ? "y" : "z";
  const url = new URL(location.href);
  url.searchParams.set("up", other);
  ui.upToggle.href = url.href;
  ui.upToggle.textContent = `Switch to ${other.toUpperCase()}-up`;
  ui.upToggle.title = `This page is ${up.toUpperCase()}-up`;
}

// --- Render loop --------------------------------------------------------------------------------

let frames = 0;
let since = performance.now();

renderer.setAnimationLoop((_time, frame) => {
  kit?.update(frame);
  if (!kit?.presenting) controls.update();
  renderer.render(scene, camera);

  frames++;
  const now = performance.now();
  if (now - since >= 1000) {
    const fps = (frames * 1000) / (now - since);
    ui.fps.textContent = `${fps.toFixed(0)} fps`;
    // The page is not visible inside a headset.
    if (kit?.presenting) console.info(`[viewer] ${kit.presenting} ${fps.toFixed(1)} fps`);
    frames = 0;
    since = now;
  }
});

// --- Start --------------------------------------------------------------------------------------

async function start(): Promise<void> {
  const viewpointsUrl = params.get("viewpoints");
  const file = viewpointsUrl ? await loadViewpointsUrl(viewpointsUrl) : null;
  // A viewpoints file names its model relative to itself.
  const modelUrl =
    params.get("model") ??
    (file?.model && viewpointsUrl
      ? new URL(file.model, new URL(viewpointsUrl, location.href)).href
      : null);
  if (modelUrl && (await loadModelUrl(modelUrl))) return;
  showDemo();
}

void start();
