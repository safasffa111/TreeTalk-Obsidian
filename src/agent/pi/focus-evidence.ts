import { estimateTextTokens } from "../../domain/context-engine";
import type {
  PiConversationMessageSnapshot,
  PiConversationNodeSnapshot,
  PiFocusAnchor,
  PiFocusContext,
  PiFocusDecision,
  PiFocusScope
} from "../../execution/types";
import { sha256Hex } from "./cache-identity";
import {
  clipMarkdownToTokenBudget,
  type PiMaterializedEvidence
} from "./evidence-materializer";
import {
  extractMarkdownContainingSection,
  renderConversationNodeTranscript
} from "./context-index";
import type { PiContextWorkspace } from "./context-workspace";

export interface PiFocusEvidenceOptions {
  tokenBudget: number;
}

type FocusCandidateGroup =
  | "primary-target"
  | "target-context"
  | "structural-context";

interface FocusCandidate {
  key: string;
  sourceId: string;
  nodeId?: string;
  notePath?: string;
  group: FocusCandidateGroup;
  header: string;
  content: string;
}

function quote(value: string): string {
  return `> ${value.replace(/\n/gu, "\n> ")}`;
}

function localExcerpt(anchor: Extract<PiFocusAnchor, { kind: "note-selection" | "message-selection" }>): string {
  return [anchor.prefix, anchor.quote, anchor.suffix].join("").trim() || anchor.quote;
}

function sourceMessage(
  node: PiConversationNodeSnapshot,
  messageId: string
): PiConversationMessageSnapshot | undefined {
  return node.messages.find((message) => message.id === messageId);
}

function roundMessages(
  node: PiConversationNodeSnapshot,
  sourceMessageId?: string
): PiConversationMessageSnapshot[] {
  let anchorIndex = sourceMessageId === undefined
    ? -1
    : node.messages.findIndex((message) => message.id === sourceMessageId);
  if (anchorIndex < 0) {
    for (let index = node.messages.length - 1; index >= 0; index -= 1) {
      const message = node.messages[index];
      if (message?.role === "assistant" && message.status === "complete") {
        anchorIndex = index;
        break;
      }
    }
  }
  if (anchorIndex < 0) return [];
  const anchor = node.messages[anchorIndex];
  if (anchor === undefined) return [];
  if (anchor.role === "assistant") {
    let userIndex = anchorIndex - 1;
    while (userIndex >= 0 && node.messages[userIndex]?.role !== "user") {
      userIndex -= 1;
    }
    return node.messages.slice(Math.max(0, userIndex), anchorIndex + 1);
  }
  let assistantIndex = anchorIndex + 1;
  while (
    assistantIndex < node.messages.length &&
    node.messages[assistantIndex]?.role !== "assistant"
  ) {
    assistantIndex += 1;
  }
  return node.messages.slice(
    anchorIndex,
    Math.min(node.messages.length, assistantIndex + 1)
  );
}

function renderMessages(messages: PiConversationMessageSnapshot[]): string {
  return messages
    .map((message) => [
      message.role === "user" ? "### User" : "### Assistant",
      "",
      message.content
    ].join("\n"))
    .join("\n\n");
}

function renderMessagesCompact(messages: PiConversationMessageSnapshot[]): string {
  return messages
    .map((message) =>
      `${message.role === "user" ? "User" : "Assistant"}: ${message.content}`
    )
    .join("\n");
}

