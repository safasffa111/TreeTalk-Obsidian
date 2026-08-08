import { estimateTextTokens } from "../../../domain/context-engine";
import type { ExecutionRequest, PiFocusAnchor, PiResponseTarget } from "../../../execution/types";
import { sha256Hex } from "../cache-identity";
import { renderConversationNodeTranscript } from "../context-index";
import type { PiContextWorkspace } from "../context-workspace";
import { rankExternalEvidenceCandidates } from "./external-evidence-ranker";
import {
  extractLocalMarkdownWindow,
  locateMarkdownContainingSection,
  locateQuoteOffset,
  splitMarkdownIntoLogicalSections,
  type LocatedMarkdownSection
} from "./section-locator";
import {
  availableContextTargets,
  targetForLevel,
  type ContextTarget,
  type ContextTargetAvailability
} from "./semantic-context";
import {
  createReverseTokenWindows,
  createStructuralParentDigest,
  resolveStructuralParentSource,
  type StructuralParentSource
} from "./structural-parent-context";
import {
  buildProgressiveContextInventory,
  formatProvenanceList
} from "./progressive-prompts";
import type {
  ProgressiveContextLevel,
  ProgressiveContextState,
  ProgressiveEvidenceBatch,
  ProgressiveExpansionResult,
  ProgressiveContextSnapshot
} from "./types";
import {
  recordExpandedProgressiveBatch,
  disableProgressiveExpansion,
  markProgressiveLevelExhausted
} from "./context-state";

const L1_MAX_TOKENS = 1_200;
const L2_MAX_TOKENS = 1_800;
const L3_MAX_TOKENS = 1_800;
const L4_MAX_TOKENS = 2_400;

function clipToTokens(
  content: string,
  maximumTokens: number
): { text: string; truncated: boolean; consumedChars: number } {
  if (estimateTextTokens(content) <= maximumTokens) {
    return { text: content.trim(), truncated: false, consumedChars: content.length };
  }
  let low = 0;
  let high = content.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTextTokens(content.slice(0, middle)) <= maximumTokens) low = middle;
    else high = middle - 1;
  }
  let consumedChars = Math.max(1, low);
  const minimumBoundary = Math.max(1, Math.floor(consumedChars * 0.75));
  for (let index = consumedChars - 1; index >= minimumBoundary; index -= 1) {
    if (/[。！？；，、,.!?;:\n\s]/u.test(content[index] ?? "")) {
      consumedChars = index + 1;
      break;
    }
  }
  return {
    text: `${content.slice(0, consumedChars).trim()}\n\n…（本批次已截断，可继续扩展）`,
    truncated: true,
    consumedChars
  };
}

function batchId(input: {
  level: ProgressiveContextLevel;
  sourceId: string;
  revision: string;
  label: string;
  start?: number;
  end?: number;
}): string {
  return sha256Hex([
    `L${String(input.level)}`,
    input.sourceId,
    input.revision,
    input.label,
    String(input.start ?? 0),
    String(input.end ?? 0)
  ].join("\n"));
}

function exactTarget(request: ExecutionRequest): Extract<PiResponseTarget, { kind: "exact-selection" }> | undefined {
  return (request.piContext?.focus?.targets ?? []).find(
    (target): target is Extract<PiResponseTarget, { kind: "exact-selection" }> =>
      target.kind === "exact-selection"
  );
}

function exactTargetText(request: ExecutionRequest): string | undefined {
  return exactTarget(request)?.text;
}

function queryTargetText(request: ExecutionRequest): string {
  return exactTargetText(request) ??
    request.piContext?.selectedQuotes?.find((entry) => entry.trim().length > 0) ??
    request.currentQuestion ??
    request.piContext?.currentQuestion ??
    "";
}

function anchorForExactTarget(request: ExecutionRequest): PiFocusAnchor | undefined {
  const target = exactTarget(request);
  if (target === undefined) return undefined;
  const anchors = request.piContext?.focus?.anchors ?? [];
  return anchors.find((anchor) => (anchor.id ?? "") === target.anchorId);
}

