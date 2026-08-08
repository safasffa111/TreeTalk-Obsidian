import { describe, expect, it, vi } from "vitest";
import {
  RelationshipGraphPersistentGeometry,
  type RelationshipGraphGeometryAdapter
} from "../../src/relationship-graph/pixi-geometry";
import type { RelationshipGraphRenderFrame } from "../../src/relationship-graph/render-model";

function frame(panX = 0, nodeX = 10): RelationshipGraphRenderFrame {
  return {
    camera: { scale: 1, panX, panY: 0 },
    nodes: [{
      id: "conversation:root",
      x: nodeX,
      y: 20,
      radius: 8,
      note: false,
      highlighted: false,
      dimmed: false,
      excluded: false,
      active: false,
      focused: false
    }],
    edges: [{
      id: "parent-child:root-child",
      sourceId: "root",
      targetId: "child",
      sourceX: nodeX,
      sourceY: 20,
      targetX: 40,
      targetY: 50,
      highlighted: false,
      dimmed: false,
      excluded: false
    }],
    labels: []
  };
}

describe("persistent Pixi graph geometry", () => {
  it("allocates node and edge objects once across position and camera frames", () => {
    const createNode = vi.fn(() => ({}));
    const createEdge = vi.fn(() => ({}));
    const setCamera = vi.fn();
    const render = vi.fn();
    const adapter: RelationshipGraphGeometryAdapter<object, object> = {
      createNode,
      updateNode: vi.fn(),
      setNodeVisible: vi.fn(),
      destroyNode: vi.fn(),
      createEdge,
      updateEdge: vi.fn(),
      setEdgeVisible: vi.fn(),
      destroyEdge: vi.fn(),
      setCamera,
      render,
      destroy: vi.fn()
    };
    const geometry = new RelationshipGraphPersistentGeometry(adapter);
    geometry.render(frame());
    for (let index = 1; index <= 100; index += 1) {
      geometry.render(frame(index, 10 + index));
    }

    expect(createNode).toHaveBeenCalledOnce();
    expect(createEdge).toHaveBeenCalledOnce();
    expect(setCamera).toHaveBeenCalledTimes(101);
    expect(render).toHaveBeenCalledTimes(101);
    expect(geometry.diagnostics).toMatchObject({
      nodeObjectHighWaterMark: 1,
      edgeObjectHighWaterMark: 1,
      topologyAllocationCount: 2,
      frameCount: 101
    });
  });

  it("hides absent objects, reuses them when visible again, and destroys once", () => {
    const nodeHandle = {};
    const edgeHandle = {};
    const createNode = vi.fn(() => nodeHandle);
    const createEdge = vi.fn(() => edgeHandle);
    const setNodeVisible = vi.fn();
    const setEdgeVisible = vi.fn();
    const destroyNode = vi.fn();
    const destroyEdge = vi.fn();
    const destroy = vi.fn();
    const adapter: RelationshipGraphGeometryAdapter<object, object> = {
      createNode, updateNode: vi.fn(), setNodeVisible, destroyNode,
      createEdge, updateEdge: vi.fn(), setEdgeVisible, destroyEdge,
      setCamera: vi.fn(), render: vi.fn(), destroy
    };
    const geometry = new RelationshipGraphPersistentGeometry(adapter);
    geometry.render(frame());
    geometry.render({ ...frame(), nodes: [], edges: [] });
    geometry.render(frame());
    expect(createNode).toHaveBeenCalledOnce();
    expect(createEdge).toHaveBeenCalledOnce();
    expect(setNodeVisible).toHaveBeenCalledWith(nodeHandle, false);
    expect(setEdgeVisible).toHaveBeenCalledWith(edgeHandle, false);
    geometry.destroy();
    geometry.destroy();
    expect(destroyNode).toHaveBeenCalledOnce();
    expect(destroyEdge).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
  });
});
