import { isNoteSelectionContext, type ConversationFile } from "../domain/types";
import type {
  RelationshipGraphEdgeKind,
  RelationshipGraphEdge,
  RelationshipGraphModel,
  RelationshipGraphNode,
  RelationshipGraphProjection
} from "./types";
import { isRelationshipEdgeIncluded, isRelationshipNodeIncluded } from "./state";
import type { RelationshipGraphSnapshot } from "./types";
import type { RelationshipGraphWorkerLinkInput, RelationshipGraphWorkerNodeInput } from "./worker-core";

export function conversationRelationshipNodeId(nodeId: string): string {
  return `conversation:${nodeId}`;
}

function normalizePath(path: string): string {
  return path.replace(/\\/gu, "/").replace(/^\.\//u, "");
}

export function noteRelationshipNodeId(filePath: string): string {
  return `note:${normalizePath(filePath)}`;
}

export function relationshipGraphInputSignature(conversation: ConversationFile): string {
  return JSON.stringify(Object.values(conversation.nodes).map((node) => [
    node.id,
    node.parentId,
    node.childIds ?? [],
    node.title,
    node.messages
      .filter((message) => message.role === "user")
      .map((message) => [
        (message.selectionContexts ?? [])
          .filter(isNoteSelectionContext)
          .map((context) => [normalizePath(context.filePath), context.fileName]),
        (message.noteContextGraph?.nodes ?? []).map((note) => [
          normalizePath(note.filePath),
          note.fileName,
          note.root
        ])
      ])
  ]));
}

export function relationshipGraphVisualStateSignature(conversation: ConversationFile): string {
  const state = conversation.depositGraphState;
  return JSON.stringify([
    Object.entries(state?.nodeStates ?? {})
      .map(([id, value]) => [id, value.included])
      .sort(([left], [right]) => String(left).localeCompare(String(right))),
    Object.entries(state?.edgeOverrides ?? {})
      .map(([id, value]) => [id, value.included])
      .sort(([left], [right]) => String(left).localeCompare(String(right)))
  ]);
}

export function relationshipEdgeId(
  kind: RelationshipGraphEdgeKind,
  sourceId: string,
  targetId: string
): string {
  return `${kind}:${sourceId}->${targetId}`;
}

function nodeLabel(title: string | undefined, fallback: string): string {
  const trimmed = title?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : fallback;
}

export function buildRelationshipGraph(conversation: ConversationFile): RelationshipGraphModel {
  const nodes = new Map<string, RelationshipGraphNode>();
  const edges = new Map<string, RelationshipGraphEdge>();
  const addNote = (filePath: string, fileName: string): string => {
    const normalized = normalizePath(filePath);
    const id = noteRelationshipNodeId(normalized);
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        kind: "note",
        layoutOrder: 0,
        label: nodeLabel(fileName.replace(/\.md$/iu, ""), normalized),
        title: nodeLabel(fileName.replace(/\.md$/iu, ""), normalized),
        degree: 0,
        included: true,
        filePath: normalized,
        fileName
      });
    }
    return id;
  };
  const addEdge = (
    kind: RelationshipGraphEdgeKind,
    sourceId: string,
    targetId: string,
    conversationNodeId: string,
    notePath?: string
  ): void => {
    const id = relationshipEdgeId(kind, sourceId, targetId);
    if (!edges.has(id)) {
      edges.set(id, {
        id,
        kind,
        sourceId,
        targetId,
        included: true,
        conversationNodeId,
        ...(notePath === undefined ? {} : { notePath })
      });
    }
  };

  const conversationNodes = Object.values(conversation.nodes);
  const fallbackOrder = new Map(conversationNodes.map((node, index) => [node.id, index]));
  for (const node of conversationNodes) {
    const id = conversationRelationshipNodeId(node.id);
    const parent = node.parentId === null ? undefined : conversation.nodes[node.parentId];
    const siblingIndex = parent?.childIds?.indexOf(node.id) ?? -1;
    nodes.set(id, {
      id,
      kind: "conversation",
      layoutOrder: siblingIndex >= 0 ? siblingIndex : fallbackOrder.get(node.id) ?? 0,
      ...(parent === undefined ? {} : { layoutParentId: conversationRelationshipNodeId(parent.id) }),
      ...(node.id === conversation.rootNodeId ? { layoutRoot: true } : {}),
      label: nodeLabel(node.title, "未命名节点"),
      title: nodeLabel(node.title, "未命名节点"),
      degree: 0,
      included: true,
      conversationNodeId: node.id
    });
  }
  for (const node of Object.values(conversation.nodes)) {
    const targetId = conversationRelationshipNodeId(node.id);
    if (node.parentId !== null && conversation.nodes[node.parentId] !== undefined) {
      addEdge("parent-child", conversationRelationshipNodeId(node.parentId), targetId, node.id);
    }
    for (const message of node.messages) {
      if (message.role !== "user") continue;
      for (const context of message.selectionContexts ?? []) {
        if (!isNoteSelectionContext(context)) continue;
        const noteId = addNote(context.filePath, context.fileName);
        addEdge("source-note", targetId, noteId, node.id, normalizePath(context.filePath));
      }
      const graph = message.noteContextGraph;
      if (graph === undefined) continue;
      for (const note of graph.nodes) {
        const noteId = addNote(note.filePath, note.fileName);
        addEdge(note.root ? "source-note" : "related-note", targetId, noteId, node.id, normalizePath(note.filePath));
      }
    }
  }
  for (const edge of edges.values()) {
    const source = nodes.get(edge.sourceId);
    const target = nodes.get(edge.targetId);
    if (source !== undefined) source.degree += 1;
    if (target !== undefined) target.degree += 1;
  }

  const noteAttachments = new Map<string, RelationshipGraphEdge[]>();
  for (const edge of edges.values()) {
    if (edge.kind === "parent-child") continue;
    const target = nodes.get(edge.targetId);
    if (target?.kind !== "note") continue;
    const attached = noteAttachments.get(target.id) ?? [];
    attached.push(edge);
    noteAttachments.set(target.id, attached);
  }
  const noteGroups = new Map<string, RelationshipGraphNode[]>();
  for (const [noteId, attachments] of noteAttachments) {
    const note = nodes.get(noteId);
    if (note === undefined) continue;
    attachments.sort((left, right) => {
      const kindOrder = Number(left.kind === "related-note") - Number(right.kind === "related-note");
      if (kindOrder !== 0) return kindOrder;
      const leftHost = nodes.get(left.sourceId)?.layoutOrder ?? 0;
      const rightHost = nodes.get(right.sourceId)?.layoutOrder ?? 0;
      return leftHost - rightHost || left.id.localeCompare(right.id);
    });
    const primary = attachments[0];
    if (primary === undefined || primary.kind === "parent-child") continue;
    note.layoutHostId = primary.sourceId;
    note.layoutNoteRelation = primary.kind;
    const group = noteGroups.get(primary.sourceId) ?? [];
    group.push(note);
    noteGroups.set(primary.sourceId, group);
  }
  for (const group of noteGroups.values()) {
    group.sort((left, right) => {
      const relationOrder = Number(left.layoutNoteRelation === "related-note") - Number(right.layoutNoteRelation === "related-note");
      return relationOrder || left.title.localeCompare(right.title) || left.id.localeCompare(right.id);
    });
    group.forEach((note, index) => {
      note.layoutOrder = index;
      note.layoutOrbitIndex = index;
      note.layoutOrbitCount = group.length;
    });
  }
  return { conversationId: conversation.id, nodes: [...nodes.values()], edges: [...edges.values()] };
}

