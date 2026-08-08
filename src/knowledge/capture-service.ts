import {
  conversationRelationshipNodeId,
  relationshipEdgeId,
  createRelationshipProjection
} from "../relationship-graph/model";
import type { RelationshipGraphProjection } from "../relationship-graph/types";
import type {
  ChatMessage,
  ConversationFile,
  ConversationNode,
  NoteSelectionContext,
  SelectionAnchor
} from "../domain/types";
import {
  isMessageSelectionContext,
  isNoteSelectionContext
} from "../domain/types";
import type { VaultPort } from "../storage/conversation-repository";
import {
  insertMarkdownLinks,
  markdownWikiLink,
  resolveMarkdownAnchor,
  type MarkdownLink,
  type MarkdownLinkInsertion
} from "./markdown-branch-links";

export type KnowledgeCaptureRequest =
  | { scope: "tree"; conversation: ConversationFile }
  | {
      scope: "answer";
      conversation: ConversationFile;
      nodeId: string;
      messageId: string;
    };

interface ExportNodeNote {
  nodeId: string;
  title: string;
  path: string;
}

interface TreeExportPlan {
  folder: string;
  indexPath: string;
  nodes: Record<string, ExportNodeNote>;
}

interface MessageBranchGroup {
  sourceNodeId: string;
  sourceMessageId: string;
  context: SelectionAnchor;
  links: MarkdownLink[];
}

interface NoteBranchGroup {
  sourcePath: string;
  sourceTitle: string;
  context?: NoteSelectionContext;
  links: MarkdownLink[];
}

function normalizeFolder(value: string): string {
  return value.replace(/\\/gu, "/").replace(/^\/+|\/+$/gu, "");
}

function safeFileStem(value: string): string {
  const safe = value
    .replace(/[\\/:*?"<>|#]/gu, "-")
    .replaceAll("[", "-")
    .replaceAll("]", "-")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/gu, " ")
    .replace(/[. ]+$/gu, "")
    .trim()
    .slice(0, 60)
    .trim();
  return safe.length > 0 ? safe : "未命名";
}

function timestampForFile(now: string): string {
  return now.replace(/[-:]/gu, "").replace("T", "-").slice(0, 15);
}

function requireNode(
  conversation: ConversationFile,
  nodeId: string
): ConversationNode {
  const node = conversation.nodes[nodeId];
  if (node === undefined) throw new Error(`Node not found: ${nodeId}`);
  return node;
}

function requireMessage(
  node: ConversationNode,
  messageId: string
): ChatMessage {
  const message = node.messages.find((entry) => entry.id === messageId);
  if (message === undefined) throw new Error(`Message not found: ${messageId}`);
  return message;
}

function nodeTitle(node: ConversationNode): string {
  const title = node.title.trim();
  if (title.length > 0) return title;
  const question = node.messages.find((message) => message.role === "user")
    ?.content.trim();
  return question !== undefined && question.length > 0 ? question : "未命名";
}

function hasStreamingResponse(conversation: ConversationFile): boolean {
  return Object.values(conversation.nodes).some((node) =>
    node.messages.some(
      (message) => message.role === "assistant" && message.status === "streaming"
    )
  );
}

function orderedNodeIds(conversation: ConversationFile): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const visit = (nodeId: string): void => {
    if (seen.has(nodeId)) return;
    seen.add(nodeId);
    ordered.push(nodeId);
    const node = conversation.nodes[nodeId];
    if (node === undefined) return;
    for (const childId of node.childIds) visit(childId);
  };
  visit(conversation.rootNodeId);
  for (const nodeId of Object.keys(conversation.nodes)) visit(nodeId);
  return ordered;
}

async function uniqueFolder(
  vault: VaultPort,
  root: string,
  stem: string
): Promise<string> {
  const normalizedRoot = normalizeFolder(root);
  let suffix = 1;
  let folder = `${normalizedRoot}/${stem}`;
  while ((await vault.list(`${folder}/`)).length > 0) {
    suffix += 1;
    folder = `${normalizedRoot}/${stem}-${String(suffix)}`;
  }
  return folder;
}

