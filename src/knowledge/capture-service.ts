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
import type { AnchorStatus } from "../domain/anchor-status";
import { isVaultRelativeMarkdownPath } from "../domain/anchor-path";
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

export type AnchorCaptureErrorCode =
  | "anchor-foreign-vault"
  | "anchor-legacy-unverified"
  | "anchor-missing"
  | "anchor-ambiguous";

/**
 * 沉淀前锚点状态失败时抛出的领域错误。
 * 携带 `code` 供主插件映射为中文 Notice。
 */
export class AnchorCaptureError extends Error {
  constructor(
    public readonly code: AnchorCaptureErrorCode,
    message: string
  ) {
    super(message);
    this.name = "AnchorCaptureError";
  }
}

/**
 * 将领域错误映射为面向用户的 Notice 文案。
 * 纯函数，无 obsidian 依赖，便于 TDD。
 * 非 `AnchorCaptureError` 一律落到通用沉淀失败文案。
 */
export function mapAnchorCaptureErrorToNotice(error: unknown): string {
  if (error instanceof AnchorCaptureError) {
    switch (error.code) {
      case "anchor-foreign-vault":
        return "会话锚定文件不在当前 Vault，请右键目标笔记重新绑定";
      case "anchor-legacy-unverified":
        return "当前锚点为旧数据未验证，请在笔记上右键重新绑定后再沉淀";
      case "anchor-missing":
        return "锚定文件不存在或已删除，请右键目标笔记重新绑定";
      case "anchor-ambiguous":
        return "当前 Vault 中存在多个同 ctime 的候选文件，请右键目标笔记重新绑定";
      default:
        return error.message;
    }
  }
  return "知识沉淀失败，对话内容未受影响";
}

/**
 * 解析会话锚点状态的回调。
 * 沉淀前 preflight 调用，仅允许 `none` 或 `verified`。
 */
export type AnchorStatusResolver = (
  conversation: ConversationFile
) => AnchorStatus;

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
  includedNodeIds: Set<string>,
  resolvedAnchorPath: string | undefined
): Promise<TreeExportPlan> {
  const conversationStem = safeFileStem(conversation.title);
  // 诉求1: 如果对话有锚点(发送首条消息时打开的 md 笔记),
  // 在该笔记同级目录建 `<笔记名>-tree/`, 避免污染 TreeTalk 设置目录;
  // 旧对话无锚点时回退到 treeFolder (与上游默认行为一致).
  //
  // Vault-aware: 归组根目录使用最新解析的 verified 路径。
  // 多个会话锚定同一文件时必然共享同一根目录；
  // 目录是否已存在不影响路径计算。
  let parentFolder = treeFolder;
  const anchorPath = resolvedAnchorPath ?? conversation.anchorFilePath;
  if (anchorPath) {
    // patch 7: 用纯字符串规范化, 避免跨平台 path 拼接差异
    const normalized = anchorPath.replace(/\\/g, "/");
    const lastSlash = normalized.lastIndexOf("/");
    const anchorDir = lastSlash > 0 ? normalized.substring(0, lastSlash) : "";
    const anchorName = lastSlash > 0 ? normalized.substring(lastSlash + 1) : normalized;
    const anchorStem = anchorName.replace(/\.md$/i, "");
    parentFolder = anchorDir
      ? `${anchorDir}/${anchorStem}-tree`
      : `${anchorStem}-tree`;
  }
  const folder = await uniqueFolder(
    vault,
    parentFolder,
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
  private readonly anchorStatusResolver: AnchorStatusResolver | undefined;

  constructor(
    private readonly vault: VaultPort,
    private readonly knowledgeFolder: string,
    private readonly treeCaptureFolder = knowledgeFolder,
    options: { anchorStatusResolver?: AnchorStatusResolver } = {}
  ) {
    this.anchorStatusResolver = options.anchorStatusResolver;
  }

  /**
   * 沉淀前对会话锚点做状态预检：
   * - `none`：无锚点，按 `treeCaptureFolder` 旧行为沉淀。
   * - `verified`：使用最新解析路径作为归组根目录的依据。
   * - 其他状态（`foreign-vault` / `legacy-unverified` / `missing` / `ambiguous`）：
   *   抛出 `AnchorCaptureError`，并保证零写入。
   */
  private preflightAnchor(
    conversation: ConversationFile
  ): { resolvedPath: string | undefined } {
    if (this.anchorStatusResolver === undefined) {
      return { resolvedPath: conversation.anchorFilePath };
    }
    const status = this.anchorStatusResolver(conversation);
    if (status.kind === "none") {
      return { resolvedPath: undefined };
    }
    if (status.kind === "verified") {
      if (!isVaultRelativeMarkdownPath(status.filePath)) {
        throw new AnchorCaptureError(
          "anchor-missing",
          "锚定文件路径不是当前 Vault 内的 Markdown 文件，已阻止本次沉淀"
        );
      }
      return { resolvedPath: status.filePath };
    }
    if (status.kind === "foreign-vault") {
      throw new AnchorCaptureError(
        "anchor-foreign-vault",
        "会话锚定文件不在当前 Vault，已阻止本次沉淀"
      );
    }
    if (status.kind === "legacy-unverified") {
      throw new AnchorCaptureError(
        "anchor-legacy-unverified",
        "锚点为旧数据未验证，请先在笔记上右键选择「重新绑定当前 TreeTalk 对话到此笔记」"
      );
    }
    if (status.kind === "missing") {
      throw new AnchorCaptureError(
        "anchor-missing",
        "锚定文件不存在或已删除，已阻止本次沉淀"
      );
    }
    throw new AnchorCaptureError(
      "anchor-ambiguous",
      "当前 Vault 中存在多个同 ctime 的候选文件，无法自动选择，请右键目标笔记重新绑定"
    );
  }

  async capture(
    request: KnowledgeCaptureRequest,
    capturedAt: string
  ): Promise<string> {
    const scope = (request as { scope?: unknown }).scope;
    if (scope !== "tree" && scope !== "answer") {
      throw new Error("Unsupported capture scope");
    }

    // Every capture route must validate the anchor before it can write anything.
    const { resolvedPath } = this.preflightAnchor(request.conversation);

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
      projection.includedNodeIds,
      resolvedPath
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
