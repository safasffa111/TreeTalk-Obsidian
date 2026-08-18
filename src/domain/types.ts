import type { AgentRunRecord } from "./agent-run";
import type { AnswerThinkingMode } from "../execution/answer-thinking";

export type ConversationStatus = "active" | "archived";
export type MessageRole = "user" | "assistant";
export type MessageStatus = "complete" | "streaming" | "interrupted" | "failed";
export type DraftMode = "continue" | "child";
export type NodeTitleSource = "question" | "auto" | "manual";

export interface NodeSummaryRecord {
  protocol: "node-summary:v1" | "node-summary:v2" | "node-summary:v3";
  status: "pending" | "complete" | "failed";
  attemptedAt: string;
  completedAt?: string;
  providerProfileId: string;
  modelId: string;
  generatedTitle?: string;
}

export type BalancedFreezeSourceType =
  | "assistant-message"
  | "note-snapshot"
  | "recovery-patch";

export type BalancedFreezeTier = "standard" | "compact";

export interface BalancedFreezeArtifact {
  protocol: "balanced:v3";
  key: string;
  sourceType: BalancedFreezeSourceType;
  sourceIdentity: string;
  sourceContentHash: string;
  protectionHash: string;
  tier: BalancedFreezeTier;
  content: string;
  originalEstimatedTokens: number;
  sentEstimatedTokens: number;
  deletionRatio: number;
}

export interface BalancedContextRequestState {
  protocol: "balanced:v3";
  artifactKeys: string[];
  compactSourceIdentities: string[];
  recoveryPatchKeys: string[];
}

export interface ConversationContextArtifacts {
  balancedV3?: Record<string, BalancedFreezeArtifact>;
}

export interface SelectionAnchor {
  messageId: string;
  sourceNodeId: string;
  sourceRole: MessageRole;
  basis: "rendered-text-v1";
  startOffset: number;
  endOffset: number;
  quote: string;
  visibleQuote?: string;
  prefix: string;
  suffix: string;
  contentHash: string;
}

export interface NoteSnapshot {
  version: "note-snapshot-v1";
  content: string;
  contentHash: string;
  selectionStartOffset: number;
  selectionEndOffset: number;
}

export interface NoteSelectionContext {
  sourceType: "note";
  filePath: string;
  fileName: string;
  basis: "note-source-v1" | "note-rendered-text-v1";
  startOffset: number;
  endOffset: number;
  quote: string;
  prefix: string;
  suffix: string;
  contentHash: string;
  snapshot?: NoteSnapshot;
}

export type SelectionContext = SelectionAnchor | NoteSelectionContext;

export function isNoteSelectionContext(
  context: SelectionContext
): context is NoteSelectionContext {
  return "sourceType" in context;
}

export function isMessageSelectionContext(
  context: SelectionContext
): context is SelectionAnchor {
  return !isNoteSelectionContext(context);
}

export type NoteContextTokenBudget = "minimal" | "full" | number;
export type RelatedNoteDepth = "unlimited" | number;

export interface NoteContextGraphNode {
  id: string;
  filePath: string;
  fileName: string;
  content: string;
  contentHash: string;
  depth: number;
  root: boolean;
  /** First-discovery parent in the context traversal tree, independent of Markdown edge direction. */
  primaryParentId?: string;
  /** First-discovery chain used for depth/order rendering. */
  primaryChain: string[];
  /** Real incoming Markdown-link source node IDs. */
  parentIds: string[];
  /** Real outgoing Markdown-link target node IDs. */
  outgoingNodeIds: string[];
}

export interface NoteContextGraphEdge {
  sourceNodeId: string;
  targetNodeId: string;
  labels: string[];
}

export interface UnresolvedNoteLink {
  sourceNodeId: string;
  target: string;
  label: string;
  reason: "unresolved" | "non-markdown" | "unreadable";
}

export interface NoteContextGraphSnapshot {
  protocol: "note-context-graph:v1";
  rootNodeIds: string[];
  fullNoteContext: boolean;
  relatedNotesEnabled: boolean;
  perNoteBudget: NoteContextTokenBudget;
  maxDepth: RelatedNoteDepth;
  builtAt: string;
  nodes: NoteContextGraphNode[];
  edges: NoteContextGraphEdge[];
  unresolvedLinks: UnresolvedNoteLink[];
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  status: MessageStatus;
  responseVersionGroupId?: string;
  providerProfileId?: string;
  modelId?: string;
  selectionContexts?: SelectionContext[];
  referencedNoteNames?: string[];
  balancedContextState?: BalancedContextRequestState;
  noteContextGraph?: NoteContextGraphSnapshot;
  agentRun?: AgentRunRecord;
  createdAt: string;
  updatedAt: string;
}

export interface ComposerDraft {
  text: string;
  mode: DraftMode;
  selectionContexts: SelectionContext[];
  answerThinkingModeOverride?: AnswerThinkingMode;
  selectionModeBeforeCapture?: DraftMode;
}

export interface ConversationNode {
  id: string;
  parentId: string | null;
  childIds: string[];
  title: string;
  titleSource?: NodeTitleSource;
  summary?: NodeSummaryRecord;
  messages: ChatMessage[];
  draft: ComposerDraft;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationUiState {
  expandedNodeIds: string[];
  treeScrollTop: number;
  messageScrollTopByNode: Record<string, number>;
}


export interface DepositContentSelection {
  question: boolean;
  answer: boolean;
  selection: boolean;
  sourceLinks: boolean;
  relatedLinks: boolean;
  attachments: boolean;
}

export interface DepositNodeState {
  included: boolean;
  content: DepositContentSelection;
}

export interface DepositEdgeOverride {
  included: boolean;
}

export interface DepositGraphPosition {
  x: number;
  y: number;
  fixed: boolean;
}

export interface DepositGraphState {
  protocol: "deposit-graph:v1";
  nodeStates: Record<string, DepositNodeState>;
  edgeOverrides: Record<string, DepositEdgeOverride>;
  nodePositions: Record<string, DepositGraphPosition>;
}

export interface ConversationFile {
  schemaVersion: 1;
  id: string;
  title: string;
  status: ConversationStatus;
  revision: number;
  checksum: string;
  createdAt: string;
  updatedAt: string;
  rootNodeId: string;
  currentNodeId: string;
  nodes: Record<string, ConversationNode>;
  /**
   * 诉求1 + Vault-aware 锚点: 对话锁定时打开的 md 笔记路径 (发送首条消息时记录).
   * 沉淀目录会基于此路径创建 `<笔记名>-tree/` 同级目录.
   * 旧对话仅有此字段 → `legacy-unverified`，不可回退为当前 Vault 归属。
   */
  anchorFilePath?: string;
  /**
   * 已验证锚点的来源 Vault UUID。三个字段 (`anchorVaultId` + `anchorFilePath`
   * + `anchorFileCtime`) 齐全时为 `verified`；否则视为未验证。
   */
  anchorVaultId?: string;
  /**
   * 已验证锚点对应文件的 Vault 内创建时间戳（毫秒，Unix epoch）。
   * 正文修改不改变该值；rename/move 也不应改变该值，除非外部工具重建了文件。
   */
  anchorFileCtime?: number;
  contextArtifacts?: ConversationContextArtifacts;
  depositGraphState?: DepositGraphState;
  ui: ConversationUiState;
}

export interface ValidationIssue {
  code: string;
  message: string;
  nodeId?: string;
}
