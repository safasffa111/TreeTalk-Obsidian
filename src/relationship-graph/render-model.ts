import type { DepositGraphPosition } from "../domain/types";
import {
  relationshipGraphLabelAlpha,
  shouldShowRelationshipGraphLabels,
  type RelationshipGraphCamera
} from "./camera";
import type { RelationshipGraphEdgeKind, RelationshipGraphSnapshot } from "./types";

export interface RelationshipGraphVisualState {
  hoveredNodeId?: string;
  activeNodeId?: string;
  focusedNodeId?: string;
}

export interface RelationshipGraphRenderFrame {
  camera: RelationshipGraphCamera;
  edges: Array<{ id: string; sourceId: string; targetId: string; kind?: RelationshipGraphEdgeKind; sourceX: number; sourceY: number; targetX: number; targetY: number; highlighted: boolean; dimmed: boolean; excluded: boolean }>;
  nodes: Array<{ id: string; x: number; y: number; radius: number; note: boolean; highlighted: boolean; dimmed: boolean; excluded: boolean; active: boolean; focused: boolean }>;
  labels: Array<{ id: string; text: string; x: number; y: number; alpha: number; highlighted: boolean }>;
}

function nodeRadius(degree: number): number {
  return Math.max(8, Math.min(30, 3 * Math.sqrt(Math.max(0, degree) + 1)));
}

interface RelationshipGraphRenderTopologyCache {
  nodeIndexById: Map<string, number>;
  connectedByNode: Map<string, Set<string>>;
}

const topologyCache = new WeakMap<RelationshipGraphSnapshot, RelationshipGraphRenderTopologyCache>();
const keyedTopologyCache = new Map<string, RelationshipGraphRenderTopologyCache>();

function getTopologyCache(snapshot: RelationshipGraphSnapshot): RelationshipGraphRenderTopologyCache {
  if (snapshot.topologySignature !== undefined) {
    const keyed = keyedTopologyCache.get(snapshot.topologySignature);
    if (keyed !== undefined) return keyed;
  }
  const existing = topologyCache.get(snapshot);
  if (existing !== undefined) return existing;
  const connectedByNode = new Map<string, Set<string>>();
  for (const edge of snapshot.edges) {
    const source = connectedByNode.get(edge.sourceId) ?? new Set<string>();
    source.add(edge.targetId);
    connectedByNode.set(edge.sourceId, source);
    const target = connectedByNode.get(edge.targetId) ?? new Set<string>();
    target.add(edge.sourceId);
    connectedByNode.set(edge.targetId, target);
  }
  const cache = {
    nodeIndexById: new Map(snapshot.nodes.map((node, index) => [node.id, index])),
    connectedByNode
  };
  if (snapshot.topologySignature === undefined) topologyCache.set(snapshot, cache);
  else {
    keyedTopologyCache.set(snapshot.topologySignature, cache);
    if (keyedTopologyCache.size > 32) {
      const oldest = keyedTopologyCache.keys().next().value;
      if (typeof oldest === "string") keyedTopologyCache.delete(oldest);
    }
  }
  return cache;
}

export function createRelationshipGraphRenderFrame(
  snapshot: RelationshipGraphSnapshot,
  camera: RelationshipGraphCamera,
  visual: RelationshipGraphVisualState | undefined,
  viewport: { width: number; height: number }
): RelationshipGraphRenderFrame {
  const activeId = visual?.hoveredNodeId;
  const topology = getTopologyCache(snapshot);
  const connected = new Set<string>();
  if (activeId !== undefined) connected.add(activeId);
  for (const nodeId of topology.connectedByNode.get(activeId ?? "") ?? []) connected.add(nodeId);
  const positions = snapshot.positions;
  const scale = Math.max(camera.scale, Number.EPSILON);
  const margin = 120;
  const left = (-camera.panX - margin) / scale;
  const top = (-camera.panY - margin) / scale;
  const right = (viewport.width - camera.panX + margin) / scale;
  const bottom = (viewport.height - camera.panY + margin) / scale;
  const visible = (position: Pick<DepositGraphPosition, "x" | "y">): boolean =>
    position.x >= left && position.x <= right && position.y >= top && position.y <= bottom;
  const nodes = snapshot.nodes
    .filter((node) => positions[node.id] !== undefined)
    .map((node) => {
      const position = positions[node.id] as DepositGraphPosition;
      const excluded = !node.included;
      const highlighted = node.id === activeId;
      return {
        id: node.id,
        x: position.x,
        y: position.y,
        radius: nodeRadius(node.degree),
        note: node.kind === "note",
        highlighted,
        dimmed: excluded || activeId !== undefined && !connected.has(node.id),
        excluded,
        active: node.id === visual?.activeNodeId,
        focused: node.id === visual?.focusedNodeId
      };
    });
  const baseLabelAlpha = relationshipGraphLabelAlpha(camera.scale);
  const labels = (!shouldShowRelationshipGraphLabels(camera.scale) && activeId === undefined)
    ? []
    : nodes
      .filter((node) =>
        visible(node) &&
        (shouldShowRelationshipGraphLabels(camera.scale) || node.highlighted)
      )
      .sort((left, right) =>
        Number(right.highlighted) - Number(left.highlighted) ||
        Number(right.active) - Number(left.active) ||
        Number(right.focused) - Number(left.focused) ||
        right.radius - left.radius ||
        left.id.localeCompare(right.id)
      )
      .slice(0, 250)
      .map((node) => ({
        id: node.id,
        text: (() => {
          const nodeIndex = topology.nodeIndexById.get(node.id);
          return nodeIndex === undefined ? node.id : snapshot.nodes[nodeIndex]?.title ?? node.id;
        })(),
        x: node.x,
        y: node.y + node.radius + 6,
        alpha: node.highlighted ? 1 : node.dimmed ? baseLabelAlpha * 0.18 : baseLabelAlpha,
        highlighted: node.highlighted
      }));
  const edges = snapshot.edges.flatMap((edge) => {
    const source = positions[edge.sourceId];
    const target = positions[edge.targetId];
    if (source === undefined || target === undefined) return [];
    const highlighted = edge.sourceId === activeId || edge.targetId === activeId;
    return [{
      id: edge.id,
      sourceId: edge.sourceId,
      targetId: edge.targetId,
      kind: edge.kind,
      sourceX: source.x,
      sourceY: source.y,
      targetX: target.x,
      targetY: target.y,
      highlighted,
      dimmed: !edge.included || activeId !== undefined && !highlighted,
      excluded: !edge.included
    }];
  });
  return { camera, edges, nodes, labels };
}
