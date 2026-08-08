// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { RelationshipGraphPixiView, resolveRelationshipGraphThemeColors, type RelationshipGraphPixiSurface } from "../../src/relationship-graph/pixi-view";
import {
  RelationshipGraphSharedMemoryReader,
  RelationshipGraphSharedMemoryWriter,
  createRelationshipGraphSharedMemory
} from "../../src/relationship-graph/shared-memory";

class FakeSurface implements RelationshipGraphPixiSurface {
  readonly canvas = document.createElement("canvas");
  readonly render = vi.fn();
  readonly renderPositions = vi.fn();
  readonly renderLabels = vi.fn();
  readonly resize = vi.fn();
  readonly destroy = vi.fn();
  readonly labelObjectHighWaterMark = 0;
  readonly liveLabelObjectCount = 0;
}

describe("relationship graph Pixi view", () => {
  it("reads Obsidian graph CSS variables for node, line, and text colors", () => {
    const canvas = document.createElement("canvas");
    const style = { getPropertyValue: (name: string): string => ({
      "--graph-node": "#112233",
      "--graph-line": "#445566",
      "--graph-text": "#778899"
    }[name] ?? "") };
    if (document.defaultView === null) throw new Error("missing window");
    const spy = vi.spyOn(document.defaultView as Window, "getComputedStyle").mockReturnValue(style as unknown as CSSStyleDeclaration);
    try {
      expect(resolveRelationshipGraphThemeColors(canvas)).toMatchObject({ node: 0x112233, edge: 0x445566, text: "#778899" });
    } finally {
      spy.mockRestore();
    }
  });

  it("renders a frame through one Pixi surface and hit-tests nodes in world space", () => {
    const surface = new FakeSurface();
    const view = new RelationshipGraphPixiView(surface);
    view.resize(800, 600);
    view.render({
      sessionId: "space-a",
      nodes: [{ id: "conversation:root", kind: "conversation", title: "Root", label: "Root", degree: 1, included: true }],
      edges: [],
      positions: { "conversation:root": { x: 200, y: 160, fixed: false } }
    }, { scale: 1, panX: 0, panY: 0 }, undefined);
    expect(surface.render).toHaveBeenCalledOnce();
    const hit = view.hitTest({ x: 200, y: 160 });
    expect(hit !== undefined && "nodeId" in hit ? hit.nodeId : undefined).toBe("conversation:root");
    view.destroy();
    expect(surface.destroy).toHaveBeenCalledOnce();
  });

  it("eases newly connected node growth within the native graph size bounds", () => {
    const surface = new FakeSurface();
    const view = new RelationshipGraphPixiView(surface);
    const snapshot = {
      sessionId: "space-a",
      nodes: [{ id: "conversation:root", kind: "conversation" as const, title: "Root", label: "Root", degree: 48, included: true, conversationNodeId: "root" }],
      edges: [],
      positions: { "conversation:root": { x: 200, y: 160, fixed: false } }
    };
    view.resize(800, 600);
    view.render(snapshot, { scale: 1, panX: 0, panY: 0 }, undefined, 0);
    const first = (surface.render.mock.calls[0]?.[0] as { nodes: Array<{ radius: number }> }).nodes[0]?.radius ?? 0;
    view.render(snapshot, { scale: 1, panX: 0, panY: 0 }, undefined, 900);
    const second = (surface.render.mock.calls[1]?.[0] as { nodes: Array<{ radius: number }> }).nodes[0]?.radius ?? 0;
    expect(second).toBeGreaterThan(first);
    expect(second).toBeLessThanOrEqual(30);
  });

  it("updates moving positions without rebuilding the full render model", () => {
    const surface = new FakeSurface();
    const view = new RelationshipGraphPixiView(surface);
    const snapshot = {
      sessionId: "space-a",
      topologySignature: "one-node",
      nodes: [{ id: "conversation:root", kind: "conversation" as const, title: "Root", label: "Root", degree: 1, included: true }],
      edges: [],
      positions: { "conversation:root": { x: 10, y: 20, fixed: false } }
    };
    view.resize(800, 600);
    view.render(snapshot, { scale: 1, panX: 0, panY: 0 }, undefined, 0);
    snapshot.positions["conversation:root"].x = 30;
    expect(view.renderPositions(snapshot, { scale: 1, panX: 0, panY: 0 }, 16)).toBe(true);
    expect(surface.render).toHaveBeenCalledOnce();
    expect(surface.renderPositions).toHaveBeenCalledOnce();
    const positionFrame = surface.renderPositions.mock.calls[0]?.[0] as { nodes: Array<{ x: number }> };
    expect(positionFrame.nodes[0]?.x).toBe(30);
  });

  it("keeps the node index topology stable across 5,000-node position frames", () => {
    const surface = new FakeSurface();
    const view = new RelationshipGraphPixiView(surface);
    const nodes = Array.from({ length: 5000 }, (_, index) => ({
      id: `node-${String(index)}`,
      kind: "conversation" as const,
      title: `Node ${String(index)}`,
      label: `Node ${String(index)}`,
      degree: 1,
      included: true
    }));
    const snapshot = {
      sessionId: "large",
      topologySignature: "large-stable",
      nodes,
      edges: [],
      positions: Object.fromEntries(nodes.map((node, index) => [node.id, {
        x: (index % 100) * 180,
        y: Math.floor(index / 100) * 180,
        fixed: false
      }]))
    };
    view.resize(800, 600);
    view.render(snapshot, { scale: 1, panX: 0, panY: 0 }, undefined, 0);
    for (let frame = 1; frame <= 100; frame += 1) {
      for (const position of Object.values(snapshot.positions)) position.x += 0.1;
      view.renderPositions(snapshot, { scale: 1, panX: 0, panY: 0 }, frame * 16);
    }
    expect(view.diagnostics).toMatchObject({ spatialIndexRebuildCount: 1, spatialIndexUpdateCount: 100 });
  });

  it("refreshes the bounded visible label set without rebuilding topology", () => {
    const surface = new FakeSurface();
    const view = new RelationshipGraphPixiView(surface);
    const snapshot = {
      sessionId: "labels",
      topologySignature: "two-nodes",
      nodes: [
        { id: "a", kind: "conversation" as const, title: "Alpha", label: "Alpha", degree: 1, included: true },
        { id: "b", kind: "conversation" as const, title: "Beta", label: "Beta", degree: 1, included: true }
      ],
      edges: [],
      positions: {
        a: { x: 100, y: 100, fixed: false },
        b: { x: 1000, y: 100, fixed: false }
      }
    };
    view.resize(800, 600);
    view.render(snapshot, { scale: 1.2, panX: 0, panY: 0 }, undefined, 0);
    const initial = surface.render.mock.calls[0]?.[0] as { labels: Array<{ id: string }> };
    expect(initial.labels.map((label) => label.id)).toEqual(["a"]);
    view.renderLabels({ scale: 1.2, panX: -600, panY: 0 });
    const refreshed = surface.renderLabels.mock.calls[0]?.[1] as Array<{ id: string }>;
    expect(refreshed.map((label) => label.id)).toEqual(["b"]);
    expect(view.diagnostics.spatialIndexRebuildCount).toBe(1);
  });
  it("renders shared pages without per-node or per-edge CPU position updates", () => {
    const surface = new FakeSurface();
    const configureShared = vi.fn();
    const renderShared = vi.fn();
    Object.assign(surface, { configureShared, renderShared });
    const descriptor = createRelationshipGraphSharedMemory(2, 1);
    const reader = new RelationshipGraphSharedMemoryReader(descriptor);
    const writer = new RelationshipGraphSharedMemoryWriter(descriptor);
    const seed = writer.beginWrite();
    if (seed === undefined) throw new Error("missing seed page");
    seed.values.set([100, 120, 0, 1, 260, 120, 0, 1]);
    writer.publish(seed, true);
    const view = new RelationshipGraphPixiView(surface);
    view.setSharedState({ revision: 1, nodeIds: ["a", "b"], reader });
    const snapshot = {
      sessionId: "shared",
      topologySignature: "a-b",
      nodes: [
        { id: "a", kind: "conversation" as const, title: "A", label: "A", degree: 1, included: true },
        { id: "b", kind: "conversation" as const, title: "B", label: "B", degree: 1, included: true }
      ],
      edges: [{ id: "a-b", kind: "parent-child" as const, sourceId: "a", targetId: "b", included: true, conversationNodeId: "a" }],
      positions: { a: { x: 0, y: 0, fixed: false }, b: { x: 0, y: 0, fixed: false } }
    };
    view.resize(800, 600);
    view.render(snapshot, { scale: 1, panX: 0, panY: 0 }, undefined, 0);
    expect(configureShared).toHaveBeenCalledOnce();
    const next = writer.beginWrite();
    if (next === undefined) throw new Error("missing position page");
    next.values.set([140, 160, 0, 1, 300, 160, 0, 1]);
    writer.publish(next, true);
    expect(view.renderShared(snapshot, { scale: 1, panX: 0, panY: 0 }, 16)).toEqual(expect.objectContaining({ active: true }));
    expect(renderShared).toHaveBeenCalledOnce();
    expect(surface.renderPositions).not.toHaveBeenCalled();
    expect(view.hitTestNode({ x: 140, y: 160 })?.nodeId).toBe("a");
  });

});
