import { describe, expect, it } from "vitest";
import {
  RelationshipGraphFrameInterpolator,
  stepRelationshipGraphRadius
} from "../../src/relationship-graph/frame-interpolator";

describe("relationship graph frame interpolation", () => {
  it("interpolates ordered Worker samples into a reused display buffer", () => {
    const frames = new RelationshipGraphFrameInterpolator(2);
    const target = new Float32Array(4);

    expect(frames.push({
      sequence: 1,
      receivedAt: 0,
      values: new Float32Array([0, 0, 10, 20])
    })).toBe(true);
    expect(frames.push({
      sequence: 2,
      receivedAt: 40,
      values: new Float32Array([40, 20, 30, 40])
    })).toBe(true);

    expect(frames.sample(20, target)).toBe(target);
    expect([...target]).toEqual([20, 10, 20, 30]);
  });

  it("rejects stale or malformed samples without replacing the current frame", () => {
    const frames = new RelationshipGraphFrameInterpolator(1);
    expect(frames.push({
      sequence: 2,
      receivedAt: 10,
      values: new Float32Array([20, 30])
    })).toBe(true);
    expect(frames.push({
      sequence: 2,
      receivedAt: 20,
      values: new Float32Array([90, 90])
    })).toBe(false);
    expect(frames.push({
      sequence: 3,
      receivedAt: 30,
      values: new Float32Array([1])
    })).toBe(false);

    expect([...frames.sample(100, new Float32Array(2))]).toEqual([20, 30]);
  });

  it("renders a dragged node immediately and hands it back smoothly", () => {
    const frames = new RelationshipGraphFrameInterpolator(1);
    frames.push({
      sequence: 1,
      receivedAt: 0,
      values: new Float32Array([10, 20])
    });
    frames.setDragOverride(0, 90, 80);
    expect([...frames.sample(0, new Float32Array(2))]).toEqual([90, 80]);

    frames.releaseDragOverride(0, 100);
    const halfway = frames.sample(145, new Float32Array(2));
    expect(halfway[0]).toBeCloseTo(50);
    expect(halfway[1]).toBeCloseTo(50);
    expect(frames.needsFrame(145)).toBe(true);
    expect([...frames.sample(190, new Float32Array(2))]).toEqual([10, 20]);
    expect(frames.needsFrame(190)).toBe(false);
  });

  it("grows node radius by elapsed time instead of frame count", () => {
    const oneLongFrame = stepRelationshipGraphRadius(8, 30, 32);
    const twoShortFrames = stepRelationshipGraphRadius(
      stepRelationshipGraphRadius(8, 30, 16),
      30,
      16
    );
    expect(oneLongFrame).toBeCloseTo(twoShortFrames, 8);
    expect(oneLongFrame).toBeGreaterThan(8);
    expect(oneLongFrame).toBeLessThan(30);
  });
});