export function createRelationshipProjection(
  conversation: ConversationFile
): RelationshipGraphProjection {
  const graph = buildRelationshipGraph(conversation);
  const includedNodeIds = new Set<string>();
  for (const nodeId of Object.keys(conversation.nodes)) {
    if (isRelationshipNodeIncluded(conversation.depositGraphState, nodeId)) {
      includedNodeIds.add(nodeId);
    }
  }
  const enabledParentEdges = new Set<string>();
  const enabledNoteEdges = new Set<string>();
  for (const edge of graph.edges) {
    if (!isRelationshipEdgeIncluded(conversation.depositGraphState, graph, edge)) continue;
    if (edge.kind === "parent-child") enabledParentEdges.add(edge.id);
    else enabledNoteEdges.add(edge.id);
  }
  return { graph, includedNodeIds, enabledParentEdges, enabledNoteEdges };
}

export class RelationshipGraphModelAdapter {
  snapshot(sessionId: string, conversation: ConversationFile): RelationshipGraphSnapshot {
    const graph = buildRelationshipGraph(conversation);
    const state = conversation.depositGraphState;
    for (const node of graph.nodes) {
      node.included = node.kind === "conversation"
        ? isRelationshipNodeIncluded(state, node.conversationNodeId ?? "")
        : isRelationshipNodeIncluded(state, node.id);
    }
    for (const edge of graph.edges) edge.included = isRelationshipEdgeIncluded(state, graph, edge);
    const positions = structuredClone(state?.nodePositions ?? {});
    return {
      sessionId,
      nodes: graph.nodes,
      edges: graph.edges,
      positions,
      restoredPositionIds: new Set(Object.keys(positions)),
      ...(state === undefined ? {} : { state: structuredClone(state) })
    };
  }
}

export function relationshipGraphWorkerTopology(snapshot: RelationshipGraphSnapshot): {
  nodes: RelationshipGraphWorkerNodeInput[];
  links: RelationshipGraphWorkerLinkInput[];
} {
  return {
    nodes: snapshot.nodes.map((node) => {
      const position = snapshot.positions[node.id];
      return {
        id: node.id,
        kind: node.kind,
        order: node.layoutOrder ?? 0,
        ...(node.layoutParentId === undefined ? {} : { parentId: node.layoutParentId }),
        ...(node.layoutRoot === true ? { root: true } : {}),
        ...(node.layoutHostId === undefined ? {} : { hostId: node.layoutHostId }),
        ...(node.layoutNoteRelation === undefined ? {} : { noteRelation: node.layoutNoteRelation }),
        ...(node.layoutOrbitIndex === undefined ? {} : { orbitIndex: node.layoutOrbitIndex }),
        ...(node.layoutOrbitCount === undefined ? {} : { orbitCount: node.layoutOrbitCount }),
        ...(position === undefined ? {} : { x: position.x, y: position.y }),
        ...(snapshot.restoredPositionIds?.has(node.id) === true ? { restored: true } : {})
      };
    }),
    links: snapshot.edges.map((edge) => ({
      id: edge.id,
      sourceId: edge.sourceId,
      targetId: edge.targetId,
      kind: edge.kind
    }))
  };
}
