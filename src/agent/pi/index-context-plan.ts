import type {
  ContextMode,
  ContextPlan
} from "../../domain/context-engine";
import { estimateTextTokens } from "../../domain/context-engine";
import type {
  ConversationFile,
  NoteContextGraphSnapshot
} from "../../domain/types";
import type { PiConversationNodeSnapshot } from "../../execution/types";
import {
  buildPiConversationNodeSnapshots,
  listMarkdownHeadingEntries
} from "./context-index";
import { PiContextWorkspace } from "./context-workspace";

export interface BuildPiIndexContextPlanInput {
  conversation: ConversationFile;
  currentNodeId: string;
  currentQuestion: string;
  selectedQuotes: string[];
  noteContextGraph?: NoteContextGraphSnapshot;
  systemPrompt: string;
  mode: ContextMode;
}

export interface PiIndexContextPlanResult {
  contextPlan: ContextPlan;
  conversationNodes: PiConversationNodeSnapshot[];
  indexText: string;
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function noteIndexText(graph?: NoteContextGraphSnapshot): string {
  return (graph?.nodes ?? [])
    .map((node) => {
      const headings = listMarkdownHeadingEntries(node.content, 2)
        .slice(0, 6)
        .map((entry) => entry.heading);
      return [
        node.filePath,
        `depth=${String(node.depth)}`,
        `headings=${headings.join(" | ")}`
      ].join("\n");
    })
    .join("\n\n");
}

function fullBoundaryText(
  nodes: PiConversationNodeSnapshot[],
  graph: NoteContextGraphSnapshot | undefined,
  input: BuildPiIndexContextPlanInput
): string {
  return [
    input.systemPrompt,
    input.currentQuestion,
    ...input.selectedQuotes,
    ...nodes.flatMap((node) => node.messages.map((message) => message.content)),
    ...(graph?.nodes ?? []).map((node) => node.content)
  ].join("\n\n");
}

export function buildPiIndexContextPlan(
  input: BuildPiIndexContextPlanInput
): PiIndexContextPlanResult {
  const conversationNodes = buildPiConversationNodeSnapshots(
    input.conversation,
    input.currentNodeId
  );
  const workspace = new PiContextWorkspace(
    input.noteContextGraph,
    conversationNodes
  );
  const indexText = workspace.catalogText();
  const messages = input.systemPrompt.trim().length === 0
    ? []
    : [{ role: "system" as const, content: input.systemPrompt }];
  const sentText = [
    input.systemPrompt,
    indexText,
    input.currentQuestion,
    ...input.selectedQuotes
  ].join("\n\n");
  const fullText = fullBoundaryText(
    conversationNodes,
    input.noteContextGraph,
    input
  );
  const fullEstimatedTokens = estimateTextTokens(fullText);
  const sentEstimatedTokens = estimateTextTokens(sentText);
  const reducedTokens = Math.max(
    0,
    fullEstimatedTokens - sentEstimatedTokens
  );
  const noteContextOriginalEstimatedTokens = estimateTextTokens(
    (input.noteContextGraph?.nodes ?? [])
      .map((node) => node.content)
      .join("\n\n")
  );
  const noteContextSentEstimatedTokens = estimateTextTokens(
    noteIndexText(input.noteContextGraph)
  );
  const referencedNoteNames = [
    ...new Set(
      (input.noteContextGraph?.nodes ?? []).map((node) => node.fileName)
    )
  ];
  return {
    conversationNodes,
    indexText,
    contextPlan: {
      mode: input.mode,
      messages,
      fullEstimatedTokens,
      sentEstimatedTokens,
      reducedTokens,
      reductionRatio:
        fullEstimatedTokens === 0 ? 0 : reducedTokens / fullEstimatedTokens,
      stablePrefixHash: stableHash(sentText),
      trimmed: reducedTokens > 0,
      noteContextOriginalEstimatedTokens,
      noteContextSentEstimatedTokens,
      noteContextTrimmed:
        noteContextSentEstimatedTokens < noteContextOriginalEstimatedTokens,
      referencedNoteNames
    }
  };
}