async function uniquePath(
  vault: VaultPort,
  folder: string,
  stem: string,
  reserved: Set<string>
): Promise<string> {
  let suffix = 1;
  let path = `${folder}/${stem}.md`;
  while (reserved.has(path) || (await vault.exists(path))) {
    suffix += 1;
    path = `${folder}/${stem} ${String(suffix)}.md`;
  }
  reserved.add(path);
  return path;
}

async function buildTreeExportPlan(
  vault: VaultPort,
  conversation: ConversationFile,
  capturedAt: string,
  treeFolder: string,
  includedNodeIds: Set<string>
): Promise<TreeExportPlan> {
  const conversationStem = safeFileStem(conversation.title);
  const folder = await uniqueFolder(
    vault,
    treeFolder,
    `${timestampForFile(capturedAt)}-${conversationStem}`
  );
  const reserved = new Set<string>();
  const indexPath = await uniquePath(vault, folder, "节点列表", reserved);
  const nodes: Record<string, ExportNodeNote> = {};
  for (const nodeId of orderedNodeIds(conversation)) {
    if (!includedNodeIds.has(nodeId)) continue;
    const node = requireNode(conversation, nodeId);
    const title = nodeTitle(node);
    nodes[nodeId] = {
      nodeId,
      title,
      path: await uniquePath(vault, folder, safeFileStem(title), reserved)
    };
  }
  return { folder, indexPath, nodes };
}

function addUniqueLink(target: MarkdownLink[], link: MarkdownLink): void {
  if (
    !target.some(
      (entry) => entry.path === link.path && entry.title === link.title
    )
  ) {
    target.push(link);
  }
}

function contextKey(
  source: string,
  context: Pick<SelectionAnchor, "startOffset" | "endOffset" | "quote">
): string {
  return [
    source,
    String(context.startOffset),
    String(context.endOffset),
    context.quote
  ].join("\u0000");
}

function parentEdgeEnabled(
  projection: RelationshipGraphProjection,
  parentId: string,
  childId: string
): boolean {
  return projection.enabledParentEdges.has(
    relationshipEdgeId(
      "parent-child",
      conversationRelationshipNodeId(parentId),
      conversationRelationshipNodeId(childId)
    )
  );
}

