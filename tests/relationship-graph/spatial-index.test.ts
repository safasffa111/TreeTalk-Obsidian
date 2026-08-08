import { describe, expect, it } from "vitest";
import { RelationshipGraphEdgeSpatialIndex, RelationshipGraphSpatialIndex } from "../../src/relationship-graph/spatial-index";

describe("relationship graph spatial index", () => {
  it("returns the nearest node within its hit radius", () => {
    const index = new RelationshipGraphSpatialIndex();
    index.rebuild([{ id: "a", x: 100, y: 100, radius: 12 }]);
    expect(index.hitTest({ x: 108, y: 104 })?.id).toBe("a");
    expect(index.hitTest({ x: 140, y: 140 })).toBeUndefined();
  });

  it("visits only the nearby node cells for a large graph", () => {
    const index = new RelationshipGraphSpatialIndex();
    index.rebuild(Array.from({ length: 5000 }, (_, index) => ({
      id: `node-${String(index)}`,
      x: (index % 100) * 180,
      y: Math.floor(index / 100) * 180,
      radius: 8
    })));
    expect(index.hitTest({ x: 180, y: 180 })?.id).toBe("node-101");
    expect(index.getLastVisitedCount()).toBeLessThan(80);
  });

  it("updates moving node cells without rebuilding topology storage", () => {
    const index = new RelationshipGraphSpatialIndex();
    const nodes = Array.from({ length: 5000 }, (_, nodeIndex) => ({
      id: `node-${String(nodeIndex)}`,
      x: (nodeIndex % 100) * 180,
      y: Math.floor(nodeIndex / 100) * 180,
      radius: 8
    }));
    index.rebuild(nodes);
    for (let frame = 0; frame < 100; frame += 1) {
      for (const node of nodes) node.x += 0.1;
      index.updatePositions(nodes);
    }
    expect(index.getDiagnostics()).toMatchObject({ rebuildCount: 1, updateCount: 100 });
    expect(index.hitTest({ x: 190, y: 180 })?.id).toBe("node-101");
  });

  it("visits only nearby edge cells for context-menu edge hit testing", () => {
    const index = new RelationshipGraphEdgeSpatialIndex();
    index.rebuild(Array.from({ length: 10000 }, (_, edgeIndex) => {
      const column = edgeIndex % 100;
      const row = Math.floor(edgeIndex / 100);
      return { id: `edge-${String(edgeIndex)}`, sourceX: column * 180, sourceY: row * 180, targetX: column * 180 + 60, targetY: row * 180 + 20 };
    }));
    expect(index.hitTest({ x: 30, y: 10 })?.edge.id).toBe("edge-0");
    expect(index.getLastVisitedCount()).toBeLessThan(80);
  });

  it("indexes a long diagonal by traversed cells instead of its bounding rectangle", () => {
    const index = new RelationshipGraphEdgeSpatialIndex();
    index.rebuild([{ id: "diagonal", sourceX: 0, sourceY: 0, targetX: 96_000, targetY: 96_000 }]);
    expect(index.getCellEntryCount()).toBeLessThanOrEqual(1002);
    expect(index.hitTest({ x: 48_004, y: 47_996 })?.edge.id).toBe("diagonal");
  });
});
