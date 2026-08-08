import type {
  ConversationFile,
  DepositContentSelection,
  DepositGraphPosition,
  DepositGraphState
} from "../domain/types";
import type { RelationshipGraphEdge, RelationshipGraphModel } from "./types";

export const DEFAULT_RELATIONSHIP_CONTENT: DepositContentSelection = Object.freeze({
  question: true,
  answer: true,
  selection: true,
  sourceLinks: true,
  relatedLinks: true,
  attachments: true
});

export function emptyRelationshipGraphState(): DepositGraphState {
  return {
    protocol: "deposit-graph:v1",
    nodeStates: {},
    edgeOverrides: {},
    nodePositions: {}
  };
}

function cloneState(state: DepositGraphState | undefined): DepositGraphState {
  return state === undefined ? emptyRelationshipGraphState() : structuredClone(state);
}

export function relationshipContentSelectionForNode(
  state: DepositGraphState | undefined,
  nodeId: string
): DepositContentSelection {
  return {
    ...DEFAULT_RELATIONSHIP_CONTENT,
    ...(state?.nodeStates[nodeId]?.content ?? {})
  };
}

export function isRelationshipNodeIncluded(
  state: DepositGraphState | undefined,
  nodeId: string
): boolean {
  return state?.nodeStates[nodeId]?.included ?? true;
}

function writeNodeIncluded(state: DepositGraphState, nodeId: string, included: boolean): void {
  state.nodeStates[nodeId] = {
    included,
    content: relationshipContentSelectionForNode(state, nodeId)
  };
}

export function setRelationshipNodeIncluded(
  conversation: ConversationFile,
  current: DepositGraphState | undefined,
  nodeId: string,
  included: boolean
): DepositGraphState {
  const state = cloneState(current);
  if (conversation.nodes[nodeId] === undefined) return state;
  writeNodeIncluded(state, nodeId, included);
  if (!included) {
    const visit = (parentId: string): void => {
      for (const childId of conversation.nodes[parentId]?.childIds ?? []) {
        writeNodeIncluded(state, childId, false);
        visit(childId);
      }
    };
    visit(nodeId);
  }
  return state;
}

/** Toggle a persisted graph node by its stable graph ID (including note nodes). */
export function setRelationshipGraphNodeIncluded(
  current: DepositGraphState | undefined,
  graphNodeId: string,
  included: boolean
): DepositGraphState {
  const state = cloneState(current);
  writeNodeIncluded(state, graphNodeId, included);
  return state;
}

export function setRelationshipEdgeOverride(
  current: DepositGraphState | undefined,
  edgeId: string,
  included: boolean
): DepositGraphState {
  const state = cloneState(current);
  state.edgeOverrides[edgeId] = { included };
  return state;
}

export function clearRelationshipEdgeOverride(
  current: DepositGraphState | undefined,
  edgeId: string
): DepositGraphState {
  const state = cloneState(current);
  Reflect.deleteProperty(state.edgeOverrides, edgeId);
  return state;
}

export function setRelationshipNodePosition(
  current: DepositGraphState | undefined,
  graphNodeId: string,
  position: DepositGraphPosition
): DepositGraphState {
  const state = cloneState(current);
  state.nodePositions[graphNodeId] = { ...position };
  return state;
}

export function setRelationshipNodePositions(
  current: DepositGraphState | undefined,
  positions: Record<string, DepositGraphPosition>
): DepositGraphState {
  const state = cloneState(current);
  for (const [graphNodeId, position] of Object.entries(positions)) {
    state.nodePositions[graphNodeId] = { ...position };
  }
  return state;
}

export function isRelationshipEdgeIncluded(
  state: DepositGraphState | undefined,
  graph: RelationshipGraphModel,
  edge: RelationshipGraphEdge
): boolean {
  const source = graph.nodes.find((node) => node.id === edge.sourceId);
  const target = graph.nodes.find((node) => node.id === edge.targetId);
  if (source !== undefined && !isRelationshipNodeIncluded(state, source.kind === "conversation" ? source.conversationNodeId ?? "" : source.id)) {
    return false;
  }
  if (target !== undefined && !isRelationshipNodeIncluded(state, target.kind === "conversation" ? target.conversationNodeId ?? "" : target.id)) {
    return false;
  }
  return state?.edgeOverrides[edge.id]?.included ?? true;
}