function collectBranchGroups(
  conversation: ConversationFile,
  plan: TreeExportPlan,
  projection: RelationshipGraphProjection
): {
  messageGroups: MessageBranchGroup[];
  noteGroups: NoteBranchGroup[];
  fallbackByNode: Map<string, MarkdownLink[]>;
  sourceLinksByNode: Map<string, MarkdownLink[]>;
} {
  const messageGroups = new Map<string, MessageBranchGroup>();
  const noteGroups: NoteBranchGroup[] = [];
  const fallbackByNode = new Map<string, MarkdownLink[]>();
  const sourceLinksByNode = new Map<string, MarkdownLink[]>();

  for (const childId of orderedNodeIds(conversation)) {
    if (!projection.includedNodeIds.has(childId)) continue;
    const child = conversation.nodes[childId];
    const record = plan.nodes[childId];
    if (child === undefined || record === undefined || child.parentId === null) {
      continue;
    }
    if (!parentEdgeEnabled(projection, child.parentId, childId)) continue;
    const link: MarkdownLink = { path: record.path, title: record.title };
    let linkedAtParentSelection = false;
    for (const message of child.messages) {
      if (message.role !== "user") continue;
      for (const context of message.selectionContexts ?? []) {
        if (!isMessageSelectionContext(context)) continue;
        const key = contextKey(
          `${context.sourceNodeId}:${context.messageId}`,
          context
        );
        const group = messageGroups.get(key) ?? {
          sourceNodeId: context.sourceNodeId,
          sourceMessageId: context.messageId,
          context,
          links: []
        };
        addUniqueLink(group.links, link);
        messageGroups.set(key, group);
        if (context.sourceNodeId === child.parentId) {
          linkedAtParentSelection = true;
        }
      }
    }
    if (!linkedAtParentSelection) {
      const links = fallbackByNode.get(child.parentId) ?? [];
      addUniqueLink(links, link);
      fallbackByNode.set(child.parentId, links);
    }
  }

  for (const edge of projection.graph.edges) {
    if (!projection.enabledNoteEdges.has(edge.id) || edge.notePath === undefined) {
      continue;
    }
    const record = plan.nodes[edge.conversationNodeId];
    if (record === undefined) continue;
    const noteNode = projection.graph.nodes.find(
      (candidate) => candidate.id === edge.targetId
    );
    const sourceTitle = noteNode?.label ?? edge.notePath.replace(/\.md$/iu, "");
    const link: MarkdownLink = { path: record.path, title: record.title };
    const backlinks = sourceLinksByNode.get(edge.conversationNodeId) ?? [];
    addUniqueLink(backlinks, { path: edge.notePath, title: sourceTitle });
    sourceLinksByNode.set(edge.conversationNodeId, backlinks);

    let matchedContext = false;
    if (edge.kind === "source-note") {
      const node = conversation.nodes[edge.conversationNodeId];
      for (const message of node?.messages ?? []) {
        if (message.role !== "user") continue;
        for (const context of message.selectionContexts ?? []) {
          if (
            isNoteSelectionContext(context) &&
            context.filePath.replace(/\\/gu, "/") === edge.notePath
          ) {
            noteGroups.push({
              sourcePath: edge.notePath,
              sourceTitle,
              context,
              links: [link]
            });
            matchedContext = true;
          }
        }
      }
    }
    if (!matchedContext) {
      noteGroups.push({
        sourcePath: edge.notePath,
        sourceTitle,
        links: [link]
      });
    }
  }

  return {
    messageGroups: [...messageGroups.values()],
    noteGroups,
    fallbackByNode,
    sourceLinksByNode
  };
}

function applyMessageBranchLinks(
  conversation: ConversationFile,
  groups: MessageBranchGroup[],
  fallbackByNode: Map<string, MarkdownLink[]>
): Record<string, Record<string, string>> {
  const insertionsByMessage = new Map<string, MarkdownLinkInsertion[]>();

  for (const group of groups) {
    const sourceMessage = conversation.nodes[group.sourceNodeId]?.messages.find(
      (message) => message.id === group.sourceMessageId
    );
    if (sourceMessage === undefined) {
      const links = fallbackByNode.get(group.sourceNodeId) ?? [];
      for (const link of group.links) addUniqueLink(links, link);
      fallbackByNode.set(group.sourceNodeId, links);
      continue;
    }
    const anchor = resolveMarkdownAnchor(sourceMessage.content, group.context);
    if (anchor === undefined) {
      const links = fallbackByNode.get(group.sourceNodeId) ?? [];
      for (const link of group.links) addUniqueLink(links, link);
      fallbackByNode.set(group.sourceNodeId, links);
      continue;
    }
    const key = `${group.sourceNodeId}\u0000${group.sourceMessageId}`;
    const insertions = insertionsByMessage.get(key) ?? [];
    insertions.push({ anchor, links: group.links });
    insertionsByMessage.set(key, insertions);
  }

  const contentByNode: Record<string, Record<string, string>> = {};
  for (const [key, insertions] of insertionsByMessage) {
    const separator = key.indexOf("\u0000");
    const nodeId = key.slice(0, separator);
    const messageId = key.slice(separator + 1);
    const message = conversation.nodes[nodeId]?.messages.find(
      (entry) => entry.id === messageId
    );
    if (message === undefined) continue;
    const byMessage = contentByNode[nodeId] ?? {};
    byMessage[messageId] = insertMarkdownLinks(message.content, insertions);
    contentByNode[nodeId] = byMessage;
  }
  return contentByNode;
}