function selectionCandidate(
  workspace: PiContextWorkspace,
  anchor: PiFocusAnchor,
  index: number
): FocusCandidate | undefined {
  if (anchor.kind === "conversation-round") return undefined;
  const anchorId = focusAnchorId(anchor, index);
  if (anchor.kind === "note-selection") {
    const note = workspace.resolveNotePath(anchor.filePath);
    return {
      key: `focus:note:${note.filePath}:selection:${String(index)}`,
      sourceId: note.filePath,
      notePath: note.filePath,
      group: "primary-target",
      header: `## Target ${anchorId} · Exact Selection`,
      content: [
        `- Target text: ${anchor.quote}`,
        `- Source container: ${note.fileName} (${note.filePath}) (context only)`,
        "",
        quote(anchor.quote),
        anchor.prefix.length === 0 && anchor.suffix.length === 0
          ? ""
          : `\n\nLocal context: ${localExcerpt(anchor)}`
      ].join("\n")
    };
  }
  const node = workspace.resolveConversationNode(anchor.sourceNodeId);
  return {
    key: `focus:node:${node.id}:selection:${anchor.sourceMessageId}:${String(index)}`,
    sourceId: node.id,
    nodeId: node.id,
    group: "primary-target",
    header: `## Target ${anchorId} · Exact Selection`,
    content: [
      `- Target text: ${anchor.quote}`,
      `- Source container: ${node.title} (context only)`,
      `- Source message: ${anchor.sourceMessageId}`,
      `- Source role: ${anchor.sourceRole}`,
      "",
      quote(anchor.quote),
      anchor.prefix.length === 0 && anchor.suffix.length === 0
        ? ""
        : `\n\nLocal context: ${localExcerpt(anchor)}`
    ].join("\n")
  };
}

function candidateHeading(
  group: FocusCandidateGroup,
  anchorId: string,
  range: string
): string {
  if (group === "primary-target") return `## Target ${anchorId} · ${range}`;
  if (group === "structural-context") {
    return `## Structural ${anchorId} · ${range}`;
  }
  return `## Context for ${anchorId} · ${range}`;
}

function sourceMessageCandidate(
  workspace: PiContextWorkspace,
  anchor: PiFocusAnchor,
  index: number,
  group: FocusCandidateGroup
): FocusCandidate | undefined {
  const anchorId = focusAnchorId(anchor, index);
  if (anchor.kind === "note-selection") {
    const note = workspace.resolveNotePath(anchor.filePath);
    return {
      key: `focus:note:${note.filePath}:local:${String(index)}`,
      sourceId: note.filePath,
      notePath: note.filePath,
      group,
      header: candidateHeading(group, anchorId, "Local Source Context"),
      content: [
        `- Source container: ${note.fileName} (${note.filePath})`,
        "",
        localExcerpt(anchor)
      ].join("\n")
    };
  }
  const node = workspace.resolveConversationNode(anchor.sourceNodeId);
  const messageId = anchor.sourceMessageId;
  const message = messageId === undefined
    ? roundMessages(node).at(-1)
    : sourceMessage(node, messageId);
  if (message === undefined) return undefined;
  return {
    key: `focus:node:${node.id}:message:${message.id}`,
    sourceId: node.id,
    nodeId: node.id,
    group,
    header: candidateHeading(group, anchorId, "Source Message"),
    content: [
      `- Source container: ${node.title}`,
      "",
      renderMessages([message])
    ].join("\n")
  };
}

function resolvedSelectionStart(
  content: string,
  anchor: Extract<PiFocusAnchor, { kind: "note-selection" }>
): number | undefined {
  const start = anchor.selectionStartOffset;
  const end = anchor.selectionEndOffset;
  if (
    start !== undefined &&
    end !== undefined &&
    start >= 0 &&
    end >= start &&
    end <= content.length &&
    content.slice(start, end) === anchor.quote
  ) {
    return start;
  }
  const local = [anchor.prefix, anchor.quote, anchor.suffix].join("");
  if (local.length > anchor.quote.length) {
    const localStart = content.indexOf(local);
    if (localStart >= 0) return localStart + anchor.prefix.length;
  }
  const quoteStart = content.indexOf(anchor.quote);
  return quoteStart < 0 ? undefined : quoteStart;
}

