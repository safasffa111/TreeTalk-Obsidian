import type { ProviderMessage } from "./context-builder";
import {
  BALANCED_V3_PROTOCOL,
  balancedV3TextHash,
  buildAssistantFreezeArtifact,
  buildNoteFreezeArtifact,
  buildRecoveryPatchArtifact
} from "./balanced-freeze-v3";
import { resolveSelectionInMarkdown } from "./balanced-markdown-compressor";
import type { CharacterRange } from "./balanced-markdown-compressor";
import {
  isMessageSelectionContext,
  isNoteSelectionContext
} from "./types";
import type {
  BalancedContextRequestState,
  BalancedFreezeArtifact,
  ChatMessage,
  ConversationFile,
  ConversationNode,
  NoteContextGraphNode,
  NoteContextGraphSnapshot,
  NoteSelectionContext,
  NoteSnapshot,
  SelectionContext
} from "./types";
import {
  compressRelatedNoteContent,
  estimateNoteTextTokens,
  extractDeterministicNoteKeywords,
  renderNoteSnapshot
} from "./note-snapshot";

export type ContextMode = "balanced" | "full";

export class ProtectedContextTooLongError extends Error {
  constructor() {
    super("受保护上下文过长，无法在不删除用户问题或引用原文的情况下发送");
    this.name = "ProtectedContextTooLongError";
  }
}

export interface ContextEngineOptions {
  mode: ContextMode;
  systemPrompt: string;
  maxInputTokens: number;
  recentRoundTarget?: number;
  minRecentRounds?: number;
  maxRecentRounds?: number;
}

export interface ContextPlanPersistencePatch {
  artifacts: BalancedFreezeArtifact[];
  currentUserMessageId: string;
  requestState: BalancedContextRequestState;
}

export interface ContextPlan {
  mode: ContextMode;
  messages: ProviderMessage[];
  fullEstimatedTokens: number;
  sentEstimatedTokens: number;
  reducedTokens: number;
  reductionRatio: number;
  stablePrefixHash: string;
  trimmed: boolean;
  noteContextOriginalEstimatedTokens: number;
  noteContextSentEstimatedTokens: number;
  noteContextTrimmed: boolean;
  referencedNoteNames: string[];
  persistencePatch?: ContextPlanPersistencePatch;
}

interface PathMessage {
  nodeId: string;
  message: ChatMessage;
  roundIndex: number;
}

type MarkdownBlockKind =
  | "heading"
  | "paragraph"
  | "list"
  | "quote"
  | "table"
  | "code"
  | "math";

interface MarkdownBlock {
  kind: MarkdownBlockKind;
  content: string;
  index: number;
  score: number;
  tokens: number;
}

const OMITTED_CODE_MARKER = "TreeTalk 为控制上下文长度省略了未引用代码";

function requiredNode(
  conversation: ConversationFile,
  nodeId: string
): ConversationNode {
  const node = conversation.nodes[nodeId];
  if (node === undefined) throw new Error(`Node not found: ${nodeId}`);
  return node;
}

export function pathToConversationNode(
  conversation: ConversationFile,
  nodeId: string
): ConversationNode[] {
  const reversed: ConversationNode[] = [];
  const seen = new Set<string>();
  let current: ConversationNode | undefined = requiredNode(conversation, nodeId);
  while (current !== undefined) {
    if (seen.has(current.id)) throw new Error("Conversation path contains a cycle");
    seen.add(current.id);
    reversed.push(current);
    current =
      current.parentId === null
        ? undefined
        : requiredNode(conversation, current.parentId);
  }
  return reversed.reverse();
}

interface NoteSnapshotDescriptor {
  key: string;
  filePath: string;
  fileName: string;
  snapshot: NoteSnapshot;
}

type NoteGraphBodyOverride = "minimal" | "omit";

interface NoteGraphBodyCandidate {
  key: string;
  fullBody: boolean;
  root: boolean;
  depth: number;
  order: number;
}

interface NoteRenderingState {
  descriptors: ReadonlyMap<string, NoteSnapshotDescriptor>;
  seen: Set<string>;
  budgets?: ReadonlyMap<string, number>;
  suppressBackgrounds: boolean;
  graphBodyOverrides?: ReadonlyMap<string, NoteGraphBodyOverride>;
  seenGraphSnapshots: Set<string>;
  originalEstimatedTokens: number;
  sentEstimatedTokens: number;
  trimmed: boolean;
}

interface ProviderBuildResult {
  messages: ProviderMessage[];
  noteContextOriginalEstimatedTokens: number;
  noteContextSentEstimatedTokens: number;
  noteContextTrimmed: boolean;
}

function noteSnapshotKey(context: NoteSelectionContext): string | undefined {
  const snapshot = context.snapshot;
  return snapshot === undefined
    ? undefined
    : `${context.filePath}\u0000${snapshot.contentHash}`;
}

function collectNoteSnapshotDescriptors(
  flattened: PathMessage[]
): Map<string, NoteSnapshotDescriptor> {
  const descriptors = new Map<string, NoteSnapshotDescriptor>();
  for (const entry of flattened) {
    for (const context of entry.message.selectionContexts ?? []) {
      if (!isNoteSelectionContext(context) || context.snapshot === undefined) {
        continue;
      }
      const key = noteSnapshotKey(context);
      if (key === undefined) continue;
      const existing = descriptors.get(key);
      if (existing === undefined) {
        descriptors.set(key, {
          key,
          filePath: context.filePath,
          fileName: context.fileName,
          snapshot: structuredClone(context.snapshot)
        });
        continue;
      }
      existing.snapshot.selectionStartOffset = Math.min(
        existing.snapshot.selectionStartOffset,
        context.snapshot.selectionStartOffset
      );
      existing.snapshot.selectionEndOffset = Math.max(
        existing.snapshot.selectionEndOffset,
        context.snapshot.selectionEndOffset
      );
    }
  }
  return descriptors;
}

function referencedNoteNamesForPath(
  flattened: PathMessage[],
  descriptors: ReadonlyMap<string, NoteSnapshotDescriptor>
): string[] {
  const names: string[] = [];
  const seenPaths = new Set<string>();
  const append = (filePath: string, fallbackName?: string): void => {
    const normalizedPath = filePath.trim();
    if (normalizedPath.length === 0 || seenPaths.has(normalizedPath)) return;
    seenPaths.add(normalizedPath);
    const name = fallbackName?.trim() || normalizedPath.split(/[\\/]/u).at(-1)?.trim();
    if (name !== undefined && name.length > 0) names.push(name);
  };
  for (const descriptor of descriptors.values()) {
    append(descriptor.filePath, descriptor.fileName);
  }
  for (const entry of flattened) {
    for (const node of entry.message.noteContextGraph?.nodes ?? []) {
      append(node.filePath, node.fileName);
    }
  }
  return names;
}

