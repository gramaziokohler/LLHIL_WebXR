import { PerspectiveCamera, Scene } from "three";
import { describe, expect, it } from "vitest";
import { createXRKit, resolveOptions } from "../../src/index";

const fakeRenderer = () => ({ xr: { enabled: false } }) as any;

describe("resolveOptions", () => {
  it("applies the spec defaults", () => {
    const scene = new Scene();
    const o = resolveOptions({ renderer: fakeRenderer(), scene, camera: new PerspectiveCamera() });
    expect(o.model).toBe(scene);
    expect(o.metresPerUnit).toBe(1);
    expect(o.up).toBe("y");
    expect(o.floors).toBe("auto");
    expect(o.vr).toEqual({ turn: "snap", snapDegrees: 30, eyeHeight: 1.6, teleport: true });
    expect(o.ar.scales).toEqual([1, 1 / 50, 1 / 100, 1 / 200]);
    expect(o.ar.defaultScale).toBe(1 / 100);
    expect(o.performance).toEqual({ framebufferScale: 1, foveation: 1, targetFrameRate: 72 });
    expect(o.floorsReady).toBeNull();
    expect(o.diagnostics).toEqual({ enabled: false, extra: null });
  });
});

describe("createXRKit", () => {
  it("starts on the desktop and ignores update without a frame", () => {
    const kit = createXRKit({
      renderer: fakeRenderer(),
      scene: new Scene(),
      camera: new PerspectiveCamera(),
    });
    expect(kit.presenting).toBeNull();
    expect(() => kit.update()).not.toThrow();
    kit.dispose();
  });

  it("keeps the diagnostics switch, and has no frame stats outside a session", () => {
    const kit = createXRKit({
      renderer: fakeRenderer(),
      scene: new Scene(),
      camera: new PerspectiveCamera(),
      diagnostics: { enabled: true },
    });
    expect(kit.diagnostics).toBe(true);
    kit.setDiagnostics(false);
    expect(kit.diagnostics).toBe(false);
    expect(kit.frameStats).toBeNull();
    kit.dispose();
  });
});
