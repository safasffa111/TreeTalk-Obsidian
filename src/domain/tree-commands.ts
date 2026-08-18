import { parseConversation } from "./schema";
import {
  appendDraftContext,
  removeDraftContext
} from "./draft-contexts";
import type {
  ChatMessage,
  ConversationFile,
  ConversationNode,
  NoteContextGraphSnapshot,
  SelectionContext
} from "./types";
import { isMessageSelectionContext } from "./types";
import { isVaultRelativeMarkdownPath } from "./anchor-path";

export interface ContinueNodeInput {
  nodeId: string;
  text: string;
  messageId: string;
  now: string;
  /** 诉求1: 首条消息时锁定当前打开的 md 笔记路径 (可选, 旧调用方不传) */
  anchorFilePath?: string;
  /** Vault-aware 锚点来源 UUID。三个字段全部齐全才会写入 verified 三元组。 */
  anchorVaultId?: string;
  /** Vault-aware 锚点文件的 ctime（毫秒，Unix epoch）。 */
  anchorFileCtime?: number;
  selectionContexts?: SelectionContext[];
}

export interface PrepareChildDraftInput {
  nodeId: string;
  now: string;
}

export interface SubmitChildDraftInput {
  text: string;
  childId: string;
  messageId: string;
  now: string;
  /** 诉求1: 首条消息时锁定当前打开的 md 笔记路径 (可选, 旧调用方不传) */
  anchorFilePath?: string;
  /** Vault-aware 锚点来源 UUID。三个字段全部齐全才会写入 verified 三元组。 */
  anchorVaultId?: string;
  /** Vault-aware 锚点文件的 ctime（毫秒，Unix epoch）。 */
  anchorFileCtime?: number;
}

export type TreeOperation =
  | {
      kind: "append-message";
      nodeId: string;
      messageId: string;
      previousDraft: ConversationNode["draft"];
      previousCurrentNodeId: string;
      appliedRevision: number;
      previousConversationTitle?: string;
      previousRootTitle?: string;
    }
  | {
      kind: "create-child";
      childId: string;
      parentId: string;
      previousDraft: ConversationNode["draft"];
      previousChildIds: string[];
      previousCurrentNodeId: string;
      appliedRevision: number;
      previousConversationTitle?: string;
      previousRootTitle?: string;
    };

export interface CommandResult {
  state: ConversationFile;
  operation: TreeOperation;
}

function mutableClone(conversation: ConversationFile): ConversationFile {
  return structuredClone(conversation);
}

function requiredNode(conversation: ConversationFile, nodeId: string): ConversationNode {
  const node = conversation.nodes[nodeId];
  if (node === undefined) {
    throw new Error(`Node not found: ${nodeId}`);
  }
  return node;
}

function applyFirstQuestionTitle(
  conversation: ConversationFile,
  text: string
):
  | {
      previousConversationTitle: string;
      previousRootTitle: string;
    }
  | undefined {
  const hasUserMessage = Object.values(conversation.nodes).some((node) =>
    node.messages.some((message) => message.role === "user")
  );
  if (hasUserMessage) return undefined;
  const root = requiredNode(conversation, conversation.rootNodeId);
  const previousTitles = {
    previousConversationTitle: conversation.title,
    previousRootTitle: root.title
  };
  const title = text.trim().split(/\r?\n/u)[0]?.slice(0, 80) ?? text.slice(0, 80);
  conversation.title = title;
  root.title = title;
  root.titleSource = "question";
  delete root.summary;
  return previousTitles;
}

function userMessage(
  id: string,
  content: string,
  now: string,
  selectionContexts: SelectionContext[]
): ChatMessage {
  const message: ChatMessage = {
    id,
    role: "user",
    content,
    status: "complete",
    createdAt: now,
    updatedAt: now
  };
  if (selectionContexts.length > 0) {
    message.selectionContexts = structuredClone(selectionContexts);
  }
  return message;
}

function nextRevision(conversation: ConversationFile, now: string): void {
  conversation.revision += 1;
  conversation.updatedAt = now;
}

export function isMarkdownPath(path: string): boolean {
  return isVaultRelativeMarkdownPath(path);
}

export function hasUserMessage(conversation: ConversationFile): boolean {
  return Object.values(conversation.nodes).some((node) =>
    node.messages.some((message) => message.role === "user")
  );
}

interface AnchorTripleInput {
  anchorFilePath?: string | undefined;
  anchorVaultId?: string | undefined;
  anchorFileCtime?: number | undefined;
}

function isUuidLike(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      value
    )
  );
}