function noteGraphBodyKey(messageId: string, nodeId: string): string {
  return `${messageId}\u0000${nodeId}`;
}

function collectNoteGraphBodyCandidates(
  flattened: PathMessage[]
): NoteGraphBodyCandidate[] {
  const candidates: NoteGraphBodyCandidate[] = [];
  let order = 0;
  for (const entry of flattened) {
    const graph = entry.message.noteContextGraph;
    if (graph === undefined) continue;
    for (const node of graph.nodes) {
      candidates.push({
        key: noteGraphBodyKey(entry.message.id, node.id),
        fullBody: graph.fullNoteContext || graph.perNoteBudget === "full",
        root: node.root,
        depth: node.depth,
        order
      });
      order += 1;
    }
  }
  return candidates.sort((left, right) => {
    if (left.root !== right.root) return left.root ? 1 : -1;
    if (left.depth !== right.depth) return right.depth - left.depth;
    return left.order - right.order;
  });
}

function applyNextNoteGraphReduction(
  candidates: readonly NoteGraphBodyCandidate[],
  overrides: Map<string, NoteGraphBodyOverride>
): boolean {
  for (const candidate of candidates) {
    const current = overrides.get(candidate.key);
    if (candidate.fullBody) {
      if (current === undefined) {
        overrides.set(candidate.key, "omit");
        return true;
      }
      continue;
    }
    if (current === undefined) {
      overrides.set(candidate.key, "minimal");
      return true;
    }
    if (current === "minimal") {
      overrides.set(candidate.key, "omit");
      return true;
    }
  }
  return false;
}

function noteRenderingState(
  descriptors: ReadonlyMap<string, NoteSnapshotDescriptor>,
  budgets?: ReadonlyMap<string, number>,
  suppressBackgrounds = false,
  graphBodyOverrides?: ReadonlyMap<string, NoteGraphBodyOverride>
): NoteRenderingState {
  return {
    descriptors,
    seen: new Set<string>(),
    ...(budgets === undefined ? {} : { budgets }),
    suppressBackgrounds,
    ...(graphBodyOverrides === undefined ? {} : { graphBodyOverrides }),
    seenGraphSnapshots: new Set<string>(),
    originalEstimatedTokens: 0,
    sentEstimatedTokens: 0,
    trimmed: false
  };
}

function noteBackgroundBlock(
  descriptor: NoteSnapshotDescriptor,
  content: string
): string {
  return [
    "[TreeTalk 笔记背景]",
    `笔记标题：${descriptor.fileName}`,
    `笔记路径：${descriptor.filePath}`,
    "以下是本轮框选所在笔记的正文快照：",
    "---",
    content,
    "---",
    "[笔记背景结束]"
  ].join("\n");
}

function noteFocusBlock(context: NoteSelectionContext): string {
  return [
    "[TreeTalk 框选重点]",
    `来源：${context.filePath}`,
    "---",
    context.quote,
    "---",
    "[框选重点结束]"
  ].join("\n");
}


function noteGraphStructureBlock(graph: NoteContextGraphSnapshot): string {
  const nodeLines = graph.nodes.map((node) => [
    `- ${node.id} | 标题：${node.fileName} | 路径：${node.filePath} | 深度：${String(node.depth)}`,
    `  主链路：${node.primaryChain.join(" → ")}`,
    `  父节点：${node.parentIds.length === 0 ? "无" : node.parentIds.join("、")}`,
    `  出站节点：${node.outgoingNodeIds.length === 0 ? "无" : node.outgoingNodeIds.join("、")}`
  ].join("\n"));
  const edgeLines = graph.edges.length === 0
    ? ["- 无"]
    : graph.edges.map((edge) =>
        `- ${edge.sourceNodeId} → ${edge.targetNodeId} | 链接文本：${edge.labels.join("、")}`
      );
  const unresolvedLines = graph.unresolvedLinks.length === 0
    ? ["- 无"]
    : graph.unresolvedLinks.map((link) =>
        `- ${link.sourceNodeId} → ${link.target} | ${link.label} | ${link.reason}`
      );
  return [
    "[TreeTalk 关联笔记图]",
    `根节点：${graph.rootNodeIds.join("、") || "无"}`,
    `读取深度：${graph.maxDepth === "unlimited" ? "无限" : String(graph.maxDepth)}`,
    "节点：",
    ...nodeLines,
    "边：",
    ...edgeLines,
    "未解析链接：",
    ...unresolvedLines,
    "[关联笔记图结束]"
  ].join("\n");
}

function selectionSnapshotForGraphNode(
  message: ChatMessage,
  node: NoteContextGraphNode
): NoteSnapshot | undefined {
  let snapshot: NoteSnapshot | undefined;
  for (const context of message.selectionContexts ?? []) {
    if (
      !isNoteSelectionContext(context) ||
      context.snapshot === undefined ||
      context.filePath !== node.filePath ||
      context.snapshot.contentHash !== node.contentHash
    ) {
      continue;
    }
    if (snapshot === undefined) {
      snapshot = structuredClone(context.snapshot);
    } else {
      snapshot.selectionStartOffset = Math.min(
        snapshot.selectionStartOffset,
        context.snapshot.selectionStartOffset
      );
      snapshot.selectionEndOffset = Math.max(
        snapshot.selectionEndOffset,
        context.snapshot.selectionEndOffset
      );
    }
  }
  return snapshot;
}

