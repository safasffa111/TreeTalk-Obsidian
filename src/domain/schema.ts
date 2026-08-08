import type { AgentRunRecord, AgentRunStatus, AgentStageRecord } from "./agent-run";
import type {
  BalancedContextRequestState,
  BalancedFreezeArtifact,
  ChatMessage,
  ComposerDraft,
  ConversationFile,
  ConversationNode,
  DepositContentSelection,
  DepositGraphPosition,
  DepositGraphState,
  DepositNodeState,
  ConversationUiState,
  NoteContextGraphEdge,
  NoteContextGraphNode,
  NoteContextGraphSnapshot,
  NoteContextTokenBudget,
  NoteSelectionContext,
  NoteSnapshot,
  RelatedNoteDepth,
  UnresolvedNoteLink,
  NodeSummaryRecord,
  NodeTitleSource,
  SelectionAnchor,
  SelectionContext,
  ValidationIssue
} from "./types";
import type { ContextTarget } from "../agent/pi/progressive/semantic-context";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown, label: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as UnknownRecord;
}


function string(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
  return value;
}

function nonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative number`);
  }
  return value;
}

function integer(value: unknown, label: string): number {
  const parsed = nonNegativeNumber(value, label);
  if (!Number.isInteger(parsed)) {
    throw new TypeError(`${label} must be an integer`);
  }
  return parsed;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  return value.map((entry, index) => string(entry, `${label}[${String(index)}]`));
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : string(value, label);
}

function optionalValidStringArray(value: unknown): string[] | undefined {
  if (value === undefined || !Array.isArray(value)) return undefined;
  if (!value.every((entry) => typeof entry === "string")) return undefined;
  return [...value];
}


function parseNodeTitleSource(value: unknown, label: string): NodeTitleSource {
  const source = string(value, label);
  if (source !== "question" && source !== "auto" && source !== "manual") {
    throw new TypeError(`${label} is invalid`);
  }
  return source;
}

function parseNodeSummary(value: unknown, label: string): NodeSummaryRecord {
  const source = record(value, label);
  const protocol = string(source.protocol, `${label}.protocol`);
  if (
    protocol !== "node-summary:v1" &&
    protocol !== "node-summary:v2" &&
    protocol !== "node-summary:v3"
  ) {
    throw new TypeError(`${label}.protocol is invalid`);
  }
  const status = string(source.status, `${label}.status`);
  if (status !== "pending" && status !== "complete" && status !== "failed") {
    throw new TypeError(`${label}.status is invalid`);
  }
  const summary: NodeSummaryRecord = {
    protocol,
    status,
    attemptedAt: string(source.attemptedAt, `${label}.attemptedAt`),
    providerProfileId: string(
      source.providerProfileId,
      `${label}.providerProfileId`
    ),
    modelId: string(source.modelId, `${label}.modelId`)
  };
  const completedAt = optionalString(source.completedAt, `${label}.completedAt`);
  const generatedTitle = optionalString(
    source.generatedTitle,
    `${label}.generatedTitle`
  );
  if (completedAt !== undefined) summary.completedAt = completedAt;
  if (generatedTitle !== undefined && generatedTitle.trim().length > 0) {
    summary.generatedTitle = generatedTitle;
  }
  return summary;
}

function parseSelectionAnchorFromRecord(
  source: UnknownRecord,
  label: string
): SelectionAnchor {
  const sourceRole = optionalString(source.sourceRole, `${label}.sourceRole`);
  if (
    sourceRole !== undefined &&
    sourceRole !== "user" &&
    sourceRole !== "assistant"
  ) {
    throw new TypeError(`${label}.sourceRole is invalid`);
  }
  const basis = optionalString(source.basis, `${label}.basis`);
  if (basis !== undefined && basis !== "rendered-text-v1") {
    throw new TypeError(`${label}.basis is invalid`);
  }
  const anchor: SelectionAnchor = {
    messageId: string(source.messageId, `${label}.messageId`),
    sourceNodeId:
      optionalString(source.sourceNodeId, `${label}.sourceNodeId`) ?? "",
    sourceRole: sourceRole ?? "assistant",
    basis: "rendered-text-v1",
    startOffset: integer(source.startOffset, `${label}.startOffset`),
    endOffset: integer(source.endOffset, `${label}.endOffset`),
    quote: string(source.quote, `${label}.quote`),
    prefix: string(source.prefix, `${label}.prefix`),
    suffix: string(source.suffix, `${label}.suffix`),
    contentHash: string(source.contentHash, `${label}.contentHash`)
  };
  const visibleQuote = optionalString(
    source.visibleQuote,
    `${label}.visibleQuote`
  );
  if (visibleQuote !== undefined) anchor.visibleQuote = visibleQuote;
  return anchor;
}

function parseNoteSnapshot(value: unknown, label: string): NoteSnapshot {
  const source = record(value, label);
  if (string(source.version, `${label}.version`) !== "note-snapshot-v1") {
    throw new TypeError(`${label}.version is invalid`);
  }
  const content = string(source.content, `${label}.content`);
  const selectionStartOffset = integer(
    source.selectionStartOffset,
    `${label}.selectionStartOffset`
  );
  const selectionEndOffset = integer(
    source.selectionEndOffset,
    `${label}.selectionEndOffset`
  );
  if (
    selectionStartOffset > selectionEndOffset ||
    selectionEndOffset > content.length
  ) {
    throw new TypeError(`${label} selection range is invalid`);
  }
  return {
    version: "note-snapshot-v1",
    content,
    contentHash: string(source.contentHash, `${label}.contentHash`),
    selectionStartOffset,
    selectionEndOffset
  };
}

function parseNoteSelectionContextFromRecord(
  source: UnknownRecord,
  label: string
): NoteSelectionContext {
  const basis = string(source.basis, `${label}.basis`);
  if (basis !== "note-source-v1" && basis !== "note-rendered-text-v1") {
    throw new TypeError(`${label}.basis is invalid`);
  }
  const context: NoteSelectionContext = {
    sourceType: "note",
    filePath: string(source.filePath, `${label}.filePath`),
    fileName: string(source.fileName, `${label}.fileName`),
    basis,
    startOffset: integer(source.startOffset, `${label}.startOffset`),
    endOffset: integer(source.endOffset, `${label}.endOffset`),
    quote: string(source.quote, `${label}.quote`),
    prefix: string(source.prefix, `${label}.prefix`),
    suffix: string(source.suffix, `${label}.suffix`),
    contentHash: string(source.contentHash, `${label}.contentHash`)
  };
  if (source.snapshot !== undefined) {
    context.snapshot = parseNoteSnapshot(source.snapshot, `${label}.snapshot`);
  }
  return context;
}

function parseSelectionContext(
  value: unknown,
  label: string
): SelectionContext {
  const source = record(value, label);
  if (source.sourceType === "note") {
    return parseNoteSelectionContextFromRecord(source, label);
  }
  if (source.sourceType !== undefined && source.sourceType !== "message") {
    throw new TypeError(`${label}.sourceType is invalid`);
  }
  return parseSelectionAnchorFromRecord(source, label);
}

function ratio(value: unknown, label: string): number {
  const parsed = nonNegativeNumber(value, label);
  if (parsed > 1) throw new TypeError(`${label} must be at most 1`);
  return parsed;
}

function parseBalancedFreezeArtifact(
  value: unknown,
  label: string
): BalancedFreezeArtifact {
  const source = record(value, label);
  if (string(source.protocol, `${label}.protocol`) !== "balanced:v3") {
    throw new TypeError(`${label}.protocol is invalid`);
  }
  const sourceType = string(source.sourceType, `${label}.sourceType`);
  if (
    sourceType !== "assistant-message" &&
    sourceType !== "note-snapshot" &&
    sourceType !== "recovery-patch"
  ) {
    throw new TypeError(`${label}.sourceType is invalid`);
  }
  const tier = string(source.tier, `${label}.tier`);
  if (tier !== "standard" && tier !== "compact") {
    throw new TypeError(`${label}.tier is invalid`);
  }
  return {
    protocol: "balanced:v3",
    key: string(source.key, `${label}.key`),
    sourceType,
    sourceIdentity: string(source.sourceIdentity, `${label}.sourceIdentity`),
    sourceContentHash: string(
      source.sourceContentHash,
      `${label}.sourceContentHash`
    ),
    protectionHash: string(source.protectionHash, `${label}.protectionHash`),
    tier,
    content: string(source.content, `${label}.content`),
    originalEstimatedTokens: integer(
      source.originalEstimatedTokens,
      `${label}.originalEstimatedTokens`
    ),
    sentEstimatedTokens: integer(
      source.sentEstimatedTokens,
      `${label}.sentEstimatedTokens`
    ),
    deletionRatio: ratio(source.deletionRatio, `${label}.deletionRatio`)
  };
}

function parseBalancedContextState(
  value: unknown,
  label: string
): BalancedContextRequestState {
  const source = record(value, label);
  if (string(source.protocol, `${label}.protocol`) !== "balanced:v3") {
    throw new TypeError(`${label}.protocol is invalid`);
  }
  return {
    protocol: "balanced:v3",
    artifactKeys: stringArray(source.artifactKeys, `${label}.artifactKeys`),
    compactSourceIdentities: stringArray(
      source.compactSourceIdentities,
      `${label}.compactSourceIdentities`
    ),
    recoveryPatchKeys: stringArray(
      source.recoveryPatchKeys,
      `${label}.recoveryPatchKeys`
    )
  };
}


function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`${label} must be a boolean`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = integer(value, label);
  if (parsed < 1) throw new TypeError(`${label} must be positive`);
  return parsed;
}

function parseNoteContextBudget(
  value: unknown,
  label: string
): NoteContextTokenBudget {
  if (value === "minimal" || value === "full") return value;
  return positiveInteger(value, label);
}

function parseRelatedNoteDepth(
  value: unknown,
  label: string
): RelatedNoteDepth {
  if (value === "unlimited") return value;
  return positiveInteger(value, label);
}

function parseNoteContextGraphNode(
  value: unknown,
  label: string
): NoteContextGraphNode {
  const source = record(value, label);
  const node: NoteContextGraphNode = {
    id: string(source.id, `${label}.id`),
    filePath: string(source.filePath, `${label}.filePath`),
    fileName: string(source.fileName, `${label}.fileName`),
    content: string(source.content, `${label}.content`),
    contentHash: string(source.contentHash, `${label}.contentHash`),
    depth: integer(source.depth, `${label}.depth`),
    root: boolean(source.root, `${label}.root`),
    primaryChain: stringArray(source.primaryChain, `${label}.primaryChain`),
    parentIds: stringArray(source.parentIds, `${label}.parentIds`),
    outgoingNodeIds: stringArray(
      source.outgoingNodeIds,
      `${label}.outgoingNodeIds`
    )
  };
  const primaryParentId = optionalString(
    source.primaryParentId,
    `${label}.primaryParentId`
  );
  if (primaryParentId !== undefined) node.primaryParentId = primaryParentId;
  if (node.id.length === 0 || node.filePath.length === 0) {
    throw new TypeError(`${label} identity is invalid`);
  }
  if (node.primaryChain.at(-1) !== node.id) {
    throw new TypeError(`${label}.primaryChain must end at the node`);
  }
  return node;
}

function parseNoteContextGraphEdge(
  value: unknown,
  label: string
): NoteContextGraphEdge {
  const source = record(value, label);
  return {
    sourceNodeId: string(source.sourceNodeId, `${label}.sourceNodeId`),
    targetNodeId: string(source.targetNodeId, `${label}.targetNodeId`),
    labels: stringArray(source.labels, `${label}.labels`)
  };
}

function parseUnresolvedNoteLink(
  value: unknown,
  label: string
): UnresolvedNoteLink {
  const source = record(value, label);
  const reason = string(source.reason, `${label}.reason`);
  if (
    reason !== "unresolved" &&
    reason !== "non-markdown" &&
    reason !== "unreadable"
  ) {
    throw new TypeError(`${label}.reason is invalid`);
  }
  return {
    sourceNodeId: string(source.sourceNodeId, `${label}.sourceNodeId`),
    target: string(source.target, `${label}.target`),
    label: string(source.label, `${label}.label`),
    reason
  };
}

function parseNoteContextGraph(
  value: unknown,
  label: string
): NoteContextGraphSnapshot {
  const source = record(value, label);
  if (
    string(source.protocol, `${label}.protocol`) !== "note-context-graph:v1"
  ) {
    throw new TypeError(`${label}.protocol is invalid`);
  }
  if (!Array.isArray(source.nodes)) {
    throw new TypeError(`${label}.nodes must be an array`);
  }
  if (!Array.isArray(source.edges)) {
    throw new TypeError(`${label}.edges must be an array`);
  }
  if (!Array.isArray(source.unresolvedLinks)) {
    throw new TypeError(`${label}.unresolvedLinks must be an array`);
  }
  const graph: NoteContextGraphSnapshot = {
    protocol: "note-context-graph:v1",
    rootNodeIds: stringArray(source.rootNodeIds, `${label}.rootNodeIds`),
    fullNoteContext: boolean(source.fullNoteContext, `${label}.fullNoteContext`),
    relatedNotesEnabled: boolean(
      source.relatedNotesEnabled,
      `${label}.relatedNotesEnabled`
    ),
    perNoteBudget: parseNoteContextBudget(
      source.perNoteBudget,
      `${label}.perNoteBudget`
    ),
    maxDepth: parseRelatedNoteDepth(source.maxDepth, `${label}.maxDepth`),
    builtAt: string(source.builtAt, `${label}.builtAt`),
    nodes: source.nodes.map((entry, index) =>
      parseNoteContextGraphNode(entry, `${label}.nodes[${String(index)}]`)
    ),
    edges: source.edges.map((entry, index) =>
      parseNoteContextGraphEdge(entry, `${label}.edges[${String(index)}]`)
    ),
    unresolvedLinks: source.unresolvedLinks.map((entry, index) =>
      parseUnresolvedNoteLink(
        entry,
        `${label}.unresolvedLinks[${String(index)}]`
      )
    )
  };
  const nodeIds = new Set<string>();
  for (const node of graph.nodes) {
    if (nodeIds.has(node.id)) throw new TypeError(`${label}.nodes contain duplicate ids`);
    nodeIds.add(node.id);
  }
  const requireNode = (nodeId: string, field: string): void => {
    if (!nodeIds.has(nodeId)) throw new TypeError(`${field} references a missing node`);
  };
  for (const rootNodeId of graph.rootNodeIds) {
    requireNode(rootNodeId, `${label}.rootNodeIds`);
  }
  for (const node of graph.nodes) {
    for (const nodeId of node.primaryChain) requireNode(nodeId, `${label}.nodes.primaryChain`);
    for (const nodeId of node.parentIds) requireNode(nodeId, `${label}.nodes.parentIds`);
    for (const nodeId of node.outgoingNodeIds) requireNode(nodeId, `${label}.nodes.outgoingNodeIds`);
    if (node.primaryParentId !== undefined) {
      requireNode(node.primaryParentId, `${label}.nodes.primaryParentId`);
      if (node.primaryChain.at(-2) !== node.primaryParentId) {
        throw new TypeError(
          `${label}.nodes.primaryParentId must precede the node in primaryChain`
        );
      }
    }
  }
  for (const edge of graph.edges) {
    requireNode(edge.sourceNodeId, `${label}.edges.sourceNodeId`);
    requireNode(edge.targetNodeId, `${label}.edges.targetNodeId`);
  }
  for (const unresolved of graph.unresolvedLinks) {
    requireNode(unresolved.sourceNodeId, `${label}.unresolvedLinks.sourceNodeId`);
  }
  if (graph.fullNoteContext && graph.perNoteBudget !== "full") {
    throw new TypeError(`${label}.perNoteBudget must be full in full-note mode`);
  }
  return graph;
}


function parseAgentRunStatus(value: unknown, label: string): AgentRunStatus {
  const status = string(value, label);
  if (
    status !== "running" &&
    status !== "completed" &&
    status !== "aborted" &&
    status !== "failed"
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return status;
}

function parseAgentStageRecord(
  value: unknown,
  label: string
): AgentStageRecord {
  const source = record(value, label);
  const status = string(source.status, `${label}.status`);
  if (
    status !== "running" &&
    status !== "completed" &&
    status !== "aborted" &&
    status !== "failed"
  ) {
    throw new TypeError(`${label}.status is invalid`);
  }
  const stage: AgentStageRecord = {
    stageId: string(source.stageId, `${label}.stageId`),
    roleId: string(source.roleId, `${label}.roleId`),
    routeId: string(source.routeId, `${label}.routeId`),
    status,
    startedAt: string(source.startedAt, `${label}.startedAt`)
  };
  const finishedAt = optionalString(source.finishedAt, `${label}.finishedAt`);
  if (finishedAt !== undefined) stage.finishedAt = finishedAt;
  if (source.usage !== undefined) {
    stage.usage = parseAgentUsage(source.usage, `${label}.usage`);
  }
  const stablePrefixHash = optionalString(
    source.stablePrefixHash,
    `${label}.stablePrefixHash`
  );
  if (stablePrefixHash !== undefined) stage.stablePrefixHash = stablePrefixHash;
  if (source.stablePrefixEstimatedTokens !== undefined) {
    stage.stablePrefixEstimatedTokens = integer(
      source.stablePrefixEstimatedTokens,
      `${label}.stablePrefixEstimatedTokens`
    );
  }
  if (source.dynamicTailEstimatedTokens !== undefined) {
    stage.dynamicTailEstimatedTokens = integer(
      source.dynamicTailEstimatedTokens,
      `${label}.dynamicTailEstimatedTokens`
    );
  }
  if (source.selectorTokenBreakdown !== undefined) {
    const breakdown = record(
      source.selectorTokenBreakdown,
      `${label}.selectorTokenBreakdown`
    );
    stage.selectorTokenBreakdown = {
      systemPrompt: integer(breakdown.systemPrompt, `${label}.selectorTokenBreakdown.systemPrompt`),
      noteCatalog: integer(breakdown.noteCatalog, `${label}.selectorTokenBreakdown.noteCatalog`),
      conversationBranch: integer(breakdown.conversationBranch, `${label}.selectorTokenBreakdown.conversationBranch`),
      localFocus: integer(breakdown.localFocus, `${label}.selectorTokenBreakdown.localFocus`),
      currentRequest: integer(breakdown.currentRequest, `${label}.selectorTokenBreakdown.currentRequest`),
      outputContract: integer(breakdown.outputContract, `${label}.selectorTokenBreakdown.outputContract`),
      total: integer(breakdown.total, `${label}.selectorTokenBreakdown.total`),
      budget: integer(breakdown.budget, `${label}.selectorTokenBreakdown.budget`),
      detailedNoteCount: integer(breakdown.detailedNoteCount, `${label}.selectorTokenBreakdown.detailedNoteCount`),
      compactNoteCount: integer(breakdown.compactNoteCount, `${label}.selectorTokenBreakdown.compactNoteCount`),
      omittedNoteCount: integer(breakdown.omittedNoteCount, `${label}.selectorTokenBreakdown.omittedNoteCount`)
    };
  }
  return stage;
}

function parseAgentToolExecutionRecord(
  value: unknown,
  label: string
): AgentRunRecord["toolExecutions"][number] {
  const source = record(value, label);
  const status = string(source.status, `${label}.status`);
  if (status !== "running" && status !== "completed" && status !== "failed") {
    throw new TypeError(`${label}.status is invalid`);
  }
  const args = record(source.arguments, `${label}.arguments`);
  if (!Array.isArray(source.notePaths)) {
    throw new TypeError(`${label}.notePaths must be an array`);
  }
  const result: AgentRunRecord["toolExecutions"][number] = {
    toolCallId: string(source.toolCallId, `${label}.toolCallId`),
    toolName: string(source.toolName, `${label}.toolName`),
    status,
    arguments: structuredClone(args),
    notePaths: source.notePaths.map((entry, index) =>
      string(entry, `${label}.notePaths[${String(index)}]`)
    ),
    nodeIds: Array.isArray(source.nodeIds)
      ? source.nodeIds.map((entry, index) =>
          string(entry, `${label}.nodeIds[${String(index)}]`)
        )
      : [],
    startedAt: string(source.startedAt, `${label}.startedAt`)
  };
  const summary = optionalString(source.summary, `${label}.summary`);
  const finishedAt = optionalString(source.finishedAt, `${label}.finishedAt`);
  if (summary !== undefined) result.summary = summary;
  if (finishedAt !== undefined) result.finishedAt = finishedAt;
  return result;
}

function parseAgentContextRouting(
  value: unknown,
  label: string
): NonNullable<AgentRunRecord["contextRouting"]> {
  const source = record(value, label);
  const phase = string(source.phase, `${label}.phase`);
  if (phase !== "initial" && phase !== "supplementary") {
    throw new TypeError(`${label}.phase is invalid`);
  }
  if (typeof source.truncated !== "boolean") {
    throw new TypeError(`${label}.truncated must be a boolean`);
  }
  if (typeof source.supplementaryUsed !== "boolean") {
    throw new TypeError(`${label}.supplementaryUsed must be a boolean`);
  }
  const routing: NonNullable<AgentRunRecord["contextRouting"]> = {
    phase,
    selectedNoteCount: integer(source.selectedNoteCount, `${label}.selectedNoteCount`),
    selectedNodeCount: integer(source.selectedNodeCount, `${label}.selectedNodeCount`),
    materializedNotePaths: stringArray(
      source.materializedNotePaths,
      `${label}.materializedNotePaths`
    ),
    materializedNodeIds: stringArray(
      source.materializedNodeIds,
      `${label}.materializedNodeIds`
    ),
    evidenceEstimatedTokens: integer(
      source.evidenceEstimatedTokens,
      `${label}.evidenceEstimatedTokens`
    ),
    evidenceTokenBudget: integer(
      source.evidenceTokenBudget,
      `${label}.evidenceTokenBudget`
    ),
    omittedSourceCount: integer(
      source.omittedSourceCount,
      `${label}.omittedSourceCount`
    ),
    truncated: source.truncated,
    supplementaryUsed: source.supplementaryUsed
  };
  if (source.candidateNoteCount !== undefined) {
    routing.candidateNoteCount = integer(
      source.candidateNoteCount,
      `${label}.candidateNoteCount`
    );
  }
  if (source.candidateNodeCount !== undefined) {
    routing.candidateNodeCount = integer(
      source.candidateNodeCount,
      `${label}.candidateNodeCount`
    );
  }
  return routing;
}

function parseProgressiveLevel(value: unknown, label: string): 0 | 1 | 2 | 3 | 4 {
  const level = integer(value, label);
  if (level < 0 || level > 4) throw new TypeError(`${label} is invalid`);
  return level as 0 | 1 | 2 | 3 | 4;
}

function parseProgressiveSourceKind(
  value: unknown,
  label: string
): "selection" | "section" | "note" | "conversation-node" {
  const kind = string(value, label);
  if (
    kind !== "selection" &&
    kind !== "section" &&
    kind !== "note" &&
    kind !== "conversation-node"
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return kind;
}

function parseContextTarget(
  value: unknown,
  label: string
): ContextTarget {
  const target = string(value, label);
  if (
    target !== "current_section" &&
    target !== "current_source" &&
    target !== "related_sections" &&
    target !== "related_full_source"
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return target;
}

function parseContextMode(
  value: unknown,
  label: string
): "convergent" | "divergent" {
  const mode = string(value, label);
  if (mode !== "convergent" && mode !== "divergent") {
    throw new TypeError(`${label} is invalid`);
  }
  return mode;
}

function parseInitialContextKind(
  value: unknown,
  label: string
): "exact-selection" | "structural-parent-digest" | "structural-parent-tail" | "external-fallback" | "request-only" {
  const kind = string(value, label);
  if (
    kind !== "exact-selection" &&
    kind !== "structural-parent-digest" &&
    kind !== "structural-parent-tail" &&
    kind !== "external-fallback" &&
    kind !== "request-only"
  ) {
    throw new TypeError(`${label} is invalid`);
  }
  return kind;
}

function parseAgentProgressiveContext(
  value: unknown,
  label: string
): NonNullable<AgentRunRecord["progressiveContext"]> {
  const source = record(value, label);
  const rawBatches = source.batches ?? [];
  if (!Array.isArray(rawBatches)) {
    throw new TypeError(`${label}.batches must be an array`);
  }
  const booleanField = (key: "relatedNotesAllowed" | "relatedNotesUsed"): boolean => {
    if (typeof source[key] !== "boolean") {
      throw new TypeError(`${label}.${key} must be a boolean`);
    }
    return source[key];
  };
  const result: NonNullable<AgentRunRecord["progressiveContext"]> = {
    initialLevel: parseProgressiveLevel(source.initialLevel, `${label}.initialLevel`),
    finalLevel: parseProgressiveLevel(source.finalLevel, `${label}.finalLevel`),
    startReason: string(source.startReason, `${label}.startReason`),
    maximumEvidenceTokens: integer(source.maximumEvidenceTokens, `${label}.maximumEvidenceTokens`),
    maximumExpansions: integer(source.maximumExpansions, `${label}.maximumExpansions`),
    deliveredEvidenceTokens: integer(source.deliveredEvidenceTokens, `${label}.deliveredEvidenceTokens`),
    expansionCount: integer(source.expansionCount, `${label}.expansionCount`),
    relatedNotesAllowed: booleanField("relatedNotesAllowed"),
    relatedNotesUsed: booleanField("relatedNotesUsed"),
    batches: rawBatches.map((entry, index) => {
      const batchLabel = `${label}.batches[${String(index)}]`;
      const batch = record(entry, batchLabel);
      return {
        level: parseProgressiveLevel(batch.level, `${batchLabel}.level`),
        evidenceId: string(batch.evidenceId, `${batchLabel}.evidenceId`),
        sourceKind: parseProgressiveSourceKind(batch.sourceKind, `${batchLabel}.sourceKind`),
        sourceId: string(batch.sourceId, `${batchLabel}.sourceId`),
        title: string(batch.title, `${batchLabel}.title`),
        relationship: string(batch.relationship, `${batchLabel}.relationship`),
        estimatedTokens: integer(batch.estimatedTokens, `${batchLabel}.estimatedTokens`),
        notePaths: stringArray(batch.notePaths ?? [], `${batchLabel}.notePaths`),
        nodeIds: stringArray(batch.nodeIds ?? [], `${batchLabel}.nodeIds`),
        expansionReason: string(batch.expansionReason, `${batchLabel}.expansionReason`),
        ...(batch.requestedTarget === undefined
          ? {}
          : { requestedTarget: parseContextTarget(batch.requestedTarget, `${batchLabel}.requestedTarget`) }),
        ...(batch.crossedLevel === undefined
          ? {}
          : { crossedLevel: boolean(batch.crossedLevel, `${batchLabel}.crossedLevel`) })
      };
    })
  };
  if (source.contextMode !== undefined) {
    result.contextMode = parseContextMode(source.contextMode, `${label}.contextMode`);
  }
  if (source.initialContextKind !== undefined) {
    result.initialContextKind = parseInitialContextKind(
      source.initialContextKind,
      `${label}.initialContextKind`
    );
  }
  return result;
}

function parseAgentUsage(
  value: unknown,
  label: string
): NonNullable<AgentRunRecord["usage"]> {
  const source = record(value, label);
  const usage: NonNullable<AgentRunRecord["usage"]> = {
    providerReported: source.providerReported === true
  };
  for (const key of [
    "promptTokens",
    "completionTokens",
    "reasoningTokens",
    "cacheHitTokens",
    "cacheMissTokens"
  ] as const) {
    if (source[key] !== undefined) usage[key] = integer(source[key], `${label}.${key}`);
  }
  return usage;
}

function parseAgentRunRecord(value: unknown, label: string): AgentRunRecord {
  const source = record(value, label);
  if (string(source.protocol, `${label}.protocol`) !== "pi-agent-run:v1") {
    throw new TypeError(`${label}.protocol is invalid`);
  }
  const executionMode = string(source.executionMode, `${label}.executionMode`);
  if (executionMode !== "legacy" && executionMode !== "pi") {
    throw new TypeError(`${label}.executionMode is invalid`);
  }
  if (!Array.isArray(source.stages)) {
    throw new TypeError(`${label}.stages must be an array`);
  }
  if (!Array.isArray(source.sources)) {
    throw new TypeError(`${label}.sources must be an array`);
  }
  if (source.toolExecutions !== undefined && !Array.isArray(source.toolExecutions)) {
    throw new TypeError(`${label}.toolExecutions must be an array`);
  }
  const result: AgentRunRecord = {
    protocol: "pi-agent-run:v1",
    executionMode,
    status: parseAgentRunStatus(source.status, `${label}.status`),
    roleId: string(source.roleId, `${label}.roleId`),
    routeId: string(source.routeId, `${label}.routeId`),
    providerId: string(source.providerId, `${label}.providerId`),
    modelId: string(source.modelId, `${label}.modelId`),
    stages: source.stages.map((entry, index) =>
      parseAgentStageRecord(entry, `${label}.stages[${String(index)}]`)
    ),
    toolExecutions: (source.toolExecutions ?? []).map((entry, index) =>
      parseAgentToolExecutionRecord(
        entry,
        `${label}.toolExecutions[${String(index)}]`
      )
    ),
    sources: source.sources.map((entry, index) => {
      const item = record(entry, `${label}.sources[${String(index)}]`);
      return {
        title: string(item.title, `${label}.sources[${String(index)}].title`),
        url: string(item.url, `${label}.sources[${String(index)}].url`)
      };
    }),
    startedAt: string(source.startedAt, `${label}.startedAt`)
  };
  const runtime = optionalString(source.runtime, `${label}.runtime`);
  if (runtime !== undefined) {
    if (
      runtime !== "pi-agent-core-compatible" &&
      runtime !== "pi-agent-core-v0.82.1-vendored"
    ) {
      throw new TypeError(`${label}.runtime is invalid`);
    }
    result.runtime = runtime;
  }
  if (source.contextRouting !== undefined) {
    result.contextRouting = parseAgentContextRouting(
      source.contextRouting,
      `${label}.contextRouting`
    );
  }
  if (source.progressiveContext !== undefined) {
    result.progressiveContext = parseAgentProgressiveContext(
      source.progressiveContext,
      `${label}.progressiveContext`
    );
  }
  if (source.usage !== undefined) {
    result.usage = parseAgentUsage(source.usage, `${label}.usage`);
  }
  const finishedAt = optionalString(source.finishedAt, `${label}.finishedAt`);
  const errorMessage = optionalString(source.errorMessage, `${label}.errorMessage`);
  if (finishedAt !== undefined) result.finishedAt = finishedAt;
  if (errorMessage !== undefined) result.errorMessage = errorMessage;
  return result;
}

function parseMessage(value: unknown, label: string): ChatMessage {
  const source = record(value, label);
  const role = string(source.role, `${label}.role`);
  const status = string(source.status, `${label}.status`);
  if (role !== "user" && role !== "assistant") {
    throw new TypeError(`${label}.role is invalid`);
  }
  if (!["complete", "streaming", "interrupted", "failed"].includes(status)) {
    throw new TypeError(`${label}.status is invalid`);
  }

  const message: ChatMessage = {
    id: string(source.id, `${label}.id`),
    role,
    content: string(source.content, `${label}.content`),
    status: status as ChatMessage["status"],
    createdAt: string(source.createdAt, `${label}.createdAt`),
    updatedAt: string(source.updatedAt, `${label}.updatedAt`)
  };
  const responseVersionGroupId = optionalString(
    source.responseVersionGroupId,
    `${label}.responseVersionGroupId`
  );
  const providerProfileId = optionalString(source.providerProfileId, `${label}.providerProfileId`);
  const modelId = optionalString(source.modelId, `${label}.modelId`);
  if (responseVersionGroupId !== undefined) message.responseVersionGroupId = responseVersionGroupId;
  if (providerProfileId !== undefined) message.providerProfileId = providerProfileId;
  if (modelId !== undefined) message.modelId = modelId;
  if (source.balancedContextState !== undefined) {
    message.balancedContextState = parseBalancedContextState(
      source.balancedContextState,
      `${label}.balancedContextState`
    );
  }
  if (source.agentRun !== undefined) {
    message.agentRun = parseAgentRunRecord(source.agentRun, `${label}.agentRun`);
  }
  if (source.noteContextGraph !== undefined) {
    message.noteContextGraph = parseNoteContextGraph(
      source.noteContextGraph,
      `${label}.noteContextGraph`
    );
  }
  const referencedNoteNames = optionalValidStringArray(source.referencedNoteNames);
  if (referencedNoteNames !== undefined) {
    message.referencedNoteNames = referencedNoteNames;
  }
  const rawSelectionContexts =
    source.selectionContexts ??
    (source.selectionContext === undefined ? [] : [source.selectionContext]);
  if (!Array.isArray(rawSelectionContexts)) {
    throw new TypeError(`${label}.selectionContexts must be an array`);
  }
  if (rawSelectionContexts.length > 0) {
    message.selectionContexts = rawSelectionContexts.map((entry, index) =>
      parseSelectionContext(
        entry,
        `${label}.selectionContexts[${String(index)}]`
      )
    );
  }
  return message;
}

function parseDraft(value: unknown, label: string): ComposerDraft {
  const source = record(value, label);
  const mode = string(source.mode, `${label}.mode`);
  if (mode !== "continue" && mode !== "child") {
    throw new TypeError(`${label}.mode is invalid`);
  }
  const draft: ComposerDraft = {
    text: string(source.text, `${label}.text`),
    mode,
    selectionContexts: []
  };
  if (
    source.answerThinkingModeOverride === "auto" ||
    source.answerThinkingModeOverride === "disabled" ||
    source.answerThinkingModeOverride === "enabled"
  ) {
    draft.answerThinkingModeOverride = source.answerThinkingModeOverride;
  }
  const selectionModeBeforeCapture = optionalString(
    source.selectionModeBeforeCapture,
    `${label}.selectionModeBeforeCapture`
  );
  if (
    selectionModeBeforeCapture !== undefined &&
    selectionModeBeforeCapture !== "continue" &&
    selectionModeBeforeCapture !== "child"
  ) {
    throw new TypeError(`${label}.selectionModeBeforeCapture is invalid`);
  }
  if (selectionModeBeforeCapture !== undefined) {
    draft.selectionModeBeforeCapture = selectionModeBeforeCapture;
  }
  const rawSelectionContexts =
    source.selectionContexts ??
    (source.selectionContext === undefined ? [] : [source.selectionContext]);
  if (!Array.isArray(rawSelectionContexts)) {
    throw new TypeError(`${label}.selectionContexts must be an array`);
  }
  draft.selectionContexts = rawSelectionContexts.map((entry, index) =>
    parseSelectionContext(
      entry,
      `${label}.selectionContexts[${String(index)}]`
    )
  );
  return draft;
}

function parseNode(value: unknown, label: string): ConversationNode {
  const source = record(value, label);
  const parentId =
    source.parentId === null ? null : string(source.parentId, `${label}.parentId`);
  if (!Array.isArray(source.messages)) {
    throw new TypeError(`${label}.messages must be an array`);
  }
  const node: ConversationNode = {
    id: string(source.id, `${label}.id`),
    parentId,
    childIds: stringArray(source.childIds, `${label}.childIds`),
    title: string(source.title, `${label}.title`),
    messages: source.messages.map((message, index) =>
      parseMessage(message, `${label}.messages[${String(index)}]`)
    ),
    draft: parseDraft(source.draft, `${label}.draft`),
    createdAt: string(source.createdAt, `${label}.createdAt`),
    updatedAt: string(source.updatedAt, `${label}.updatedAt`)
  };
  if (source.titleSource !== undefined) {
    node.titleSource = parseNodeTitleSource(
      source.titleSource,
      `${label}.titleSource`
    );
  }
  if (source.summary !== undefined) {
    node.summary = parseNodeSummary(source.summary, `${label}.summary`);
  }
  return node;
}


function parseDepositContentSelection(
  value: unknown,
  label: string
): DepositContentSelection {
  const source = record(value, label);
  return {
    question: boolean(source.question, `${label}.question`),
    answer: boolean(source.answer, `${label}.answer`),
    selection: boolean(source.selection, `${label}.selection`),
    sourceLinks: boolean(source.sourceLinks, `${label}.sourceLinks`),
    relatedLinks: boolean(source.relatedLinks, `${label}.relatedLinks`),
    attachments: boolean(source.attachments, `${label}.attachments`)
  };
}

function parseDepositNodeState(value: unknown, label: string): DepositNodeState {
  const source = record(value, label);
  return {
    included: boolean(source.included, `${label}.included`),
    content: parseDepositContentSelection(source.content, `${label}.content`)
  };
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
  }
  return value;
}

function parseDepositGraphPosition(
  value: unknown,
  label: string
): DepositGraphPosition {
  const source = record(value, label);
  return {
    x: finiteNumber(source.x, `${label}.x`),
    y: finiteNumber(source.y, `${label}.y`),
    fixed: boolean(source.fixed, `${label}.fixed`)
  };
}

function parseDepositGraphState(value: unknown): DepositGraphState {
  const source = record(value, "depositGraphState");
  if (source.protocol !== "deposit-graph:v1") {
    throw new TypeError("depositGraphState.protocol is invalid");
  }
  const rawNodeStates = record(source.nodeStates, "depositGraphState.nodeStates");
  const nodeStates: Record<string, DepositNodeState> = {};
  for (const [nodeId, rawState] of Object.entries(rawNodeStates)) {
    nodeStates[nodeId] = parseDepositNodeState(
      rawState,
      `depositGraphState.nodeStates.${nodeId}`
    );
  }
  const rawOverrides = record(
    source.edgeOverrides,
    "depositGraphState.edgeOverrides"
  );
  const edgeOverrides: DepositGraphState["edgeOverrides"] = {};
  for (const [edgeId, rawOverride] of Object.entries(rawOverrides)) {
    const override = record(
      rawOverride,
      `depositGraphState.edgeOverrides.${edgeId}`
    );
    edgeOverrides[edgeId] = {
      included: boolean(
        override.included,
        `depositGraphState.edgeOverrides.${edgeId}.included`
      )
    };
  }
  const rawPositions = record(
    source.nodePositions,
    "depositGraphState.nodePositions"
  );
  const nodePositions: Record<string, DepositGraphPosition> = {};
  for (const [nodeId, rawPosition] of Object.entries(rawPositions)) {
    nodePositions[nodeId] = parseDepositGraphPosition(
      rawPosition,
      `depositGraphState.nodePositions.${nodeId}`
    );
  }
  return {
    protocol: "deposit-graph:v1",
    nodeStates,
    edgeOverrides,
    nodePositions
  };
}

function parseUi(value: unknown): ConversationUiState {
  const source = record(value, "ui");
  const scrollRecord = record(source.messageScrollTopByNode, "ui.messageScrollTopByNode");
  const messageScrollTopByNode: Record<string, number> = {};
  for (const [nodeId, scrollTop] of Object.entries(scrollRecord)) {
    messageScrollTopByNode[nodeId] = nonNegativeNumber(
      scrollTop,
      `ui.messageScrollTopByNode.${nodeId}`
    );
  }
  return {
    expandedNodeIds: stringArray(source.expandedNodeIds, "ui.expandedNodeIds"),
    treeScrollTop: nonNegativeNumber(source.treeScrollTop, "ui.treeScrollTop"),
    messageScrollTopByNode
  };
}

export function validateTree(conversation: ConversationFile): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { nodes } = conversation;
  if (!(conversation.rootNodeId in nodes)) {
    issues.push({ code: "missing-root", message: "Root node does not exist" });
    return issues;
  }
  if (!(conversation.currentNodeId in nodes)) {
    issues.push({ code: "missing-current", message: "Current node does not exist" });
  }

  for (const node of Object.values(nodes)) {
    if (new Set(node.childIds).size !== node.childIds.length) {
      issues.push({ code: "duplicate-child", message: "Duplicate child ID", nodeId: node.id });
    }
    for (const childId of node.childIds) {
      const child = nodes[childId];
      if (child === undefined) {
        issues.push({ code: "missing-child", message: "Child node does not exist", nodeId: node.id });
      } else if (child.parentId !== node.id) {
        issues.push({
          code: "parent-mismatch",
          message: "Child parent does not point back to parent",
          nodeId: childId
        });
      }
    }
    if (node.parentId !== null) {
      const parent = nodes[node.parentId];
      if (parent === undefined || !parent.childIds.includes(node.id)) {
        issues.push({
          code: "parent-mismatch",
          message: "Parent does not point back to child",
          nodeId: node.id
        });
      }
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (nodeId: string): void => {
    if (visiting.has(nodeId)) {
      issues.push({ code: "cycle", message: "Tree contains a cycle", nodeId });
      return;
    }
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    for (const childId of nodes[nodeId]?.childIds ?? []) {
      if (nodes[childId] !== undefined) visit(childId);
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  visit(conversation.rootNodeId);

  for (const nodeId of Object.keys(nodes)) {
    if (!visited.has(nodeId)) {
      issues.push({ code: "unreachable", message: "Node is unreachable from root", nodeId });
    }
  }
  return issues;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as UnknownRecord)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

export function parseConversation(value: unknown): ConversationFile {
  const source = record(value, "conversation");
  if (source.schemaVersion !== 1) {
    throw new TypeError("Unsupported schemaVersion");
  }
  const rawNodes = record(source.nodes, "nodes");
  const nodes: Record<string, ConversationNode> = {};
  for (const [nodeId, rawNode] of Object.entries(rawNodes)) {
    const node = parseNode(rawNode, `nodes.${nodeId}`);
    if (node.id !== nodeId) {
      throw new TypeError(`nodes.${nodeId}.id does not match its key`);
    }
    nodes[nodeId] = node;
  }
  const status = string(source.status, "status");
  if (status !== "active" && status !== "archived") {
    throw new TypeError("status is invalid");
  }
  const conversation: ConversationFile = {
    schemaVersion: 1,
    id: string(source.id, "id"),
    title: string(source.title, "title"),
    status,
    revision: integer(source.revision, "revision"),
    checksum: string(source.checksum, "checksum"),
    createdAt: string(source.createdAt, "createdAt"),
    updatedAt: string(source.updatedAt, "updatedAt"),
    rootNodeId: string(source.rootNodeId, "rootNodeId"),
    currentNodeId: string(source.currentNodeId, "currentNodeId"),
    nodes,
    ui: parseUi(source.ui)
  };
  if (source.depositGraphState !== undefined) {
    conversation.depositGraphState = parseDepositGraphState(source.depositGraphState);
  }
  if (source.contextArtifacts !== undefined) {
    const artifactsSource = record(source.contextArtifacts, "contextArtifacts");
    const contextArtifacts: NonNullable<ConversationFile["contextArtifacts"]> = {};
    if (artifactsSource.balancedV3 !== undefined) {
      const balancedSource = record(
        artifactsSource.balancedV3,
        "contextArtifacts.balancedV3"
      );
      const balancedV3: Record<string, BalancedFreezeArtifact> = {};
      for (const [key, value] of Object.entries(balancedSource)) {
        const artifact = parseBalancedFreezeArtifact(
          value,
          `contextArtifacts.balancedV3.${key}`
        );
        if (artifact.key !== key) {
          throw new TypeError(
            `contextArtifacts.balancedV3.${key}.key does not match its key`
          );
        }
        balancedV3[key] = artifact;
      }
      contextArtifacts.balancedV3 = balancedV3;
    }
    conversation.contextArtifacts = contextArtifacts;
  }
  const issues = validateTree(conversation);
  if (issues.length > 0) {
    throw new TypeError(issues.map((issue) => `${issue.code}: ${issue.message}`).join("; "));
  }
  return deepFreeze(conversation);
}