function applyAnchor(
  state: ConversationFile,
  input: AnchorTripleInput | string | undefined
): void {
  // 锚点只在对话尚无任何用户消息时写入一次；之后任何消息不得修改。
  if (hasUserMessage(state)) return;
  // 兼容旧调用方：纯字符串仍按 path-only legacy 写入。
  if (typeof input === "string" || input === undefined) {
    if (input === undefined) return;
    if (!isMarkdownPath(input)) return;
    state.anchorFilePath = input;
    return;
  }
  const { anchorFilePath, anchorVaultId, anchorFileCtime } = input;
  if (anchorFilePath === undefined) return;
  if (!isMarkdownPath(anchorFilePath)) return;
  const hasVaultId = anchorVaultId !== undefined;
  const hasCtime = anchorFileCtime !== undefined;
  // 三个字段都缺失 → 旧 path-only legacy 锚点。
  if (!hasVaultId && !hasCtime) {
    state.anchorFilePath = anchorFilePath;
    return;
  }
  // 必须三个字段同时存在且合法才进入 verified 三元组；否则一律不写入（避免半截状态）。
  if (!isUuidLike(anchorVaultId)) return;
  if (
    typeof anchorFileCtime !== "number" ||
    !Number.isFinite(anchorFileCtime) ||
    !Number.isInteger(anchorFileCtime) ||
    anchorFileCtime < 0
  ) {
    return;
  }
  state.anchorFilePath = anchorFilePath;
  state.anchorVaultId = anchorVaultId;
  state.anchorFileCtime = anchorFileCtime;
}

export function continueNode(
  conversation: ConversationFile,
  input: ContinueNodeInput
): CommandResult {
  const text = input.text.trim();
  if (text.length === 0) {
    throw new Error("Message cannot be empty");
  }
  const state = mutableClone(conversation);
  const previousTitles = applyFirstQuestionTitle(state, text);
  const node = requiredNode(state, input.nodeId);
  const previousDraft = structuredClone(node.draft);
  const previousCurrentNodeId = state.currentNodeId;
  const selectionContexts =
    input.selectionContexts ?? node.draft.selectionContexts;
  // 锚点：仅对话尚无用户消息时写入（见 applyAnchor），一次决定后冻结。
  applyAnchor(state, {
    anchorFilePath: input.anchorFilePath,
    anchorVaultId: input.anchorVaultId,
    anchorFileCtime: input.anchorFileCtime
  });
  node.messages.push(
    userMessage(input.messageId, text, input.now, selectionContexts)
  );
  node.draft = { text: "", mode: "continue", selectionContexts: [] };
  node.updatedAt = input.now;
  state.currentNodeId = input.nodeId;
  nextRevision(state, input.now);
  return {
    state: parseConversation(state),
    operation: {
      kind: "append-message",
      nodeId: input.nodeId,
      messageId: input.messageId,
      previousDraft,
      previousCurrentNodeId,
      appliedRevision: state.revision,
      ...previousTitles
    }
  };
}

export function prepareChildDraft(
  conversation: ConversationFile,
  input: PrepareChildDraftInput
): ConversationFile {
  const state = mutableClone(conversation);
  const node = requiredNode(state, input.nodeId);
  const draft: ConversationNode["draft"] = {
    text: node.draft.text,
    mode: "child",
    selectionContexts: structuredClone(node.draft.selectionContexts),
    ...(node.draft.answerThinkingModeOverride === undefined
      ? {}
      : { answerThinkingModeOverride: node.draft.answerThinkingModeOverride })
  };
  node.draft = draft;
  node.updatedAt = input.now;
  state.currentNodeId = input.nodeId;
  nextRevision(state, input.now);
  return parseConversation(state);
}

export function prepareSelectionChildDraft(
  conversation: ConversationFile,
  input: PrepareChildDraftInput
): ConversationFile {
  const state = mutableClone(conversation);
  const node = requiredNode(state, input.nodeId);
  const messageSelectionCount = node.draft.selectionContexts.filter(
    isMessageSelectionContext
  ).length;
  if (
    messageSelectionCount === 1 &&
    node.draft.selectionModeBeforeCapture === undefined
  ) {
    node.draft.selectionModeBeforeCapture = node.draft.mode;
  }
  node.draft.mode = "child";
  node.updatedAt = input.now;
  state.currentNodeId = input.nodeId;
  nextRevision(state, input.now);
  return parseConversation(state);
}

export function toggleBranchDraft(
  conversation: ConversationFile,
  nodeId: string,
  now: string
): ConversationFile {
  const state = mutableClone(conversation);
  const node = requiredNode(state, nodeId);
  node.draft.mode = node.draft.mode === "continue" ? "child" : "continue";
  delete node.draft.selectionModeBeforeCapture;
  node.updatedAt = now;
  state.currentNodeId = nodeId;
  nextRevision(state, now);
  return parseConversation(state);
}

export function addSelectionToDraft(
  conversation: ConversationFile,
  nodeId: string,
  anchor: SelectionContext,
  now: string
): ConversationFile {
  const state = mutableClone(conversation);
  const node = requiredNode(state, nodeId);
  node.draft.selectionContexts = appendDraftContext(
    node.draft.selectionContexts,
    anchor
  );
  node.updatedAt = now;
  state.currentNodeId = nodeId;
  nextRevision(state, now);
  return parseConversation(state);
}

