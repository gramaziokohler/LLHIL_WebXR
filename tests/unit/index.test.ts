import { PerspectiveCamera, Scene } from "three";
import { describe, expect, it, vi } from "vitest";
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
    expect(o.vr).toEqual({
      turn: "snap",
      snapDegrees: 30,
      eyeHeight: 1.6,
      teleport: true,
      locomotion: {
        mode: "walk",
        speed: 1.4,
        turn: "snap",
        snapDegrees: 30,
        smoothDegreesPerSecond: 90,
        vignette: true,
      },
    });
    expect(o.ar.scales).toEqual([1, 1 / 50, 1 / 100, 1 / 200]);
    expect(o.ar.defaultScale).toBe(1 / 100);
    expect(o.performance).toEqual({ framebufferScale: 1, foveation: 1 });
  });
});

describe("locomotion options", () => {
  it("takes vr.locomotion over the defaults, and vr.snapDegrees as the snap default", () => {
    const o = resolveOptions({
      renderer: fakeRenderer(),
      scene: new Scene(),
      camera: new PerspectiveCamera(),
      vr: { snapDegrees: 45, locomotion: { mode: "fly", speed: 3, turn: "smooth" } },
    });
    expect(o.vr.locomotion).toEqual({
      mode: "fly",
      speed: 3,
      turn: "smooth",
      snapDegrees: 45,
      smoothDegreesPerSecond: 90,
      vignette: true,
    });
  });

  it("setLocomotion patches, emits locomotion on a mode change only, and ignores invalid values", () => {
    const kit = createXRKit({
      renderer: fakeRenderer(),
      scene: new Scene(),
      camera: new PerspectiveCamera(),
    });
    const modes: string[] = [];
    kit.on("locomotion", ({ mode }) => modes.push(mode));
    expect(kit.locomotion.mode).toBe("walk");
    kit.setLocomotion({ speed: 2 });
    expect(modes).toEqual([]);
    kit.setLocomotion({ mode: "teleport", vignette: false });
    expect(modes).toEqual(["teleport"]);
    kit.setLocomotion({ mode: "teleport" });
    expect(modes).toEqual(["teleport"]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    kit.setLocomotion({ mode: "swim" as any, speed: -1, smoothDegreesPerSecond: Number.NaN });
    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
    expect(kit.locomotion).toEqual({
      mode: "teleport",
      speed: 2,
      turn: "snap",
      snapDegrees: 30,
      smoothDegreesPerSecond: 90,
      vignette: false,
    });
    kit.dispose();
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
});
