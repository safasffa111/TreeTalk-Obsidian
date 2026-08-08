import type {
  DepositGraphPosition,
  DepositGraphState
} from "../domain/types";

export type RelationshipGraphNodeKind = "conversation" | "note";
export type RelationshipGraphEdgeKind =
  | "parent-child"
  | "source-note"
  | "related-note";

export interface RelationshipGraphNode {
  id: string;
  kind: RelationshipGraphNodeKind;
  layoutOrder?: number;
  layoutParentId?: string;
  layoutRoot?: boolean;
  layoutHostId?: string;
  layoutNoteRelation?: Exclude<RelationshipGraphEdgeKind, "parent-child">;
  layoutOrbitIndex?: number;
  layoutOrbitCount?: number;
  title: string;
  label: string;
  degree: number;
  included: boolean;
  conversationNodeId?: string;
  filePath?: string;
  fileName?: string;
}

export interface RelationshipGraphEdge {
  id: string;
  sourceId: string;
  targetId: string;
  kind: RelationshipGraphEdgeKind;
  included: boolean;
  conversationNodeId: string;
  notePath?: string;
}

export interface RelationshipGraphModel {
  conversationId: string;
  nodes: RelationshipGraphNode[];
  edges: RelationshipGraphEdge[];
}

export interface RelationshipGraphProjection {
  graph: RelationshipGraphModel;
  includedNodeIds: Set<string>;
  enabledParentEdges: Set<string>;
  enabledNoteEdges: Set<string>;
}

export interface RelationshipGraphSnapshot {
  sessionId: string;
  topologySignature?: string;
  nodes: RelationshipGraphNode[];
  edges: RelationshipGraphEdge[];
  positions: Record<string, DepositGraphPosition>;
  restoredPositionIds?: Set<string>;
  state?: DepositGraphState;
}

export interface RelationshipGraphWorkerFrame {
  sessionId: string;
  revision: number;
  sequence?: number;
  receivedAt?: number;
  values?: Float32Array;
  positions: Record<string, DepositGraphPosition>;
  active: boolean;
}