function paragraphChunks(content: string, maxTokens: number): string[] {
  if (estimateTextTokens(content) <= maxTokens) return [content.trim()].filter(Boolean);
  const paragraphs = content.split(/\n\s*\n/u).map((part) => part.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    const proposed = current.length === 0 ? paragraph : `${current}\n\n${paragraph}`;
    if (estimateTextTokens(proposed) <= maxTokens) {
      current = proposed;
      continue;
    }
    if (current.length > 0) chunks.push(current);
    if (estimateTextTokens(paragraph) <= maxTokens) current = paragraph;
    else {
      let remaining = paragraph;
      while (remaining.length > 0) {
        const clipped = clipToTokens(remaining, maxTokens);
        chunks.push(clipped.text.replace(/\n\n…（本批次已截断，可继续扩展）$/u, ""));
        remaining = remaining.slice(clipped.consumedChars).trim();
        if (!clipped.truncated) break;
      }
      current = "";
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

type TargetSource = {
  kind: "note" | "node";
  id: string;
  title: string;
  content: string;
  revision: string;
  notePaths: string[];
  nodeIds: string[];
};

export class ProgressiveContextBatchPlanner {
  private readonly snapshot: ProgressiveContextSnapshot;
  private readonly target: Extract<PiResponseTarget, { kind: "exact-selection" }> | undefined;
  private readonly targetAnchor: PiFocusAnchor | undefined;
  private readonly targetSource: TargetSource | undefined;
  private readonly structuralParent: StructuralParentSource | undefined;
  private readonly targetSection: LocatedMarkdownSection | undefined;
  private readonly inventories = new Map<ProgressiveContextLevel, ProgressiveEvidenceBatch[]>();

  constructor(
    private readonly request: ExecutionRequest,
    private readonly workspace: PiContextWorkspace
  ) {
    this.target = exactTarget(request);
    this.targetAnchor = anchorForExactTarget(request);
    this.snapshot = workspace.progressiveSnapshot();
    this.targetSource = this.resolveExactTargetSource();
    this.structuralParent = this.target === undefined
      ? resolveStructuralParentSource(request, this.snapshot)
      : undefined;
    this.targetSection = this.resolveTargetSection();
  }

  hasExactSelection(): boolean {
    return this.target !== undefined;
  }

  /**
   * Compact navigational inventory of the frozen context, used by the initial
   * user message so the model knows which sources request_context may return.
   */
  inventoryText(): string | undefined {
    return buildProgressiveContextInventory(this.snapshot);
  }

  private sourceRevision(sourceId: string, content: string): string {
    return sha256Hex(`${sourceId}\n${content}`);
  }

  private resolveExactTargetSource(): TargetSource | undefined {
    const target = this.target;
    const source = target?.source;
    if (source?.type === "note") {
      const note = this.workspace.resolveNotePath(source.filePath);
      return {
        kind: "note",
        id: note.id,
        title: note.fileName,
        content: note.content,
        revision: this.sourceRevision(note.filePath, note.content),
        notePaths: [note.filePath],
        nodeIds: []
      };
    }
    if (source?.type === "conversation-message") {
      const node = this.workspace.resolveConversationNode(source.nodeId);
      const message = node.messages.find((entry) => entry.id === source.messageId);
      const content = message?.content ?? renderConversationNodeTranscript(node);
      return {
        kind: "node",
        id: node.id,
        title: node.title,
        content,
        revision: this.sourceRevision(`${node.id}:${source.messageId}`, content),
        notePaths: [],
        nodeIds: [node.id]
      };
    }
    if (this.targetAnchor?.kind === "note-selection") {
      const note = this.workspace.resolveNotePath(this.targetAnchor.filePath);
      return {
        kind: "note",
        id: note.id,
        title: note.fileName,
        content: note.content,
        revision: this.sourceRevision(note.filePath, note.content),
        notePaths: [note.filePath],
        nodeIds: []
      };
    }
    return undefined;
  }

  private resolveTargetSection(): LocatedMarkdownSection | undefined {
    const source = this.targetSource;
    const anchor = this.targetAnchor;
    if (source === undefined || anchor === undefined || anchor.kind === "conversation-round") return undefined;
    const offset = locateQuoteOffset(source.content, {
      quote: anchor.quote,
      prefix: anchor.prefix,
      suffix: anchor.suffix,
      ...(anchor.kind === "note-selection"
        ? {
            selectionStartOffset: anchor.selectionStartOffset,
            selectionEndOffset: anchor.selectionEndOffset
          }
        : {})
    });
    return offset === undefined ? undefined : locateMarkdownContainingSection(source.content, offset);
  }

  private buildExactSelectionL0(): ProgressiveEvidenceBatch[] {
    const text = exactTargetText(this.request);
    if (text === undefined) return [];
    const source = this.targetSource;
    const content = [
      "# Primary Response Target",
      `- Exact target: ${text}`,
      "- 后续上下文只能补充该目标，不能替换目标。"
    ].join("\n");
    return [{
      id: batchId({
        level: 0,
        sourceId: source?.id ?? "request",
        revision: source?.revision ?? "request",
        label: text
      }),
      level: 0,
      sourceKind: "selection",
      sourceId: source?.id ?? "request",
      sourceRevision: source?.revision ?? "request",
      title: text,
      relationship: "primary-target",
      content,
      estimatedTokens: estimateTextTokens(content),
      truncated: false,
      hasMoreFromSource: source !== undefined,
      relatedNote: false,
      notePaths: source?.notePaths ?? [],
      nodeIds: source?.nodeIds ?? []
    }];
  }

  private buildCurrentSectionL1(): ProgressiveEvidenceBatch[] {
    const source = this.targetSource;
    const anchor = this.targetAnchor;
    if (source === undefined || anchor === undefined || anchor.kind === "conversation-round") return [];
    const section = this.targetSection;
    const raw = section?.content ?? extractLocalMarkdownWindow(source.content, L1_MAX_TOKENS, {
      quote: anchor.quote,
      prefix: anchor.prefix,
      suffix: anchor.suffix,
      ...(anchor.kind === "note-selection"
        ? {
            selectionStartOffset: anchor.selectionStartOffset,
            selectionEndOffset: anchor.selectionEndOffset
          }
        : {})
    });
    if (raw.trim().length === 0) return [];
    const clipped = clipToTokens(raw, L1_MAX_TOKENS);
    const label = section?.heading ?? "局部窗口";
    return [{
      id: batchId({
        level: 1,
        sourceId: source.id,
        revision: source.revision,
        label,
        ...(section === undefined ? {} : { start: section.lineStart, end: section.endOffset })
      }),
      level: 1,
      sourceKind: "section",
      sourceId: source.id,
      sourceRevision: source.revision,
      title: `${source.title} · ${label}`,
      relationship: "target-containing-section",
      content: clipped.text,
      estimatedTokens: estimateTextTokens(clipped.text),
      truncated: clipped.truncated,
      hasMoreFromSource: true,
      relatedNote: false,
      notePaths: source.notePaths,
      nodeIds: source.nodeIds,
      requestedTarget: "current_section"
    }];
  }

  private buildExactSourceL2(): ProgressiveEvidenceBatch[] {
    const source = this.targetSource;
    if (source === undefined) return [];
    const question = `${queryTargetText(this.request)} ${this.request.currentQuestion ?? this.request.piContext?.currentQuestion ?? ""}`.toLowerCase();
    const sections = splitMarkdownIntoLogicalSections(source.content)
      .flatMap((section, index) => {
        const isTargetSection =
          this.targetSection !== undefined &&
          section.lineStart === this.targetSection.lineStart &&
          section.endOffset === this.targetSection.endOffset;
        if (isTargetSection) {
          const delivered = clipToTokens(section.content, L1_MAX_TOKENS);
          if (!delivered.truncated) return [];
          const remainder = section.content.slice(delivered.consumedChars).trim();
          if (remainder.length === 0) return [];
          return [{
            section: {
              ...section,
              heading: `${section.heading}（续）`,
              content: remainder,
              contentStart: section.contentStart + delivered.consumedChars,
              lineStart: section.lineStart + delivered.consumedChars
            },
            index,
            score: 1_000
          }];
        }
        return [{
          section,
          index,
          score:
            (question.includes(section.heading.toLowerCase()) ? 100 : 0) +
            (/(定义|基础|前提)/u.test(section.heading) ? 35 : 0) +
            (/(结论|总结)/u.test(section.heading) ? 25 : 0)
        }];
      })
      .sort((a, b) => b.score - a.score || a.index - b.index);
    const batches: ProgressiveEvidenceBatch[] = [];
    for (const { section } of sections) {
      const chunks = paragraphChunks(section.content, L2_MAX_TOKENS);
      for (const [chunkIndex, chunk] of chunks.entries()) {
        batches.push({
          id: batchId({
            level: 2,
            sourceId: source.id,
            revision: source.revision,
            label: `${section.heading}:${String(chunkIndex)}`,
            start: section.lineStart,
            end: section.endOffset
          }),
          level: 2,
          sourceKind: source.kind === "note" ? "note" : "conversation-node",
          sourceId: source.id,
          sourceRevision: source.revision,
          title: `${source.title} · ${section.heading}${chunks.length > 1 ? ` · ${String(chunkIndex + 1)}` : ""}`,
          relationship: "target-full-source",
          content: chunk,
          estimatedTokens: estimateTextTokens(chunk),
          truncated: chunks.length > 1,
          hasMoreFromSource: chunkIndex < chunks.length - 1,
          relatedNote: false,
          notePaths: source.notePaths,
          nodeIds: source.nodeIds,
          requestedTarget: "current_source"
        });
      }
    }
    return batches;
  }

  private buildStructuralParentL2(): ProgressiveEvidenceBatch[] {
    const source = this.structuralParent;
    if (source === undefined) return [];
    const windows = createReverseTokenWindows(source.content);
    const digest = createStructuralParentDigest(source.content);
    const batches: ProgressiveEvidenceBatch[] = [{
      id: batchId({
        level: 2,
        sourceId: `${source.nodeId}:${source.messageId}`,
        revision: source.revision,
        label: "digest"
      }),
      level: 2,
      sourceKind: "conversation-node",
      sourceId: source.nodeId,
      sourceRevision: source.revision,
      title: "父回答 · 结论与结尾",
      relationship: "structural-parent-digest",
      content: digest.content,
      estimatedTokens: estimateTextTokens(digest.content),
      truncated: digest.truncated,
      hasMoreFromSource: windows.length > 1,
      relatedNote: false,
      notePaths: [],
      nodeIds: [source.nodeId],
      requestedTarget: "current_source"
    }];
    for (let index = 1; index < windows.length; index += 1) {
      const window = windows[index];
      if (window === undefined) continue;
      batches.push({
        id: batchId({
          level: 2,
          sourceId: `${source.nodeId}:${source.messageId}`,
          revision: source.revision,
          label: `earlier:${String(index)}`,
          start: window.startOffset,
          end: window.endOffset
        }),
        level: 2,
        sourceKind: "conversation-node",
        sourceId: source.nodeId,
        sourceRevision: source.revision,
        title: `父回答 · 更早内容 ${String(index)}`,
        relationship: "structural-parent-earlier",
        content: window.content,
        estimatedTokens: estimateTextTokens(window.content),
        truncated: window.hasEarlierContent,
        hasMoreFromSource: window.hasEarlierContent,
        relatedNote: false,
        notePaths: [],
        nodeIds: [source.nodeId],
        requestedTarget: "current_source"
      });
    }
    return batches;
  }

  isStructuralContinue(): boolean {
    return this.structuralParent !== undefined;
  }

  /**
   * Compact list of the sources the parent answer actually delivered, so a
   * follow-up can re-anchor on the same sections instead of re-deriving them.
   */
  continueProvenanceText(): string | undefined {
    const source = this.structuralParent;
    if (source === undefined) return undefined;
    const node = this.snapshot.conversationNodes.find(
      (entry) => entry.id === source.nodeId
    );
    const message = node?.messages.find((entry) => entry.id === source.messageId);
    if (message?.provenance === undefined || message.provenance.length === 0) {
      return undefined;
    }
    return formatProvenanceList(message.provenance);
  }

  private buildExternal(level: 3 | 4): ProgressiveEvidenceBatch[] {
    const ranked = rankExternalEvidenceCandidates({
      question: this.request.currentQuestion ?? this.request.piContext?.currentQuestion ?? "",
      targetText: queryTargetText(this.request),
      relatedNotesAllowed: this.request.piContext?.relatedNotesAllowed ?? false,
      snapshot: this.snapshot
    }).filter((candidate) => candidate.level === level);
    const maximum = level === 3 ? L3_MAX_TOKENS : L4_MAX_TOKENS;
    const target: ContextTarget = level === 3 ? "related_sections" : "related_full_source";
    return ranked.flatMap((candidate) => {
      const chunks = paragraphChunks(candidate.content, maximum);
      return chunks.map((chunk, index) => ({
        id: batchId({
          level,
          sourceId: candidate.sourceId,
          revision: candidate.sourceRevision,
          label: `${candidate.key}:${String(index)}`
        }),
        level,
        sourceKind: candidate.sourceKind,
        sourceId: candidate.sourceId,
        sourceRevision: candidate.sourceRevision,
        title: `${candidate.title}${index > 0 ? ` · ${String(index + 1)}` : ""}`,
        relationship: candidate.relationship,
        content: chunk,
        estimatedTokens: estimateTextTokens(chunk),
        truncated: chunks.length > 1,
        hasMoreFromSource: index < chunks.length - 1,
        relatedNote: candidate.relatedNote,
        notePaths: candidate.notePaths,
        nodeIds: candidate.nodeIds,
        requestedTarget: target
      }));
    });
  }

  private buildRequestOnlyFallback(): ProgressiveEvidenceBatch {
    const content = "未找到可用的结构父文本或外部上下文。";
    return {
      id: batchId({ level: 2, sourceId: "request", revision: "request", label: "request-only" }),
      level: 2,
      sourceKind: "conversation-node",
      sourceId: "request",
      sourceRevision: "request",
      title: "当前任务",
      relationship: "request-only",
      content,
      estimatedTokens: estimateTextTokens(content),
      truncated: false,
      hasMoreFromSource: false,
      relatedNote: false,
      notePaths: [],
      nodeIds: []
    };
  }

  private inventory(level: ProgressiveContextLevel): ProgressiveEvidenceBatch[] {
    const cached = this.inventories.get(level);
    if (cached !== undefined) return cached;
    const value = level === 0
      ? this.buildExactSelectionL0()
      : level === 1
        ? this.buildCurrentSectionL1()
        : level === 2
          ? (this.hasExactSelection() ? this.buildExactSourceL2() : this.buildStructuralParentL2())
          : this.buildExternal(level);
    this.inventories.set(level, value);
    return value;
  }

  inventoryForTarget(target: ContextTarget): ProgressiveEvidenceBatch[] {
    if (target === "current_section") return this.inventory(1);
    if (target === "current_source") return this.inventory(2);
    if (target === "related_sections") return this.inventory(3);
    return this.inventory(4);
  }

  buildInitialEvidence(state: ProgressiveContextState): ProgressiveEvidenceBatch {
    for (let rawLevel = state.initialLevel; rawLevel <= 4; rawLevel += 1) {
      const level = rawLevel as ProgressiveContextLevel;
      const first = this.inventory(level).find(
        (batch) =>
          (!batch.relatedNote || state.relatedNotesAllowed) &&
          batch.estimatedTokens <= state.maximumEvidenceTokens
      );
      if (first !== undefined) return first;
    }
    if (this.hasExactSelection()) return this.inventory(0)[0] ?? this.buildRequestOnlyFallback();
    return this.buildRequestOnlyFallback();
  }

  private undeliveredForTarget(
    state: ProgressiveContextState,
    target: ContextTarget
  ): ProgressiveEvidenceBatch | undefined {
    return this.inventoryForTarget(target).find(
      (batch) =>
        !state.deliveredEvidenceIds.includes(batch.id) &&
        (!batch.relatedNote || state.relatedNotesAllowed) &&
        state.deliveredTokens + batch.estimatedTokens <= state.maximumEvidenceTokens
    );
  }

  availableTargets(
    state: ProgressiveContextState,
    divergenceEnabled: boolean
  ): ContextTargetAvailability[] {
    const availableLevels = new Set<1 | 2 | 3 | 4>();
    for (const level of [1, 2, 3, 4] as const) {
      const target = targetForLevel(level);
      if (target !== undefined && this.undeliveredForTarget(state, target) !== undefined) {
        availableLevels.add(level);
      }
    }
    return availableContextTargets({
      state,
      exactSelection: this.hasExactSelection(),
      divergenceEnabled,
      availableLevels
    });
  }

  requestTarget(
    state: ProgressiveContextState,
    target: ContextTarget,
    reason: string
  ): ProgressiveExpansionResult {
    if (state.expansionDisabled) {
      return { state, status: "limit", message: "上下文扩展已达到限制" };
    }
    const level = target === "current_section" ? 1 : target === "current_source" ? 2 : target === "related_sections" ? 3 : 4;
    if (level < state.currentLevel) {
      return { state, status: "error", message: "Progressive context cannot move to a lower level" };
    }
    try {
      const batch = this.undeliveredForTarget(state, target);
      if (batch === undefined) {
        const exhausted = markProgressiveLevelExhausted(state, level);
        return { state: exhausted, status: "exhausted", message: `${target} context is exhausted` };
      }
      const nextState = recordExpandedProgressiveBatch(state, {
        ...batch,
        requestedTarget: target
      });
      return {
        state: nextState,
        batch: { ...batch, requestedTarget: target },
        status: "expanded",
        message: reason
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/budget|limit/u.test(message)) {
        return { state: disableProgressiveExpansion(state), status: "limit", message };
      }
      return { state, status: "error", message };
    }
  }

  private findNextBatch(state: ProgressiveContextState): {
    batch?: ProgressiveEvidenceBatch;
    exhaustedLevels: ProgressiveContextLevel[];
  } {
    const exhaustedLevels: ProgressiveContextLevel[] = [];
    for (let rawLevel = state.currentLevel; rawLevel <= 4; rawLevel += 1) {
      const level = rawLevel as ProgressiveContextLevel;
      const undelivered = this.inventory(level).find(
        (batch) =>
          !state.deliveredEvidenceIds.includes(batch.id) &&
          (!batch.relatedNote || state.relatedNotesAllowed) &&
          state.deliveredTokens + batch.estimatedTokens <= state.maximumEvidenceTokens
      );
      if (undelivered !== undefined) return { batch: undelivered, exhaustedLevels };
      exhaustedLevels.push(level);
    }
    return { exhaustedLevels };
  }

  nextBatch(state: ProgressiveContextState): ProgressiveEvidenceBatch {
    const { batch } = this.findNextBatch(state);
    if (batch !== undefined) return batch;
    throw new Error("Progressive context is exhausted");
  }

  expand(state: ProgressiveContextState, reason: string): ProgressiveExpansionResult {
    if (state.expansionDisabled) {
      return { state, status: "limit", message: "上下文扩展已达到限制" };
    }
    try {
      const result = this.findNextBatch(state);
      let preparedState = state;
      for (const level of result.exhaustedLevels) {
        preparedState = markProgressiveLevelExhausted(preparedState, level);
      }
      if (result.batch === undefined) {
        return {
          state: disableProgressiveExpansion(preparedState),
          status: "exhausted",
          message: "Progressive context is exhausted"
        };
      }
      const nextState = recordExpandedProgressiveBatch(preparedState, result.batch);
      return { state: nextState, batch: result.batch, status: "expanded", message: reason };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/budget|limit/u.test(message)) {
        return { state: disableProgressiveExpansion(state), status: "limit", message };
      }
      return { state: disableProgressiveExpansion(state), status: "error", message };
    }
  }
}
