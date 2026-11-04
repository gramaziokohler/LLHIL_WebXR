import { Matrix4, Quaternion, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { nudgeMatrix, solveTwoPoint, userFrameMove } from "../../src/align";
import { directionFromYaw, normalizeDegrees, upVector, yawFromDirection } from "../../src/math";

const DEG = Math.PI / 180;

// Seeded so a failure reproduces.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const between = (rand: () => number, lo: number, hi: number) => lo + (hi - lo) * rand();
const randomPoint = (rand: () => number, extent: number) =>
  new Vector3(
    between(rand, -extent, extent),
    between(rand, -extent, extent),
    between(rand, -extent, extent),
  );

/** A rigid "truth": turn about up by yawDeg, then translate (horizontal shift plus a height offset). */
function rigid(up: Vector3, yawDeg: number, shift: Vector3): Matrix4 {
  const q = new Quaternion().setFromAxisAngle(up, yawDeg * DEG);
  return new Matrix4().compose(shift, q, new Vector3(1, 1, 1));
}

function horizontalDistance(p: Vector3, q: Vector3, up: Vector3): number {
  const d = new Vector3().subVectors(q, p);
  return d.addScaledVector(up, -d.dot(up)).length();
}

/** Two model points at least `minSpan` apart horizontally. */
function randomPair(rand: () => number, up: Vector3, minSpan: number): [Vector3, Vector3] {
  for (;;) {
    const a = randomPoint(rand, 50);
    const b = randomPoint(rand, 50);
    if (horizontalDistance(a, b, up) >= minSpan) return [a, b];
  }
}

const angleDiff = (x: number, y: number) => Math.abs(normalizeDegrees(x - y));

for (const axis of ["y", "z"] as const) {
  const up = upVector(axis);

  describe(`solveTwoPoint (${axis} up)`, () => {
    it("recovers a random rigid transform exactly", () => {
      const rand = rng(axis === "y" ? 1 : 2);
      for (let i = 0; i < 200; i++) {
        const yawDeg = between(rand, -179.9, 180);
        const truth = rigid(up, yawDeg, randomPoint(rand, 100));
        const [a, b] = randomPair(rand, up, 0.5);
        const realA = a.clone().applyMatrix4(truth);
        const realB = b.clone().applyMatrix4(truth);

        const s = solveTwoPoint(a, b, realA, realB, up);

        expect(a.clone().applyMatrix4(s.matrix).distanceTo(realA)).toBeLessThan(1e-9);
        expect(b.clone().applyMatrix4(s.matrix).distanceTo(realB)).toBeLessThan(1e-9);
        expect(angleDiff(s.yawDeg, yawDeg)).toBeLessThan(1e-9);
        expect(s.yawDeg).toBeGreaterThan(-180);
        expect(s.yawDeg).toBeLessThanOrEqual(180);
        expect(s.errorM).toBeLessThan(1e-9);
        // Rigid about up: no scale, no tilt.
        expect(s.matrix.determinant()).toBeCloseTo(1, 12);
        const turnedUp = up.clone().transformDirection(s.matrix);
        expect(turnedUp.distanceTo(up)).toBeLessThan(1e-12);
      }
    });

    it("positive yaw turns left (counter-clockwise seen from above)", () => {
      const a = new Vector3();
      const b = directionFromYaw(0, axis).multiplyScalar(5);
      const realB = directionFromYaw(90, axis).multiplyScalar(5);
      const s = solveTwoPoint(a, b, a.clone(), realB, up);
      expect(s.yawDeg).toBeCloseTo(90, 9);
      const forward = directionFromYaw(0, axis).transformDirection(s.matrix);
      expect(yawFromDirection(forward, axis)).toBeCloseTo(90, 9);
    });

    it("reports a half turn as 180, not -180", () => {
      const a = new Vector3();
      const b = directionFromYaw(0, axis).multiplyScalar(5);
      const s = solveTwoPoint(a, b, a.clone(), b.clone().negate(), up);
      expect(s.yawDeg).toBe(180);
    });

    it("stays within tolerance under ±2 cm measurement noise", () => {
      const rand = rng(axis === "y" ? 3 : 4);
      const noise = () => randomPoint(rand, 0.02);
      for (let i = 0; i < 200; i++) {
        const yawDeg = between(rand, -180, 180);
        const truth = rigid(up, yawDeg, randomPoint(rand, 100));
        const [a, b] = randomPair(rand, up, 5);
        const trueA = a.clone().applyMatrix4(truth);
        const trueB = b.clone().applyMatrix4(truth);
        const realA = trueA.clone().add(noise());
        const realB = trueB.clone().add(noise());

        const s = solveTwoPoint(a, b, realA, realB, up);

        const expected = Math.abs(
          horizontalDistance(a, b, up) - horizontalDistance(realA, realB, up),
        );
        expect(s.errorM).toBeCloseTo(expected, 12);
        // Each point moves at most 2*sqrt(2)*2 cm horizontally.
        expect(s.errorM).toBeLessThanOrEqual(2 * Math.SQRT2 * 0.02 + 1e-12);

        const placedA = a.clone().applyMatrix4(s.matrix);
        const placedB = b.clone().applyMatrix4(s.matrix);
        for (const [placed, real, truePoint] of [
          [placedA, realA, trueA],
          [placedB, realB, trueB],
        ]) {
          expect(placed.distanceTo(real)).toBeLessThan(0.04);
          expect(placed.distanceTo(truePoint)).toBeLessThan(0.075);
          // Height from the mean of the two offsets: off by half their difference at most.
          expect(Math.abs(placed.clone().sub(real).dot(up))).toBeLessThanOrEqual(0.02 + 1e-12);
        }
        // Over at least 5 m, 2 cm at each end bends the heading by well under a degree.
        expect(angleDiff(s.yawDeg, yawDeg)).toBeLessThan(0.7);
      }
    });

    it("reports a scale mismatch as errorM", () => {
      const a = new Vector3();
      const b = directionFromYaw(30, axis).multiplyScalar(10);
      const realB = directionFromYaw(30, axis).multiplyScalar(10.1);
      const s = solveTwoPoint(a, b, a.clone(), realB, up);
      expect(s.errorM).toBeCloseTo(0.1, 12);
      // Midpoints coincide, so each end is off by half the mismatch.
      expect(b.clone().applyMatrix4(s.matrix).distanceTo(realB)).toBeCloseTo(0.05, 12);
    });

    it("throws when the model points are too close horizontally", () => {
      const a = new Vector3(1, 1, 1);
      const b = a
        .clone()
        .addScaledVector(up, 3)
        .add(directionFromYaw(10, axis).multiplyScalar(0.05));
      const realA = new Vector3(0, 0, 0);
      const realB = directionFromYaw(0, axis).multiplyScalar(4);
      expect(() => solveTwoPoint(a, b, realA, realB, up)).toThrow(
        "[llhil-webxr] align: the two reference points are too close",
      );
    });

    it("throws when the measured points are too close", () => {
      const a = new Vector3();
      const b = directionFromYaw(0, axis).multiplyScalar(4);
      const realA = new Vector3(2, 2, 2);
      const realB = realA.clone().add(directionFromYaw(45, axis).multiplyScalar(0.09));
      expect(() => solveTwoPoint(a, b, realA, realB, up)).toThrow(/too close/);
    });
  });

  describe(`nudgeMatrix (${axis} up)`, () => {
    const rand = rng(axis === "y" ? 5 : 6);

    function setup() {
      const yawDeg = between(rand, -180, 180);
      const correction = rigid(up, yawDeg, randomPoint(rand, 20));
      const modelA = randomPoint(rand, 20);
      const pivot = modelA.clone().applyMatrix4(correction);
      return { yawDeg, correction, modelA, pivot };
    }

    it("turns about the pivot: the pivot stays put and the heading changes by turnDeg", () => {
      for (let i = 0; i < 50; i++) {
        const { yawDeg, correction, modelA, pivot } = setup();
        const turnDeg = between(rand, -20, 20);
        const nudged = nudgeMatrix(correction, pivot, up, turnDeg, new Vector3());

        expect(nudged).not.toBe(correction);
        expect(modelA.clone().applyMatrix4(nudged).distanceTo(pivot)).toBeLessThan(1e-9);

        const forward = directionFromYaw(0, axis).transformDirection(nudged);
        expect(angleDiff(yawFromDirection(forward, axis), yawDeg + turnDeg)).toBeLessThan(1e-9);

        // Any other point keeps its height and its distance to the pivot.
        const p = randomPoint(rand, 20);
        const before = p.clone().applyMatrix4(correction);
        const after = p.clone().applyMatrix4(nudged);
        expect(after.dot(up)).toBeCloseTo(before.dot(up), 9);
        expect(after.distanceTo(pivot)).toBeCloseTo(before.distanceTo(pivot), 9);
      }
    });

    it("moves every point by moveWorld", () => {
      const { correction, pivot } = setup();
      const move = directionFromYaw(between(rand, -180, 180), axis).multiplyScalar(0.3);
      const nudged = nudgeMatrix(correction, pivot, up, 0, move);
      for (let i = 0; i < 10; i++) {
        const p = randomPoint(rand, 20);
        const expected = p.clone().applyMatrix4(correction).add(move);
        expect(p.applyMatrix4(nudged).distanceTo(expected)).toBeLessThan(1e-9);
      }
    });

    it("turns first, then moves: the pivot ends up at pivot + moveWorld", () => {
      const { correction, modelA, pivot } = setup();
      const move = directionFromYaw(70, axis).multiplyScalar(0.25);
      const nudged = nudgeMatrix(correction, pivot, up, 5, move);
      const expected = pivot.clone().add(move);
      expect(modelA.applyMatrix4(nudged).distanceTo(expected)).toBeLessThan(1e-9);
    });

    it("leaves the correction untouched", () => {
      const { correction, pivot } = setup();
      const copy = correction.clone();
      nudgeMatrix(correction, pivot, up, 15, directionFromYaw(0, axis));
      expect(correction.equals(copy)).toBe(true);
    });
  });

  describe(`userFrameMove (${axis} up)`, () => {
    it("at yaw 0, right is +X and forward is the yaw-0 forward", () => {
      const head = directionFromYaw(0, axis);
      const right = userFrameMove([1, 0], head, up);
      expect(right.distanceTo(new Vector3(1, 0, 0))).toBeLessThan(1e-12);
      const forward = userFrameMove([0, 1], head, up);
      expect(forward.distanceTo(head)).toBeLessThan(1e-12);
    });

    for (const yaw of [0, 37, 90, 135, -60, -150, 180]) {
      it(`moves along the head's heading for a head at yaw ${yaw}, looking down`, () => {
        // Pitched 40 degrees down: the move must still be horizontal and metre for metre.
        const flat = directionFromYaw(yaw, axis);
        const head = flat
          .clone()
          .multiplyScalar(Math.cos(40 * DEG))
          .addScaledVector(up, -Math.sin(40 * DEG));

        const forward = userFrameMove([0, 2], head, up);
        expect(forward.distanceTo(flat.clone().multiplyScalar(2))).toBeLessThan(1e-12);

        const right = userFrameMove([1.5, 0], head, up);
        const expectedRight = directionFromYaw(yaw - 90, axis).multiplyScalar(1.5);
        expect(right.distanceTo(expectedRight)).toBeLessThan(1e-12);

        const both = userFrameMove([0.3, -0.4], head, up);
        expect(both.dot(up)).toBeCloseTo(0, 12);
        expect(both.length()).toBeCloseTo(0.5, 12);
        expect(
          both.distanceTo(expectedRight.multiplyScalar(0.2).addScaledVector(flat, -0.4)),
        ).toBeLessThan(1e-12);
      });
    }

    it("drops the move when the head looks straight down", () => {
      const move = userFrameMove([1, 1], up.clone().negate(), up);
      expect(move.length()).toBe(0);
    });
  });
}