function renderIndexMarkdown(
  conversation: ConversationFile,
  plan: TreeExportPlan,
  projection: RelationshipGraphProjection
): string {
  const lines = ["# 节点列表", ""];
  const seen = new Set<string>();
  const visit = (nodeId: string, depth: number): void => {
    if (seen.has(nodeId) || !projection.includedNodeIds.has(nodeId)) return;
    seen.add(nodeId);
    const node = conversation.nodes[nodeId];
    const record = plan.nodes[nodeId];
    if (node === undefined || record === undefined) return;
    lines.push(
      `${"  ".repeat(depth)}- ${markdownWikiLink(record.path, record.title)}`
    );
    for (const childId of node.childIds) {
      if (parentEdgeEnabled(projection, nodeId, childId)) {
        visit(childId, depth + 1);
      }
    }
  };
  for (const nodeId of orderedNodeIds(conversation)) {
    if (!projection.includedNodeIds.has(nodeId)) continue;
    const parentId = conversation.nodes[nodeId]?.parentId;
    if (
      parentId === null ||
      parentId === undefined ||
      !projection.includedNodeIds.has(parentId) ||
      !parentEdgeEnabled(projection, parentId, nodeId)
    ) {
      visit(nodeId, 0);
    }
  }
  for (const nodeId of orderedNodeIds(conversation)) visit(nodeId, 0);
  return `${lines.join("\n")}\n`;
}

function selectionQuotes(node: ConversationNode): string[] {
  const seen = new Set<string>();
  const quotes: string[] = [];
  for (const message of node.messages) {
    if (message.role !== "user") continue;
    for (const context of message.selectionContexts ?? []) {
      const quote = context.quote.trim();
      if (quote.length === 0 || seen.has(quote)) continue;
      seen.add(quote);
      quotes.push(quote);
    }
  }
  return quotes;
}

function attachmentReferences(node: ConversationNode): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  const patterns = [
    /!\[\[([^\]]+)\]\]/gu,
    /!\[[^\]]*\]\(([^)]+)\)/gu
  ];
  for (const message of node.messages) {
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      for (const match of message.content.matchAll(pattern)) {
        const value = match[1]?.trim();
        if (value === undefined || value.length === 0 || seen.has(value)) continue;
        seen.add(value);
        output.push(value);
      }
    }
  }
  return output;
}

function renderNodeMarkdown(
  node: ConversationNode,
  title: string,
  messageContentById: Record<string, string> | undefined,
  fallbackLinks: MarkdownLink[],
  sourceLinks: MarkdownLink[]
): string {
  const sections: string[] = [`# ${title}`];
  for (const message of node.messages) {
    const label = message.role === "user" ? "提问" : "回答";
    sections.push(
      `## ${label}\n\n${messageContentById?.[message.id] ?? message.content}`
    );
  }
  const quotes = selectionQuotes(node);
  if (quotes.length > 0) {
    sections.push(
      `## 框选原文\n\n${quotes.map((quote) => `> ${quote.replace(/\n/gu, "\n> ")}`).join("\n\n")}`
    );
  }
  const attachments = attachmentReferences(node);
  if (attachments.length > 0) {
    sections.push(
      `## 附件信息\n\n${attachments.map((entry) => `- ${entry}`).join("\n")}`
    );
  }
  if (fallbackLinks.length > 0) {
    sections.push(
      `## 分支\n\n${fallbackLinks
        .map((link) => `- ${markdownWikiLink(link.path, link.title)}`)
        .join("\n")}`
    );
  }
  if (sourceLinks.length > 0) {
    sections.push(
      `## 来源\n\n${sourceLinks
        .map((link) => `- ${markdownWikiLink(link.path, link.title)}`)
        .join("\n")}`
    );
  }
  return `${sections.join("\n\n")}\n`;
}

function appendCaptureLinks(content: string, links: MarkdownLink[]): string {
  const missing = links.filter(
    (link) => !content.includes(markdownWikiLink(link.path, link.title))
  );
  if (missing.length === 0) return content;
  const heading = "## TreeTalk 沉淀";
  const block = missing
    .map((link) => `- ${markdownWikiLink(link.path, link.title)}`)
    .join("\n");
  const trimmed = content.replace(/\s+$/u, "");
  return `${trimmed}\n\n${content.includes(heading) ? "" : `${heading}\n\n`}${block}\n`;
}

