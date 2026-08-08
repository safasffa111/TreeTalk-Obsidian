import { describe, expect, it } from "vitest";
import {
  RelationshipGraphPersistentGeometry,
  type RelationshipGraphGeometryAdapter
} from "../../src/relationship-graph/pixi-geometry";
import type { RelationshipGraphRenderFrame } from "../../src/relationship-graph/render-model";

interface Handle { id: string; }

function largeFrame(): RelationshipGraphRenderFrame {
  const nodes = Array.from({ length: 5_000 }, (_, index) => ({
    id: `node-${String(index)}`,
    x: index % 100 * 20,
    y: Math.floor(index / 100) * 20,
    radius: 8,
    note: false,
    highlighted: false,
    dimmed: false,
    excluded: false,
    active: false,
    focused: false
  }));
  const edges = Array.from({ length: 10_000 }, (_, index) => {
    const source = nodes[index % nodes.length];
    const target = nodes[(index * 17 + 1) % nodes.length];
    if (source === undefined || target === undefined) throw new Error("invalid large graph fixture");
    return {
      id: `edge-${String(index)}`,
      sourceId: source.id,
      targetId: target.id,
      sourceX: source.x,
      sourceY: source.y,
      targetX: target.x,
      targetY: target.y,
      highlighted: false,
      dimmed: false,
      excluded: false
    };
  });
  return { camera: { scale: 1, panX: 0, panY: 0 }, nodes, edges, labels: [] };
}

describe("large persistent relationship graph", () => {
  it("keeps 1,000 camera frames independent from 5,000 nodes and 10,000 edges", () => {
    const liveNodes = new Set<Handle>();
    const liveEdges = new Set<Handle>();
    const adapter: RelationshipGraphGeometryAdapter<Handle, Handle> = {
      createNode: (id) => { const handle = { id }; liveNodes.add(handle); return handle; },
      updateNode: () => undefined,
      setNodeVisible: () => undefined,
      destroyNode: (handle) => { liveNodes.delete(handle); },
      createEdge: (id) => { const handle = { id }; liveEdges.add(handle); return handle; },
      updateEdge: () => undefined,
      setEdgeVisible: () => undefined,
      destroyEdge: (handle) => { liveEdges.delete(handle); },
      setCamera: () => undefined,
      render: () => undefined,
      destroy: () => undefined
    };
    const geometry = new RelationshipGraphPersistentGeometry(adapter);
    const graphFrame = largeFrame();
    geometry.render(graphFrame);
    const allocations = geometry.diagnostics.topologyAllocationCount;
    for (let index = 0; index < 1_000; index += 1) {
      geometry.renderCamera({ scale: 1 + index / 10_000, panX: index, panY: -index });
    }
    for (let index = 0; index < 100; index += 1) geometry.renderPositions(graphFrame);
    expect(geometry.diagnostics).toMatchObject({
      nodeObjectHighWaterMark: 5_000,
      edgeObjectHighWaterMark: 10_000,
      topologyAllocationCount: allocations,
      cameraOnlyFrameCount: 1_000,
      positionOnlyFrameCount: 100
    });
    expect(allocations).toBe(15_000);
    geometry.destroy();
    expect(liveNodes.size).toBe(0);
    expect(liveEdges.size).toBe(0);
  });
});
