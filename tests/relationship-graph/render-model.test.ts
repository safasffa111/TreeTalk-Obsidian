import { describe, expect, it } from "vitest";
import { createRelationshipGraphRenderFrame } from "../../src/relationship-graph/render-model";
import type { RelationshipGraphSnapshot } from "../../src/relationship-graph/types";

function snapshot(): RelationshipGraphSnapshot {
  return {
    sessionId: "space-a",
    nodes: [
      { id: "conversation:root", kind: "conversation", title: "Root", label: "Root", degree: 1, included: true, conversationNodeId: "root" },
      { id: "conversation:child", kind: "conversation", title: "Child", label: "Child", degree: 1, included: true, conversationNodeId: "child" },
      { id: "conversation:other", kind: "conversation", title: "Other", label: "Other", degree: 1, included: false, conversationNodeId: "other" }
    ],
    edges: [
      { id: "parent-child:conversation:root->conversation:child", sourceId: "conversation:root", targetId: "conversation:child", kind: "parent-child", included: true, conversationNodeId: "child" },
      { id: "parent-child:conversation:other->conversation:root", sourceId: "conversation:other", targetId: "conversation:root", kind: "parent-child", included: false, conversationNodeId: "root" }
    ],
    positions: {
      "conversation:root": { x: 100, y: 100, fixed: false },
      "conversation:child": { x: 180, y: 100, fixed: false },
      "conversation:other": { x: 100, y: 220, fixed: false }
    }
  };
}

describe("relationship graph render model", () => {
  it("does not highlight the current conversation without a hover", () => {
    const frame = createRelationshipGraphRenderFrame(snapshot(), { scale: 1, panX: 0, panY: 0 }, { activeNodeId: "conversation:root" }, { width: 800, height: 600 });
    expect(frame.nodes.every((node) => !node.highlighted)).toBe(true);
    expect(frame.edges.every((edge) => !edge.highlighted)).toBe(true);
  });

  it("dims unrelated graph items while preserving direct neighbors and marks exclusions", () => {
    const frame = createRelationshipGraphRenderFrame(snapshot(), { scale: 1, panX: 0, panY: 0 }, { hoveredNodeId: "conversation:root" }, { width: 800, height: 600 });
    const root = frame.nodes.find((node) => node.id === "conversation:root");
    const child = frame.nodes.find((node) => node.id === "conversation:child");
    const other = frame.nodes.find((node) => node.id === "conversation:other");
    expect(root?.highlighted).toBe(true);
    expect(child?.dimmed).toBe(false);
    expect(other?.dimmed).toBe(true);
    expect(frame.edges.find((edge) => edge.id.startsWith("parent-child:conversation:root"))?.highlighted).toBe(true);
    const excluded = frame.edges.find((edge) => edge.id.startsWith("parent-child:conversation:other"));
    expect(excluded?.excluded).toBe(true);
    expect(excluded?.dimmed).toBe(true);
  });

  it("keeps persistent topology complete while limiting labels for a large graph", () => {
    const nodes = Array.from({ length: 5000 }, (_, index) => ({
      id: `node-${String(index)}`,
      kind: "conversation" as const,
      title: `Node ${String(index)}`,
      label: `Node ${String(index)}`,
      degree: 2,
      included: true
    }));
    const positions = Object.fromEntries(nodes.map((node, index) => [node.id, {
      x: (index % 100) * 80,
      y: Math.floor(index / 100) * 80,
      fixed: false
    }]));
    const edges = Array.from({ length: 10000 }, (_, index) => ({
      id: `edge-${String(index)}`,
      sourceId: `node-${String(index % 5000)}`,
      targetId: `node-${String((index % 5000 + 1) % 5000)}`,
      kind: "related-note" as const,
      included: true,
      conversationNodeId: "root"
    }));
    const frame = createRelationshipGraphRenderFrame(
      { sessionId: "large", nodes, edges, positions },
      { scale: 1, panX: 0, panY: 0 },
      undefined,
      { width: 800, height: 600 }
    );
    expect(frame.nodes).toHaveLength(5000);
    expect(frame.edges).toHaveLength(10000);
    expect(frame.labels.length).toBeLessThanOrEqual(250);
  });
});