function containingSectionCandidate(
  workspace: PiContextWorkspace,
  anchor: Extract<PiFocusAnchor, { kind: "note-selection" }>,
  index: number,
  group: FocusCandidateGroup
): FocusCandidate | undefined {
  const note = workspace.resolveNotePath(anchor.filePath);
  const start = resolvedSelectionStart(note.content, anchor);
  const section = start === undefined
    ? undefined
    : extractMarkdownContainingSection(note.content, start);
  if (section === undefined) {
    return sourceMessageCandidate(workspace, anchor, index, group);
  }
  return {
    key: `note:${note.filePath}:section:${section.heading.toLowerCase()}`,
    sourceId: note.filePath,
    notePath: note.filePath,
    group,
    header: candidateHeading(group, focusAnchorId(anchor, index), section.heading),
    content: [
      `- Source container: ${note.fileName} (${note.filePath})`,
      "- Range: selected Markdown section",
      "",
      section.content
    ].join("\n")
  };
}

function latestRoundCandidate(
  workspace: PiContextWorkspace,
  anchor: PiFocusAnchor,
  index: number,
  group: FocusCandidateGroup
): FocusCandidate | undefined {
  if (anchor.kind === "note-selection") {
    return sourceMessageCandidate(workspace, anchor, index, group);
  }
  const node = workspace.resolveConversationNode(anchor.sourceNodeId);
  const messages = roundMessages(
    node,
    anchor.kind === "conversation-round"
      ? anchor.sourceMessageId
      : anchor.sourceMessageId
  );
  if (messages.length === 0) return undefined;
  return {
    key: `focus:node:${node.id}:round:${messages.at(-1)?.id ?? "latest"}`,
    sourceId: node.id,
    nodeId: node.id,
    group,
    header: candidateHeading(group, focusAnchorId(anchor, index), "Focused Round"),
    content: [
      `- Source container: ${node.title}`,
      "",
      renderMessages(messages)
    ].join("\n")
  };
}

function fullSourceCandidate(
  workspace: PiContextWorkspace,
  anchor: PiFocusAnchor,
  index: number,
  group: FocusCandidateGroup
): FocusCandidate {
  if (anchor.kind === "note-selection") {
    const note = workspace.resolveNotePath(anchor.filePath);
    return {
      key: `note:${note.filePath}:full`,
      sourceId: note.filePath,
      notePath: note.filePath,
      group,
      header: candidateHeading(group, focusAnchorId(anchor, index), "Full Note"),
      content: [
        `- Source container: ${note.fileName} (${note.filePath})`,
        "",
        note.content
      ].join("\n")
    };
  }
  const node = workspace.resolveConversationNode(anchor.sourceNodeId);
  const protectedRound = roundMessages(
    node,
    anchor.kind === "conversation-round"
      ? anchor.sourceMessageId
      : anchor.sourceMessageId
  );
  return {
    key: `node:${node.id}:all`,
    sourceId: node.id,
    nodeId: node.id,
    group,
    header: candidateHeading(group, focusAnchorId(anchor, index), "Full Conversation Node"),
    content: [
      ...(group === "structural-context" && protectedRound.length > 0
        ? [renderMessagesCompact(protectedRound)]
        : [
            `- Source container: ${node.title}`,
            ...(protectedRound.length === 0
              ? []
              : ["- Protected latest round:", renderMessagesCompact(protectedRound)])
          ]),
      "",
      "Additional full source:",
      renderConversationNodeTranscript(node)
    ].join("\n")
  };
}

function expansionCandidate(
  workspace: PiContextWorkspace,
  anchor: PiFocusAnchor,
  scope: PiFocusScope,
  index: number,
  group: FocusCandidateGroup
): FocusCandidate | undefined {
  if (scope === "containing_section") {
    return anchor.kind === "note-selection"
      ? containingSectionCandidate(workspace, anchor, index, group)
      : sourceMessageCandidate(workspace, anchor, index, group);
  }
  if (scope === "selection_only") {
    return anchor.kind === "conversation-round"
      ? latestRoundCandidate(workspace, anchor, index, group)
      : undefined;
  }
  if (scope === "source_message") {
    return sourceMessageCandidate(workspace, anchor, index, group);
  }
  if (scope === "latest_round") {
    return latestRoundCandidate(workspace, anchor, index, group);
  }
  return fullSourceCandidate(workspace, anchor, index, group);
}