function noteGraphNodeBlock(
  graph: NoteContextGraphSnapshot,
  node: NoteContextGraphNode,
  message: ChatMessage,
  state: NoteRenderingState
): string {
  const snapshotKey = `${node.filePath}\u0000${node.contentHash}`;
  const alreadySeen = state.seenGraphSnapshots.has(snapshotKey);
  const bodyOverride = state.graphBodyOverrides?.get(
    noteGraphBodyKey(message.id, node.id)
  );
  state.seenGraphSnapshots.add(snapshotKey);
  state.originalEstimatedTokens += estimateNoteTextTokens(node.content);
  let content: string;
  if (alreadySeen) {
    content = "[该笔记正文已在较早的 TreeTalk 上下文中提供，本节点仅保留图关系]";
  } else if (bodyOverride === "omit") {
    content = "[正文因模型总上下文上限未发送]";
    state.trimmed = true;
  } else if (bodyOverride === "minimal") {
    const keywords = extractDeterministicNoteKeywords(node.content, 2);
    content = keywords.length === 0 ? "关键词：无" : `关键词：${keywords.join("、")}`;
    state.trimmed = true;
  } else if (graph.fullNoteContext || graph.perNoteBudget === "full") {
    content = node.content;
  } else if (graph.perNoteBudget === "minimal") {
    const keywords = extractDeterministicNoteKeywords(node.content, 2);
    content = keywords.length === 0 ? "关键词：无" : `关键词：${keywords.join("、")}`;
    state.trimmed = true;
  } else {
    const selectedSnapshot = node.root
      ? selectionSnapshotForGraphNode(message, node)
      : undefined;
    if (selectedSnapshot !== undefined) {
      const rendered = renderNoteSnapshot(selectedSnapshot, graph.perNoteBudget);
      content = rendered.content;
      state.trimmed ||= rendered.trimmed;
    } else {
      const relevanceTerms = [
        node.fileName.replace(/\.md$/iu, ""),
        ...(message.selectionContexts ?? [])
          .filter(isNoteSelectionContext)
          .map((context) => context.quote)
      ];
      content = compressRelatedNoteContent(
        node.content,
        graph.perNoteBudget,
        relevanceTerms
      );
      state.trimmed ||= content !== node.content;
    }
  }
  state.sentEstimatedTokens += estimateNoteTextTokens(content);
  return [
    `[关联笔记节点 ${node.id}]`,
    `标题：${node.fileName}`,
    `路径：${node.filePath}`,
    `深度：${String(node.depth)}`,
    `主链路：${node.primaryChain.join(" → ")}`,
    `父节点：${node.parentIds.length === 0 ? "无" : node.parentIds.join("、")}`,
    `出站节点：${node.outgoingNodeIds.length === 0 ? "无" : node.outgoingNodeIds.join("、")}`,
    "---",
    content,
    "---",
    `[关联笔记节点 ${node.id} 结束]`
  ].join("\n");
}

function noteGraphBlocks(
  graph: NoteContextGraphSnapshot,
  message: ChatMessage,
  state: NoteRenderingState
): string[] {
  return [
    noteGraphStructureBlock(graph),
    ...graph.nodes.map((node) => noteGraphNodeBlock(graph, node, message, state))
  ];
}

function genericSelectionBlock(quote: string, index: number): string {
  return [
    `[TreeTalk 引用上下文 ${String(index)}]`,
    "以下内容仅作为回答参考：",
    "---",
    quote,
    "---",
    "[引用上下文结束]"
  ].join("\n");
}

export function providerContentForMessage(
  message: ChatMessage,
  state?: NoteRenderingState
): string {
  const contexts = message.selectionContexts ?? [];
  if (contexts.length === 0 && message.noteContextGraph === undefined) {
    return message.content;
  }
  const localState =
    state ??
    noteRenderingState(
      collectNoteSnapshotDescriptors([
        { nodeId: "", message, roundIndex: 0 }
      ])
    );
  const rendered: string[] = [];
  if (message.noteContextGraph !== undefined) {
    rendered.push(...noteGraphBlocks(message.noteContextGraph, message, localState));
  }
  let genericIndex = 0;
  for (const context of contexts) {
    if (isNoteSelectionContext(context)) {
      const key = noteSnapshotKey(context);
      if (
        key !== undefined &&
        !localState.seen.has(key) &&
        !localState.suppressBackgrounds &&
        message.noteContextGraph === undefined
      ) {
        localState.seen.add(key);
        const descriptor = localState.descriptors.get(key);
        if (descriptor !== undefined) {
          const budget =
            localState.budgets?.get(key) ??
            estimateNoteTextTokens(descriptor.snapshot.content);
          const result = renderNoteSnapshot(descriptor.snapshot, budget);
          localState.originalEstimatedTokens += result.originalEstimatedTokens;
          localState.sentEstimatedTokens += result.sentEstimatedTokens;
          localState.trimmed ||= result.trimmed;
          rendered.push(noteBackgroundBlock(descriptor, result.content));
        }
      } else if (key !== undefined) {
        localState.seen.add(key);
      }
      rendered.push(noteFocusBlock(context));
      continue;
    }
    genericIndex += 1;
    rendered.push(genericSelectionBlock(context.quote, genericIndex));
  }
  return `${rendered.join("\n\n")}\n\n[当前问题]\n${message.content}`;
}

export function estimateTextTokens(text: string): number {
  let weighted = 0;
  for (const character of text) {
    if (/\s/u.test(character)) continue;
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Extended_Pictographic}/u.test(character)) {
      weighted += 1;
    } else if (/[^\x00-\x7F]/u.test(character)) {
      weighted += 0.6;
    } else {
      weighted += 0.25;
    }
  }
  return Math.max(1, Math.ceil(weighted));
}

export function estimateProviderMessagesTokens(
  messages: ProviderMessage[]
): number {
  return messages.reduce(
    (total, message) => total + estimateTextTokens(message.content) + 4,
    2
  );
}

function flattenPath(
  conversation: ConversationFile,
  nodeId: string
): PathMessage[] {
  const path = pathToConversationNode(conversation, nodeId);
  const output: PathMessage[] = [];
  let roundIndex = -1;
  for (const node of path) {
    for (const message of node.messages) {
      if (message.role === "user") roundIndex += 1;
      output.push({ nodeId: node.id, message, roundIndex: Math.max(0, roundIndex) });
    }
  }
  return output;
}

function providerMessages(
  flattened: PathMessage[],
  systemPrompt: string,
  noteBudgets?: ReadonlyMap<string, number>,
  suppressNoteBackgrounds = false,
  graphBodyOverrides?: ReadonlyMap<string, NoteGraphBodyOverride>
): ProviderBuildResult {
  const messages: ProviderMessage[] = [];
  if (systemPrompt.length > 0) {
    messages.push({ role: "system", content: systemPrompt });
  }
  const state = noteRenderingState(
    collectNoteSnapshotDescriptors(flattened),
    noteBudgets,
    suppressNoteBackgrounds,
    graphBodyOverrides
  );
  for (const entry of flattened) {
    messages.push({
      role: entry.message.role,
      content: providerContentForMessage(entry.message, state)
    });
  }
  return {
    messages,
    noteContextOriginalEstimatedTokens: state.originalEstimatedTokens,
    noteContextSentEstimatedTokens: state.sentEstimatedTokens,
    noteContextTrimmed: state.trimmed
  };
}

interface NoteGraphBudgetResult {
  build: ProviderBuildResult;
  overrides: Map<string, NoteGraphBodyOverride>;
}

function reduceNoteGraphBodiesForProvider(
  flattened: PathMessage[],
  systemPrompt: string,
  maxInputTokens: number
): NoteGraphBudgetResult {
  const candidates = collectNoteGraphBodyCandidates(flattened);
  const overrides = new Map<string, NoteGraphBodyOverride>();
  let build = providerMessages(
    flattened,
    systemPrompt,
    undefined,
    false,
    overrides
  );
  while (
    estimateProviderMessagesTokens(build.messages) > maxInputTokens &&
    applyNextNoteGraphReduction(candidates, overrides)
  ) {
    build = providerMessages(
      flattened,
      systemPrompt,
      undefined,
      false,
      overrides
    );
  }
  return { build, overrides };
}

