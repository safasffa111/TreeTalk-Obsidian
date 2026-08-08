import type {
  NoteContextGraphEdge,
  NoteContextGraphNode,
  NoteContextGraphSnapshot
} from "../../domain/types";
import type { PiConversationNodeSnapshot } from "../../execution/types";
import type { ProgressiveContextSnapshot } from "./progressive/types";
import {
  clipIndexConclusion,
  extractMarkdownConclusion,
  extractMarkdownSection,
  latestNodeConclusion,
  listMarkdownHeadingEntries,
  listMarkdownHeadings,
  renderConversationNodeTranscript
} from "./context-index";
import {
  compareStable,
  sha256Hex,
  stableNodeSourceId,
  stableNoteSourceId
} from "./cache-identity";

export interface PiToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface PiToolExecutionDetails {
  toolName: string;
  notePaths: string[];
  nodeIds: string[];
  summary: string;
}

export interface PiToolExecutionResult {
  content: string;
  details: PiToolExecutionDetails;
}

export interface PiContextCatalogNoteBlock {
  id: string;
  detailedMarkdown: string;
  compactMarkdown: string;
  root: boolean;
  depth: number;
  relevanceScore: number;
}

export interface PiContextCatalogNodeBlock {
  id: string;
  detailedMarkdown: string;
  compactMarkdown: string;
  current: boolean;
  depth: number;
}

export interface PiContextCatalogDiagnostics {
  candidateNoteCount: number;
  candidateNodeCount: number;
  availableDetailedNoteCount: number;
}

export interface PiContextCatalogSnapshot {
  stableMarkdown: string;
  dynamicMarkdown: string;
  markdown: string;
  stableHash: string;
  markdownHash: string;
  stableHeaderMarkdown?: string;
  noteBlocks?: PiContextCatalogNoteBlock[];
  dynamicHeaderMarkdown?: string;
  nodeBlocks?: PiContextCatalogNodeBlock[];
  diagnostics?: PiContextCatalogDiagnostics;
}

export interface PiContextCatalogOptions {
  queryText?: string;
}

const DEFAULT_READ_CHARS = 12_000;
const MAX_READ_CHARS = 40_000;
const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 20;

function normalizePath(value: string): string {
  return value.replace(/\\/gu, "/").replace(/^\.\//u, "").trim();
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("tool arguments must be an object");
  }
  return value as Record<string, unknown>;
}