function allowedScope(
  anchor: PiFocusAnchor,
  requested: PiFocusScope
): PiFocusScope {
  if (anchor.kind === "note-selection") {
    return requested === "containing_section" || requested === "full_source"
      ? requested
      : "selection_only";
  }
  if (anchor.kind === "conversation-round") {
    return requested === "full_source" ? "full_source" : "latest_round";
  }
  return requested === "selection_only" ||
    requested === "source_message" ||
    requested === "latest_round" ||
    requested === "full_source"
    ? requested
    : defaultScopeForAnchor(anchor);
}

function defaultScopeForAnchor(anchor: PiFocusAnchor): PiFocusScope {
  if (anchor.defaultScope !== undefined) return anchor.defaultScope;
  if (anchor.kind === "note-selection") return "selection_only";
  if (anchor.kind === "message-selection") return "source_message";
  return "latest_round";
}

function focusAnchorId(anchor: PiFocusAnchor, index: number): string {
  return anchor.id ?? `F${String(index + 1)}`;
}

export function resolvePiFocusDecisions(
  focus: PiFocusContext | undefined,
  decisions: PiFocusScope | readonly PiFocusDecision[]
): PiFocusDecision[] {
  if (focus === undefined) return [];
  return focus.anchors.map((anchor, index) => {
    const anchorId = focusAnchorId(anchor, index);
    const selected = typeof decisions === "string"
      ? undefined
      : decisions.find((decision) => decision.anchorId === anchorId);
    const requested = typeof decisions === "string"
      ? decisions
      : selected?.scope ?? defaultScopeForAnchor(anchor);
    return {
      anchorId,
      scope: allowedScope(anchor, requested),
      reason: selected?.reason ?? ""
    };
  });
}

function scopeForAnchor(
  anchor: PiFocusAnchor,
  index: number,
  decisions: PiFocusScope | readonly PiFocusDecision[]
): PiFocusScope {
  if (typeof decisions === "string") return allowedScope(anchor, decisions);
  const selected = decisions.find(
    (decision) => decision.anchorId === focusAnchorId(anchor, index)
  );
  return allowedScope(anchor, selected?.scope ?? defaultScopeForAnchor(anchor));
}

function focusSourceId(anchor: PiFocusAnchor): string {
  return anchor.kind === "note-selection"
    ? anchor.filePath
    : anchor.sourceNodeId;
}

function collectCandidate(
  candidates: FocusCandidate[],
  omitted: Array<{ sourceId: string; reason: string }>,
  anchor: PiFocusAnchor,
  build: () => FocusCandidate | undefined
): void {
  try {
    const candidate = build();
    if (candidate !== undefined) candidates.push(candidate);
  } catch (error) {
    omitted.push({
      sourceId: focusSourceId(anchor),
      reason: error instanceof Error ? error.message : String(error)
    });
  }
}

function focusCandidates(
  workspace: PiContextWorkspace,
  focus: PiFocusContext,
  decisions: PiFocusScope | readonly PiFocusDecision[],
  omitted: Array<{ sourceId: string; reason: string }>
): FocusCandidate[] {
  const candidates: FocusCandidate[] = [];
  const hasExactSelections = focus.anchors.some(
    (anchor) => anchor.kind === "message-selection" || anchor.kind === "note-selection"
  );
  focus.anchors.forEach((anchor, index) => {
    collectCandidate(
      candidates,
      omitted,
      anchor,
      () => selectionCandidate(workspace, anchor, index)
    );
  });
  focus.anchors.forEach((anchor, index) => {
    const group: FocusCandidateGroup = anchor.kind === "conversation-round"
      ? (hasExactSelections ? "structural-context" : "primary-target")
      : "target-context";
    collectCandidate(
      candidates,
      omitted,
      anchor,
      () => expansionCandidate(
        workspace,
        anchor,
        scopeForAnchor(anchor, index, decisions),
        index,
        group
      )
    );
  });
  const unique = candidates.filter((candidate, index, all) =>
    all.findIndex((entry) => entry.key === candidate.key) === index
  );
  const rank: Record<FocusCandidateGroup, number> = {
    "primary-target": 0,
    "structural-context": 1,
    "target-context": 2
  };
  return unique.sort((left, right) => rank[left.group] - rank[right.group]);
}