function allocateNoteBudgets(
  descriptors: ReadonlyMap<string, NoteSnapshotDescriptor>,
  fullBuild: ProviderBuildResult,
  baseBuild: ProviderBuildResult,
  maxInputTokens: number
): Map<string, number> | undefined {
  if (
    descriptors.size === 0 ||
    estimateProviderMessagesTokens(fullBuild.messages) <= maxInputTokens
  ) {
    return undefined;
  }
  const entries = [...descriptors.values()];
  const originals = entries.map((entry) =>
    estimateNoteTextTokens(entry.snapshot.content)
  );
  const totalOriginal = originals.reduce((total, value) => total + value, 0);
  const baseTokens = estimateProviderMessagesTokens(baseBuild.messages);
  const minimumPerSnapshot = 128;
  const available = Math.max(
    minimumPerSnapshot * entries.length,
    maxInputTokens - baseTokens - 48 * entries.length
  );
  if (available >= totalOriginal) return undefined;
  const remaining = Math.max(
    0,
    available - minimumPerSnapshot * entries.length
  );
  const budgets = new Map<string, number>();
  entries.forEach((entry, index) => {
    const original = originals[index] ?? minimumPerSnapshot;
    const proportional =
      totalOriginal === 0
        ? 0
        : Math.floor((remaining * original) / totalOriginal);
    budgets.set(
      entry.key,
      Math.min(original, minimumPerSnapshot + proportional)
    );
  });
  return budgets;
}

function isFenceStart(line: string): { marker: string; info: string } | undefined {
  const match = line.match(/^\s*(`{3,}|~{3,})(.*)$/u);
  if (match === null) return undefined;
  return { marker: match[1] ?? "```", info: (match[2] ?? "").trim() };
}

function scoreBlock(
  kind: MarkdownBlockKind,
  content: string,
  index: number,
  total: number
): number {
  let score = 25;
  if (kind === "code" || kind === "math") score = 90;
  else if (kind === "table") score = 75;
  else if (kind === "heading") score = 68;
  else if (kind === "list") score = 55;
  else if (kind === "quote") score = 52;
  if (/必须|不要|禁止|约束|结论|总结|定义|错误|原因|关键|注意|因此|所以|接口|签名/iu.test(content)) {
    score += 20;
  }
  if (index === 0) score += 28;
  if (index === total - 1) score += 24;
  return score;
}

function classifyPlainBlock(content: string): MarkdownBlockKind {
  const lines = content.split("\n");
  if (lines.every((line) => /^\s{0,3}#{1,6}\s+/u.test(line))) return "heading";
  if (lines.every((line) => /^\s*(?:[-*+] |\d+[.)]\s+)/u.test(line))) return "list";
  if (lines.every((line) => /^\s*>/u.test(line))) return "quote";
  if (
    lines.length >= 2 &&
    lines.some((line) => line.includes("|")) &&
    lines.some((line) => /^\s*\|?\s*:?-{3,}/u.test(line))
  ) {
    return "table";
  }
  if (lines.length === 1 && /^\s{0,3}#{1,6}\s+/u.test(lines[0] ?? "")) {
    return "heading";
  }
  if (lines.some((line) => /^\s*(?:[-*+] |\d+[.)]\s+)/u.test(line))) return "list";
  if (lines.some((line) => /^\s*>/u.test(line))) return "quote";
  return "paragraph";
}

export function splitMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n?/gu, "\n").split("\n");
  const raw: Array<{ kind: MarkdownBlockKind; content: string }> = [];
  let paragraph: string[] = [];
  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    const content = paragraph.join("\n").trim();
    paragraph = [];
    if (content.length > 0) raw.push({ kind: classifyPlainBlock(content), content });
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const fence = isFenceStart(line);
    if (fence !== undefined) {
      flushParagraph();
      const block = [line];
      index += 1;
      while (index < lines.length) {
        const next = lines[index] ?? "";
        block.push(next);
        index += 1;
        if (new RegExp(`^\\s*${fence.marker[0]}{${String(fence.marker.length)},}\\s*$`, "u").test(next)) {
          break;
        }
      }
      if (block.length === 1 || !new RegExp(`^\\s*${fence.marker[0]}{${String(fence.marker.length)},}\\s*$`, "u").test(block.at(-1) ?? "")) {
        block.push(fence.marker);
      }
      raw.push({ kind: "code", content: block.join("\n") });
      continue;
    }
    if (/^\s*\$\$\s*$/u.test(line)) {
      flushParagraph();
      const block = [line];
      index += 1;
      while (index < lines.length) {
        const next = lines[index] ?? "";
        block.push(next);
        index += 1;
        if (/^\s*\$\$\s*$/u.test(next)) break;
      }
      if (block.length === 1 || !/^\s*\$\$\s*$/u.test(block.at(-1) ?? "")) {
        block.push("$$");
      }
      raw.push({ kind: "math", content: block.join("\n") });
      continue;
    }
    if (line.trim().length === 0) {
      flushParagraph();
      index += 1;
      continue;
    }
    paragraph.push(line);
    index += 1;
  }
  flushParagraph();

  return raw.map((block, blockIndex) => ({
    ...block,
    index: blockIndex,
    score: scoreBlock(block.kind, block.content, blockIndex, raw.length),
    tokens: estimateTextTokens(block.content)
  }));
}

function omissionComment(language: string): string {
  const normalized = language.toLowerCase();
  if (/^(?:py|python|sh|bash|zsh|fish|yaml|yml|toml|r|ruby|perl)$/u.test(normalized)) {
    return `# ……${OMITTED_CODE_MARKER}……`;
  }
  if (/^(?:html|xml|svg|md|markdown)$/u.test(normalized)) {
    return `<!-- ……${OMITTED_CODE_MARKER}…… -->`;
  }
  return `// ……${OMITTED_CODE_MARKER}……`;
}