function requiredString(
  source: Record<string, unknown>,
  key: string
): string {
  const value = source[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${key} must be a non-empty string`);
  }
  return value.trim();
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

function lineExcerpt(content: string, query: string, radius = 160): string {
  const lower = content.toLowerCase();
  const index = lower.indexOf(query.toLowerCase());
  if (index < 0) return content.slice(0, radius * 2).trim();
  const start = Math.max(0, index - radius);
  const end = Math.min(content.length, index + query.length + radius);
  return `${start > 0 ? "…" : ""}${content.slice(start, end).trim()}${
    end < content.length ? "…" : ""
  }`;
}

function catalogHeadings(markdown: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of listMarkdownHeadingEntries(markdown, 2)) {
    const heading = entry.heading.trim();
    const key = heading.toLowerCase();
    if (heading.length === 0 || seen.has(key)) continue;
    seen.add(key);
    result.push(heading);
    if (result.length >= 6) break;
  }
  return result;
}

function queryTerms(value: string | undefined): string[] {
  if (value === undefined) return [];
  return [...new Set(
    value
      .toLowerCase()
      .split(/[\s\p{P}\p{S}]+/u)
      .map((term) => term.trim())
      .filter((term) => term.length >= 2)
  )].slice(0, 12);
}

function noteRelevanceScore(
  node: NoteContextGraphNode,
  headings: readonly string[],
  terms: readonly string[]
): number {
  let score = node.root ? 10_000 : Math.max(0, 1_000 - node.depth * 100);
  const title = `${node.fileName} ${node.filePath}`.toLowerCase();
  const headingText = headings.join(" ").toLowerCase();
  for (const term of terms) {
    if (title.includes(term)) score += 500;
    if (headingText.includes(term)) score += 250;
  }
  return score;
}

function noteMetadata(node: NoteContextGraphNode): Record<string, unknown> {
  const conclusion = extractMarkdownConclusion(node.content);
  return {
    id: node.id,
    path: node.filePath,
    title: node.fileName,
    depth: node.depth,
    root: node.root,
    incomingCount: node.parentIds.length,
    outgoingCount: node.outgoingNodeIds.length,
    primaryChain: [...node.primaryChain],
    ...(conclusion === undefined
      ? {}
      : {
          conclusionHeading: conclusion.heading,
          conclusion: clipIndexConclusion(conclusion.content)
        })
  };
}

function conversationNodeMetadata(
  node: PiConversationNodeSnapshot
): Record<string, unknown> {
  const conclusion = latestNodeConclusion(node);
  return {
    id: node.id,
    title: node.title,
    parentId: node.parentId,
    depth: node.depth,
    root: node.root,
    current: node.current,
    messageCount: node.messages.length,
    ...(conclusion === undefined
      ? {}
      : {
          conclusionHeading: conclusion.heading,
          conclusion: clipIndexConclusion(conclusion.content)
        })
  };
}

export const PI_CONTEXT_TOOL_DEFINITIONS: PiToolDefinition[] = [
  {
    name: "list_context_notes",
    description:
      "List every Markdown note inside the frozen TreeTalk context boundary, including only names, graph metadata, and explicit conclusion sections.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "list_context_nodes",
    description:
      "List every conversation node on the frozen TreeTalk branch, including only node names and explicit conclusion sections.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "read_context_note",
    description:
      "Read a chunk of one note already inside the frozen TreeTalk context boundary. Prefer read_context_note_section when a specific section is enough.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Exact Vault-relative Markdown path from the frozen context"
        },
        offset: {
          type: "integer",
          minimum: 0,
          description: "Character offset, default 0"
        },
        maxChars: {
          type: "integer",
          minimum: 256,
          maximum: MAX_READ_CHARS,
          description: "Maximum characters to return, default 12000"
        }
      },
      required: ["path"],
      additionalProperties: false
    }
  },
  {
    name: "read_context_note_section",
    description:
      "Read one Markdown section from a note inside the frozen context. The section ends at the next heading of the same or higher level.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Exact Vault-relative Markdown path from the frozen context"
        },
        heading: {
          type: "string",
          description: "Exact Markdown heading text to read"
        },
        maxChars: {
          type: "integer",
          minimum: 256,
          maximum: MAX_READ_CHARS,
          description: "Maximum characters to return, default 12000"
        }
      },
      required: ["path", "heading"],
      additionalProperties: false
    }
  },
  {
    name: "read_context_node",
    description:
      "Read the complete transcript of one conversation node on the frozen TreeTalk branch. Historical node answers are not sent unless this tool is called.",
    parameters: {
      type: "object",
      properties: {
        nodeId: {
          type: "string",
          description: "Exact TreeTalk node ID from the context index"
        },
        offset: {
          type: "integer",
          minimum: 0,
          description: "Character offset, default 0"
        },
        maxChars: {
          type: "integer",
          minimum: 256,
          maximum: MAX_READ_CHARS,
          description: "Maximum characters to return, default 12000"
        }
      },
      required: ["nodeId"],
      additionalProperties: false
    }
  },
  {
    name: "search_context_notes",
    description:
      "Search only within frozen TreeTalk context notes and return matching snippets. This never searches outside the user's selected context boundary.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to search for" },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_SEARCH_LIMIT,
          description: "Maximum result count, default 8"
        }
      },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    name: "get_context_links",
    description:
      "Get both forward links and backlinks for one note inside the frozen TreeTalk context. Both directions have equal status for exploration.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Exact Vault-relative Markdown path from the frozen context"
        }
      },
      required: ["path"],
      additionalProperties: false
    }
  }
];

export class PiContextWorkspace {
  private readonly nodesByPath = new Map<string, NoteContextGraphNode>();
  private readonly noteNodesById = new Map<string, NoteContextGraphNode>();
  private readonly conversationNodesById = new Map<
    string,
    PiConversationNodeSnapshot
  >();
  private readonly outgoingByPath = new Map<string, NoteContextGraphEdge[]>();
  private readonly incomingByPath = new Map<string, NoteContextGraphEdge[]>();
  private readonly notesByCompactId = new Map<string, NoteContextGraphNode>();
  private readonly legacyNotesByCompactId = new Map<string, NoteContextGraphNode>();
  private readonly compactNoteIdByNodeId = new Map<string, string>();
  private readonly conversationNodesByCompactId = new Map<
    string,
    PiConversationNodeSnapshot
  >();
  private readonly legacyConversationNodesByCompactId = new Map<
    string,
    PiConversationNodeSnapshot
  >();
  private readonly compactConversationNodeIdById = new Map<string, string>();

  constructor(
    private readonly graph?: NoteContextGraphSnapshot,
    private readonly conversationNodes: PiConversationNodeSnapshot[] = []
  ) {
    const sortedNotes = [...(graph?.nodes ?? [])].sort((left, right) => {
      if (left.depth !== right.depth) return left.depth - right.depth;
      return compareStable(left.filePath, right.filePath);
    });
    for (const [index, node] of sortedNotes.entries()) {
      const path = normalizePath(node.filePath);
      const compactId = stableNoteSourceId(path);
      const existing = this.notesByCompactId.get(compactId);
      if (existing !== undefined && normalizePath(existing.filePath) !== path) {
        throw new Error(`Stable note source ID collision: ${compactId}`);
      }
      this.nodesByPath.set(path, node);
      this.noteNodesById.set(node.id, node);
      this.notesByCompactId.set(compactId, node);
      this.legacyNotesByCompactId.set(`P${String(index + 1)}`, node);
      this.compactNoteIdByNodeId.set(node.id, compactId);
      this.outgoingByPath.set(path, []);
      this.incomingByPath.set(path, []);
    }
    const sortedConversationNodes = [...conversationNodes].sort((left, right) => {
      if (left.depth !== right.depth) return left.depth - right.depth;
      return compareStable(left.id, right.id);
    });
    for (const [index, node] of sortedConversationNodes.entries()) {
      const compactId = stableNodeSourceId(node.id);
      const existing = this.conversationNodesByCompactId.get(compactId);
      if (existing !== undefined && existing.id !== node.id) {
        throw new Error(`Stable conversation-node source ID collision: ${compactId}`);
      }
      this.conversationNodesById.set(node.id, node);
      this.conversationNodesByCompactId.set(compactId, node);
      this.legacyConversationNodesByCompactId.set(`N${String(index + 1)}`, node);
      this.compactConversationNodeIdById.set(node.id, compactId);
    }
    for (const edge of graph?.edges ?? []) {
      const source = this.noteNodesById.get(edge.sourceNodeId);
      const target = this.noteNodesById.get(edge.targetNodeId);
      if (source === undefined || target === undefined) continue;
      this.outgoingByPath.get(normalizePath(source.filePath))?.push(edge);
      this.incomingByPath.get(normalizePath(target.filePath))?.push(edge);
    }
  }

  progressiveSnapshot(): ProgressiveContextSnapshot {
    const notes = [...this.nodesByPath.values()]
      .sort((left, right) => left.depth - right.depth || compareStable(left.filePath, right.filePath))
      .map((node) => ({
        id: node.id,
        filePath: normalizePath(node.filePath),
        fileName: node.fileName,
        depth: node.depth,
        root: node.root,
        ...(node.primaryParentId === undefined ? {} : { primaryParentId: node.primaryParentId }),
        content: node.content,
        revision: sha256Hex(`${normalizePath(node.filePath)}\n${node.content}`)
      }));
    const edges = (this.graph?.edges ?? []).map((edge) => ({
      sourceNodeId: edge.sourceNodeId,
      targetNodeId: edge.targetNodeId,
      labels: [...edge.labels]
    }));
    const conversationNodes = [...this.conversationNodes]
      .sort((left, right) => left.depth - right.depth || compareStable(left.id, right.id))
      .map((node) => structuredClone(node));
    return { notes, edges, conversationNodes };
  }

  hasNotes(): boolean {
    return this.nodesByPath.size > 0;
  }

  hasConversationNodes(): boolean {
    return this.conversationNodesById.size > 0;
  }

  resolveNoteId(compactId: string): NoteContextGraphNode {
    const normalized = compactId.trim();
    const node =
      this.notesByCompactId.get(normalized) ??
      this.legacyNotesByCompactId.get(normalized);
    if (node === undefined) {
      throw new Error(
        `Note selection is outside the frozen TreeTalk context boundary: ${compactId}`
      );
    }
    return node;
  }

  resolveNotePath(filePath: string): NoteContextGraphNode {
    const normalized = normalizePath(filePath);
    const node = this.nodesByPath.get(normalized);
    if (node === undefined) {
      throw new Error(
        `Note is outside the frozen TreeTalk context boundary: ${filePath}`
      );
    }
    return node;
  }

  resolveConversationNode(nodeId: string): PiConversationNodeSnapshot {
    const node = this.conversationNodesById.get(nodeId);
    if (node === undefined) {
      throw new Error(
        `Conversation node is outside the frozen TreeTalk branch: ${nodeId}`
      );
    }
    return node;
  }

  resolveConversationNodeId(compactId: string): PiConversationNodeSnapshot {
    const normalized = compactId.trim();
    const node =
      this.conversationNodesByCompactId.get(normalized) ??
      this.legacyConversationNodesByCompactId.get(normalized);
    if (node === undefined) {
      throw new Error(
        `Conversation-node selection is outside the frozen TreeTalk context boundary: ${compactId}`
      );
    }
    return node;
  }

  compactNoteId(nodeId: string): string | undefined {
    return this.compactNoteIdByNodeId.get(nodeId);
  }

  compactConversationNodeId(nodeId: string): string | undefined {
    return this.compactConversationNodeIdById.get(nodeId);
  }

  noteSection(compactId: string, heading: string): {
    node: NoteContextGraphNode;
    heading: string;
    content: string;
  } {
    const node = this.resolveNoteId(compactId);
    const section = extractMarkdownSection(node.content, heading);
    if (section === undefined) {
      throw new Error(
        `Markdown section not found in ${node.filePath}: ${heading}. Available headings: ${
          listMarkdownHeadings(node.content).join(", ") || "none"
        }`
      );
    }
    return { node, heading: section.heading, content: section.content };
  }

  conversationNodePart(
    compactId: string,
    part: "question" | "answer" | "selection" | "all"
  ): { node: PiConversationNodeSnapshot; label: string; content: string } {
    const node = this.resolveConversationNodeId(compactId);
    if (part === "all") {
      return { node, label: "完整节点", content: renderConversationNodeTranscript(node) };
    }
    if (part === "question") {
      return {
        node,
        label: "问题",
        content: node.messages
          .filter((message) => message.role === "user")
          .map((message) => message.content)
          .join("\n\n")
          .trim()
      };
    }
    if (part === "answer") {
      return {
        node,
        label: "回答",
        content: node.messages
          .filter(
            (message) => message.role === "assistant" && message.status === "complete"
          )
          .map((message) => message.content)
          .join("\n\n")
          .trim()
      };
    }
    return {
      node,
      label: "精确框选",
      content: node.messages
        .flatMap((message) => message.selectionQuotes)
        .map((quote) => `> ${quote.replace(/\n/gu, "\n> ")}`)
        .join("\n\n")
        .trim()
    };
  }

  catalogSnapshot(options: PiContextCatalogOptions = {}): PiContextCatalogSnapshot {
    const terms = queryTerms(options.queryText);
    const stableHeaderMarkdown = [
      "# Stable Note Catalog",
      "",
      "> Candidate-note index only. Note bodies and conclusion text are omitted. Every detailed entry contains a stable ID, title, depth, focus relationship, and at most six level-1/level-2 headings."
    ].join("\n");

    const relationshipFor = (node: NoteContextGraphNode): string => {
      if (node.root) return "用户框选源笔记";
      const parentNode = node.primaryParentId === undefined
        ? undefined
        : this.noteNodesById.get(node.primaryParentId);
      const parentId = parentNode === undefined
        ? undefined
        : this.compactNoteIdByNodeId.get(parentNode.id);
      const edge = parentNode === undefined
        ? undefined
        : (this.graph?.edges ?? []).find((candidate) =>
            (candidate.sourceNodeId === parentNode.id && candidate.targetNodeId === node.id) ||
            (candidate.sourceNodeId === node.id && candidate.targetNodeId === parentNode.id)
          );
      const labels = edge === undefined || edge.labels.length === 0
        ? ""
        : `；链接标签：${[...edge.labels].sort((left, right) => compareStable(left, right)).join("、")}`;
      if (parentId === undefined) return `距焦点 ${String(node.depth)} 层关联候选${labels}`;
      if (edge?.sourceNodeId === node.id) {
        return `距焦点 ${String(node.depth)} 层；当前 → ${parentId}${labels}`;
      }
      return `距焦点 ${String(node.depth)} 层；${parentId} → 当前${labels}`;
    };

    const noteBlocks: PiContextCatalogNoteBlock[] = [...this.notesByCompactId.entries()]
      .map(([id, node]) => {
        const headings = catalogHeadings(node.content);
        const relation = relationshipFor(node);
        const detailedMarkdown = [
          `## ${id} · ${node.fileName}`,
          "",
          `- ID：${id}`,
          `- 标题：${node.fileName}`,
          `- 深度：${String(node.depth)}`,
          `- 与焦点关系：${relation}`,
          `- 一级/二级标题：${headings.length === 0 ? "无" : headings.join("；")}`
        ].join("\n");
        const compactMarkdown = [
          `## ${id} · ${node.fileName}`,
          "",
          `- 深度：${String(node.depth)}`,
          `- 与焦点关系：${relation}`
        ].join("\n");
        return {
          id,
          detailedMarkdown,
          compactMarkdown,
          root: node.root,
          depth: node.depth,
          relevanceScore: noteRelevanceScore(node, headings, terms)
        };
      })
      .sort((left, right) => {
        if (left.relevanceScore !== right.relevanceScore) {
          return right.relevanceScore - left.relevanceScore;
        }
        if (left.depth !== right.depth) return left.depth - right.depth;
        return compareStable(left.id, right.id);
      });

    const dynamicHeaderMarkdown = [
      "# Dynamic Conversation Branch",
      "",
      "> Compact frozen root-to-current branch index. Historical answer bodies and conclusion text are omitted."
    ].join("\n");
    const orderedNodes = [...this.conversationNodes].sort((left, right) => {
      if (left.depth !== right.depth) return left.depth - right.depth;
      return compareStable(left.id, right.id);
    });
    const nodeBlocks: PiContextCatalogNodeBlock[] = orderedNodes.flatMap((node) => {
      const id = this.compactConversationNodeIdById.get(node.id);
      if (id === undefined) return [];
      const state = node.current ? "当前节点" : node.root ? "根节点" : "历史节点";
      const parentId = node.parentId === null
        ? undefined
        : this.compactConversationNodeIdById.get(node.parentId);
      const latestQuestion = [...node.messages]
        .reverse()
        .find((message) => message.role === "user")?.content.trim();
      const detailedMarkdown = [
        `## ${id} · ${node.title}`,
        "",
        `- 深度：${String(node.depth)}`,
        `- 状态：${state}`,
        ...(parentId === undefined ? [] : [`- 父节点：${parentId}`]),
        ...(latestQuestion === undefined || latestQuestion.length === 0
          ? []
          : [`- 最近问题：${latestQuestion.slice(0, 120)}`])
      ].join("\n");
      const compactMarkdown = [
        `## ${id} · ${node.title}`,
        "",
        `- 深度：${String(node.depth)}`,
        `- 状态：${state}`
      ].join("\n");
      return [{
        id,
        detailedMarkdown,
        compactMarkdown,
        current: node.current,
        depth: node.depth
      }];
    });

    const stableMarkdown = [
      stableHeaderMarkdown,
      ...noteBlocks.map((block) => block.detailedMarkdown)
    ].join("\n\n");
    const dynamicMarkdown = [
      dynamicHeaderMarkdown,
      ...nodeBlocks.map((block) => block.detailedMarkdown)
    ].join("\n\n");
    const markdown = `${stableMarkdown}\n\n${dynamicMarkdown}`;
    return {
      stableMarkdown,
      dynamicMarkdown,
      markdown,
      stableHash: sha256Hex(stableMarkdown),
      markdownHash: sha256Hex(markdown),
      stableHeaderMarkdown,
      noteBlocks,
      dynamicHeaderMarkdown,
      nodeBlocks,
      diagnostics: {
        candidateNoteCount: noteBlocks.length,
        candidateNodeCount: nodeBlocks.length,
        availableDetailedNoteCount: noteBlocks.length
      }
    };
  }

  catalogText(options: PiContextCatalogOptions = {}): string {
    return this.catalogSnapshot(options).markdown;
  }

  async execute(
    toolName: string,
    rawArguments: unknown
  ): Promise<PiToolExecutionResult> {
    const args = asRecord(rawArguments);
    if (toolName === "list_context_notes") {
      const notes = [...this.nodesByPath.values()]
        .sort((left, right) => {
          if (left.depth !== right.depth) return left.depth - right.depth;
          return compareStable(left.filePath, right.filePath);
        })
        .map(noteMetadata);
      return {
        content: JSON.stringify(
          {
            boundary: "frozen-selected-context",
            noteCount: notes.length,
            rootPaths: (this.graph?.rootNodeIds ?? [])
              .map((id) => this.noteNodesById.get(id)?.filePath)
              .filter((value): value is string => value !== undefined),
            notes
          },
          null,
          2
        ),
        details: {
          toolName,
          notePaths: notes.map((note) => String(note.path)),
          nodeIds: [],
          summary: `Listed ${String(notes.length)} frozen context notes`
        }
      };
    }

    if (toolName === "list_context_nodes") {
      const nodes = this.conversationNodes.map(conversationNodeMetadata);
      return {
        content: JSON.stringify(
          {
            boundary: "frozen-current-branch",
            nodeCount: nodes.length,
            nodes
          },
          null,
          2
        ),
        details: {
          toolName,
          notePaths: [],
          nodeIds: nodes.map((node) => String(node.id)),
          summary: `Listed ${String(nodes.length)} frozen conversation nodes`
        }
      };
    }

    if (toolName === "read_context_note") {
      const path = normalizePath(requiredString(args, "path"));
      const node = this.nodesByPath.get(path);
      if (node === undefined) {
        throw new Error(
          `Note is outside the frozen TreeTalk context boundary: ${path}`
        );
      }
      const offset = boundedInteger(args.offset, 0, 0, node.content.length);
      const maxChars = boundedInteger(
        args.maxChars,
        DEFAULT_READ_CHARS,
        256,
        MAX_READ_CHARS
      );
      const content = node.content.slice(offset, offset + maxChars);
      const nextOffset = offset + content.length;
      return {
        content: JSON.stringify(
          {
            path: node.filePath,
            title: node.fileName,
            depth: node.depth,
            root: node.root,
            offset,
            nextOffset,
            totalChars: node.content.length,
            truncated: nextOffset < node.content.length,
            content
          },
          null,
          2
        ),
        details: {
          toolName,
          notePaths: [node.filePath],
          nodeIds: [],
          summary: `Read ${node.filePath} (${String(content.length)} chars)`
        }
      };
    }

    if (toolName === "read_context_note_section") {
      const path = normalizePath(requiredString(args, "path"));
      const heading = requiredString(args, "heading");
      const node = this.nodesByPath.get(path);
      if (node === undefined) {
        throw new Error(
          `Note is outside the frozen TreeTalk context boundary: ${path}`
        );
      }
      const section = extractMarkdownSection(node.content, heading);
      if (section === undefined) {
        const available = listMarkdownHeadings(node.content);
        throw new Error(
          `Markdown section not found in ${path}: ${heading}. Available headings: ${
            available.length === 0 ? "none" : available.join(", ")
          }`
        );
      }
      const maxChars = boundedInteger(
        args.maxChars,
        DEFAULT_READ_CHARS,
        256,
        MAX_READ_CHARS
      );
      const content = section.content.slice(0, maxChars);
      return {
        content: JSON.stringify(
          {
            path: node.filePath,
            title: node.fileName,
            heading: section.heading,
            level: section.level,
            totalChars: section.content.length,
            truncated: content.length < section.content.length,
            content
          },
          null,
          2
        ),
        details: {
          toolName,
          notePaths: [node.filePath],
          nodeIds: [],
          summary: `Read section ${section.heading} from ${node.filePath} (${String(content.length)} chars)`
        }
      };
    }

    if (toolName === "read_context_node") {
      const nodeId = requiredString(args, "nodeId");
      const node = this.conversationNodesById.get(nodeId);
      if (node === undefined) {
        throw new Error(
          `Conversation node is outside the frozen TreeTalk context boundary: ${nodeId}`
        );
      }
      const transcript = renderConversationNodeTranscript(node);
      const offset = boundedInteger(args.offset, 0, 0, transcript.length);
      const maxChars = boundedInteger(
        args.maxChars,
        DEFAULT_READ_CHARS,
        256,
        MAX_READ_CHARS
      );
      const content = transcript.slice(offset, offset + maxChars);
      const nextOffset = offset + content.length;
      return {
        content: JSON.stringify(
          {
            nodeId: node.id,
            title: node.title,
            parentId: node.parentId,
            depth: node.depth,
            offset,
            nextOffset,
            totalChars: transcript.length,
            truncated: nextOffset < transcript.length,
            content
          },
          null,
          2
        ),
        details: {
          toolName,
          notePaths: [],
          nodeIds: [node.id],
          summary: `Read TreeTalk node ${node.id} (${String(content.length)} chars)`
        }
      };
    }

    if (toolName === "search_context_notes") {
      const query = requiredString(args, "query");
      const limit = boundedInteger(
        args.limit,
        DEFAULT_SEARCH_LIMIT,
        1,
        MAX_SEARCH_LIMIT
      );
      const lowered = query.toLowerCase();
      const matches = [...this.nodesByPath.values()]
        .filter((node) =>
          `${node.fileName}\n${node.filePath}\n${node.content}`
            .toLowerCase()
            .includes(lowered)
        )
        .sort((left, right) => {
          if (left.root !== right.root) return left.root ? -1 : 1;
          if (left.depth !== right.depth) return left.depth - right.depth;
          return compareStable(left.filePath, right.filePath);
        })
        .slice(0, limit)
        .map((node) => ({
          path: node.filePath,
          title: node.fileName,
          depth: node.depth,
          root: node.root,
          snippet: lineExcerpt(node.content, query)
        }));
      return {
        content: JSON.stringify({ query, matches }, null, 2),
        details: {
          toolName,
          notePaths: matches.map((match) => match.path),
          nodeIds: [],
          summary: `Found ${String(matches.length)} notes for ${query}`
        }
      };
    }

    if (toolName === "get_context_links") {
      const path = normalizePath(requiredString(args, "path"));
      const node = this.nodesByPath.get(path);
      if (node === undefined) {
        throw new Error(
          `Note is outside the frozen TreeTalk context boundary: ${path}`
        );
      }
      const mapEdge = (
        edge: NoteContextGraphEdge,
        direction: "forward" | "backlink"
      ): Record<string, unknown> => {
        const otherId =
          direction === "forward" ? edge.targetNodeId : edge.sourceNodeId;
        const other = this.noteNodesById.get(otherId);
        return {
          path: other?.filePath ?? otherId,
          title: other?.fileName ?? otherId,
          labels: [...edge.labels]
        };
      };
      const forwardLinks = (this.outgoingByPath.get(path) ?? []).map((edge) =>
        mapEdge(edge, "forward")
      );
      const backlinks = (this.incomingByPath.get(path) ?? []).map((edge) =>
        mapEdge(edge, "backlink")
      );
      return {
        content: JSON.stringify(
          {
            path: node.filePath,
            forwardLinks,
            backlinks
          },
          null,
          2
        ),
        details: {
          toolName,
          notePaths: [
            node.filePath,
            ...forwardLinks.map((entry) => String(entry.path)),
            ...backlinks.map((entry) => String(entry.path))
          ],
          nodeIds: [],
          summary: `Resolved ${String(forwardLinks.length)} forward links and ${String(
            backlinks.length
          )} backlinks for ${node.filePath}`
        }
      };
    }

    throw new Error(`Unknown Pi context tool: ${toolName}`);
  }
}