function groupHeading(group: FocusCandidateGroup): string {
  if (group === "primary-target") return "# Primary Target Evidence";
  if (group === "target-context") return "# Target Context";
  return "# Structural Context";
}

export function materializePiFocusEvidence(
  workspace: PiContextWorkspace,
  focus: PiFocusContext | undefined,
  decisions: PiFocusScope | readonly PiFocusDecision[],
  options: PiFocusEvidenceOptions
): PiMaterializedEvidence {
  const tokenBudget = Math.max(0, Math.trunc(options.tokenBudget));
  if (focus === undefined || focus.anchors.length === 0 || tokenBudget <= 0) {
    return {
      markdown: "",
      evidenceHash: sha256Hex(""),
      estimatedTokens: 0,
      tokenBudget,
      selectedNoteCount: 0,
      selectedNodeCount: 0,
      materializedNotePaths: [],
      materializedNodeIds: [],
      materializedKeys: [],
      omitted: [],
      truncated: tokenBudget <= 0 && (focus?.anchors.length ?? 0) > 0
    };
  }

  const documentHeader = "# Local Focus Evidence";
  const headerTokens = estimateTextTokens(`${documentHeader}\n\n`);
  const blocks: string[] = [];
  const notePaths = new Set<string>();
  const nodeIds = new Set<string>();
  const keys: string[] = [];
  const omitted: Array<{ sourceId: string; reason: string }> = [];
  const materializedGroups = new Set<FocusCandidateGroup>();
  let estimatedTokens = Math.min(headerTokens, tokenBudget);
  let truncated = tokenBudget < headerTokens;

  const resolvedDecisions = resolvePiFocusDecisions(focus, decisions);
  const candidates = focusCandidates(
    workspace,
    focus,
    resolvedDecisions,
    omitted
  );

  for (const candidate of candidates) {
    const firstInGroup = !materializedGroups.has(candidate.group);
    const prefix = firstInGroup
      ? `${blocks.length === 0 ? "" : "\n\n"}${groupHeading(candidate.group)}\n\n`
      : "\n\n---\n\n";
    const prefixTokens = estimateTextTokens(prefix);
    const remaining = tokenBudget - estimatedTokens - prefixTokens;
    const clipped = clipMarkdownToTokenBudget(
      candidate.header,
      candidate.content,
      remaining
    );
    if (clipped === undefined) {
      omitted.push({
        sourceId: candidate.sourceId,
        reason: "Protected focus token budget exhausted"
      });
      truncated = true;
      continue;
    }
    blocks.push(`${prefix}${clipped.text}`);
    materializedGroups.add(candidate.group);
    estimatedTokens += prefixTokens + clipped.tokens;
    truncated ||= clipped.truncated;
    keys.push(candidate.key);
    if (candidate.notePath !== undefined) notePaths.add(candidate.notePath);
    if (candidate.nodeId !== undefined) nodeIds.add(candidate.nodeId);
  }

  const markdown = blocks.length === 0
    ? `${documentHeader}\n\nFocused source could not be materialized.`
    : `${documentHeader}\n\n${blocks.join("")}`;
  return {
    markdown,
    evidenceHash: sha256Hex(markdown),
    estimatedTokens: blocks.length === 0
      ? Math.min(estimateTextTokens(markdown), tokenBudget)
      : estimatedTokens,
    tokenBudget,
    selectedNoteCount: notePaths.size,
    selectedNodeCount: nodeIds.size,
    materializedNotePaths: [...notePaths],
    materializedNodeIds: [...nodeIds],
    materializedKeys: keys,
    omitted,
    truncated
  };
}