export function removeSelectionFromDraft(
  conversation: ConversationFile,
  nodeId: string,
  key: string,
  now: string
): ConversationFile {
  const state = mutableClone(conversation);
  const node = requiredNode(state, nodeId);
  node.draft.selectionContexts = removeDraftContext(
    node.draft.selectionContexts,
    key
  );
  const hasMessageSelection = node.draft.selectionContexts.some(
    isMessageSelectionContext
  );
  if (
    !hasMessageSelection &&
    node.draft.selectionModeBeforeCapture !== undefined
  ) {
    node.draft.mode = node.draft.selectionModeBeforeCapture;
    delete node.draft.selectionModeBeforeCapture;
  }
  node.updatedAt = now;
  state.currentNodeId = nodeId;
  nextRevision(state, now);
  return parseConversation(state);
}

export function submitChildDraft(
  conversation: ConversationFile,
  input: SubmitChildDraftInput
): CommandResult {
  const text = input.text.trim();
  if (text.length === 0) {
    throw new Error("Child message cannot be empty");
  }
  const state = mutableClone(conversation);
  if (state.nodes[input.childId] !== undefined) {
    throw new Error(`Node already exists: ${input.childId}`);
  }
  const parent = requiredNode(state, state.currentNodeId);
  if (parent.draft.mode !== "child") {
    throw new Error("Current node is not preparing a child");
  }
  const previousDraft = structuredClone(parent.draft);
  const previousChildIds = [...parent.childIds];
  const previousCurrentNodeId = state.currentNodeId;
  const previousTitles = applyFirstQuestionTitle(state, text);
  // 锚点：仅对话尚无用户消息时写入（见 applyAnchor），一次决定后冻结。
  applyAnchor(state, {
    anchorFilePath: input.anchorFilePath,
    anchorVaultId: input.anchorVaultId,
    anchorFileCtime: input.anchorFileCtime
  });
  const firstMessage = userMessage(
    input.messageId,
    text,
    input.now,
    parent.draft.selectionContexts
  );
  const child: ConversationNode = {
    id: input.childId,
    parentId: parent.id,
    childIds: [],
    title: text.split(/\r?\n/u)[0]?.slice(0, 80) ?? text.slice(0, 80),
    titleSource: "question",
    messages: [firstMessage],
    draft: { text: "", mode: "continue", selectionContexts: [] },
    createdAt: input.now,
    updatedAt: input.now
  };
  parent.childIds.push(child.id);
  parent.draft = { text: "", mode: "continue", selectionContexts: [] };
  parent.updatedAt = input.now;
  state.nodes[child.id] = child;
  state.currentNodeId = child.id;
  nextRevision(state, input.now);
  return {
    state: parseConversation(state),
    operation: {
      kind: "create-child",
      childId: child.id,
      parentId: parent.id,
      previousDraft,
      previousChildIds,
      previousCurrentNodeId,
      appliedRevision: state.revision,
      ...previousTitles
    }
  };
}

export function attachNoteContextGraphToMessage(
  conversation: ConversationFile,
  nodeId: string,
  messageId: string,
  graph: NoteContextGraphSnapshot,
  now: string
): ConversationFile {
  const state = mutableClone(conversation);
  const node = requiredNode(state, nodeId);
  const message = node.messages.find((entry) => entry.id === messageId);
  if (message === undefined || message.role !== "user") {
    throw new Error(`User message not found: ${messageId}`);
  }
  message.noteContextGraph = structuredClone(graph);
  message.updatedAt = now;
  node.updatedAt = now;
  nextRevision(state, now);
  return parseConversation(state);
}

export function revertTreeCommand(
  conversation: ConversationFile,
  operation: TreeOperation
): ConversationFile {
  if (conversation.revision !== operation.appliedRevision) {
    throw new Error("Cannot undo because the conversation revision changed");
  }
  const state = mutableClone(conversation);
  if (operation.kind === "create-child") {
    const parent = requiredNode(state, operation.parentId);
    state.nodes = Object.fromEntries(
      Object.entries(state.nodes).filter(([nodeId]) => nodeId !== operation.childId)
    );
    parent.childIds = [...operation.previousChildIds];
    parent.draft = structuredClone(operation.previousDraft);
    state.currentNodeId = operation.previousCurrentNodeId;
  } else {
    const node = requiredNode(state, operation.nodeId);
    node.messages = node.messages.filter((message) => message.id !== operation.messageId);
    node.draft = structuredClone(operation.previousDraft);
    state.currentNodeId = operation.previousCurrentNodeId;
  }
  if (
    operation.previousConversationTitle !== undefined &&
    operation.previousRootTitle !== undefined
  ) {
    state.title = operation.previousConversationTitle;
    requiredNode(state, state.rootNodeId).title = operation.previousRootTitle;
  }
  state.revision += 1;
  return parseConversation(state);
}
