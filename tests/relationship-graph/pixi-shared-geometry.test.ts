import { describe, expect, it } from "vitest";
import {
  buildRelationshipGraphEdgeMeshData,
  buildRelationshipGraphNodeMeshData
} from "../../src/relationship-graph/pixi-shared-geometry";
import type { RelationshipGraphRenderFrame } from "../../src/relationship-graph/render-model";

const frame: RelationshipGraphRenderFrame = {
  camera: { scale: 1, panX: 0, panY: 0 },
  nodes: [
    { id: "a", x: 10, y: 20, radius: 8, note: false, highlighted: false, dimmed: false, excluded: false, active: false, focused: false },
    { id: "b", x: 30, y: 40, radius: 12, note: true, highlighted: true, dimmed: false, excluded: false, active: false, focused: false }
  ],
  edges: [
    { id: "a-b", sourceId: "a", targetId: "b", sourceX: 10, sourceY: 20, targetX: 30, targetY: 40, highlighted: true, dimmed: false, excluded: false }
  ],
  labels: []
};

const theme = { accent: 0xff0000, node: 0x808080, edge: 0x404040, text: "#ffffff" };

describe("relationship graph shared GPU geometry", () => {
  it("encodes four shader vertices per node and indexes the shared position texture", () => {
    const data = buildRelationshipGraphNodeMeshData(frame.nodes, new Map([["a", 0], ["b", 1]]), 2, 1, theme);
    expect(data.corners).toHaveLength(16);
    expect(data.positionUvs).toHaveLength(16);
    expect(data.radii).toHaveLength(8);
    expect(data.colors).toHaveLength(32);
    expect(data.indices).toHaveLength(12);
    expect([...data.positionUvs.slice(0, 2)]).toEqual([0.25, 0.5]);
    expect([...data.positionUvs.slice(8, 10)]).toEqual([0.75, 0.5]);
  });

  it("encodes edge endpoints as texture coordinates instead of CPU line geometry", () => {
    const data = buildRelationshipGraphEdgeMeshData(
      frame.edges,
      [{ id: "a-b", sourceIndex: 0, targetIndex: 1 }],
      2,
      1,
      theme
    );
    expect(data.alongSide).toHaveLength(8);
    expect(data.sourceUvs).toHaveLength(8);
    expect(data.targetUvs).toHaveLength(8);
    expect(data.thickness).toHaveLength(4);
    expect(data.indices).toHaveLength(6);
    expect([...data.sourceUvs.slice(0, 2)]).toEqual([0.25, 0.5]);
    expect([...data.targetUvs.slice(0, 2)]).toEqual([0.75, 0.5]);
  });
});
