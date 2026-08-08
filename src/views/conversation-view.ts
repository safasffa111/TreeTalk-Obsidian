import { setIcon } from "obsidian";
import type { AnswerThinkingMode } from "../execution/answer-thinking";
import { agentExecutionViewModel } from "../agent/ui/execution-view-model";
import { selectionContextKey } from "../domain/draft-contexts";
import { splitStreamingMarkdown } from "../domain/markdown-compatibility";
import {
  createSelectionAnchor,
  resolveSelectionAnchor
} from "../domain/selection-anchor";
import {
  addSelectionToDraft,
  prepareSelectionChildDraft,
  removeSelectionFromDraft
} from "../domain/tree-commands";
import {
  isMessageSelectionContext,
  isNoteSelectionContext,
  type ChatMessage,
  type ConversationFile,
  type SelectionAnchor
} from "../domain/types";
import type { SourceHighlightPort } from "../navigation/source-highlight-store";
import {
  shouldDisplayTokenStats,
  type TokenStatsRecord,
  type TransientUsagePort
} from "../providers/transient-usage-store";
import type { TreeTalkSource } from "../navigation/source-link-handler";
import type {
  ResponseProgressRecord,
  TransientResponseStatusPort
} from "../providers/transient-response-status-store";
import type { TransientThinkingPort } from "../providers/transient-thinking-store";
import type { ConversationStorePort } from "../tabs/active-conversation-store";
import {
  writeExcerptDragData,
  type TreeTalkExcerptDragPayload
} from "../knowledge/excerpt-drag";
import {
  enhanceRenderedMarkdown,
  installObsidianFormulaSelection,
  plainTextMessageRendererFactory,
  type MessageRendererFactory,
  type MessageRendererPort
} from "./message-renderer";
import {
  canonicalRenderedText,
  installSourceAwareTraceRanges,
  installSourceRangeHighlight,
  selectionForDomRange
} from "./rendered-selection";
import { logWarning } from "../utils/error-log";

// Render failures fall back to plain text; warn once per message so a
// persistent parser error is visible without spamming the console.
const renderWarnedMessages = new Set<string>();

export interface ConversationPanelActions {
  send(text: string): Promise<void>;
  restore?(): Promise<void>;
  createConversation?(): Promise<void>;
  openHistory?(): Promise<void>;
  captureTree?(): Promise<void>;
  openRelationshipGraph?(): void;
  captureAnswer?(messageId: string): Promise<void>;
  retryAnswer?(messageId: string): Promise<void>;
  stop?(): Promise<void>;
  toggleBranch?(): void;
}

export interface AnswerThinkingControlPort {
  answerThinkingMode(): AnswerThinkingMode;
  isAvailable(): boolean;
  setMode(mode: AnswerThinkingMode): Promise<void> | void;
  subscribe(listener: () => void): () => void;
}

export interface RelatedNoteControlPort {
  relatedNoteContextEnabled(): boolean;
  setEnabled(enabled: boolean): Promise<void> | void;
  subscribe(listener: () => void): () => void;
}

export interface ContextDivergenceControlPort {
  contextDivergenceEnabled(): boolean;
  setEnabled(enabled: boolean): Promise<void> | void;
  subscribe(listener: () => void): () => void;
}

export interface WebSearchControlPort {
  isEnabled(): boolean;
  isAvailable(): boolean;
  setEnabled(enabled: boolean): Promise<void> | void;
  subscribe(listener: () => void): () => void;
}

interface LocatedMessage {
  nodeId: string;
  message: ChatMessage;
}

export interface SelectionTrace {
  anchor: SelectionAnchor;
  targetNodeId: string;
}

function findMessage(
  store: ConversationStorePort,
  messageId: string
): LocatedMessage {
  const conversation = store.getSnapshot();
  if (conversation === undefined) throw new Error("No active conversation");
  for (const node of Object.values(conversation.nodes)) {
    const message = node.messages.find((entry) => entry.id === messageId);
    if (message !== undefined) return { nodeId: node.id, message };
  }
  throw new Error(`Message not found: ${messageId}`);
}