async function updateSourceNotes(
  vault: VaultPort,
  groups: NoteBranchGroup[]
): Promise<void> {
  const byPath = new Map<string, NoteBranchGroup[]>();
  for (const group of groups) {
    const entries = byPath.get(group.sourcePath) ?? [];
    entries.push(group);
    byPath.set(group.sourcePath, entries);
  }

  for (const [path, entries] of byPath) {
    try {
      if (!(await vault.exists(path))) continue;
      const original = await vault.read(path);
      const insertions: MarkdownLinkInsertion[] = [];
      const appendLinks: MarkdownLink[] = [];
      for (const entry of entries) {
        if (entry.context === undefined) {
          for (const link of entry.links) addUniqueLink(appendLinks, link);
          continue;
        }
        const anchor = resolveMarkdownAnchor(original, entry.context);
        if (anchor !== undefined) {
          insertions.push({ anchor, links: entry.links });
        } else {
          for (const link of entry.links) addUniqueLink(appendLinks, link);
        }
      }
      let updated =
        insertions.length === 0
          ? original
          : insertMarkdownLinks(original, insertions);
      updated = appendCaptureLinks(updated, appendLinks);
      if (updated !== original) await vault.write(path, updated);
    } catch {
      // Source-note links are best-effort and never make the export fail.
    }
  }
}

export class KnowledgeCaptureService {
  constructor(
    private readonly vault: VaultPort,
    private readonly knowledgeFolder: string,
    private readonly treeCaptureFolder = knowledgeFolder
  ) {}

  async capture(
    request: KnowledgeCaptureRequest,
    capturedAt: string
  ): Promise<string> {
    const scope = (request as { scope?: unknown }).scope;
    if (scope !== "tree" && scope !== "answer") {
      throw new Error("Unsupported capture scope");
    }

    if (request.scope === "answer") {
      const node = requireNode(request.conversation, request.nodeId);
      const message = requireMessage(node, request.messageId);
      if (message.role !== "assistant") {
        throw new Error("Only assistant answers can be captured");
      }
      const folder = normalizeFolder(this.knowledgeFolder);
      const title = nodeTitle(node);
      const stem = safeFileStem(title);
      let suffix = 1;
      let path = `${folder}/${stem}.md`;
      while (await this.vault.exists(path)) {
        suffix += 1;
        path = `${folder}/${stem} ${String(suffix)}.md`;
      }
      await this.vault.write(path, `# ${title}\n\n${message.content}\n`);
      return path;
    }

    if (hasStreamingResponse(request.conversation)) {
      throw new Error(
        "Cannot capture a tree while an assistant response is streaming"
      );
    }

    const projection = createRelationshipProjection(request.conversation);
    const plan = await buildTreeExportPlan(
      this.vault,
      request.conversation,
      capturedAt,
      this.treeCaptureFolder,
      projection.includedNodeIds
    );
    const {
      messageGroups,
      noteGroups,
      fallbackByNode,
      sourceLinksByNode
    } = collectBranchGroups(request.conversation, plan, projection);
    const messageContentByNode = applyMessageBranchLinks(
      request.conversation,
      messageGroups,
      fallbackByNode
    );

    await this.vault.write(
      plan.indexPath,
      renderIndexMarkdown(request.conversation, plan, projection)
    );
    for (const nodeId of orderedNodeIds(request.conversation)) {
      if (!projection.includedNodeIds.has(nodeId)) continue;
      const node = requireNode(request.conversation, nodeId);
      const record = plan.nodes[nodeId];
      if (record === undefined) continue;
      await this.vault.write(
        record.path,
        renderNodeMarkdown(
          node,
          record.title,
          messageContentByNode[nodeId],
          fallbackByNode.get(nodeId) ?? [],
          sourceLinksByNode.get(nodeId) ?? []
        )
      );
    }
    await updateSourceNotes(this.vault, noteGroups);
    return plan.indexPath;
  }
}