function looksLikeCodeSignature(line: string): boolean {
  return /^\s*(?:import|export|from|require|#include|using|package|class|interface|type|enum|struct|def|fn|func|function|public|private|protected|static|async|const\s+\w+\s*=\s*\(|let\s+\w+\s*=\s*\().*/u.test(line);
}

export function trimLongFencedCode(
  markdown: string,
  maxTokens: number
): string {
  if (estimateTextTokens(markdown) <= maxTokens) return markdown;
  const lines = markdown.split("\n");
  const opening = lines[0] ?? "```";
  const closing = lines.at(-1)?.match(/^\s*(`{3,}|~{3,})\s*$/u)?.[0] ?? "```";
  const language = opening.replace(/^\s*(`{3,}|~{3,})/u, "").trim();
  const body = lines.slice(1, -1);
  const keep = new Set<number>();
  for (let index = 0; index < Math.min(14, body.length); index += 1) keep.add(index);
  for (let index = Math.max(0, body.length - 10); index < body.length; index += 1) keep.add(index);
  for (const [index, line] of body.entries()) {
    if (looksLikeCodeSignature(line)) keep.add(index);
    if (keep.size >= 48) break;
  }
  const ordered = [...keep].sort((left, right) => left - right);
  const compact: string[] = [opening];
  let previous = -1;
  for (const lineIndex of ordered) {
    if (previous >= 0 && lineIndex > previous + 1) {
      compact.push(omissionComment(language));
    }
    compact.push(body[lineIndex] ?? "");
    previous = lineIndex;
  }
  compact.push(closing);
  let result = compact.join("\n");
  if (estimateTextTokens(result) <= maxTokens) return result;

  const head = body.slice(0, 8);
  const tail = body.slice(-6);
  result = [opening, ...head, omissionComment(language), ...tail, closing].join("\n");
  return result;
}

export function trimAssistantMarkdown(
  markdown: string,
  maxTokens: number
): string {
  if (estimateTextTokens(markdown) <= maxTokens) return markdown;
  const blocks = splitMarkdownBlocks(markdown);
  if (blocks.length === 0) return markdown;
  const selected = new Map<number, string>();
  let used = 0;
  const ranked = [...blocks].sort(
    (left, right) => right.score - left.score || left.index - right.index
  );
  for (const block of ranked) {
    let content = block.content;
    let tokens = block.tokens;
    if (block.kind === "code" && tokens > Math.max(180, Math.floor(maxTokens * 0.45))) {
      content = trimLongFencedCode(content, Math.max(180, Math.floor(maxTokens * 0.45)));
      tokens = estimateTextTokens(content);
    }
    if (used + tokens > maxTokens && selected.size > 0) continue;
    selected.set(block.index, content);
    used += tokens;
    if (used >= maxTokens) break;
  }
  if (selected.size === 0) {
    const first = blocks[0];
    if (first === undefined) return markdown;
    return first.kind === "code"
      ? trimLongFencedCode(first.content, maxTokens)
      : first.content;
  }
  return [...selected.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, content]) => content)
    .join("\n\n");
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function stablePrefixHash(messages: ProviderMessage[]): string {
  const stable = messages.slice(0, Math.max(0, messages.length - 1));
  return fnv1a(
    stable.map((message) => `${message.role}\u0000${message.content}`).join("\u0001")
  );
}

interface SourceMessageProtection {
  ranges: CharacterRange[];
  unresolved: boolean;
}

function sourceMessageKey(nodeId: string, messageId: string): string {
  return `${nodeId}\u0000${messageId}`;
}

function sourceMessageProtections(
  flattened: PathMessage[]
): Map<string, SourceMessageProtection> {
  const sourceMessages = new Map<string, PathMessage>();
  for (const entry of flattened) {
    if (entry.message.role !== "assistant") continue;
    sourceMessages.set(sourceMessageKey(entry.nodeId, entry.message.id), entry);
  }

  const protections = new Map<string, SourceMessageProtection>();
  for (const entry of flattened) {
    if (entry.message.role !== "user") continue;
    for (const context of entry.message.selectionContexts ?? []) {
      if (
        !isMessageSelectionContext(context) ||
        context.sourceRole !== "assistant"
      ) {
        continue;
      }
      const key = sourceMessageKey(context.sourceNodeId, context.messageId);
      const source = sourceMessages.get(key);
      if (source === undefined) continue;
      const protection = protections.get(key) ?? { ranges: [], unresolved: false };
      const resolved = resolveSelectionInMarkdown(source.message.content, context);
      if (resolved.status === "unresolved") {
        protection.unresolved = true;
      } else {
        protection.ranges.push({ start: resolved.start, end: resolved.end });
      }
      protections.set(key, protection);
    }
  }
  return protections;
}

interface BalancedV3NoteDescriptor extends NoteSnapshotDescriptor {
  firstMessageId: string;
}

interface BalancedV3ArtifactContext {
  library: Readonly<Record<string, BalancedFreezeArtifact>>;
  candidateKeys: readonly string[];
  newArtifacts: Map<string, BalancedFreezeArtifact>;
  artifactKeys: string[];
  recoveryPatchKeys: string[];
}

interface BalancedV3BuildResult extends ProviderBuildResult {
  artifactKeys: string[];
  recoveryPatchKeys: string[];
  newArtifacts: BalancedFreezeArtifact[];
}

function balancedV3NoteDescriptors(
  flattened: PathMessage[]
): Map<string, BalancedV3NoteDescriptor> {
  const descriptors = new Map<string, BalancedV3NoteDescriptor>();
  for (const entry of flattened) {
    const firstMessageGroups = new Map<
      string,
      {
        context: NoteSelectionContext;
        selectionStartOffset: number;
        selectionEndOffset: number;
      }
    >();
    for (const context of entry.message.selectionContexts ?? []) {
      if (!isNoteSelectionContext(context) || context.snapshot === undefined) {
        continue;
      }
      const key = noteSnapshotKey(context);
      if (key === undefined || descriptors.has(key)) continue;
      const existing = firstMessageGroups.get(key);
      if (existing === undefined) {
        firstMessageGroups.set(key, {
          context,
          selectionStartOffset: context.snapshot.selectionStartOffset,
          selectionEndOffset: context.snapshot.selectionEndOffset
        });
      } else {
        existing.selectionStartOffset = Math.min(
          existing.selectionStartOffset,
          context.snapshot.selectionStartOffset
        );
        existing.selectionEndOffset = Math.max(
          existing.selectionEndOffset,
          context.snapshot.selectionEndOffset
        );
      }
    }
    for (const [key, group] of firstMessageGroups) {
      const snapshot = structuredClone(group.context.snapshot);
      if (snapshot === undefined) continue;
      snapshot.selectionStartOffset = group.selectionStartOffset;
      snapshot.selectionEndOffset = group.selectionEndOffset;
      descriptors.set(key, {
        key,
        filePath: group.context.filePath,
        fileName: group.context.fileName,
        snapshot,
        firstMessageId: entry.message.id
      });
    }
  }
  return descriptors;
}

function latestCompletedRoundIndexesV3(flattened: PathMessage[]): Set<number> {
  const completed = [...new Set(
    flattened
      .filter(
        (entry) =>
          entry.message.role === "assistant" &&
          entry.message.status === "complete"
      )
      .map((entry) => entry.roundIndex)
  )].sort((left, right) => left - right);
  const latest = completed.at(-1);
  return latest === undefined ? new Set<number>() : new Set([latest]);
}

function currentUserEntry(flattened: PathMessage[]): PathMessage | undefined {
  return [...flattened].reverse().find((entry) => entry.message.role === "user");
}

function priorBalancedState(
  flattened: PathMessage[],
  currentUser: PathMessage
): BalancedContextRequestState | undefined {
  if (currentUser.message.balancedContextState?.protocol === BALANCED_V3_PROTOCOL) {
    return currentUser.message.balancedContextState;
  }
  const currentIndex = flattened.indexOf(currentUser);
  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    const state = flattened[index]?.message.balancedContextState;
    if (state?.protocol === BALANCED_V3_PROTOCOL) return state;
  }
  return undefined;
}

function artifactCompatible(
  artifact: BalancedFreezeArtifact,
  input: {
    sourceType: BalancedFreezeArtifact["sourceType"];
    sourceIdentity: string;
    sourceContentHash: string;
    tier: BalancedFreezeArtifact["tier"];
  }
): boolean {
  return (
    artifact.protocol === BALANCED_V3_PROTOCOL &&
    artifact.sourceType === input.sourceType &&
    artifact.sourceIdentity === input.sourceIdentity &&
    artifact.sourceContentHash === input.sourceContentHash &&
    artifact.tier === input.tier
  );
}

function artifactFromCandidateKeys(
  context: BalancedV3ArtifactContext,
  input: Parameters<typeof artifactCompatible>[1]
): BalancedFreezeArtifact | undefined {
  for (const key of context.candidateKeys) {
    const artifact = context.library[key];
    if (artifact !== undefined && artifactCompatible(artifact, input)) {
      return artifact;
    }
  }
  return undefined;
}

function sameArtifact(
  left: BalancedFreezeArtifact,
  right: BalancedFreezeArtifact
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function registerArtifact(
  context: BalancedV3ArtifactContext,
  artifact: BalancedFreezeArtifact
): BalancedFreezeArtifact {
  const existing = context.library[artifact.key] ?? context.newArtifacts.get(artifact.key);
  if (existing === undefined) {
    context.newArtifacts.set(artifact.key, artifact);
    return artifact;
  }
  if (sameArtifact(existing, artifact)) return existing;
  const repaired: BalancedFreezeArtifact = {
    ...artifact,
    key: `${artifact.key}-repair-${balancedV3TextHash(JSON.stringify(artifact))}`
  };
  const repairedExisting =
    context.library[repaired.key] ?? context.newArtifacts.get(repaired.key);
  if (repairedExisting !== undefined && !sameArtifact(repairedExisting, repaired)) {
    throw new Error(`Balanced context artifact conflict: ${repaired.key}`);
  }
  if (repairedExisting === undefined) context.newArtifacts.set(repaired.key, repaired);
  return repairedExisting ?? repaired;
}

function recordArtifactKey(
  context: BalancedV3ArtifactContext,
  artifact: BalancedFreezeArtifact,
  recovery = false
): void {
  if (!context.artifactKeys.includes(artifact.key)) {
    context.artifactKeys.push(artifact.key);
  }
  if (recovery && !context.recoveryPatchKeys.includes(artifact.key)) {
    context.recoveryPatchKeys.push(artifact.key);
  }
}

function resolvedAssistantArtifact(
  context: BalancedV3ArtifactContext,
  entry: PathMessage,
  protection: SourceMessageProtection | undefined,
  tier: BalancedFreezeArtifact["tier"]
): BalancedFreezeArtifact | undefined {
  const sourceIdentity = sourceMessageKey(entry.nodeId, entry.message.id);
  const sourceContentHash = balancedV3TextHash(entry.message.content);
  const existing = artifactFromCandidateKeys(context, {
    sourceType: "assistant-message",
    sourceIdentity,
    sourceContentHash,
    tier
  });
  if (existing !== undefined) return existing;
  const built = buildAssistantFreezeArtifact({
    sourceIdentity,
    sourceContentHash,
    content: entry.message.content,
    protectedRanges: protection?.ranges ?? [],
    tier
  });
  return built === undefined ? undefined : registerArtifact(context, built);
}

function resolvedNoteArtifact(
  context: BalancedV3ArtifactContext,
  descriptor: BalancedV3NoteDescriptor,
  tier: BalancedFreezeArtifact["tier"]
): BalancedFreezeArtifact | undefined {
  const sourceIdentity = descriptor.key;
  const sourceContentHash = descriptor.snapshot.contentHash;
  const existing = artifactFromCandidateKeys(context, {
    sourceType: "note-snapshot",
    sourceIdentity,
    sourceContentHash,
    tier
  });
  if (existing !== undefined) return existing;
  const built = buildNoteFreezeArtifact({
    sourceIdentity,
    sourceContentHash,
    snapshot: descriptor.snapshot,
    tier
  });
  return built === undefined ? undefined : registerArtifact(context, built);
}

function sourceMessagesByKey(flattened: PathMessage[]): Map<string, PathMessage> {
  const output = new Map<string, PathMessage>();
  for (const entry of flattened) {
    output.set(sourceMessageKey(entry.nodeId, entry.message.id), entry);
  }
  return output;
}

function resolvedRecoveryArtifact(
  artifactContext: BalancedV3ArtifactContext,
  selection: SelectionContext,
  sources: ReadonlyMap<string, PathMessage>
): BalancedFreezeArtifact | undefined {
  if (isNoteSelectionContext(selection)) {
    const snapshot = selection.snapshot;
    const sourceContent = snapshot?.content ?? selection.quote;
    const sourceIdentity =
      snapshot === undefined
        ? `${selection.filePath}\u0000${selection.contentHash}`
        : `${selection.filePath}\u0000${snapshot.contentHash}`;
    const sourceContentHash = snapshot?.contentHash ?? balancedV3TextHash(sourceContent);
    const existing = artifactFromCandidateKeys(artifactContext, {
      sourceType: "recovery-patch",
      sourceIdentity,
      sourceContentHash,
      tier: "standard"
    });
    const built = buildRecoveryPatchArtifact({
      sourceIdentity,
      sourceContentHash,
      sourceLabel: selection.filePath,
      sourceContent,
      startOffset: snapshot?.selectionStartOffset ?? 0,
      endOffset: snapshot?.selectionEndOffset ?? selection.quote.length,
      quote: selection.quote
    });
    if (existing !== undefined && existing.key === built.key) return existing;
    return registerArtifact(artifactContext, built);
  }

  const sourceIdentity = sourceMessageKey(selection.sourceNodeId, selection.messageId);
  const source = sources.get(sourceIdentity);
  const sourceContent = source?.message.content ?? selection.quote;
  const sourceContentHash = balancedV3TextHash(sourceContent);
  const resolved =
    source === undefined
      ? { status: "unresolved" as const, quote: selection.quote }
      : resolveSelectionInMarkdown(sourceContent, selection);
  const startOffset =
    resolved.status === "resolved" ? resolved.start : Math.max(0, selection.startOffset);
  const endOffset =
    resolved.status === "resolved"
      ? resolved.end
      : Math.max(startOffset, selection.endOffset);
  const built = buildRecoveryPatchArtifact({
    sourceIdentity,
    sourceContentHash,
    sourceLabel: `节点 ${selection.sourceNodeId}`,
    sourceContent,
    startOffset,
    endOffset,
    quote: selection.quote
  });
  const existing = artifactContext.library[built.key];
  if (existing !== undefined && artifactCompatible(existing, {
    sourceType: "recovery-patch",
    sourceIdentity,
    sourceContentHash,
    tier: "standard"
  })) {
    return existing;
  }
  return registerArtifact(artifactContext, built);
}

function balancedV3UserContent(
  entry: PathMessage,
  artifactContext: BalancedV3ArtifactContext,
  noteDescriptors: ReadonlyMap<string, BalancedV3NoteDescriptor>,
  seenNotes: Set<string>,
  seenRecovery: Set<string>,
  sources: ReadonlyMap<string, PathMessage>,
  compactSources: ReadonlySet<string>,
  noteStats: {
    original: number;
    sent: number;
    trimmed: boolean;
  },
  graphState: NoteRenderingState
): string {
  const contexts = entry.message.selectionContexts ?? [];
  const graph = entry.message.noteContextGraph;
  if (contexts.length === 0 && graph === undefined) return entry.message.content;
  const rendered: string[] = [];
  if (graph !== undefined) {
    rendered.push(...noteGraphBlocks(graph, entry.message, graphState));
  }
  for (const selection of contexts) {
    if (isNoteSelectionContext(selection)) {
      if (graph !== undefined) {
        rendered.push(noteFocusBlock(selection));
        continue;
      }
      const key = noteSnapshotKey(selection);
      if (key !== undefined && !seenNotes.has(key)) {
        seenNotes.add(key);
        const descriptor = noteDescriptors.get(key);
        if (descriptor !== undefined) {
          const tier = compactSources.has(descriptor.key) ? "compact" : "standard";
          const artifact = resolvedNoteArtifact(artifactContext, descriptor, tier);
          const original = estimateNoteTextTokens(descriptor.snapshot.content);
          const content = artifact?.content ?? descriptor.snapshot.content;
          const sent = estimateNoteTextTokens(content);
          noteStats.original += original;
          noteStats.sent += sent;
          noteStats.trimmed ||= artifact !== undefined;
          if (artifact !== undefined) recordArtifactKey(artifactContext, artifact);
          rendered.push(noteBackgroundBlock(descriptor, content));
        }
      }
    }
    const recovery = resolvedRecoveryArtifact(artifactContext, selection, sources);
    if (recovery !== undefined && !seenRecovery.has(recovery.key)) {
      seenRecovery.add(recovery.key);
      recordArtifactKey(artifactContext, recovery, true);
      rendered.push(recovery.content);
    }
  }
  return `${rendered.join("\n\n")}\n\n[当前问题]\n${entry.message.content}`;
}

function balancedV3ProviderMessages(
  conversation: ConversationFile,
  flattened: PathMessage[],
  systemPrompt: string,
  compactSources: ReadonlySet<string>,
  candidateKeys: readonly string[],
  graphBodyOverrides?: ReadonlyMap<string, NoteGraphBodyOverride>
): BalancedV3BuildResult {
  const library = conversation.contextArtifacts?.balancedV3 ?? {};
  const artifactContext: BalancedV3ArtifactContext = {
    library,
    candidateKeys,
    newArtifacts: new Map<string, BalancedFreezeArtifact>(),
    artifactKeys: [],
    recoveryPatchKeys: []
  };
  const recentRounds = latestCompletedRoundIndexesV3(flattened);
  const protections = sourceMessageProtections(flattened);
  const notes = balancedV3NoteDescriptors(flattened);
  const sources = sourceMessagesByKey(flattened);
  const seenNotes = new Set<string>();
  const seenRecovery = new Set<string>();
  const noteStats = { original: 0, sent: 0, trimmed: false };
  const graphState = noteRenderingState(
    collectNoteSnapshotDescriptors(flattened),
    undefined,
    false,
    graphBodyOverrides
  );
  const messages: ProviderMessage[] = [];
  if (systemPrompt.length > 0) messages.push({ role: "system", content: systemPrompt });

  for (const entry of flattened) {
    if (entry.message.role === "user") {
      messages.push({
        role: "user",
        content: balancedV3UserContent(
          entry,
          artifactContext,
          notes,
          seenNotes,
          seenRecovery,
          sources,
          compactSources,
          noteStats,
          graphState
        )
      });
      continue;
    }
    if (
      entry.message.status !== "complete" ||
      recentRounds.has(entry.roundIndex)
    ) {
      messages.push({ role: "assistant", content: entry.message.content });
      continue;
    }
    const sourceIdentity = sourceMessageKey(entry.nodeId, entry.message.id);
    const tier = compactSources.has(sourceIdentity) ? "compact" : "standard";
    const artifact = resolvedAssistantArtifact(
      artifactContext,
      entry,
      protections.get(sourceIdentity),
      tier
    );
    if (artifact !== undefined) recordArtifactKey(artifactContext, artifact);
    messages.push({
      role: "assistant",
      content: artifact?.content ?? entry.message.content
    });
  }
  return {
    messages,
    noteContextOriginalEstimatedTokens:
      noteStats.original + graphState.originalEstimatedTokens,
    noteContextSentEstimatedTokens:
      noteStats.sent + graphState.sentEstimatedTokens,
    noteContextTrimmed: noteStats.trimmed || graphState.trimmed,
    artifactKeys: artifactContext.artifactKeys,
    recoveryPatchKeys: artifactContext.recoveryPatchKeys,
    newArtifacts: [...artifactContext.newArtifacts.values()]
  };
}

function stateEquals(
  left: BalancedContextRequestState | undefined,
  right: BalancedContextRequestState
): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right);
}

function compactCandidateIdentities(
  flattened: PathMessage[]
): string[] {
  const recentRounds = latestCompletedRoundIndexesV3(flattened);
  const candidates: string[] = [];
  for (const entry of flattened) {
    if (
      entry.message.role === "assistant" &&
      entry.message.status === "complete" &&
      !recentRounds.has(entry.roundIndex)
    ) {
      candidates.push(sourceMessageKey(entry.nodeId, entry.message.id));
    }
  }
  for (const descriptor of balancedV3NoteDescriptors(flattened).values()) {
    candidates.push(descriptor.key);
  }
  return [...new Set(candidates)];
}

function conversationWithArtifacts(
  conversation: ConversationFile,
  artifacts: ReadonlyMap<string, BalancedFreezeArtifact>
): ConversationFile {
  if (artifacts.size === 0) return conversation;
  const next = structuredClone(conversation);
  next.contextArtifacts = {
    balancedV3: {
      ...(conversation.contextArtifacts?.balancedV3 ?? {}),
      ...Object.fromEntries(artifacts)
    }
  };
  return next;
}

function compileBalancedV3(
  conversation: ConversationFile,
  flattened: PathMessage[],
  systemPrompt: string,
  maxInputTokens: number,
  fullBuild: ProviderBuildResult,
  fullEstimatedTokens: number,
  referencedNoteNames: string[]
): ContextPlan {
  const currentUser = currentUserEntry(flattened);
  if (currentUser === undefined) {
    throw new Error("Balanced context requires a current user message");
  }
  const inherited = priorBalancedState(flattened, currentUser);
  const compactSources = new Set(inherited?.compactSourceIdentities ?? []);
  const graphCandidates = collectNoteGraphBodyCandidates(flattened);
  const graphBodyOverrides = new Map<string, NoteGraphBodyOverride>();
  const accumulatedArtifacts = new Map<string, BalancedFreezeArtifact>();
  let workingConversation = conversation;
  let build = balancedV3ProviderMessages(
    workingConversation,
    flattened,
    systemPrompt,
    compactSources,
    inherited?.artifactKeys ?? [],
    graphBodyOverrides
  );
  for (const artifact of build.newArtifacts) {
    accumulatedArtifacts.set(artifact.key, artifact);
  }

  const candidates = compactCandidateIdentities(flattened);
  let sentEstimatedTokens = estimateProviderMessagesTokens(build.messages);
  while (sentEstimatedTokens > maxInputTokens) {
    const graphReduced = applyNextNoteGraphReduction(
      graphCandidates,
      graphBodyOverrides
    );
    if (!graphReduced) {
      const nextCandidate = candidates.find(
        (identity) => !compactSources.has(identity)
      );
      if (nextCandidate === undefined) throw new ProtectedContextTooLongError();
      compactSources.add(nextCandidate);
    }
    workingConversation = conversationWithArtifacts(
      conversation,
      accumulatedArtifacts
    );
    build = balancedV3ProviderMessages(
      workingConversation,
      flattened,
      systemPrompt,
      compactSources,
      [
        ...(inherited?.artifactKeys ?? []),
        ...accumulatedArtifacts.keys()
      ],
      graphBodyOverrides
    );
    for (const artifact of build.newArtifacts) {
      accumulatedArtifacts.set(artifact.key, artifact);
    }
    sentEstimatedTokens = estimateProviderMessagesTokens(build.messages);
  }

  const requestState: BalancedContextRequestState = {
    protocol: BALANCED_V3_PROTOCOL,
    artifactKeys: [...build.artifactKeys],
    compactSourceIdentities: [...compactSources],
    recoveryPatchKeys: [...build.recoveryPatchKeys]
  };
  const reducedTokens = Math.max(0, fullEstimatedTokens - sentEstimatedTokens);
  const plan: ContextPlan = {
    mode: "balanced",
    messages: build.messages,
    fullEstimatedTokens,
    sentEstimatedTokens,
    reducedTokens,
    reductionRatio:
      fullEstimatedTokens === 0 ? 0 : reducedTokens / fullEstimatedTokens,
    stablePrefixHash: stablePrefixHash(build.messages),
    trimmed: reducedTokens > 0,
    noteContextOriginalEstimatedTokens:
      fullBuild.noteContextOriginalEstimatedTokens,
    noteContextSentEstimatedTokens: build.noteContextSentEstimatedTokens,
    noteContextTrimmed: build.noteContextTrimmed,
    referencedNoteNames: [...referencedNoteNames]
  };
  if (
    accumulatedArtifacts.size > 0 ||
    !stateEquals(currentUser.message.balancedContextState, requestState)
  ) {
    plan.persistencePatch = {
      artifacts: [...accumulatedArtifacts.values()],
      currentUserMessageId: currentUser.message.id,
      requestState
    };
  }
  return plan;
}

export function compileContextPlan(
  conversation: ConversationFile,
  nodeId: string,
  options: ContextEngineOptions
): ContextPlan {
  if (!Number.isFinite(options.maxInputTokens) || options.maxInputTokens <= 0) {
    throw new Error("maxInputTokens must be positive");
  }
  const flattened = flattenPath(conversation, nodeId);
  const descriptors = collectNoteSnapshotDescriptors(flattened);
  const referencedNoteNames = referencedNoteNamesForPath(flattened, descriptors);
  const originalFullBuild = providerMessages(flattened, options.systemPrompt);
  const fullEstimatedTokens = estimateProviderMessagesTokens(originalFullBuild.messages);

  if (options.mode === "full") {
    const graphBudget = reduceNoteGraphBodiesForProvider(
      flattened,
      options.systemPrompt,
      options.maxInputTokens
    );
    const baseBuild = providerMessages(
      flattened,
      options.systemPrompt,
      undefined,
      true,
      graphBudget.overrides
    );
    const noteBudgets = allocateNoteBudgets(
      descriptors,
      graphBudget.build,
      baseBuild,
      options.maxInputTokens
    );
    const sentBuild =
      noteBudgets === undefined
        ? graphBudget.build
        : providerMessages(
            flattened,
            options.systemPrompt,
            noteBudgets,
            false,
            graphBudget.overrides
          );
    const sentEstimatedTokens = estimateProviderMessagesTokens(sentBuild.messages);
    const reducedTokens = Math.max(0, fullEstimatedTokens - sentEstimatedTokens);
    return {
      mode: "full",
      messages: sentBuild.messages,
      fullEstimatedTokens,
      sentEstimatedTokens,
      reducedTokens,
      reductionRatio:
        fullEstimatedTokens === 0 ? 0 : reducedTokens / fullEstimatedTokens,
      stablePrefixHash: stablePrefixHash(sentBuild.messages),
      trimmed: sentBuild.noteContextTrimmed,
      noteContextOriginalEstimatedTokens:
        originalFullBuild.noteContextOriginalEstimatedTokens,
      noteContextSentEstimatedTokens:
        sentBuild.noteContextSentEstimatedTokens,
      noteContextTrimmed: sentBuild.noteContextTrimmed,
      referencedNoteNames: [...referencedNoteNames]
    };
  }

  return compileBalancedV3(
    conversation,
    flattened,
    options.systemPrompt,
    options.maxInputTokens,
    originalFullBuild,
    fullEstimatedTokens,
    referencedNoteNames
  );
}

export function cacheKeyForContextPlan(
  conversationId: string,
  plan: Pick<ContextPlan, "mode">
): string | undefined {
  return plan.mode === "balanced"
    ? `treetalk:${conversationId}:balanced:v3`
    : `treetalk:${conversationId}:full:v1`;
}
