import { Vector3 } from "three";
import { describe, expect, it } from "vitest";
import {
  directionFromYaw,
  forwardAtYawZero,
  normalizeDegrees,
  projectToPlane,
  upVector,
  yawFromDirection,
} from "../../src/math";

const close = (a: Vector3, b: Vector3) => expect(a.distanceTo(b)).toBeLessThan(1e-9);

describe("yaw convention", () => {
  for (const up of ["y", "z"] as const) {
    it(`yaw 0 is the forward axis and +90 turns left (${up} up)`, () => {
      close(directionFromYaw(0, up), forwardAtYawZero(up));
      const left = directionFromYaw(90, up);
      // Turning left from forward, seen from above, is -X in both conventions.
      close(left, new Vector3(-1, 0, 0));
    });

    it(`round-trips yaw through a direction (${up} up)`, () => {
      for (const yaw of [-170, -90, -45, 0, 30, 90, 135, 180]) {
        expect(yawFromDirection(directionFromYaw(yaw, up), up)).toBeCloseTo(yaw, 9);
      }
    });

    it(`ignores the vertical part (${up} up)`, () => {
      const d = directionFromYaw(30, up).addScaledVector(upVector(up), 5);
      expect(yawFromDirection(d, up)).toBeCloseTo(30, 9);
      expect(yawFromDirection(upVector(up), up)).toBe(0);
    });
  }
});

describe("helpers", () => {
  it("normalizes degrees to (-180, 180]", () => {
    expect(normalizeDegrees(180)).toBe(180);
    expect(normalizeDegrees(-180)).toBe(180);
    expect(normalizeDegrees(370)).toBe(10);
    expect(normalizeDegrees(-0)).toBe(0);
  });

  it("projects a point onto a horizontal plane", () => {
    const p = projectToPlane(new Vector3(1, 5, 2), new Vector3(0, 1, 0), new Vector3(0, 1, 0));
    close(p, new Vector3(1, 1, 2));
  });
});
