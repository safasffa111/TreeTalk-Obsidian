import { describe, expect, it } from "vitest";
import {
  nextRelationshipGraphWheelScale,
  relationshipGraphCameraSettled,
  stepRelationshipGraphCamera,
  zoomRelationshipGraphAtPoint,
  type RelationshipGraphCamera
} from "../../src/relationship-graph/camera";

describe("relationship graph camera", () => {
  it("keeps the pointer world position fixed while zooming", () => {
    const camera: RelationshipGraphCamera = { scale: 1, panX: 40, panY: 30 };
    const next = zoomRelationshipGraphAtPoint(camera, { x: 240, y: 180 }, 2);
    expect((240 - next.panX) / next.scale).toBeCloseTo((240 - 40) / 1);
    expect((180 - next.panY) / next.scale).toBeCloseTo((180 - 30) / 1);
  });

  it("keeps the native 0.8.34 zoom range", () => {
    expect(nextRelationshipGraphWheelScale(2.4, -120)).toBe(2.4);
    expect(nextRelationshipGraphWheelScale(0.35, 120)).toBe(0.35);
  });

  it("smooths wheel targets while preserving the pointer anchor", () => {
    const pointer = { x: 240, y: 180 };
    const start: RelationshipGraphCamera = { scale: 1, panX: 40, panY: 30 };
    const target = zoomRelationshipGraphAtPoint(start, pointer, 2);
    const first = stepRelationshipGraphCamera(start, target, 16);
    const second = stepRelationshipGraphCamera(first, target, 16);
    const worldX = (pointer.x - start.panX) / start.scale;
    const worldY = (pointer.y - start.panY) / start.scale;

    expect(first.scale).toBeGreaterThan(start.scale);
    expect(second.scale).toBeGreaterThan(first.scale);
    expect(second.scale).toBeLessThan(target.scale);
    expect((pointer.x - first.panX) / first.scale).toBeCloseTo(worldX);
    expect((pointer.y - first.panY) / first.scale).toBeCloseTo(worldY);
    expect(relationshipGraphCameraSettled(second, target)).toBe(false);
    expect(relationshipGraphCameraSettled(target, target)).toBe(true);
  });
});
