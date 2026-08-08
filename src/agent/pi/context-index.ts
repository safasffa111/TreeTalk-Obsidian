import type { ConversationFile, ConversationNode } from "../../domain/types";
import {
  locateMarkdownContainingSection,
  locateMarkdownSection,
  scanMarkdownHeadings
} from "./progressive/section-locator";
import type {
  PiConversationMessageSnapshot,
  PiConversationNodeSnapshot
} from "../../execution/types";

export interface MarkdownSection {
  heading: string;
  level: number;
  content: string;
}

export interface MarkdownHeadingEntry {
  heading: string;
  level: number;
}

interface MarkdownHeading {
  heading: string;
  normalized: string;
  level: number;
  lineStart: number;
  contentStart: number;
}

const CONCLUSION_HEADINGS = new Set([
  "结论",
  "核心结论",
  "总结",
  "核心总结",
  "摘要",
  "要点",
  "关键要点",
  "结语",
  "conclusion",
  "conclusions",
  "summary",
  "keytakeaways",
  "takeaways"
]);

export const MAX_INDEX_CONCLUSION_CHARS = 1_600;

function normalizeHeading(value: string): string {
  return value
    .replace(/[`*_~]/gu, "")
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .toLowerCase();
}

function headings(markdown: string): MarkdownHeading[] {
  return scanMarkdownHeadings(markdown).map((entry) => ({
    heading: entry.heading,
    normalized: normalizeHeading(entry.heading),
    level: entry.level,
    lineStart: entry.lineStart,
    contentStart: entry.contentStart
  }));
}

function sectionFromHeading(
  markdown: string,
  all: MarkdownHeading[],
  index: number
): MarkdownSection | undefined {
  const current = all[index];
  if (current === undefined) return undefined;
  const next = all
    .slice(index + 1)
    .find((candidate) => candidate.level <= current.level);
  const content = markdown
    .slice(current.contentStart, next?.lineStart ?? markdown.length)
    .trim();
  if (content.length === 0) return undefined;
  return {
    heading: current.heading,
    level: current.level,
    content
  };
}

export function extractMarkdownSection(
  markdown: string,
  requestedHeading: string
): MarkdownSection | undefined {
  const section = locateMarkdownSection(markdown, requestedHeading);
  return section === undefined
    ? undefined
    : { heading: section.heading, level: section.level, content: markdown.slice(section.contentStart, section.endOffset).trim() };
}

export function extractMarkdownContainingSection(
  markdown: string,
  selectionStartOffset: number
): MarkdownSection | undefined {
  const section = locateMarkdownContainingSection(markdown, selectionStartOffset);
  return section === undefined
    ? undefined
    : { heading: section.heading, level: section.level, content: markdown.slice(section.contentStart, section.endOffset).trim() };
}

export function extractMarkdownConclusion(
  markdown: string
): MarkdownSection | undefined {
  const all = headings(markdown);
  const index = all.findIndex((entry) =>
    CONCLUSION_HEADINGS.has(entry.normalized)
  );
  return index < 0 ? undefined : sectionFromHeading(markdown, all, index);
}

export function listMarkdownHeadingEntries(
  markdown: string,
  maximumLevel = 6
): MarkdownHeadingEntry[] {
  return headings(markdown)
    .filter((entry) => entry.level <= maximumLevel)
    .map((entry) => ({ heading: entry.heading, level: entry.level }));
}

export function listMarkdownHeadings(markdown: string): string[] {
  return listMarkdownHeadingEntries(markdown).map((entry) => entry.heading);
}

export function clipIndexConclusion(value: string): string {
  const characters = [...value.trim()];
  if (characters.length <= MAX_INDEX_CONCLUSION_CHARS) {
    return characters.join("");
  }
  return `${characters.slice(0, MAX_INDEX_CONCLUSION_CHARS).join("")}\n\n…（结论索引已截断，可按需读取原文）`;
}

function requiredNode(
  conversation: ConversationFile,
  nodeId: string
): ConversationNode {
  const node = conversation.nodes[nodeId];
  if (node === undefined) throw new Error(`Node not found: ${nodeId}`);
  return node;
}

function pathToNode(
  conversation: ConversationFile,
  nodeId: string
): ConversationNode[] {
  const reversed: ConversationNode[] = [];
  const seen = new Set<string>();
  let current: ConversationNode | undefined = requiredNode(conversation, nodeId);
  while (current !== undefined) {
    if (seen.has(current.id)) {
      throw new Error("Conversation path contains a cycle");
    }
    seen.add(current.id);
    reversed.push(current);
    current =
      current.parentId === null
        ? undefined
        : requiredNode(conversation, current.parentId);
  }
  return reversed.reverse();
}

function messageSnapshot(
  message: ConversationNode["messages"][number]
): PiConversationMessageSnapshot {
  const provenance = (message.agentRun?.progressiveContext?.batches ?? []).map(
    (batch) => ({
      level: batch.level,
      title: batch.title,
      relationship: batch.relationship,
      notePaths: [...batch.notePaths],
      nodeIds: [...batch.nodeIds]
    })
  );
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    status: message.status,
    selectionQuotes: (message.selectionContexts ?? [])
      .map((context) => context.quote.trim())
      .filter((quote) => quote.length > 0),
    ...(provenance.length === 0 ? {} : { provenance })
  };
}

export function buildPiConversationNodeSnapshots(
  conversation: ConversationFile,
  currentNodeId: string
): PiConversationNodeSnapshot[] {
  const path = pathToNode(conversation, currentNodeId);
  return path.map((node, depth) => ({
    id: node.id,
    parentId: node.parentId,
    title: node.title,
    depth,
    root: node.id === conversation.rootNodeId,
    current: node.id === currentNodeId,
    messages: node.messages.map(messageSnapshot)
  }));
}

export function latestNodeConclusion(
  node: PiConversationNodeSnapshot
): MarkdownSection | undefined {
  for (let index = node.messages.length - 1; index >= 0; index -= 1) {
    const message = node.messages[index];
    if (
      message?.role !== "assistant" ||
      message.status !== "complete" ||
      message.content.trim().length === 0
    ) {
      continue;
    }
    const conclusion = extractMarkdownConclusion(message.content);
    if (conclusion !== undefined) return conclusion;
  }
  return undefined;
}

export function renderConversationNodeTranscript(
  node: PiConversationNodeSnapshot
): string {
  const parts = [
    `# ${node.title}`,
    "",
    `- Node ID: ${node.id}`,
    `- Parent ID: ${node.parentId ?? "none"}`
  ];
  for (const message of node.messages) {
    parts.push(
      "",
      message.role === "user" ? "## User" : "## Assistant",
      "",
      message.content
    );
    if (message.selectionQuotes.length > 0) {
      parts.push(
        "",
        "### Exact selections",
        "",
        ...message.selectionQuotes.map((quote) => `> ${quote.replace(/\n/gu, "\n> ")}`)
      );
    }
  }
  return parts.join("\n").trim();
}