export function selectionTracesForMessage(
  conversation: ConversationFile,
  messageId: string
): SelectionTrace[] {
  const traces: SelectionTrace[] = [];
  const seen = new Set<string>();
  for (const node of Object.values(conversation.nodes)) {
    for (const userMessage of node.messages) {
      if (userMessage.role !== "user") continue;
      for (const context of userMessage.selectionContexts ?? []) {
        if (
          !isMessageSelectionContext(context) ||
          context.messageId !== messageId
        ) {
          continue;
        }
        const key = `${node.id}:${selectionContextKey(context)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        traces.push({ anchor: context, targetNodeId: node.id });
      }
    }
  }
  return traces.sort(
    (left, right) =>
      right.anchor.startOffset - left.anchor.startOffset ||
      right.anchor.endOffset - left.anchor.endOffset
  );
}

export async function attachSelectionContext(
  store: ConversationStorePort,
  messageId: string,
  visibleText: string,
  startOffset: number,
  endOffset: number,
  quoteOverride?: string
): Promise<SelectionAnchor> {
  const conversation = store.getSnapshot();
  if (conversation === undefined) throw new Error("No active conversation");
  if (conversation.status === "archived") {
    throw new Error("Archived conversations are read-only");
  }
  const targetConversationId = conversation.id;
  const located = findMessage(store, messageId);
  const targetNodeId = located.nodeId;
  const anchor = await createSelectionAnchor({
    messageId,
    sourceNodeId: located.nodeId,
    sourceRole: located.message.role,
    visibleText,
    startOffset,
    endOffset,
    ...(quoteOverride === undefined ? {} : { quoteOverride })
  });
  store.update((current) => {
    const sourceStillExists = current.nodes[targetNodeId]?.messages.some(
      (message) => message.id === messageId
    );
    if (current.id !== targetConversationId || sourceStillExists !== true) {
      return current;
    }
    const now = new Date().toISOString();
    const selected = addSelectionToDraft(
      current,
      targetNodeId,
      anchor,
      now
    );
    return prepareSelectionChildDraft(selected, { nodeId: targetNodeId, now });
  });
  return anchor;
}

function installSelectionDrag(
  contentElement: HTMLElement,
  store: ConversationStorePort,
  messageId: string
): () => void {
  const onDragStart = (event: DragEvent): void => {
    if (event.dataTransfer === null) return;
    const selection = contentElement.ownerDocument.defaultView?.getSelection();
    if (
      selection === null ||
      selection === undefined ||
      selection.rangeCount === 0 ||
      selection.isCollapsed
    ) {
      return;
    }
    const range = selection.getRangeAt(0);
    if (
      !contentElement.contains(range.startContainer) ||
      !contentElement.contains(range.endContainer)
    ) {
      return;
    }
    const selectionContext = selectionForDomRange(contentElement, range);
    if (selectionContext === undefined) return;
    const conversation = store.getSnapshot();
    if (conversation === undefined) return;
    let located: LocatedMessage;
    try {
      located = findMessage(store, messageId);
    } catch {
      return;
    }
    const sourceNode = conversation.nodes[located.nodeId];
    if (sourceNode === undefined) return;
    const currentNode = conversation.nodes[conversation.currentNodeId];
    const matchingAnchor = currentNode?.draft.selectionContexts.find(
      (context): context is SelectionAnchor =>
        isMessageSelectionContext(context) &&
        context.messageId === messageId &&
        context.startOffset === selectionContext.startOffset &&
        context.endOffset === selectionContext.endOffset &&
        context.quote === selectionContext.sourceText
    );
    const payload: TreeTalkExcerptDragPayload =
      matchingAnchor === undefined
        ? {
            version: 1,
            conversationId: conversation.id,
            conversationTitle: conversation.title,
            nodeId: located.nodeId,
            nodeTitle: sourceNode.title,
            messageId,
            sourceRole: located.message.role,
            quote: selectionContext.sourceText
          }
        : {
            version: 2,
            conversationId: conversation.id,
            conversationTitle: conversation.title,
            nodeId: located.nodeId,
            nodeTitle: sourceNode.title,
            messageId,
            sourceRole: located.message.role,
            quote: matchingAnchor.quote,
            anchor: matchingAnchor
          };
    writeExcerptDragData(event.dataTransfer, payload);
  };
  contentElement.addEventListener("dragstart", onDragStart);
  return () => contentElement.removeEventListener("dragstart", onDragStart);
}

function installMessageTraces(
  contentElement: HTMLElement,
  conversation: ConversationFile,
  traces: SelectionTrace[],
  selectNode: (nodeId: string) => void
): void {
  const renderedText = canonicalRenderedText(contentElement);
  const ranges = traces.flatMap((trace) => {
    const resolved = resolveSelectionAnchor(renderedText, trace.anchor);
    return resolved.status === "resolved"
      ? [{
          start: resolved.start,
          end: resolved.end,
          targetId: trace.targetNodeId
        }]
      : [];
  });
  installSourceAwareTraceRanges(
    contentElement,
    ranges,
    (targetIds, traceElement) => {
      if (targetIds.length === 1) {
        const targetId = targetIds[0];
        if (targetId !== undefined) selectNode(targetId);
        return;
      }
      contentElement
        .querySelector(".treetalk-trace-targets")
        ?.remove();
      const choices = document.createElement("div");
      choices.className =
        "treetalk-trace-targets treetalk-control";
      choices.setAttribute("role", "menu");
      for (const targetId of targetIds) {
        const choice = document.createElement("button");
        choice.type = "button";
        choice.dataset.targetNodeId = targetId;
        choice.textContent =
          conversation.nodes[targetId]?.title ?? "对话分支";
        choice.addEventListener("click", (event) => {
          event.stopPropagation();
          choices.remove();
          selectNode(targetId);
        });
        choices.append(choice);
      }
      traceElement.after(choices);
    }
  );
}

function renderDraftContexts(
  mount: HTMLElement,
  store: ConversationStorePort
): void {
  const conversation = store.getSnapshot();
  mount.replaceChildren();
  if (conversation === undefined) return;
  const node = conversation.nodes[conversation.currentNodeId];
  if (node === undefined) return;
  for (const context of node.draft.selectionContexts) {
    const chip = document.createElement("div");
    chip.className = "treetalk-selection-chip";

    const body = document.createElement("span");
    body.className = "treetalk-selection-chip-body";
    if (isNoteSelectionContext(context)) {
      const source = document.createElement("span");
      source.className = "treetalk-selection-chip-source";
      source.textContent = context.fileName;
      source.title = context.filePath;
      body.append(source);
    }
    const quote = document.createElement("span");
    quote.className = "treetalk-selection-chip-text";
    quote.textContent = `“${context.quote}”`;
    body.append(quote);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className =
      "treetalk-selection-chip-remove treetalk-control";
    remove.setAttribute("aria-label", "删除引用上下文");
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      store.update((current) =>
        removeSelectionFromDraft(
          current,
          current.currentNodeId,
          selectionContextKey(context),
          new Date().toISOString()
        )
      );
    });

    if (isMessageSelectionContext(context)) {
      const sourceNode =
        conversation.nodes[context.sourceNodeId] ??
        Object.values(conversation.nodes).find((candidate) =>
          candidate.messages.some(
            (message) => message.id === context.messageId
          )
        );
      if (sourceNode !== undefined) {
        const payload: TreeTalkExcerptDragPayload = {
          version: 2,
          conversationId: conversation.id,
          conversationTitle: conversation.title,
          nodeId: sourceNode.id,
          nodeTitle: sourceNode.title,
          messageId: context.messageId,
          sourceRole: context.sourceRole,
          quote: context.quote,
          anchor: context
        };
        chip.draggable = true;
        chip.addEventListener("dragstart", (event) => {
          if (event.dataTransfer !== null) {
            writeExcerptDragData(event.dataTransfer, payload);
          }
        });
      }
    }
    chip.append(body, remove);
    mount.append(chip);
  }
}

function emptyState(
  container: HTMLElement,
  actions?: ConversationPanelActions
): void {
  const empty = document.createElement("div");
  empty.className = "treetalk-empty-state";
  const actionsContainer = document.createElement("div");
  actionsContainer.className = "treetalk-empty-actions";
  const create = document.createElement("button");
  create.type = "button";
  create.className = "treetalk-empty-action";
  create.textContent = "新建对话";
  create.disabled = actions?.createConversation === undefined;
  create.addEventListener("click", () => {
    if (actions?.createConversation !== undefined) {
      void actions.createConversation();
    }
  });
  const history = document.createElement("button");
  history.type = "button";
  history.className = "treetalk-empty-action";
  history.textContent = "打开历史对话";
  history.disabled = actions?.openHistory === undefined;
  history.addEventListener("click", () => {
    if (actions?.openHistory !== undefined) void actions.openHistory();
  });
  actionsContainer.append(create, history);
  empty.append(actionsContainer);
  container.append(empty);
}

interface MessageViewState {
  article: HTMLElement;
  content: HTMLElement;
  renderer: MessageRendererPort;
  renderVersion: number;
  cleanups: Array<() => void>;
  cancelScheduled?: () => void;
  pending?: {
    message: ChatMessage;
    conversation: ConversationFile;
    nodeId: string;
    mutable: boolean;
    traceKey: string;
    traces: SelectionTrace[];
  };
  renderedContent?: string;
  renderedTraceKey?: string;
  renderedStatus?: ChatMessage["status"];
  captureButton?: HTMLButtonElement;
  retryButton?: HTMLButtonElement;
  tokenStats?: HTMLDetailsElement;
  agentExecution?: HTMLDetailsElement;
  responseProgress?: HTMLElement;
  thinkingPanel?: HTMLDetailsElement;
  thinkingContent?: HTMLElement;
  renderedThinkingLength?: number;
}

interface ComposerElements {
  root: HTMLElement;
  contextMount: HTMLElement;
  input: HTMLTextAreaElement;
  modeIndicator: HTMLElement;
  graph: HTMLButtonElement;
  relatedNotes: HTMLButtonElement;
  contextDivergence: HTMLButtonElement;
  answerThinking: HTMLButtonElement;
  webSearch: HTMLButtonElement;
  send: HTMLButtonElement;
}

const NATIVE_CONTEXT_MENU_SELECTOR = [
  "a",
  "button",
  "input",
  "label",
  "select",
  "option",
  "summary",
  "details",
  "[contenteditable]:not([contenteditable='false'])",
  "[role='button']",
  "[role='link']",
  ".treetalk-control",
  ".treetalk-selection-chip"
].join(",");

function selectionIntersectsElement(
  selection: Selection,
  element: HTMLElement
): boolean {
  if (selection.isCollapsed) return false;
  for (let index = 0; index < selection.rangeCount; index += 1) {
    if (selection.getRangeAt(index).intersectsNode(element)) return true;
  }
  return false;
}

function shouldToggleBranchFromContextMenu(
  event: MouseEvent,
  container: HTMLElement,
  composer: ComposerElements | undefined
): boolean {
  if (event.defaultPrevented || composer === undefined) return false;
  const target = event.target;
  if (!(target instanceof Element) || !container.contains(target)) return false;

  const selection = container.ownerDocument.defaultView?.getSelection();
  if (
    selection !== undefined &&
    selection !== null &&
    selectionIntersectsElement(selection, container)
  ) {
    return false;
  }

  if (target === composer.input) {
    return composer.input.selectionStart === composer.input.selectionEnd;
  }

  return target.closest(NATIVE_CONTEXT_MENU_SELECTOR) === null;
}

function scheduleAnimationFrame(
  document: Document,
  callback: () => void
): () => void {
  const view = document.defaultView;
  if (view?.requestAnimationFrame !== undefined) {
    const frame = view.requestAnimationFrame(callback);
    return () => view.cancelAnimationFrame(frame);
  }
  const timer = setTimeout(callback, 0);
  return () => clearTimeout(timer);
}

function messageTraceKey(traces: SelectionTrace[]): string {
  return traces
    .map(
      (trace) =>
        `${trace.targetNodeId}:${selectionContextKey(trace.anchor)}`
    )
    .join("|");
}

function isNearBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= 48;
}

export interface ConversationPanelOptions {
  isObsidianMarkdownCompatibilityEnabled?: (() => boolean) | undefined;
  transientUsage?: TransientUsagePort | undefined;
  transientResponseStatus?: TransientResponseStatusPort | undefined;
  transientThinking?: TransientThinkingPort | undefined;
  webSearch?: WebSearchControlPort | undefined;
  relatedNotes?: RelatedNoteControlPort | undefined;
  contextDivergence?: ContextDivergenceControlPort | undefined;
  answerThinking?: AnswerThinkingControlPort | undefined;
}

export function responseProgressLabel(progress: ResponseProgressRecord): string {
  switch (progress.status) {
    case "thinking":
    case "preparing-context":
      return "正在准备对话上下文…";
    case "identifying-focus":
      return "正在围绕框选内容确定回答焦点…";
    case "selecting-context":
      return "正在筛选父节点与笔记上下文…";
    case "context-selected": {
      const prefix = progress.supplementary === true ? "已补充" : "已选择";
      return `${prefix} ${String(progress.selectedNodeCount ?? 0)} 个节点和 ${String(progress.selectedNoteCount ?? 0)} 篇笔记…`;
    }
    case "reading-context":
      return "正在读取选中的上下文…";
    case "organizing-answer":
      return "正在组织回答…";
    case "supplementing-context":
      return "正在补充缺失的上下文…";
    case "generating-final-answer":
      return "正在生成最终回答…";
    case "deciding-web-search":
      return "正在判断是否需要联网…";
    case "searching-web":
      return "正在搜索网页…";
    case "organizing-web-results":
      return "正在整理搜索结果…";
  }
}

export function shouldShowResponseProgress(
  message: ChatMessage,
  progress: ResponseProgressRecord | undefined
): progress is ResponseProgressRecord {
  return (
    message.role === "assistant" &&
    message.status === "streaming" &&
    message.content.length === 0 &&
    progress !== undefined
  );
}

function formatTokenCount(value: number | undefined): string {
  return value === undefined ? "未提供" : value.toLocaleString("zh-CN");
}

function tokenStatsTitle(record: TokenStatsRecord): string {
  if (record.mode === "full") {
    const input = record.promptTokens ?? record.sentEstimatedTokens;
    const label = record.promptTokens === undefined ? "本轮估算" : "本轮输入";
    return `${label} ${formatTokenCount(input)} Token`;
  }
  const parts: string[] = [];
  if (record.reducedTokens >= 256 || record.reductionRatio >= 0.05) {
    parts.push(`本轮减少 ${formatTokenCount(record.reducedTokens)} Token`);
  }
  if ((record.cacheHitTokens ?? 0) > 0) {
    parts.push(`缓存命中 ${formatTokenCount(record.cacheHitTokens)} Token`);
  }
  if (parts.length === 0) {
    parts.push(`本轮输入 ${formatTokenCount(record.promptTokens ?? record.sentEstimatedTokens)} Token`);
  }
  return parts.join(" · ");
}

function referencedNoteNamesLabel(message: ChatMessage): string {
  const names = message.referencedNoteNames ?? [];
  return names.length === 0 ? "无" : names.join("、");
}

function createTokenStatsDetails(
  document: Document,
  record: TokenStatsRecord | undefined,
  message: ChatMessage
): HTMLDetailsElement {
  const details = document.createElement("details");
  details.className = "treetalk-token-stats";
  const summary = document.createElement("summary");
  summary.textContent =
    record === undefined
      ? `候选上下文笔记：${referencedNoteNamesLabel(message)}`
      : tokenStatsTitle(record);
  const rows = document.createElement("div");
  rows.className = "treetalk-token-stats-rows";
  const values: Array<[string, string]> = [];
  if (record !== undefined) {
    const total =
      record.promptTokens === undefined && record.completionTokens === undefined
        ? undefined
        : (record.promptTokens ?? 0) + (record.completionTokens ?? 0);
    values.push(
      ["实际输入", formatTokenCount(record.promptTokens)],
      ["实际输出", formatTokenCount(record.completionTokens)],
      ["其中推理", formatTokenCount(record.reasoningTokens)],
      ["本轮合计", formatTokenCount(total)],
      ["缓存命中", formatTokenCount(record.cacheHitTokens)],
      ["缓存未命中", formatTokenCount(record.cacheMissTokens)],
      ["首轮索引估算", formatTokenCount(record.sentEstimatedTokens)]
    );
    if ((record.noteContextOriginalEstimatedTokens ?? 0) > 0) {
      values.push(
        ["笔记上下文", record.noteContextTrimmed ? "已裁剪" : "完整"],
        [
          "笔记原始估算",
          formatTokenCount(record.noteContextOriginalEstimatedTokens)
        ],
        [
          "笔记实际发送",
          formatTokenCount(record.noteContextSentEstimatedTokens)
        ]
      );
    }
    if (record.mode === "balanced") {
      values.push(
        ["完整模式估算", formatTokenCount(record.fullEstimatedTokens)],
        ["减少输入", formatTokenCount(record.reducedTokens)],
        ["减少比例", `${(record.reductionRatio * 100).toFixed(1)}%`]
      );
    }
  }
  values.push(["候选上下文笔记", referencedNoteNamesLabel(message)]);
  for (const [label, value] of values) {
    const row = document.createElement("div");
    row.className = "treetalk-token-stats-row";
    const name = document.createElement("span");
    name.textContent = label;
    const amount = document.createElement("span");
    amount.textContent = value;
    row.append(name, amount);
    rows.append(row);
  }
  details.append(summary, rows);
  return details;
}

export function renderConversationPanel(
  container: HTMLElement,
  store: ConversationStorePort,
  actions?: ConversationPanelActions,
  rendererFactory: MessageRendererFactory =
    plainTextMessageRendererFactory,
  highlights?: SourceHighlightPort,
  options?: ConversationPanelOptions
): () => void {
  let disposed = false;
  let suppressSync = false;
  let shellKey = "";
  let messagesMount: HTMLElement | undefined;
  let composer: ComposerElements | undefined;
  let followBottom = true;
  const messageViews = new Map<string, MessageViewState>();
  let shellCleanups: Array<() => void> = [];
  let sourceRangeCleanup: (() => void) | undefined;
  const sourceTimerCancels: Array<() => void> = [];
  const onContextMenu = (event: MouseEvent): void => {
    if (
      actions?.toggleBranch === undefined ||
      !shouldToggleBranchFromContextMenu(event, container, composer)
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    actions.toggleBranch();
  };
  container.addEventListener("contextmenu", onContextMenu);

  const removeVisualSourceHighlight = (): void => {
    sourceRangeCleanup?.();
    sourceRangeCleanup = undefined;
    for (const element of container.querySelectorAll<HTMLElement>(
      ".treetalk-source-message-flash"
    )) {
      element.classList.remove("treetalk-source-message-flash");
    }
  };

  const clearSourceHighlight = (): void => {
    for (const cancel of sourceTimerCancels.splice(0)) cancel();
    removeVisualSourceHighlight();
  };

  const scheduleSourceTimer = (
    callback: () => void,
    delay: number
  ): void => {
    const timer = setTimeout(callback, delay);
    sourceTimerCancels.push(() => clearTimeout(timer));
  };

  const applySourceHighlight = (
    source: TreeTalkSource,
    attempt = 0
  ): void => {
    if (disposed) return;
    const conversation = store.getSnapshot();
    if (
      conversation === undefined ||
      conversation.id !== source.conversationId ||
      conversation.currentNodeId !== source.nodeId ||
      source.messageId === undefined
    ) {
      return;
    }
    const messageView = messageViews.get(source.messageId);
    if (
      messageView === undefined ||
      messageView.renderedContent === undefined
    ) {
      const delays = [16, 48, 96, 180, 320];
      const delay = delays[attempt];
      if (delay !== undefined) {
        scheduleSourceTimer(
          () => applySourceHighlight(source, attempt + 1),
          delay
        );
      }
      return;
    }

    removeVisualSourceHighlight();
    messageView.article.classList.add("treetalk-source-message-flash");
    if (typeof messageView.article.scrollIntoView === "function") {
      messageView.article.scrollIntoView({
        block: "center",
        behavior: "smooth"
      });
    }
    if (
      source.anchor !== undefined &&
      source.anchor.messageId === source.messageId
    ) {
      const resolved = resolveSelectionAnchor(
        canonicalRenderedText(messageView.content),
        source.anchor
      );
      if (resolved.status === "resolved") {
        const installed = installSourceRangeHighlight(
          messageView.content,
          resolved.start,
          resolved.end
        );
        if (installed.elements.length > 0) {
          sourceRangeCleanup = () => installed.cleanup();
          const firstElement = installed.elements[0];
          if (
            firstElement !== undefined &&
            typeof firstElement.scrollIntoView === "function"
          ) {
            firstElement.scrollIntoView({
              block: "center",
              behavior: "smooth"
            });
          }
        }
      }
    }
    scheduleSourceTimer(removeVisualSourceHighlight, 1800);
  };

  const disposeMessageView = (view: MessageViewState): void => {
    view.renderVersion += 1;
    view.cancelScheduled?.();
    for (const cleanup of view.cleanups) cleanup();
    view.renderer.dispose();
    view.article.remove();
  };

  const disposeShell = (): void => {
    clearSourceHighlight();
    for (const view of messageViews.values()) disposeMessageView(view);
    messageViews.clear();
    for (const cleanup of shellCleanups) cleanup();
    shellCleanups = [];
    messagesMount = undefined;
    composer = undefined;
    shellKey = "";
  };

  const createComposer = (): ComposerElements => {
    const root = document.createElement("div");
    const contextMount = document.createElement("div");
    const inputRow = document.createElement("div");
    const input = document.createElement("textarea");
    const inputActions = document.createElement("div");
    const composerActions = document.createElement("div");
    const modeIndicator = document.createElement("div");
    const graph = document.createElement("button");
    const relatedNotes = document.createElement("button");
    const contextDivergence = document.createElement("button");
    const answerThinking = document.createElement("button");
    const webSearch = document.createElement("button");
    const send = document.createElement("button");
    root.className = "treetalk-composer";
    contextMount.className = "treetalk-selection-contexts";
    inputRow.className = "treetalk-input-row";
    inputActions.className = "treetalk-input-actions";
    composerActions.className = "treetalk-composer-actions";
    modeIndicator.className = "treetalk-branch-mode";
    modeIndicator.textContent = "子分支";
    modeIndicator.hidden = true;
    input.rows = 2;
    input.placeholder = "输入问题…";
    graph.type = "button";
    graph.className = "treetalk-open-relationship-graph treetalk-control";
    graph.setAttribute("aria-label", "打开关系图谱");
    graph.title = "打开关系图谱：查看对话节点与笔记链接";
    setIcon(graph, "git-fork");
    graph.hidden = actions?.openRelationshipGraph === undefined;
    graph.addEventListener("click", () => actions?.openRelationshipGraph?.());
    relatedNotes.type = "button";
    relatedNotes.className = "treetalk-related-note-toggle treetalk-control";
    setIcon(relatedNotes, "link-2");
    contextDivergence.type = "button";
    contextDivergence.className = "treetalk-context-divergence-toggle treetalk-control";
    setIcon(contextDivergence, "git-fork");
    answerThinking.type = "button";
    answerThinking.className = "treetalk-answer-thinking-toggle treetalk-control";
    setIcon(answerThinking, "brain");
    webSearch.type = "button";
    webSearch.className = "treetalk-web-search-toggle treetalk-control";
    setIcon(webSearch, "globe-2");
    send.type = "button";
    input.addEventListener("input", () => {
      send.disabled = input.value.trim().length === 0;
      suppressSync = true;
      try {
        store.update((current) => {
          const next = structuredClone(current);
          const node = next.nodes[next.currentNodeId];
          if (node === undefined) return next;
          const now = new Date().toISOString();
          node.draft.text = input.value;
          node.updatedAt = now;
          next.updatedAt = now;
          next.revision += 1;
          return next;
        });
      } finally {
        suppressSync = false;
      }
    });
    composerActions.append(
      relatedNotes,
      contextDivergence,
      answerThinking,
      webSearch,
      send
    );
    inputActions.append(modeIndicator, graph, composerActions);
    inputRow.append(input, inputActions);
    root.append(contextMount, inputRow);
    return {
      root,
      contextMount,
      input,
      modeIndicator,
      graph,
      relatedNotes,
      contextDivergence,
      answerThinking,
      webSearch,
      send
    };
  };

  const syncCaptureButton = (
    view: MessageViewState,
    message: ChatMessage
  ): void => {
    const shouldShow =
      message.role === "assistant" &&
      message.status === "complete" &&
      actions?.captureAnswer !== undefined;
    if (!shouldShow) {
      view.captureButton?.remove();
      delete view.captureButton;
      return;
    }
    if (view.captureButton === undefined) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "treetalk-capture-answer treetalk-control";
      button.textContent = "沉淀回答";
      button.addEventListener("click", () => {
        void actions.captureAnswer?.(message.id);
      });
      view.captureButton = button;
    }
    view.article.append(view.captureButton);
  };

  const syncRetryButton = (
    view: MessageViewState,
    message: ChatMessage
  ): void => {
    const shouldShow =
      message.role === "assistant" &&
      message.status === "failed" &&
      actions?.retryAnswer !== undefined;
    if (!shouldShow) {
      view.retryButton?.remove();
      delete view.retryButton;
      return;
    }
    if (view.retryButton === undefined) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "treetalk-retry-answer treetalk-control";
      button.textContent = "重试";
      button.addEventListener("click", () => {
        void actions.retryAnswer?.(message.id);
      });
      view.retryButton = button;
    }
    view.article.append(view.retryButton);
  };

  const syncResponseProgress = (
    view: MessageViewState,
    message: ChatMessage
  ): void => {
    const progress = options?.transientResponseStatus?.get(message.id);
    if (!shouldShowResponseProgress(message, progress)) {
      view.responseProgress?.remove();
      delete view.responseProgress;
      return;
    }
    if (view.responseProgress === undefined) {
      const progress = container.ownerDocument.createElement("div");
      progress.className = "treetalk-response-progress";
      progress.setAttribute("role", "status");
      progress.setAttribute("aria-live", "polite");
      progress.setAttribute("aria-atomic", "true");
      view.responseProgress = progress;
      view.article.insertBefore(progress, view.content);
    }
    view.responseProgress.textContent = responseProgressLabel(progress);
  };

  const syncThinking = (
    view: MessageViewState,
    message: ChatMessage
  ): void => {
    const record = options?.transientThinking?.get(message.id);
    const shouldShow =
      message.role === "assistant" &&
      message.status === "streaming" &&
      record !== undefined &&
      record.content.length > 0;
    if (!shouldShow) {
      view.thinkingPanel?.remove();
      delete view.thinkingPanel;
      delete view.thinkingContent;
      delete view.renderedThinkingLength;
      return;
    }
    if (view.thinkingPanel === undefined) {
      const details = container.ownerDocument.createElement("details");
      details.className = "treetalk-thinking-panel";
      const summary = container.ownerDocument.createElement("summary");
      summary.textContent = "思考过程 · 正在生成";
      const content = container.ownerDocument.createElement("pre");
      content.className = "treetalk-thinking-content";
      details.append(summary, content);
      view.thinkingPanel = details;
      view.thinkingContent = content;
      view.article.insertBefore(details, view.content);
    }
    if (view.thinkingContent !== undefined && view.thinkingPanel !== undefined) {
      view.renderedThinkingLength ??= 0;
      const renderedThinkingLength = view.renderedThinkingLength;
      const shouldFollow =
        view.thinkingPanel.open && isNearBottom(view.thinkingContent);
      if (record.content.length < renderedThinkingLength) {
        view.thinkingContent.textContent = record.content;
      } else if (record.content.length > renderedThinkingLength) {
        const suffix = record.content.slice(view.renderedThinkingLength);
        view.thinkingContent.append(
          container.ownerDocument.createTextNode(suffix)
        );
      }
      view.renderedThinkingLength = record.content.length;
      if (shouldFollow) {
        view.thinkingContent.scrollTop = view.thinkingContent.scrollHeight;
      }
    }
  };

  const syncAgentExecution = (
    view: MessageViewState,
    message: ChatMessage
  ): void => {
    if (message.role !== "assistant" || message.agentRun === undefined) {
      view.agentExecution?.remove();
      delete view.agentExecution;
      return;
    }
    const open = view.agentExecution?.open ?? false;
    view.agentExecution?.remove();
    const model = agentExecutionViewModel(message.agentRun);
    const details = container.ownerDocument.createElement("details");
    details.className = "treetalk-agent-execution";
    const summary = container.ownerDocument.createElement("summary");
    summary.textContent = model.title;
    const rows = container.ownerDocument.createElement("div");
    rows.className = "treetalk-agent-execution-rows";
    for (const [label, value] of model.rows) {
      const row = container.ownerDocument.createElement("div");
      row.className = "treetalk-agent-execution-row";
      const name = container.ownerDocument.createElement("span");
      name.textContent = label;
      const content = container.ownerDocument.createElement("span");
      content.textContent = value;
      row.append(name, content);
      rows.append(row);
    }
    details.append(summary, rows);
    details.open = open;
    view.agentExecution = details;
    view.article.append(details);
  };

  const syncTokenStats = (
    view: MessageViewState,
    message: ChatMessage
  ): void => {
    const record = options?.transientUsage?.get(message.id);
    const shouldShow =
      message.role === "assistant" && message.status === "complete";
    if (!shouldShow) {
      view.tokenStats?.remove();
      delete view.tokenStats;
      return;
    }
    const displayRecord =
      record !== undefined && shouldDisplayTokenStats(record) ? record : undefined;
    const open = view.tokenStats?.open ?? false;
    view.tokenStats?.remove();
    view.tokenStats = createTokenStatsDetails(
      container.ownerDocument,
      displayRecord,
      message
    );
    view.tokenStats.open = open;
    view.article.append(view.tokenStats);
  };

  const performMessageRender = async (
    view: MessageViewState,
    version: number,
    pending: NonNullable<MessageViewState["pending"]>
  ): Promise<void> => {
    const staging = container.ownerDocument.createElement("div");
    const compatibilityEnabled =
      pending.message.role === "assistant" &&
      pending.message.status === "streaming" &&
      (options?.isObsidianMarkdownCompatibilityEnabled?.() ?? false);
    const split = compatibilityEnabled
      ? splitStreamingMarkdown(pending.message.content)
      : { stableMarkdown: pending.message.content, pendingSource: "" };
    const renderedMount = container.ownerDocument.createElement("div");
    renderedMount.className = "treetalk-streaming-rendered";
    if (split.stableMarkdown.length > 0) {
      try {
        await view.renderer.render(split.stableMarkdown, renderedMount);
      } catch (error) {
        if (!renderWarnedMessages.has(pending.message.id)) {
          renderWarnedMessages.add(pending.message.id);
          logWarning(`流式 Markdown 渲染失败: ${pending.message.id}`, error);
        }
        renderedMount.textContent = split.stableMarkdown;
      }
      enhanceRenderedMarkdown(renderedMount, split.stableMarkdown);
      staging.append(renderedMount);
    }
    if (split.pendingSource.length > 0) {
      const pendingSource = container.ownerDocument.createElement("pre");
      pendingSource.className = "treetalk-streaming-source-tail";
      pendingSource.textContent = split.pendingSource;
      staging.append(pendingSource);
    }
    installMessageTraces(
      staging,
      pending.conversation,
      pending.traces,
      (nodeId) => store.selectNode(nodeId)
    );
    if (
      disposed ||
      version !== view.renderVersion ||
      !messageViews.has(pending.message.id)
    ) {
      return;
    }
    view.content.replaceChildren(...staging.childNodes);
    view.content.classList.add("is-rendered");
    view.renderedContent = pending.message.content;
    view.renderedTraceKey = pending.traceKey;
    view.renderedStatus = pending.message.status;
    if (followBottom && messagesMount !== undefined) {
      messagesMount.scrollTop = messagesMount.scrollHeight;
    }
  };

  const scheduleMessageRender = (
    view: MessageViewState,
    pending: NonNullable<MessageViewState["pending"]>
  ): void => {
    view.renderVersion += 1;
    view.pending = pending;
    if (view.cancelScheduled !== undefined) return;
    view.cancelScheduled = scheduleAnimationFrame(
      container.ownerDocument,
      () => {
        delete view.cancelScheduled;
        const latest = view.pending;
        if (latest === undefined) return;
        const version = view.renderVersion;
        void performMessageRender(view, version, latest);
      }
    );
  };

  const createMessageView = (
    message: ChatMessage,
    mutable: boolean
  ): MessageViewState => {
    const article = document.createElement("article");
    const content = document.createElement("div");
    article.dataset.messageId = message.id;
    content.className = "treetalk-message-content";
    article.append(content);
    const cleanups = [installSelectionDrag(content, store, message.id)];
    if (mutable) {
      const onMouseUp = (): void => {
        const selection = content.ownerDocument.defaultView?.getSelection();
        if (
          selection === null ||
          selection === undefined ||
          selection.rangeCount === 0 ||
          selection.isCollapsed
        ) {
          return;
        }
        const range = selection.getRangeAt(0);
        if (
          !content.contains(range.startContainer) ||
          !content.contains(range.endContainer)
        ) {
          return;
        }
        const selectionContext = selectionForDomRange(content, range);
        if (selectionContext === undefined) return;
        void attachSelectionContext(
          store,
          message.id,
          selectionContext.visibleText,
          selectionContext.startOffset,
          selectionContext.endOffset,
          selectionContext.sourceText
        ).catch(() => undefined);
      };
      content.addEventListener("mouseup", onMouseUp);
      cleanups.push(() => content.removeEventListener("mouseup", onMouseUp));
    }
    return {
      article,
      content,
      renderer: rendererFactory.create(),
      renderVersion: 0,
      cleanups
    };
  };

  const syncMessages = (
    conversation: ConversationFile,
    mutable: boolean
  ): void => {
    const node = conversation.nodes[conversation.currentNodeId];
    if (node === undefined || messagesMount === undefined) return;
    const currentIds = new Set(node.messages.map((message) => message.id));
    for (const [messageId, view] of messageViews) {
      if (!currentIds.has(messageId)) {
        disposeMessageView(view);
        messageViews.delete(messageId);
      }
    }

    for (const message of node.messages) {
      let view = messageViews.get(message.id);
      if (view === undefined) {
        view = createMessageView(message, mutable);
        messageViews.set(message.id, view);
      }
      view.article.className =
        `treetalk-message is-${message.role} is-${message.status}`;
      if (view.article.parentElement !== messagesMount) {
        messagesMount.append(view.article);
      }
      syncCaptureButton(view, message);
      syncRetryButton(view, message);
      syncResponseProgress(view, message);
      syncThinking(view, message);
      syncAgentExecution(view, message);
      syncTokenStats(view, message);
      const traces = selectionTracesForMessage(conversation, message.id);
      const traceKey = messageTraceKey(traces);
      if (
        view.renderedContent !== message.content ||
        view.renderedTraceKey !== traceKey ||
        view.renderedStatus !== message.status
      ) {
        scheduleMessageRender(view, {
          message,
          conversation,
          nodeId: node.id,
          mutable,
          traceKey,
          traces
        });
      }
    }
  };

  const syncComposer = (conversation: ConversationFile): void => {
    if (composer === undefined) return;
    const node = conversation.nodes[conversation.currentNodeId];
    if (node === undefined) return;
    composer.root.className = `treetalk-composer is-${node.draft.mode}`;
    composer.modeIndicator.hidden = node.draft.mode !== "child";
    renderDraftContexts(composer.contextMount, store);
    const isStreaming = node.messages.some(
      (message) =>
        message.role === "assistant" && message.status === "streaming"
    );
    composer.input.disabled = isStreaming;
    if (
      composer.input.ownerDocument.activeElement !== composer.input &&
      composer.input.value !== node.draft.text
    ) {
      composer.input.value = node.draft.text;
    }
    const relatedNotesControl = options?.relatedNotes;
    const relatedNotesEnabled =
      relatedNotesControl?.relatedNoteContextEnabled() ?? false;
    composer.relatedNotes.disabled = isStreaming || relatedNotesControl === undefined;
    composer.relatedNotes.className = [
      "treetalk-related-note-toggle",
      "treetalk-control",
      relatedNotesEnabled ? "is-enabled" : ""
    ].filter((entry) => entry.length > 0).join(" ");
    composer.relatedNotes.setAttribute("aria-pressed", String(relatedNotesEnabled));
    composer.relatedNotes.setAttribute(
      "aria-label",
      relatedNotesEnabled ? "关闭关联笔记上下文" : "开启关联笔记上下文"
    );
    composer.relatedNotes.title = relatedNotesEnabled
      ? "关联笔记已开启。点击关闭；读取深度仍由设置页控制。"
      : "关联笔记已关闭。点击开启；读取深度仍由设置页控制。";
    composer.relatedNotes.onclick = null;
    if (!isStreaming && relatedNotesControl !== undefined) {
      composer.relatedNotes.onclick = () => {
        void relatedNotesControl.setEnabled(!relatedNotesEnabled);
      };
    }

    const contextDivergenceControl = options?.contextDivergence;
    const contextDivergenceEnabled =
      contextDivergenceControl?.contextDivergenceEnabled() ?? false;
    const contextDivergenceAvailable =
      contextDivergenceControl !== undefined;
    composer.contextDivergence.disabled =
      isStreaming || !contextDivergenceAvailable;
    composer.contextDivergence.className = [
      "treetalk-context-divergence-toggle",
      "treetalk-control",
      contextDivergenceEnabled ? "is-enabled" : "",
      contextDivergenceAvailable ? "" : "is-unavailable"
    ].filter((entry) => entry.length > 0).join(" ");
    composer.contextDivergence.setAttribute(
      "aria-pressed",
      String(contextDivergenceEnabled)
    );
    composer.contextDivergence.setAttribute(
      "aria-label",
      contextDivergenceEnabled ? "关闭上下文发散" : "开启上下文发散"
    );
    composer.contextDivergence.title = contextDivergenceEnabled
      ? "上下文发散：开启。模型可在权限范围内跨级请求上下文；点击关闭。"
      : "上下文发散：关闭。模型按相邻层级请求上下文；点击开启。";
    composer.contextDivergence.onclick = null;
    if (!isStreaming && contextDivergenceAvailable) {
      composer.contextDivergence.onclick = () => {
        void contextDivergenceControl.setEnabled(!contextDivergenceEnabled);
      };
    }

    const answerThinking = options?.answerThinking;
    const answerThinkingAvailable = answerThinking?.isAvailable() ?? false;
    const answerThinkingMode = answerThinking?.answerThinkingMode() ?? "disabled";
    const thinkingModeLabel = answerThinkingMode === "enabled" ? "开启" : "关闭";
    composer.answerThinking.disabled = isStreaming || !answerThinkingAvailable;
    composer.answerThinking.className = [
      "treetalk-answer-thinking-toggle",
      "treetalk-control",
      `is-${answerThinkingMode}`,
      answerThinkingAvailable ? "" : "is-unavailable"
    ].filter((entry) => entry.length > 0).join(" ");
    composer.answerThinking.setAttribute("aria-label", `思考模式：${thinkingModeLabel}`);
    composer.answerThinking.setAttribute("aria-pressed", String(answerThinkingMode === "enabled"));
    composer.answerThinking.title = answerThinkingAvailable
      ? answerThinkingMode === "enabled"
        ? "思考模式：开启。后续请求将启用模型思考；点击关闭。"
        : "思考模式：关闭。后续请求将直接回答；点击开启。"
      : "当前服务商暂不支持显式控制思考模式";
    composer.answerThinking.onclick = null;
    if (!isStreaming && answerThinkingAvailable && answerThinking !== undefined) {
      composer.answerThinking.onclick = () => {
        const nextMode: AnswerThinkingMode =
          answerThinkingMode === "enabled" ? "disabled" : "enabled";
        void answerThinking.setMode(nextMode);
      };
    }

    const webSearch = options?.webSearch;
    const webSearchAvailable = webSearch?.isAvailable() ?? false;
    const webSearchEnabled = webSearch?.isEnabled() ?? false;
    composer.webSearch.disabled = isStreaming || !webSearchAvailable;
    composer.webSearch.className = [
      "treetalk-web-search-toggle",
      "treetalk-control",
      webSearchEnabled ? "is-enabled" : "",
      webSearchAvailable ? "" : "is-unavailable"
    ].filter((entry) => entry.length > 0).join(" ");
    composer.webSearch.setAttribute("aria-pressed", String(webSearchEnabled));
    composer.webSearch.setAttribute(
      "aria-label",
      webSearchEnabled ? "关闭联网模式" : "开启联网模式"
    );
    composer.webSearch.title = webSearchAvailable
      ? webSearchEnabled
        ? "联网模式已开启：DeepSeek 会自动判断是否搜索网页"
        : "联网模式已关闭"
      : "当前服务商暂不支持联网模式";
    composer.webSearch.onclick = null;
    if (!isStreaming && webSearchAvailable && webSearch !== undefined) {
      composer.webSearch.onclick = () => {
        void webSearch.setEnabled(!webSearch.isEnabled());
      };
    }
    composer.send.onclick = null;
    if (isStreaming) {
      composer.send.className = "treetalk-send treetalk-stop";
      composer.send.setAttribute("aria-label", "停止生成");
      setIcon(composer.send, "square");
      composer.send.disabled = false;
      composer.send.onclick = () => {
        if (actions?.stop !== undefined) void actions.stop();
      };
    } else {
      composer.send.className = "treetalk-send";
      composer.send.setAttribute("aria-label", "发送");
      setIcon(composer.send, "arrow-up");
      composer.send.disabled = composer.input.value.trim().length === 0;
      composer.send.onclick = () => {
        const text = composer?.input.value.trim() ?? "";
        if (text.length > 0 && actions !== undefined) void actions.send(text);
      };
    }
  };

  const buildShell = (
    conversation: ConversationFile | undefined,
    mutable: boolean,
    mode: "active" | "archived" | undefined
  ): void => {
    disposeShell();
    container.replaceChildren();
    container.className = "treetalk-conversation";
    if (conversation === undefined) {
      shellKey = "empty";
      emptyState(container, actions);
      return;
    }
    shellKey = [
      conversation.id,
      conversation.currentNodeId,
      conversation.status,
      mode ?? "unknown",
      String(mutable)
    ].join(":");

    if (mode === "archived") {
      const historyBar = document.createElement("div");
      historyBar.className = "treetalk-history-bar is-archived";
      const restore = document.createElement("button");
      restore.type = "button";
      restore.className = "treetalk-restore";
      restore.textContent = "恢复对话";
      restore.disabled = actions?.restore === undefined;
      restore.addEventListener("click", () => {
        if (actions?.restore !== undefined) void actions.restore();
      });
      historyBar.append(restore);
      container.append(historyBar);
    }

    if (mode === "active" && actions?.captureTree !== undefined) {
      const captureBar = document.createElement("div");
      captureBar.className = "treetalk-capture-bar";
      const captureTree = document.createElement("button");
      captureTree.type = "button";
      captureTree.className = "treetalk-capture-tree";
      captureTree.textContent = "沉淀对话树";
      captureTree.addEventListener("click", () => {
        void actions.captureTree?.();
      });
      captureBar.append(captureTree);
      container.append(captureBar);
    }

    messagesMount = document.createElement("div");
    messagesMount.className = "treetalk-messages";
    followBottom = true;
    const onScroll = (): void => {
      if (messagesMount !== undefined) followBottom = isNearBottom(messagesMount);
    };
    messagesMount.addEventListener("scroll", onScroll, { passive: true });
    shellCleanups.push(() => messagesMount?.removeEventListener("scroll", onScroll));
    shellCleanups.push(installObsidianFormulaSelection(messagesMount));
    container.append(messagesMount);

    if (mutable) {
      composer = createComposer();
      container.append(composer.root);
    }
  };

  const syncThinkingMessage = (messageId: string): void => {
    if (disposed) return;
    const conversation = store.getSnapshot();
    if (conversation === undefined) return;
    const node = conversation.nodes[conversation.currentNodeId];
    const message = node?.messages.find((entry) => entry.id === messageId);
    const view = messageViews.get(messageId);
    if (message === undefined || view === undefined) return;
    syncThinking(view, message);
  };

  const sync = (): void => {
    const conversation = store.getSnapshot();
    const mode = store.getMode?.() ?? conversation?.status;
    const mutable =
      mode === "active" &&
      conversation?.status === "active" &&
      (store.canMutate?.() ?? true);
    const nextKey =
      conversation === undefined
        ? "empty"
        : [
            conversation.id,
            conversation.currentNodeId,
            conversation.status,
            mode ?? "unknown",
            String(mutable)
          ].join(":");
    if (nextKey !== shellKey) buildShell(conversation, mutable, mode);
    if (conversation === undefined) return;
    syncMessages(conversation, mutable);
    if (mutable) syncComposer(conversation);
  };

  const unsubscribe = store.subscribe(() => {
    if (!suppressSync) sync();
  });
  const unsubscribeHighlights = highlights?.subscribe((source) => {
    clearSourceHighlight();
    applySourceHighlight(source);
  });
  const unsubscribeUsage = options?.transientUsage?.subscribe(() => {
    if (!disposed) sync();
  });
  const unsubscribeResponseStatus =
    options?.transientResponseStatus?.subscribe(() => {
      if (!disposed) sync();
    });
  const unsubscribeThinking = options?.transientThinking?.subscribe((change) => {
    if (disposed) return;
    for (const messageId of change.messageIds) {
      syncThinkingMessage(messageId);
    }
  });
  const unsubscribeWebSearch = options?.webSearch?.subscribe(() => {
    if (!disposed) sync();
  });
  const unsubscribeRelatedNotes = options?.relatedNotes?.subscribe(() => {
    if (!disposed) sync();
  });
  const unsubscribeContextDivergence = options?.contextDivergence?.subscribe(() => {
    if (!disposed) sync();
  });
  const unsubscribeAnswerThinking = options?.answerThinking?.subscribe(() => {
    if (!disposed) sync();
  });
  sync();
  return () => {
    disposed = true;
    container.removeEventListener("contextmenu", onContextMenu);
    unsubscribe();
    unsubscribeHighlights?.();
    unsubscribeUsage?.();
    unsubscribeResponseStatus?.();
    unsubscribeThinking?.();
    unsubscribeWebSearch?.();
    unsubscribeRelatedNotes?.();
    unsubscribeContextDivergence?.();
    unsubscribeAnswerThinking?.();
    disposeShell();
  };
}
