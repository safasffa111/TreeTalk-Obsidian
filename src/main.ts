import {
  MarkdownView,
  Notice,
  Plugin,
  requestUrl,
  TFile,
  TFolder,
  type Menu
} from "obsidian";
import { ArchiveService } from "./archive/archive-service";
import { LifecycleQueue } from "./archive/lifecycle-queue";
import { LifecycleReconciler } from "./archive/lifecycle-reconciler";
import {
  cacheKeyForContextPlan,
  compileContextPlan,
  ProtectedContextTooLongError,
  type ContextPlan
} from "./domain/context-engine";
import { createConversation } from "./domain/conversation-factory";
import { RelationshipGraphWindow } from "./relationship-graph/window";
import { freezeNoteContextForMessage } from "./domain/note-context-freeze";
import { applyContextPlanPersistencePatch } from "./domain/context-persistence";
import { buildTreeTalkSystemPrompt } from "./domain/full-context-protocol";
import {
  normalizeObsidianMarkdown,
  OBSIDIAN_MARKDOWN_SYSTEM_PROMPT
} from "./domain/markdown-compatibility";
import {
  continueNode,
  hasUserMessage,
  isMarkdownPath,
  submitChildDraft,
  toggleBranchDraft
} from "./domain/tree-commands";
import type { ConversationFile } from "./domain/types";
import { createExcerptDropExtension } from "./editor/excerpt-drop-extension";
import {
  installNoteSelectionCapture,
  type MarkdownSelectionSource
} from "./editor/note-selection-capture";
import { HistoryIndex, type HistoryEntry } from "./history/history-index";
import { HistoryDeleteService } from "./history/history-delete-service";
import { logWarning } from "./utils/error-log";
import {
  confirmHistoryDeletion,
  HistoryManagerModal
} from "./history/history-manager-modal";
import {
  AnchorCaptureError,
  KnowledgeCaptureService,
  mapAnchorCaptureErrorToNotice
} from "./knowledge/capture-service";
import { SourceHighlightStore } from "./navigation/source-highlight-store";
import {
  conversationContainsSource,
  SourceLinkHandler,
  type TreeTalkSource
} from "./navigation/source-link-handler";
import { PiExecutionEngine } from "./agent/pi/pi-execution-engine";
import { buildPiFocusContext } from "./agent/pi/focus-context";
import { buildPiIndexContextPlan } from "./agent/pi/index-context-plan";
import type { ProgressiveRunCheckpoint } from "./agent/pi/progressive/types";
import { restartAssistantResponse } from "./domain/assistant-response";
import { ExecutionEventRecorder } from "./execution/event-recorder";
import type { AnswerThinkingMode } from "./execution/answer-thinking";
import { ExecutionRouter } from "./execution/execution-router";
import { LegacyExecutionEngine } from "./execution/legacy-execution-engine";
import { SendCoordinator } from "./execution/send-coordinator";
import type { ExecutionMode, ExecutionRequest } from "./execution/types";
import { ActiveResponseRequests } from "./providers/active-response-requests";
import type { ActiveResponseHandle } from "./providers/active-response-requests";
import { ProviderRegistry } from "./providers/provider-registry";
import { NodeSummaryCoordinator } from "./providers/node-summary-coordinator";
import { StreamingProviderTransport } from "./providers/streaming-transport";
import type { ProviderProfile } from "./providers/types";
import { TransientUsageStore } from "./providers/transient-usage-store";
import { TransientResponseStatusStore } from "./providers/transient-response-status-store";
import { TransientThinkingStore } from "./providers/transient-thinking-store";
import { runWithRequestDeadline } from "./providers/request-control";
import { ConversationRepository } from "./storage/conversation-repository";
import type { ObsidianPrivateStoragePort } from "./storage/obsidian-private-storage-port";
import { ObsidianNoteLinkResolver } from "./storage/obsidian-note-link-resolver";
import { ObsidianVaultPort } from "./storage/obsidian-vault-port";
import { ObsidianAnchorFileIndex } from "./storage/obsidian-anchor-file-index";
import { VaultIdentityStore } from "./storage/vault-identity-store";
import {
  conversationFolder,
  type ConversationRoots
} from "./storage/private-paths";
import { BatchedPersistenceScheduler } from "./storage/persistence-scheduler";
import { observeActiveTabLeaves } from "./storage/tabs-persistence-observer";
import { createPrivateStorageRuntime } from "./storage/runtime-private-storage";
import { SessionPersistence } from "./storage/session-persistence";
import {
  AnchorRenamer,
  type AnchorRenamerStore,
  type StoredAnchorRecord
} from "./domain/anchor-renamer";
import {
  AnchorRenameWorkflow,
  type VaultRename
} from "./domain/anchor-rename-workflow";
import { relocateVerifiedAnchor } from "./domain/anchor-relocator";
import {
  relocateStoredAnchorRecord,
  relocateTreeCaptureAnchor,
  saveStoredAnchorRecord
} from "./domain/stored-anchor-workflow";
import { classifyAnchor, type AnchorStatus } from "./domain/anchor-status";
import { decideFirstMessageAnchor } from "./domain/first-message-anchor-decision";
import { ProgressiveRunCheckpointStore } from "./state/progressive-run-checkpoint-store";
import { ActiveConversationStore } from "./tabs/active-conversation-store";
import { ConversationTabsStore } from "./tabs/conversation-tabs-store";
import {
  DEFAULT_SETTINGS,
  normalizeTreeTalkSettings,
  parsePluginData,
  type TreeTalkPluginData,
  type TreeTalkSettings
} from "./tabs/plugin-data";
import { TreeTalkSettingTab } from "./settings-tab";
import { TabLifecycleController } from "./tabs/tab-lifecycle-controller";
import { TabResponseRouter } from "./tabs/tab-response-router";
import type { TabResponseTicket } from "./tabs/tab-response-router";
import { loadStartupConversations } from "./tabs/startup-conversation-loader";
import type { ConversationTab } from "./tabs/types";
import {
  openConversationTab,
  selectAdjacentTab
} from "./tabs/tab-workspace-operations";
import {
  restoreTabsWorkspace,
  serializeTabsWorkspace,
  tabsWorkspaceDataEqual,
  type RestoredTabDescriptor
} from "./tabs/workspace-state";
import { TreeTalkWorkspaceView } from "./views/obsidian-views";
import {
  ObsidianSidebarWorkspacePort,
  SidebarWorkspaceCoordinator,
  TREETALK_WORKSPACE_VIEW_TYPE
} from "./views/sidebar-workspace-coordinator";

export const PLUGIN_ID = "treetalk";
export const COMMAND_IDS = {
  close: "close-current-conversation-tab",
  new: "new-conversation-tab",
  next: "next-conversation-tab",
  previous: "previous-conversation-tab",
  toggleBranch: "toggle-current-branch",
  depositGraph: "open-deposit-relationship-graph"
} as const;

const SECRET_ID = "treetalk-api-key";

function sourceSection(
  sources: Array<{ title: string; url: string }>
): string {
  if (sources.length === 0) return "";
  return [
    "### 参考来源",
    "",
    ...sources.map((source) => {
      const title = source.title
        .replace(/[\[\]\r\n]/gu, " ")
        .replace(/\s+/gu, " ")
        .trim();
      const url = source.url.replace(/[()]/gu, (character) =>
        encodeURIComponent(character)
      );
      return `- [${title.length > 0 ? title : source.url}](${url})`;
    })
  ].join("\n");
}

function folderFor(
  roots: ConversationRoots,
  conversation: ConversationFile
): string {
  return conversationFolder(roots.active, conversation.id);
}

function descriptor(
  folder: string,
  conversation: ConversationFile
): RestoredTabDescriptor {
  return {
    conversationId: conversation.id,
    folder,
    conversation
  };
}

export default class TreeTalkPlugin extends Plugin {
  private pluginData: TreeTalkPluginData = parsePluginData(undefined);
  private pluginSettings: TreeTalkSettings = DEFAULT_SETTINGS;
  private readonly tabsStore = new ConversationTabsStore();
  private readonly store = new ActiveConversationStore(this.tabsStore);
  private readonly sourceHighlights = new SourceHighlightStore();
  private readonly responseRouter = new TabResponseRouter(this.tabsStore);
  private readonly providers = new ProviderRegistry();
  private readonly nodeSummaries = new NodeSummaryCoordinator(
    this.tabsStore,
    this.providers,
    {
      request: async (request, signal) => {
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        const response = await runWithRequestDeadline(
          () =>
            requestUrl({
              url: request.url,
              method: request.method,
              headers: request.headers,
              body: JSON.stringify(request.body),
              throw: false
            }),
          signal
        );
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        if (response.status >= 400) {
          throw new Error(`HTTP ${String(response.status)}`);
        }
        return response.json;
      }
    },
    {
      getProfile: () => this.currentProviderProfile(),
      getModel: () => this.pluginSettings.model,
      now: () => new Date().toISOString(),
      persistPending: async (tabId) => {
        const tab = this.tabsStore.getTab(tabId);
        if (tab === undefined || this.persistence === undefined) {
          throw new Error("Session persistence is unavailable");
        }
        this.persistenceScheduler.flush();
        await this.persistence.flush(tab.folder);
      }
    }
  );
  private readonly streamingTransport = new StreamingProviderTransport();
  private readonly legacyExecutionEngine = new LegacyExecutionEngine({
    resolveAdapter: (profile) => this.providers.get(profile),
    stream: (adapter, request, signal) =>
      this.streamingTransport.stream(adapter, request, signal),
    bufferedRequest: async (request, signal) => {
      const response = await runWithRequestDeadline(
        () =>
          requestUrl({
            url: request.url,
            method: request.method,
            headers: request.headers,
            body: JSON.stringify(request.body),
            throw: false
          }),
        signal
      );
      return { status: response.status, json: response.json };
    }
  });
  private readonly piExecutionEngine = new PiExecutionEngine({
    streamRequest: (profile, request, signal) =>
      this.streamingTransport.stream(this.providers.get(profile), request, signal),
    bufferedRequest: async (request, signal) => {
      const response = await runWithRequestDeadline(
        () =>
          requestUrl({
            url: request.url,
            method: request.method,
            headers: request.headers,
            body: JSON.stringify(request.body),
            throw: false
          }),
        signal
      );
      return { status: response.status, json: response.json };
    },
    webPageRequest: async (url, signal) => {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const response = await runWithRequestDeadline(
        () =>
          requestUrl({
            url,
            method: "GET",
            headers: {
              Accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.8,*/*;q=0.1"
            },
            throw: false
          }),
        signal
      );
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const contentType = Object.entries(response.headers).find(
        ([name]) => name.toLowerCase() === "content-type"
      )?.[1];
      return {
        status: response.status,
        text: response.text,
        ...(contentType === undefined ? {} : { contentType })
      };
    }
  });
  private readonly executionRouter = new ExecutionRouter({
    legacy: this.legacyExecutionEngine,
    pi: this.piExecutionEngine
  });
  private readonly sendCoordinator = new SendCoordinator();
  private readonly transientUsage = new TransientUsageStore();
  private readonly transientResponseStatus =
    new TransientResponseStatusStore();
  private readonly transientThinking = new TransientThinkingStore();
  private readonly activeRequests = new ActiveResponseRequests(
    this.responseRouter,
    undefined,
    undefined,
    (event) => this.flushConversationPersistence(event.conversationId)
  );
  private readonly progressiveCheckpoints = new ProgressiveRunCheckpointStore();
  /**
   * Conversations that have entered send/retry but have not yet acquired an
   * ActiveResponseHandle. Guards the async gap between the initial check and
   * begin() so a fast double-click cannot produce an unhandled rejection.
   */
  private readonly sendingConversations = new Set<string>();
  private repository: ConversationRepository | undefined;
  private archiveService: ArchiveService | undefined;
  private lifecycleReconciler: LifecycleReconciler | undefined;
  private historyIndex: HistoryIndex | undefined;
  private historyDeleteService: HistoryDeleteService | undefined;
  private captureService: KnowledgeCaptureService | undefined;
  private knowledgeVault: ObsidianVaultPort | undefined;
  private roots: ConversationRoots | undefined;
  private persistence: SessionPersistence | undefined;
  private tabLifecycle: TabLifecycleController | undefined;
  private readonly lifecycleQueue = new LifecycleQueue();
  private readonly persistenceScheduler = new BatchedPersistenceScheduler(
    () => this.persistAllNow()
  );
  private coordinator: SidebarWorkspaceCoordinator | undefined;
  private relationshipGraphWindow: RelationshipGraphWindow | undefined;
  private dataSaveTail: Promise<void> = Promise.resolve();
  private readonly webSearchListeners = new Set<() => void>();
  private readonly composerControlListeners = new Set<() => void>();
  /** 显式锚定：tabId -> 待落库的笔记路径（仅首条消息时进入 canonical 数据）。 */
  private readonly pendingAnchors = new Map<string, string>();
  private readonly anchorChipListeners = new Set<() => void>();
  /** Vault 身份与文件锚点重定位 / 串行 rename 处理。 */
  private vaultIdentityStore: VaultIdentityStore | undefined;
  private anchorFileIndex: ObsidianAnchorFileIndex | undefined;
  private anchorRenamer: AnchorRenamer | undefined;
  private anchorRenameWorkflow: AnchorRenameWorkflow | undefined;
  private currentVaultId: string | undefined;

  async onload(): Promise<void> {
    this.registerEditorExtension(createExcerptDropExtension());
    const sourceLinkHandler = new SourceLinkHandler({
      openActive: (source) => this.openActiveSource(source),
      openHistory: (source) => this.openHistorySource(source)
    });
    this.registerObsidianProtocolHandler("treetalk-open", (parameters) => {
      void sourceLinkHandler.open(parameters).then((result) => {
        if (result === "missing") {
          new Notice("TreeTalk 来源对话不存在");
        }
      });
    });
    this.pluginData = parsePluginData(await this.loadData());
    this.pluginSettings = this.pluginData.settings;
    const runtime = createPrivateStorageRuntime(this.app.vault);
    const vaultPort = runtime.port;
    this.roots = runtime.roots;
    this.knowledgeVault = new ObsidianVaultPort(this.app.vault);
    this.captureService = new KnowledgeCaptureService(
      this.knowledgeVault,
      this.pluginSettings.knowledgeFolder,
      this.pluginSettings.treeCaptureFolder,
      { anchorStatusResolver: (conversation) => this.classifyAnchor(conversation) }
    );
    this.repository = new ConversationRepository(vaultPort);
    this.persistence = new SessionPersistence(this.repository, () => {
      new Notice("TreeTalk 自动保存遇到冲突，已保留冲突副本");
    });
    this.archiveService = new ArchiveService(
      this.repository,
      vaultPort,
      runtime.roots
    );
    this.lifecycleReconciler = new LifecycleReconciler(
      this.repository,
      vaultPort,
      runtime.roots
    );
    this.historyIndex = new HistoryIndex(vaultPort, runtime.roots.history);
    this.historyDeleteService = new HistoryDeleteService(
      vaultPort,
      this.historyIndex,
      (conversationId) => this.closeOpenHistory(conversationId)
    );
    // Vault 身份与文件锚点重定位：在插件目录之外持久化每 Vault 的 UUID。
    this.vaultIdentityStore = new VaultIdentityStore(
      vaultPort,
      this.app.vault.configDir
    );
    this.anchorFileIndex = new ObsidianAnchorFileIndex(this.app.vault);
    try {
      this.currentVaultId = await this.vaultIdentityStore.getVaultId();
    } catch (error) {
      logWarning("读取 Vault 身份失败", error);
      new Notice("TreeTalk Vault 身份文件损坏，锚点校验已停用");
      this.currentVaultId = undefined;
    }
    this.anchorRenamer = new AnchorRenamer(this.buildAnchorRenamerStore());
    this.anchorRenameWorkflow = new AnchorRenameWorkflow(
      this.anchorRenamer,
      this.currentVaultId
    );
    const reconciliation = await this.lifecycleQueue.run(() =>
      this.lifecycleReconciler?.reconcile() ??
      Promise.resolve({ repaired: 0, failed: 0 })
    );
    if (reconciliation.repaired > 0) {
      new Notice(
        `TreeTalk 已恢复 ${String(reconciliation.repaired)} 个中断的对话`
      );
    }
    if (reconciliation.failed > 0) {
      new Notice("部分 TreeTalk 对话需要手动检查，原文件未被删除");
    }

    await this.restoreOpenTabs(vaultPort, runtime.roots);
    await this.relocateOpenTabsOnStartup();
    await this.relocateStoredAnchorsOnStartup();
    this.tabLifecycle = new TabLifecycleController(
      this.tabsStore,
      this.persistence,
      this.archiveService,
      this.lifecycleQueue,
      () => this.saveTabsWorkspace(),
      this.historyIndex
    );
    this.register(
      installNoteSelectionCapture({
        document,
        store: this.store,
        getActiveSource: () => this.activeMarkdownSelectionSource(),
        now: () => new Date().toISOString()
      })
    );
    this.registerView(
      TREETALK_WORKSPACE_VIEW_TYPE,
      (leaf) =>
        new TreeTalkWorkspaceView(
          leaf,
          this.store,
          {
            send: (text) => this.send(text),
            restore: () => this.restoreActiveTab(),
            createConversation: () => this.createConversationTab(),
            openHistory: () => this.openHistoryManager(),
            captureTree: () => this.captureTree(),
            openRelationshipGraph: () => this.openDepositGraph(),
            captureAnswer: (messageId) => this.captureAnswer(messageId),
            retryAnswer: (messageId) => this.retryAssistant(messageId),
            stop: () => this.stopActiveResponse(),
            toggleBranch: () => this.toggleActiveBranch()
          },
          {
            initialTreeWidth: this.pluginSettings.treeWidth,
            onTreeWidthChange: (treeWidth) => {
              void this.updateSettings({
                ...this.pluginSettings,
                treeWidth
              });
            }
          },
          this.tabsStore,
          {
            create: () => this.createConversationTab(),
            close: (tabId) => this.closeTab(tabId),
            reorder: (tabId, targetIndex) =>
              this.tabsStore.reorder(tabId, targetIndex)
          },
          undefined,
          this.sourceHighlights,
          () => this.pluginSettings.obsidianMarkdownCompatibility,
          this.transientUsage,
          this.transientResponseStatus,
          this.transientThinking,
          {
            isEnabled: () => this.pluginSettings.webSearchEnabled,
            isAvailable: () => true,
            setEnabled: (enabled) => this.setWebSearchEnabled(enabled),
            subscribe: (listener) => this.subscribeWebSearch(listener)
          },
          {
            relatedNoteContextEnabled: () =>
              this.pluginSettings.relatedNoteContextEnabled,
            setEnabled: (enabled) =>
              this.setRelatedNoteContextEnabled(enabled),
            subscribe: (listener) => this.subscribeComposerControls(listener)
          },
          {
            contextDivergenceEnabled: () =>
              this.pluginSettings.contextDivergenceEnabled,
            setEnabled: (enabled) =>
              this.setContextDivergenceEnabled(enabled),
            subscribe: (listener) => this.subscribeComposerControls(listener)
          },
          {
            answerThinkingMode: () => this.pluginSettings.answerThinkingMode,
            isAvailable: () => true,
            setMode: (mode) => this.setAnswerThinkingMode(mode),
            subscribe: (listener) => this.subscribeComposerControls(listener)
          }
        )
    );
    this.coordinator = new SidebarWorkspaceCoordinator(
      new ObsidianSidebarWorkspacePort(this.app.workspace)
    );
    this.registerCommands();
    this.registerAnchorMenus();
    this.addSettingTab(new TreeTalkSettingTab(this.app, this));
    this.app.workspace.onLayoutReady(() => {
      void this.coordinator?.repairLegacyViews();
      this.schedulePersistAll();
    });
    this.register(
      this.tabsStore.subscribe(() => {
        this.schedulePersistAll();
        void this.saveTabsWorkspace();
      })
    );
    this.register(
      observeActiveTabLeaves(this.tabsStore, (tabId) => {
        const leavingTab = this.tabsStore.getTab(tabId);
        if (leavingTab !== undefined) {
          this.flushConversationPersistence(leavingTab.conversationId);
        }
      })
    );
    // Vault rename 事件：文件与文件夹必须走不同的重映射路径。
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        const kind = file instanceof TFile ? "file" : file instanceof TFolder ? "folder" : undefined;
        if (kind === "file" && !isMarkdownPath(file.path)) return;
        if (kind === undefined) return;
        const oldNormalized = oldPath.replace(/\\/gu, "/");
        const newNormalized = file.path.replace(/\\/gu, "/");
        if (oldNormalized === newNormalized) return;
        if (this.anchorRenameWorkflow === undefined) return;
        void this.handleVaultRename({
          kind,
          oldPath: oldNormalized,
          newPath: newNormalized
        });
      })
    );
    await this.saveTabsWorkspace();
    void this.nodeSummaries.repairOpenTabs();
  }

  onunload(): void {
    this.activeRequests.interruptAll(new Date().toISOString());
    this.nodeSummaries.dispose();
    this.progressiveCheckpoints.clear();
    this.transientUsage.clear();
    this.transientResponseStatus.clear();
    this.transientThinking.clear();
    this.persistenceScheduler.flush();
    void this.persistence?.flush().catch(() => undefined);
    this.relationshipGraphWindow?.destroy();
    this.relationshipGraphWindow = undefined;
    void this.coordinator?.close();
  }

  getSettings(): TreeTalkSettings {
    return this.pluginSettings;
  }

  async updateSettings(next: TreeTalkSettings): Promise<void> {
    const normalized = normalizeTreeTalkSettings(next);
    const webSearchChanged =
      normalized.webSearchEnabled !== this.pluginSettings.webSearchEnabled;
    const composerControlsChanged =
      normalized.answerThinkingMode !== this.pluginSettings.answerThinkingMode ||
      normalized.relatedNoteContextEnabled !==
        this.pluginSettings.relatedNoteContextEnabled ||
      normalized.contextDivergenceEnabled !==
        this.pluginSettings.contextDivergenceEnabled;
    this.pluginSettings = normalized;
    if (webSearchChanged) {
      for (const listener of this.webSearchListeners) listener();
    }
    if (composerControlsChanged) {
      for (const listener of [...this.composerControlListeners]) listener();
    }
    this.knowledgeVault = new ObsidianVaultPort(this.app.vault);
    this.captureService = new KnowledgeCaptureService(
      this.knowledgeVault,
      normalized.knowledgeFolder,
      normalized.treeCaptureFolder,
      { anchorStatusResolver: (conversation) => this.classifyAnchor(conversation) }
    );
    this.pluginData = { ...this.pluginData, settings: normalized };
    await this.persistPluginData();
  }

  subscribeWebSearch(listener: () => void): () => void {
    this.webSearchListeners.add(listener);
    return () => this.webSearchListeners.delete(listener);
  }

  subscribeComposerControls(listener: () => void): () => void {
    this.composerControlListeners.add(listener);
    return () => this.composerControlListeners.delete(listener);
  }

  /** 供输入区锚点 chip 订阅 pending anchor 变化。 */
  subscribeAnchorChip(listener: () => void): () => void {
    this.anchorChipListeners.add(listener);
    return () => this.anchorChipListeners.delete(listener);
  }

  getPendingAnchor(tabId: string): string | undefined {
    return this.pendingAnchors.get(tabId);
  }

  clearPendingAnchor(tabId: string): void {
    this.pendingAnchors.delete(tabId);
    this.anchorRenamer?.clearPending(tabId);
    this.notifyAnchorChipListeners();
  }

  private notifyAnchorChipListeners(): void {
    for (const listener of [...this.anchorChipListeners]) listener();
  }

  /** 显式锚定入口（右键菜单调用）：对话无用户消息且路径为 .md 时记录 pending。 */
  async anchorConversationToFile(filePath: string): Promise<void> {
    if (!isMarkdownPath(filePath)) return;
    let tab = this.tabsStore.getActiveTab();
    if (tab === undefined || tab.mode !== "active" || tab.lifecycle !== "idle") {
      await this.createConversationTab();
      tab = this.tabsStore.getActiveTab();
    }
    if (tab === undefined || tab.mode !== "active") return;
    if (hasUserMessage(tab.conversation)) {
      new Notice("当前对话已有消息，锚点在首条消息时确定，无法再更改");
      return;
    }
    if (tab.conversation.anchorFilePath !== undefined) {
      new Notice("当前对话已锚定，锚点不可更改");
      return;
    }
    this.pendingAnchors.set(tab.id, filePath);
    this.anchorRenamer?.setPending(tab.id, filePath);
    this.notifyAnchorChipListeners();
    new Notice(`已锚定到 ${filePath}，发送首条消息后生效`);
  }

  /**
   * 显式重新绑定入口（右键菜单调用）：将当前 active 会话或目标 Markdown
   * 写入完整 anchorVaultId + anchorFilePath + anchorFileCtime 三元组。
   *
   * 只对 legacy/foreign/missing/ambiguous 锚点开放；verified 锚点保持冻结。
   * 无用户消息的新会话则直接走普通锚定流程。
   */
  async rebindConversationToFile(filePath: string): Promise<void> {
    if (!isMarkdownPath(filePath)) return;
    const tab = this.tabsStore.getActiveTab();
    if (tab === undefined || tab.mode !== "active") {
      new Notice("请先打开要重新绑定的 TreeTalk 对话");
      return;
    }
    const status = this.classifyAnchor(tab.conversation);
    if (status.kind === "verified") {
      new Notice("当前锚点仍有效，无需重新绑定");
      return;
    }
    if (status.kind === "none") {
      // 未锚定的对话：回退为首次锚定。
      this.pendingAnchors.set(tab.id, filePath);
      this.anchorRenamer?.setPending(tab.id, filePath);
      this.notifyAnchorChipListeners();
      new Notice(`已锚定到 ${filePath}，发送首条消息后生效`);
      return;
    }
    // legacy / foreign / missing / ambiguous：写入 verified 三元组（只增加一次 revision）。
    if (this.currentVaultId === undefined) {
      new Notice("Vault 身份不可用，无法重新绑定");
      return;
    }
    const ctime = await this.readCtimeForAnchor(filePath);
    if (ctime === undefined) {
      new Notice("目标笔记无法读取 ctime，请确认文件存在");
      return;
    }
    const updated = structuredClone(tab.conversation) as ConversationFile;
    updated.anchorVaultId = this.currentVaultId;
    updated.anchorFilePath = filePath;
    updated.anchorFileCtime = ctime;
    updated.revision += 1;
    updated.updatedAt = new Date().toISOString();
    this.tabsStore.updateConversation(tab.id, () => updated);
    this.pendingAnchors.delete(tab.id);
    this.anchorRenamer?.clearPending(tab.id);
    this.notifyAnchorChipListeners();
    try {
      this.persistenceScheduler.flush();
      await this.persistence?.flush(tab.folder);
    } catch (error) {
      logWarning("重新绑定锚点保存失败", error);
      new Notice("重新绑定保存失败，请重试");
      return;
    }
    new Notice(`已重新绑定到 ${filePath}`);
  }

  private async readCtimeForAnchor(filePath: string): Promise<number | undefined> {
    if (this.anchorFileIndex === undefined) return undefined;
    const ctime = this.anchorFileIndex.getCtime(filePath);
    if (typeof ctime === "number" && Number.isFinite(ctime)) return ctime;
    return undefined;
  }

  /** 当前会话锚点状态判定：注入 Vault 身份与文件解析器。 */
  private classifyAnchor(conversation: ConversationFile): AnchorStatus {
    if (this.currentVaultId === undefined || this.anchorFileIndex === undefined) {
      // Vault 身份不可用时降级为旧 path-only 行为：未配置 → none。
      if (conversation.anchorFilePath === undefined) {
        return { kind: "none" };
      }
      return { kind: "legacy-unverified" };
    }
    return classifyAnchor({
      conversation,
      currentVaultId: this.currentVaultId,
      resolveCurrentPath: (path) =>
        this.anchorFileIndex?.resolveCurrentPath(path),
      resolveCtime: (path) =>
        this.anchorFileIndex?.getCtime(path),
      findCandidatesByCtime: (ctime) =>
        this.anchorFileIndex?.findCandidatesByCtime(ctime) ?? []
    });
  }

  /** 构建 AnchorRenamer 的存储后端：枚举所有未打开会话并用 repository revision 保存。 */
  private buildAnchorRenamerStore(): AnchorRenamerStore {
    return {
      loadStored: () => this.loadAllStoredAnchors(),
      saveStored: (record) => this.saveStoredAnchorRecord(record),
      skipOpenConversationIds: new Set(),
      onError: (error, record) => {
        logWarning(`rename 串行更新失败: ${record.conversationId}`, error);
      }
    };
  }

  private async loadAllStoredAnchors(): Promise<StoredAnchorRecord[]> {
    const roots = this.roots;
    if (roots === undefined) return [];
    const openIds = new Set(
      Object.values(this.tabsStore.getSnapshot().tabs).map(
        (tab) => tab.conversationId
      )
    );
    const out: StoredAnchorRecord[] = [];
    for (const area of [roots.active, roots.history]) {
      let folders: string[];
      try {
        folders = await this.loadConversationFolders(area);
      } catch (error) {
        logWarning(`读取 ${area} 失败`, error);
        continue;
      }
      for (const folder of folders) {
        const conversationId = folder.slice(folder.lastIndexOf("/") + 1);
        if (openIds.has(conversationId)) continue;
        const repository = this.repository;
        if (repository === undefined) continue;
        try {
          const loaded = await this.lifecycleQueue.run(() => repository.load(folder));
          const conversation = loaded.conversation;
          if (
            conversation.anchorFilePath === undefined ||
            conversation.anchorVaultId === undefined ||
            conversation.anchorFileCtime === undefined
          ) {
            continue;
          }
          out.push({
            conversationId: conversation.id,
            folder,
            anchorFilePath: conversation.anchorFilePath,
            observedAnchorFilePath: conversation.anchorFilePath,
            anchorVaultId: conversation.anchorVaultId,
            observedAnchorVaultId: conversation.anchorVaultId,
            anchorFileCtime: conversation.anchorFileCtime,
            observedAnchorFileCtime: conversation.anchorFileCtime,
            revision: conversation.revision
          });
        } catch (error) {
          logWarning(`读取会话失败: ${folder}`, error);
        }
      }
    }
    return out;
  }

  private async loadConversationFolders(area: string): Promise<string[]> {
    if (this.persistence === undefined) return [];
    const runtime = createPrivateStorageRuntime(this.app.vault);
    const folders = await runtime.port.list(`${area}/`);
    return folders
      .filter((path) => path.endsWith("/tree.json"))
      .map((path) => path.slice(0, -"/tree.json".length));
  }

  private async saveStoredAnchorRecord(
    record: StoredAnchorRecord
  ): Promise<"saved" | "stale"> {
    const repository = this.repository;
    if (repository === undefined) return "stale";
    return await saveStoredAnchorRecord(
      {
        load: async (folder) =>
          (await this.lifecycleQueue.run(() => repository.load(folder))).conversation,
        save: (folder, conversation, expectedRevision) =>
          this.lifecycleQueue.run(() =>
            repository.save(folder, conversation, expectedRevision)
          )
      },
      record,
      new Date().toISOString()
    );
  }

  /** 启动时对已打开会话执行 verified 锚点 ctime 唯一候选重定位。 */
  private async relocateOpenTabsOnStartup(): Promise<void> {
    if (
      this.currentVaultId === undefined ||
      this.anchorFileIndex === undefined ||
      this.persistence === undefined
    ) {
      return;
    }
    const port = {
      resolveCurrentPath: (path: string) =>
        this.anchorFileIndex!.resolveCurrentPath(path),
      getCtime: (path: string) => this.anchorFileIndex!.getCtime(path),
      findCandidatesByCtime: (ctime: number) =>
        this.anchorFileIndex!.findCandidatesByCtime(ctime)
    };
    for (const tab of Object.values(this.tabsStore.getSnapshot().tabs)) {
      const conversation = tab.conversation;
      const verified =
        conversation.anchorVaultId === this.currentVaultId &&
        typeof conversation.anchorFilePath === "string" &&
        typeof conversation.anchorFileCtime === "number";
      if (!verified) continue;
      try {
        const result = await relocateVerifiedAnchor(conversation, port);
        if (result.kind === "relocated" || result.kind === "unchanged") {
          if (result.conversation !== conversation) {
            this.tabsStore.updateConversation(tab.id, () => result.conversation);
          }
        }
      } catch (error) {
        logWarning(`启动锚点重定位失败: ${tab.conversationId}`, error);
      }
    }
  }

  /** 启动时恢复未打开 active/history 会话的同 Vault 唯一 ctime 锚点。 */
  private async relocateStoredAnchorsOnStartup(): Promise<void> {
    const { currentVaultId, anchorFileIndex, repository, roots } = this;
    if (
      currentVaultId === undefined ||
      anchorFileIndex === undefined ||
      repository === undefined ||
      roots === undefined
    ) {
      return;
    }
    const openIds = new Set(
      Object.values(this.tabsStore.getSnapshot().tabs).map(
        (tab) => tab.conversationId
      )
    );
    const relocator = {
      resolveCurrentPath: (path: string) => anchorFileIndex.resolveCurrentPath(path),
      getCtime: (path: string) => anchorFileIndex.getCtime(path),
      findCandidatesByCtime: (ctime: number) => anchorFileIndex.findCandidatesByCtime(ctime)
    };
    const persistence = {
      load: async (folder: string) =>
        (await this.lifecycleQueue.run(() => repository.load(folder))).conversation,
      save: (folder: string, conversation: ConversationFile, expectedRevision: number) =>
        this.lifecycleQueue.run(() =>
          repository.save(folder, conversation, expectedRevision)
        )
    };
    for (const area of [roots.active, roots.history]) {
      let folders: string[];
      try {
        folders = await this.loadConversationFolders(area);
      } catch (error) {
        logWarning(`启动读取会话目录失败: ${area}`, error);
        continue;
      }
      for (const folder of folders) {
        const conversationId = folder.slice(folder.lastIndexOf("/") + 1);
        if (openIds.has(conversationId)) continue;
        try {
          await relocateStoredAnchorRecord(
            persistence,
            folder,
            currentVaultId,
            relocator,
            new Date().toISOString()
          );
        } catch (error) {
          logWarning(`启动锚点重定位失败: ${conversationId}`, error);
        }
      }
    }
  }

  /** 处理 Vault rename 事件，并让工作流区分文件和文件夹事件。 */
  private async handleVaultRename(rename: VaultRename): Promise<void> {
    const renamer = this.anchorRenamer;
    const workflow = this.anchorRenameWorkflow;
    if (renamer === undefined || workflow === undefined) return;
    for (const [tabId, path] of this.pendingAnchors) {
      renamer.setPending(tabId, path);
    }
    const result = await workflow.apply(
      rename,
      () =>
        Object.values(this.tabsStore.getSnapshot().tabs).map(
          (tab) => tab.conversation
        ),
      new Date().toISOString()
    );
    for (const updated of result.openConversations) {
      const tab = Object.values(this.tabsStore.getSnapshot().tabs).find(
        (candidate) => candidate.conversationId === updated.id
      );
      if (tab !== undefined && updated.anchorFilePath !== tab.conversation.anchorFilePath) {
        this.tabsStore.updateConversation(tab.id, () => updated);
      }
    }
    if (result.stored !== null) {
      for (const update of result.stored.updates) {
        logWarning(
          `rename 已更新: ${update.previousPath} → ${update.nextPath} (${update.conversationId})`
        );
      }
    }
    for (const tabId of this.pendingAnchors.keys()) {
      const next = renamer.getPending(tabId);
      if (next === undefined) this.pendingAnchors.delete(tabId);
      else this.pendingAnchors.set(tabId, next);
    }
    this.notifyAnchorChipListeners();
  }

  private setWebSearchEnabled(enabled: boolean): Promise<void> {
    return this.updateSettings({
      ...this.pluginSettings,
      webSearchEnabled: enabled
    });
  }

  private setRelatedNoteContextEnabled(
    relatedNoteContextEnabled: boolean
  ): Promise<void> {
    return this.updateSettings({
      ...this.pluginSettings,
      relatedNoteContextEnabled
    });
  }

  private setContextDivergenceEnabled(
    contextDivergenceEnabled: boolean
  ): Promise<void> {
    return this.updateSettings({
      ...this.pluginSettings,
      contextDivergenceEnabled
    });
  }

  private setAnswerThinkingMode(
    answerThinkingMode: AnswerThinkingMode
  ): Promise<void> {
    return this.updateSettings({
      ...this.pluginSettings,
      answerThinkingMode
    });
  }

  getApiKey(): string {
    return this.app.secretStorage.getSecret(SECRET_ID) ?? "";
  }

  setApiKey(value: string): void {
    const apiKey = value.trim();
    this.app.secretStorage.setSecret(SECRET_ID, apiKey);
    if (apiKey.length > 0) void this.nodeSummaries.repairOpenTabs();
  }

  private activeMarkdownSelectionSource():
    | MarkdownSelectionSource
    | undefined {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view === null || view.file === null) {
      return undefined;
    }
    const file = view.file;
    const mode = view.getMode();
    const contentEl =
      view.contentEl.querySelector<HTMLElement>(
        mode === "source"
          ? ".markdown-source-view"
          : ".markdown-preview-view"
      ) ?? view.contentEl;
    return {
      filePath: file.path,
      fileName: file.name,
      mode,
      contentEl,
      loadSourceText: () => this.app.vault.cachedRead(file),
      ...(mode === "source" ? { editor: view.editor } : {})
    };
  }

  private registerCommands(): void {
    this.addRibbonIcon("messages-square", "打开 TreeTalk", () => {
      void this.coordinator?.toggle();
    });
    this.addCommand({
      id: "toggle-paired-views",
      name: "打开或关闭 TreeTalk",
      callback: () => void this.coordinator?.toggle()
    });
    this.addCommand({
      id: COMMAND_IDS.new,
      name: "新建对话空间",
      callback: () => void this.createConversationTab()
    });
    this.addCommand({
      id: COMMAND_IDS.close,
      name: "关闭当前对话空间",
      callback: () => {
        const tabId = this.tabsStore.getSnapshot().activeTabId;
        if (tabId !== null) void this.closeTab(tabId);
      }
    });
    this.addCommand({
      id: COMMAND_IDS.next,
      name: "切换到下一个对话空间",
      callback: () => selectAdjacentTab(this.tabsStore, 1)
    });
    this.addCommand({
      id: COMMAND_IDS.previous,
      name: "切换到上一个对话空间",
      callback: () => selectAdjacentTab(this.tabsStore, -1)
    });
    this.addCommand({
      id: COMMAND_IDS.toggleBranch,
      name: "创建或关闭当前分支",
      callback: () => this.toggleActiveBranch()
    });
    this.addCommand({
      id: COMMAND_IDS.depositGraph,
      name: "打开沉淀关系图谱",
      callback: () => this.openDepositGraph()
    });
    this.addCommand({
      id: "open-history",
      name: "打开历史对话",
      callback: () => void this.openHistoryManager()
    });
    this.addCommand({
      id: "restore-history",
      name: "恢复当前历史对话",
      callback: () => void this.restoreActiveTab()
    });
  }

  private async restoreOpenTabs(
    vaultPort: ObsidianPrivateStoragePort,
    roots: ConversationRoots
  ): Promise<void> {
    const repository = this.repository;
    if (repository === undefined) return;
    const available = new Map<string, RestoredTabDescriptor>();
    let latestActive: RestoredTabDescriptor | undefined;
    let latestActiveUpdatedAt: string | undefined;
    const [activePaths, historyPaths] = await Promise.all([
      vaultPort.list(`${roots.active}/`),
      vaultPort.list(`${roots.history}/`)
    ]);
    const folders = [...activePaths, ...historyPaths]
      .filter((path) => path.endsWith("/tree.json"))
      .map((path) => path.slice(0, -"/tree.json".length));
    const loadedConversations = await loadStartupConversations({
      folders,
      repository,
      now: () => new Date().toISOString(),
      reportLoadError: (folder, error) => {
        logWarning(`读取会话失败: ${folder}`, error);
      },
      reportSaveError: (folder, error) => {
        logWarning(`保存会话中断恢复状态失败: ${folder}`, error);
      }
    });
    for (const loaded of loadedConversations) {
      const entry = descriptor(loaded.folder, loaded.conversation);
      if (!available.has(entry.conversationId)) {
        available.set(entry.conversationId, entry);
      }
      if (
        loaded.sourceStatus === "active" &&
        (latestActiveUpdatedAt === undefined ||
          loaded.sourceUpdatedAt > latestActiveUpdatedAt)
      ) {
        latestActive = entry;
        latestActiveUpdatedAt = loaded.sourceUpdatedAt;
      }
    }
    const restored = await restoreTabsWorkspace(
      this.pluginData.tabs,
      (conversationId) => Promise.resolve(available.get(conversationId))
    );
    for (const tab of restored.tabs) {
      this.tabsStore.open(tab);
      this.persistence?.seed(tab.folder, tab.conversation.revision);
    }
    if (restored.activeConversationId !== null) {
      this.tabsStore.select(restored.activeConversationId);
    } else if (
      restored.tabs.length === 0 &&
      latestActive !== undefined &&
      this.pluginData.tabs.openConversationIds.length === 0
    ) {
      openConversationTab(
        this.tabsStore,
        latestActive.folder,
        latestActive.conversation
      );
      this.persistence?.seed(
        latestActive.folder,
        latestActive.conversation.revision
      );
    }
  }

  private createConversationTab(): Promise<void> {
    const roots = this.roots;
    if (roots === undefined) return Promise.resolve();
    const conversation = createConversation();
    openConversationTab(
      this.tabsStore,
      folderFor(roots, conversation),
      conversation
    );
    return this.coordinator?.open() ?? Promise.resolve();
  }

  private async closeTab(tabId: string): Promise<void> {
    const closingTab = this.tabsStore.getTab(tabId);
    if (closingTab !== undefined) {
      for (const node of Object.values(closingTab.conversation.nodes)) {
        for (const message of node.messages) {
          this.transientUsage.delete(message.id);
        }
      }
    }
    const conversationId = closingTab?.conversationId;
    if (conversationId !== undefined) {
      this.activeRequests.interrupt(
        conversationId,
        new Date().toISOString()
      );
    }
    this.persistenceScheduler.flush();
    try {
      await this.tabLifecycle?.close(tabId);
    } catch (error) {
      logWarning("关闭对话失败", error);
      new Notice("关闭失败，当前对话已安全保留");
    }
  }

  private registerAnchorMenus(): void {
    const anchorItem = (menu: Menu, filePath: string): void => {
      const tab = this.tabsStore.getActiveTab();
      const status =
        tab !== undefined && tab.mode === "active"
          ? this.classifyAnchor(tab.conversation)
          : ({ kind: "none" } as AnchorStatus);
      // 有效 verified 锚点保持冻结：仅显示普通「锚定」入口（仍由对话自身首条消息路径决定）。
      if (status.kind === "verified") {
        menu.addItem((item) =>
          item
            .setTitle("TreeTalk 对话已锚定此笔记")
            .setIcon("anchor")
            .setDisabled(true)
        );
        return;
      }
      menu.addItem((item) =>
        item
          .setTitle(
            status.kind === "none"
              ? "锚定 TreeTalk 对话到此笔记"
              : "重新绑定当前 TreeTalk 对话到此笔记"
          )
          .setIcon("anchor")
          .onClick(() => {
            if (status.kind === "none") {
              void this.anchorConversationToFile(filePath);
            } else {
              void this.rebindConversationToFile(filePath);
            }
          })
      );
    };
    // 主编辑区正文右键（用户确认的主要触发方式）。
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, _editor, context) => {
        const file = context?.file;
        if (file !== null && file !== undefined && isMarkdownPath(file.path)) {
          anchorItem(menu, file.path);
        }
      })
    );
    // 左侧文件管理器 / 标签页右键。
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (
          file instanceof TFile &&
          isMarkdownPath(file.path)
        ) {
          anchorItem(menu, file.path);
        }
      })
    );
  }

  private async restoreActiveTab(): Promise<void> {
    const tabId = this.tabsStore.getSnapshot().activeTabId;
    if (tabId === null) return;
    try {
      await this.tabLifecycle?.restore(tabId);
      new Notice("历史对话已恢复");
    } catch (error) {
      logWarning("恢复历史对话失败", error);
      new Notice("恢复失败，历史对话仍保持只读");
    }
  }

  private currentProviderProfile(): ProviderProfile {
    return {
      id: "default",
      name: "默认",
      kind: "deepseek",
      apiKey: this.getApiKey(),
      baseUrl: this.pluginSettings.baseUrl
    };
  }

  private toggleActiveBranch(): void {
    const tab = this.tabsStore.getActiveTab();
    if (
      tab === undefined ||
      tab.mode !== "active" ||
      tab.lifecycle !== "idle" ||
      this.activeRequests.has(tab.conversationId)
    ) {
      return;
    }
    this.tabsStore.updateConversation(tab.id, (conversation) =>
      toggleBranchDraft(
        conversation,
        conversation.currentNodeId,
        new Date().toISOString()
      )
    );
  }

  private async send(text: string): Promise<void> {
    const tab = this.tabsStore.getActiveTab();
    if (
      tab === undefined ||
      tab.mode !== "active" ||
      tab.lifecycle !== "idle"
    ) {
      return;
    }
    if (
      this.sendingConversations.has(tab.conversationId) ||
      this.activeRequests.has(tab.conversationId)
    ) {
      new Notice("当前对话正在生成回复");
      return;
    }
    this.sendingConversations.add(tab.conversationId);
    try {
      await this.sendMessage(tab, text);
    } finally {
      this.sendingConversations.delete(tab.conversationId);
    }
  }

  private async sendMessage(
    tab: ConversationTab,
    text: string
  ): Promise<void> {
    const key = this.getApiKey();
    if (key.length === 0) {
      new Notice("请先在 TreeTalk 设置中填写 API Key");
      return;
    }
    const before = tab.conversation;
    const now = new Date().toISOString();
    const current = before.nodes[before.currentNodeId];
    if (current === undefined) return;
    const executionMode = "pi";
    const requestedAnswerThinkingMode: AnswerThinkingMode =
      this.pluginSettings.answerThinkingMode;
    const relatedNoteContextEnabled =
      this.pluginSettings.relatedNoteContextEnabled;
    const relatedNoteDepth = this.pluginSettings.relatedNoteDepth;
    const contextDivergenceEnabled =
      this.pluginSettings.contextDivergenceEnabled;
    // 锚点来源优先级：显式右键锚定（pending anchor）> 当前活动 .md 文件。
    // 领域层 applyAnchor 只在对话无用户消息时接受写入，因此这里无需重复判断
    // 「是否首条」；但 getActiveFile() 兜底只在尚未锚定时才有意义。
    const pendingAnchor = this.pendingAnchors.get(tab.id);
    const activeFilePath = this.app.workspace.getActiveFile()?.path;
    const alreadyAnchored = before.anchorFilePath !== undefined;
    const fallbackAnchor =
      alreadyAnchored || pendingAnchor !== undefined
        ? undefined
        : activeFilePath !== undefined && isMarkdownPath(activeFilePath)
          ? activeFilePath
          : undefined;
    const anchorFilePath = pendingAnchor ?? fallbackAnchor;
    const anchorDecision = decideFirstMessageAnchor({
      explicitPending: pendingAnchor !== undefined,
      filePath: anchorFilePath,
      vaultId: this.currentVaultId,
      fileCtime:
        anchorFilePath === undefined
          ? undefined
          : await this.readCtimeForAnchor(anchorFilePath)
    });
    if (anchorDecision.kind === "reject") {
      new Notice(anchorDecision.notice);
      return;
    }
    const anchor = anchorDecision.anchor;
    const userMessageId = crypto.randomUUID();
    const childInput = {
      text,
      childId: crypto.randomUUID(),
      messageId: userMessageId,
      now
    } as Parameters<typeof submitChildDraft>[1];
    if (anchor !== undefined) {
      Object.assign(childInput, anchor);
    }
    const continueInput = {
      nodeId: before.currentNodeId,
      text,
      messageId: userMessageId,
      now
    } as Parameters<typeof continueNode>[1];
    if (anchor !== undefined) {
      Object.assign(continueInput, anchor);
    }
    const command =
      current.draft.mode === "child"
        ? submitChildDraft(before, childInput)
        : continueNode(before, continueInput);
    // 锚点已随本次 tree command 落库（或对话已有消息、锚点不再可写），清理 pending。
    this.pendingAnchors.delete(tab.id);
    this.anchorRenamer?.clearPending(tab.id);
    this.notifyAnchorChipListeners();
    this.tabsStore.updateConversation(tab.id, () => command.state);
    let requestState = command.state;
    try {
      const frozenNoteContext = await freezeNoteContextForMessage(
        command.state,
        {
          nodeId: command.state.currentNodeId,
          messageId: userMessageId,
          builtAt: new Date().toISOString(),
          fullNoteContext: true,
          perNoteBudget: "full",
          relatedNotesEnabled: relatedNoteContextEnabled,
          maxDepth: relatedNoteDepth,
          resolver: new ObsidianNoteLinkResolver(
            this.app.vault,
            this.app.metadataCache
          )
        }
      );
      if (frozenNoteContext.frozen) {
        requestState = frozenNoteContext.state;
        this.tabsStore.updateConversation(tab.id, () => requestState);
        if (this.persistence === undefined) {
          throw new Error("Session persistence is unavailable");
        }
        this.persistenceScheduler.flush();
        await this.persistence.flush(tab.folder);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      new Notice(`TreeTalk 笔记上下文冻结失败：${detail}，本次请求未发送`);
      return;
    }
    const responseNodeId = requestState.currentNodeId;
    const ticket = this.responseRouter.capture(tab.id, responseNodeId);
    const profile = this.currentProviderProfile();
    const contextMode = "full";
    const systemPrompt =
      contextMode === "full"
        ? buildTreeTalkSystemPrompt(
            this.pluginSettings.obsidianMarkdownCompatibility
          )
        : this.pluginSettings.obsidianMarkdownCompatibility
          ? OBSIDIAN_MARKDOWN_SYSTEM_PROMPT
          : "";
    const currentUserMessage = requestState.nodes[responseNodeId]?.messages.find(
      (message) => message.id === userMessageId
    );
    const selectedQuotes = (currentUserMessage?.selectionContexts ?? []).map(
      (selection) => selection.quote
    );
    const piFocus = executionMode === "pi"
      ? buildPiFocusContext(requestState, command.operation, userMessageId)
      : undefined;
    let contextPlan: ContextPlan;
    let piConversationNodes: ReturnType<
      typeof buildPiIndexContextPlan
    >["conversationNodes"] = [];
    if (executionMode === "pi") {
      const piIndexPlan = buildPiIndexContextPlan({
        conversation: requestState,
        currentNodeId: responseNodeId,
        currentQuestion: text,
        selectedQuotes,
        ...(currentUserMessage?.noteContextGraph === undefined
          ? {}
          : {
              noteContextGraph: structuredClone(
                currentUserMessage.noteContextGraph
              )
            }),
        systemPrompt,
        mode: contextMode
      });
      contextPlan = piIndexPlan.contextPlan;
      piConversationNodes = piIndexPlan.conversationNodes;
    } else {
      try {
        contextPlan = compileContextPlan(requestState, responseNodeId, {
          mode: contextMode,
          systemPrompt,
          maxInputTokens: 30_000,
          recentRoundTarget: 4,
          minRecentRounds: 2,
          maxRecentRounds: 6
        });
      } catch (error) {
        if (error instanceof ProtectedContextTooLongError) {
          new Notice(error.message);
        } else {
          new Notice("TreeTalk 上下文构建失败，本次请求未发送");
        }
        return;
      }
      if (contextPlan.persistencePatch !== undefined) {
        try {
          const persistedState = applyContextPlanPersistencePatch(
            requestState,
            contextPlan.persistencePatch,
            new Date().toISOString()
          );
          this.tabsStore.updateConversation(tab.id, () => persistedState);
          if (this.persistence === undefined) {
            throw new Error("Session persistence is unavailable");
          }
          this.persistenceScheduler.flush();
          await this.persistence.flush(tab.folder);
        } catch (error) {
          logWarning("上下文冻结保存失败", error);
          new Notice("TreeTalk 上下文冻结保存失败，本次请求未发送");
          return;
        }
      }
    }
    const context = contextPlan.messages;
    const contextCacheKey = cacheKeyForContextPlan(
      requestState.id,
      contextPlan
    );
    const messageId = crypto.randomUUID();
    const webSearchEnabled =
      this.pluginSettings.provider === "deepseek" &&
      this.pluginSettings.webSearchEnabled;
    const request: ExecutionRequest = {
      conversationId: ticket.conversationId,
      nodeId: ticket.nodeId,
      assistantMessageId: messageId,
      contextMessages: context,
      ...(executionMode !== "pi"
        ? {}
        : {
            piContext: {
              currentQuestion: text,
              selectedQuotes,
              relatedNotesAllowed: relatedNoteContextEnabled,
              conversationNodes: structuredClone(piConversationNodes),
              ...(piFocus === undefined
                ? {}
                : { focus: structuredClone(piFocus) }),
              ...(currentUserMessage?.noteContextGraph === undefined
                ? {}
                : {
                    noteContextGraph: structuredClone(
                      currentUserMessage.noteContextGraph
                    )
                  })
            }
          }),
      ...(contextCacheKey === undefined
        ? {}
        : { contextCacheKey }),
      roleId: "direct",
      route: {
        routeId: "default",
        providerProfile: profile,
        modelId: this.pluginSettings.model
      },
      webSearchEnabled,
      streamingOutputEnabled: this.pluginSettings.streamingOutputEnabled,
      currentQuestion: text,
      answerThinkingMode: requestedAnswerThinkingMode,
      selectionCount: selectedQuotes.length,
      contextDivergenceEnabled,
    };
    await this.runResponsePipeline({
      tabId: tab.id,
      nodeId: responseNodeId,
      userMessageId,
      assistantMessageId: messageId,
      executionMode,
      request,
      contextPlan,
      alreadyStarted: false
    });
  }

  /**
   * Owns one assistant-response execution lifecycle (recorder, ticket, request
   * handle, transient stores and completion/failure cleanup). Both fresh sends
   * and in-place retries run through here; retries supply a checkpoint so the
   * Progressive engine resumes the exact message prefix that was already sent.
   */
  private async runResponsePipeline(input: {
    tabId: string;
    nodeId: string;
    userMessageId: string;
    assistantMessageId: string;
    executionMode: ExecutionMode;
    request: ExecutionRequest;
    resume?: ProgressiveRunCheckpoint;
    contextPlan: ContextPlan;
    alreadyStarted: boolean;
  }): Promise<void> {
    const tab = this.tabsStore.getTab(input.tabId);
    if (tab === undefined) return;
    if (!input.alreadyStarted) {
      this.progressiveCheckpoints.prune(tab.conversationId);
    }
    const messageId = input.assistantMessageId;
    const executionMode = input.executionMode;
    const recorder = new ExecutionEventRecorder({
      executionMode,
      roleId: "direct",
      routeId: "default",
      providerId: input.request.route.providerProfile.kind,
      modelId: input.request.route.modelId,
      startedAt: new Date().toISOString()
    });
    let ticket: TabResponseTicket;
    let requestHandle: ActiveResponseHandle;
    try {
      ticket = this.responseRouter.capture(input.tabId, input.nodeId);
      if (input.alreadyStarted) {
        this.responseRouter.agentRun(ticket, {
          conversationId: ticket.conversationId,
          nodeId: ticket.nodeId,
          messageId,
          agentRun: recorder.snapshot(),
          now: new Date().toISOString()
        });
      } else {
        this.responseRouter.start(ticket, {
          conversationId: ticket.conversationId,
          nodeId: ticket.nodeId,
          messageId,
          providerProfileId: "default",
          modelId: input.request.route.modelId,
          now: new Date().toISOString(),
          agentRun: recorder.snapshot()
        });
      }
      requestHandle = this.activeRequests.begin(
        tab.conversationId,
        ticket,
        messageId,
        recorder.snapshot()
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      new Notice(`TreeTalk 无法开始回复：${detail}，请重试`);
      return;
    }
    const { controller } = requestHandle;
    const webSearchEnabled = input.request.webSearchEnabled;
    this.transientResponseStatus.set(messageId, {
      status: webSearchEnabled
        ? "deciding-web-search"
        : executionMode === "pi" &&
            (input.request.piContext?.selectedQuotes.length ?? 0) > 0
          ? "identifying-focus"
          : "preparing-context"
    });
    let receivedText = false;
    let errorMessage: string | undefined;
    let runFinalized = false;

    try {
      const engine = this.executionRouter.resolve(executionMode);
      const request =
        input.resume === undefined
          ? input.request
          : {
              ...input.request,
              progressiveResume: structuredClone(input.resume)
            };
      const result = await this.sendCoordinator.execute({
        engine,
        request,
        signal: controller.signal,
        recorder,
        hooks: {
          onTextDelta: (text) => {
            if (requestHandle.finalized) return;
            receivedText = true;
            this.transientResponseStatus.delete(messageId);
            this.activeRequests.appendText(
              requestHandle,
              text,
              new Date().toISOString()
            );
          },
          onThinkingDelta: (text) => {
            if (requestHandle.finalized) return;
            this.transientThinking.append(messageId, text);
          },
          onResponseStatus: (progress) => {
            if (!requestHandle.finalized) {
              this.transientResponseStatus.set(messageId, progress);
            }
          },
          onAgentRun: (record) => {
            if (requestHandle.finalized) return;
            this.activeRequests.updateAgentRun(
              requestHandle,
              record,
              new Date().toISOString()
            );
          },
          onProgressiveRunCheckpoint: (checkpoint) => {
            if (requestHandle.finalized) return;
            this.progressiveCheckpoints.set({
              userMessageId: input.userMessageId,
              assistantMessageId: messageId,
              // The engine never mutates the request or context plan, and
              // toCheckpoint() returns a fresh snapshot per event, so storing
              // references is safe; retry still clones before resuming.
              request: input.request,
              checkpoint,
              contextPlan: input.contextPlan,
              updatedAt: new Date().toISOString()
            });
          }
        }
      });
      this.activeRequests.flushText(requestHandle);
      receivedText = result.receivedText;
      runFinalized = true;
      if (requestHandle.finalized) return;
      if (result.status === "aborted") {
        this.activeRequests.finish(
          requestHandle,
          "interrupted",
          new Date().toISOString()
        );
        return;
      }
      if (result.status === "failed") {
        errorMessage =
          result.errorMessage ?? "Agent execution ended without a complete response";
        throw new Error(errorMessage);
      }

      const responseContent =
        this.tabsStore
          .getTab(ticket.tabId)
          ?.conversation.nodes[ticket.nodeId]
          ?.messages.find((message) => message.id === messageId)?.content ?? "";
      const references = sourceSection(result.sources);
      const contentWithSources =
        references.length === 0
          ? responseContent
          : `${responseContent.trimEnd()}\n\n${references}`;
      const finalContent = this.pluginSettings.obsidianMarkdownCompatibility
        ? normalizeObsidianMarkdown(contentWithSources)
        : contentWithSources;
      const completedRun = result.agentRun;
      this.activeRequests.finish(
        requestHandle,
        "complete",
        new Date().toISOString(),
        finalContent,
        input.contextPlan.referencedNoteNames
      );
      this.progressiveCheckpoints.delete(messageId);
      void this.nodeSummaries.trigger({
        tabId: ticket.tabId,
        conversationId: ticket.conversationId,
        nodeId: ticket.nodeId,
        answerMessageId: messageId
      });
      const usage = completedRun.usage;
      this.transientUsage.set(messageId, {
        mode: input.contextPlan.mode,
        fullEstimatedTokens: input.contextPlan.fullEstimatedTokens,
        sentEstimatedTokens: input.contextPlan.sentEstimatedTokens,
        reducedTokens: input.contextPlan.reducedTokens,
        reductionRatio: input.contextPlan.reductionRatio,
        noteContextOriginalEstimatedTokens:
          input.contextPlan.noteContextOriginalEstimatedTokens,
        noteContextSentEstimatedTokens:
          input.contextPlan.noteContextSentEstimatedTokens,
        noteContextTrimmed: input.contextPlan.noteContextTrimmed,
        ...(usage?.promptTokens === undefined
          ? {}
          : { promptTokens: usage.promptTokens }),
        ...(usage?.completionTokens === undefined
          ? {}
          : { completionTokens: usage.completionTokens }),
        ...(usage?.reasoningTokens === undefined
          ? {}
          : { reasoningTokens: usage.reasoningTokens }),
        ...(usage?.cacheHitTokens === undefined
          ? {}
          : { cacheHitTokens: usage.cacheHitTokens }),
        ...(usage?.cacheMissTokens === undefined
          ? {}
          : { cacheMissTokens: usage.cacheMissTokens })
      });
    } catch (error) {
      const alreadyFinalized = requestHandle.finalized;
      errorMessage ??= error instanceof Error ? error.message : String(error);
      try {
        if (!requestHandle.finalized && !receivedText) {
          this.transientResponseStatus.delete(messageId);
          this.responseRouter.delta(ticket, {
            conversationId: ticket.conversationId,
            nodeId: ticket.nodeId,
            messageId,
            delta: "回复失败，请重试。",
            now: new Date().toISOString()
          });
        }
        if (!requestHandle.finalized && !runFinalized) {
          const failedRun = recorder.finish(
            "failed",
            new Date().toISOString(),
            errorMessage
          );
          this.activeRequests.updateAgentRun(
            requestHandle,
            failedRun,
            new Date().toISOString()
          );
        }
        this.activeRequests.finish(
          requestHandle,
          "failed",
          new Date().toISOString()
        );
      } catch {
        // Closing or archiving invalidates the ticket by design.
      }
      if (!alreadyFinalized) {
        new Notice(
          webSearchEnabled
            ? `TreeTalk 联网请求失败：${errorMessage}（请检查 DeepSeek 模型、地址和 API Key）`
            : `TreeTalk 请求失败：${errorMessage}（请检查模型、地址和 API Key）`
        );
      }
    } finally {
      this.transientResponseStatus.delete(messageId);
      this.transientThinking.delete(messageId);
      this.activeRequests.release(requestHandle);
    }
  }

  private async retryAssistant(assistantMessageId: string): Promise<void> {
    const record = this.progressiveCheckpoints.get(assistantMessageId);
    if (record === undefined) {
      new Notice("没有可续跑的断点，请直接重新发送问题");
      return;
    }
    const tab = Object.values(this.tabsStore.getSnapshot().tabs).find(
      (entry) =>
        entry.mode === "active" &&
        entry.lifecycle === "idle" &&
        Object.values(entry.conversation.nodes).some((node) =>
          node.messages.some((message) => message.id === assistantMessageId)
        )
    );
    if (tab === undefined) return;
    if (
      this.sendingConversations.has(tab.conversationId) ||
      this.activeRequests.has(tab.conversationId)
    ) {
      new Notice("当前对话正在生成回复");
      return;
    }
    this.sendingConversations.add(tab.conversationId);
    const node = Object.values(tab.conversation.nodes).find((entry) =>
      entry.messages.some((message) => message.id === assistantMessageId)
    );
    if (node === undefined) return;
    const now = new Date().toISOString();
    try {
      this.tabsStore.updateConversation(tab.id, (conversation) =>
        restartAssistantResponse(conversation, {
          conversationId: tab.conversationId,
          nodeId: node.id,
          messageId: assistantMessageId,
          now
        })
      );
      const request = structuredClone(record.request);
      request.assistantMessageId = assistantMessageId;
      await this.runResponsePipeline({
        tabId: tab.id,
        nodeId: node.id,
        userMessageId: record.userMessageId,
        assistantMessageId,
        executionMode: "pi",
        request,
        resume: structuredClone(record.checkpoint),
        contextPlan: structuredClone(record.contextPlan),
        alreadyStarted: true
      });
    } catch (error) {
      logWarning("重试续跑失败", error);
      new Notice("TreeTalk 重试失败，请直接重新发送问题");
    } finally {
      this.sendingConversations.delete(tab.conversationId);
    }
  }
  private stopActiveResponse(): Promise<void> {
    const conversationId = this.tabsStore.getActiveTab()?.conversationId;
    if (conversationId !== undefined) {
      this.activeRequests.interrupt(
        conversationId,
        new Date().toISOString()
      );
    }
    return Promise.resolve();
  }

  private schedulePersistAll(): void {
    this.persistenceScheduler.schedule();
  }

  private persistAllNow(): void {
    for (const tabId of this.tabsStore.getSnapshot().orderedTabIds) {
      const tab = this.tabsStore.getTab(tabId);
      if (tab === undefined) continue;
      this.persistence?.schedule(tab.folder, tab.conversation);
    }
  }

  private flushConversationPersistence(conversationId: string): void {
    try {
      this.persistenceScheduler.flush();
      const tab = Object.values(this.tabsStore.getSnapshot().tabs).find(
        (entry) => entry.conversationId === conversationId
      );
      if (tab === undefined || this.persistence === undefined) return;
      void this.persistence.flush(tab.folder).catch((error: unknown) => {
        logWarning(`保存终态对话失败: ${tab.folder}`, error);
      });
    } catch (error) {
      logWarning(`启动终态对话保存失败: ${conversationId}`, error);
    }
  }

  private async openHistoryManager(): Promise<void> {
    const index = this.historyIndex;
    if (index === undefined) return;
    await this.lifecycleQueue.run(() => index.ensureFresh());
    const entries = index.entries();
    if (entries.length === 0) {
      new Notice("还没有历史对话");
      return;
    }
    new HistoryManagerModal(
      this.app,
      entries,
      {
        open: (entry) => this.openHistoryEntry(entry).then(() => undefined),
        confirmDelete: (entry) =>
          confirmHistoryDeletion(this.app, entry),
        delete: (entry) => {
          const service = this.historyDeleteService;
          if (service === undefined) {
            return Promise.reject(
              new Error("History deletion is unavailable")
            );
          }
          return this.lifecycleQueue.run(() => service.delete(entry));
        },
        reportError: () => {
          new Notice("删除失败，历史对话仍已安全保留");
        }
      }
    ).open();
  }

  private async closeOpenHistory(conversationId: string): Promise<void> {
    const tab = Object.values(this.tabsStore.getSnapshot().tabs).find(
      (entry) =>
        entry.conversationId === conversationId &&
        entry.mode === "archived"
    );
    if (tab !== undefined) {
      await this.tabLifecycle?.close(tab.id);
    }
  }

  private async openHistoryEntry(
    entry: HistoryEntry,
    target?: TreeTalkSource
  ): Promise<boolean> {
    const repository = this.repository;
    if (repository === undefined) return false;
    try {
      const loaded = await this.lifecycleQueue.run(() =>
        repository.load(entry.folder)
      );
      if (
        loaded.conversation.status !== "archived" ||
        (target !== undefined &&
          !conversationContainsSource(loaded.conversation, target))
      ) {
        return false;
      }
      this.persistence?.seed(entry.folder, loaded.conversation.revision);
      const tabId = openConversationTab(
        this.tabsStore,
        entry.folder,
        loaded.conversation
      );
      if (target !== undefined) {
        this.tabsStore.updateConversation(tabId, (conversation) => ({
          ...structuredClone(conversation),
          currentNodeId: target.nodeId
        }));
      }
      await this.coordinator?.open();
      return true;
    } catch (error) {
      logWarning(`读取历史对话失败: ${entry.folder}`, error);
      new Notice("无法读取这个历史对话，原数据已安全保留");
      return false;
    }
  }

  private async openActiveSource(source: TreeTalkSource): Promise<boolean> {
    const tab = Object.values(this.tabsStore.getSnapshot().tabs).find(
      (entry) => entry.conversationId === source.conversationId
    );
    if (
      tab === undefined ||
      !conversationContainsSource(tab.conversation, source)
    ) {
      return false;
    }
    this.tabsStore.select(tab.id);
    this.tabsStore.updateConversation(tab.id, (conversation) => ({
      ...structuredClone(conversation),
      currentNodeId: source.nodeId
    }));
    await this.coordinator?.open();
    this.sourceHighlights.publish(source);
    return true;
  }

  private async openHistorySource(source: TreeTalkSource): Promise<boolean> {
    const index = this.historyIndex;
    if (index === undefined) return false;
    await this.lifecycleQueue.run(() => index.ensureFresh());
    const entry = index
      .entries()
      .find((candidate) => candidate.id === source.conversationId);
    if (entry === undefined) return false;
    const opened = await this.openHistoryEntry(entry, source);
    if (opened) this.sourceHighlights.publish(source);
    return opened;
  }

  private openDepositGraph(): void {
    if (this.relationshipGraphWindow === undefined) {
      this.relationshipGraphWindow = new RelationshipGraphWindow({
        document,
        store: this.store,
        getWindowState: () => this.pluginSettings.depositGraphWindow,
        setWindowState: (depositGraphWindow) => {
          this.pluginSettings = {
            ...this.pluginSettings,
            depositGraphWindow
          };
          this.pluginData = {
            ...this.pluginData,
            settings: this.pluginSettings
          };
          void this.persistPluginData();
        },
        onOpenNote: async (filePath) => {
          try {
            const file = this.app.vault.getAbstractFileByPath(filePath);
            if (!(file instanceof TFile) || file.extension !== "md") {
              new Notice("引用笔记不存在或已移动");
              return false;
            }
            await this.app.workspace.getLeaf("tab").openFile(file);
            return true;
          } catch (error) {
            logWarning(`打开引用笔记失败: ${filePath}`, error);
            new Notice("无法打开引用笔记");
            return false;
          }
        },
        // Keep one controller across close/reopen so its camera and session caches survive.
        onClose: () => undefined
      });
    }
    this.relationshipGraphWindow.open();
  }

  private async captureTree(): Promise<void> {
    const tab = this.tabsStore.getActiveTab();
    if (tab === undefined) return;
    await this.nodeSummaries.waitForNode(
      tab.id,
      tab.conversation.currentNodeId
    );
    const conversation = this.tabsStore.getTab(tab.id)?.conversation;
    if (conversation === undefined) return;
    const relocatedConversation = await relocateTreeCaptureAnchor({
      conversation,
      currentVaultId: this.currentVaultId,
      relocator:
        this.anchorFileIndex === undefined
          ? undefined
          : {
              resolveCurrentPath: (path) => this.anchorFileIndex!.resolveCurrentPath(path),
              getCtime: (path) => this.anchorFileIndex!.getCtime(path),
              findCandidatesByCtime: (ctime) =>
                this.anchorFileIndex!.findCandidatesByCtime(ctime)
            },
      now: new Date().toISOString(),
      updateConversation: (updated) => {
        this.tabsStore.updateConversation(tab.id, () => updated);
      },
      flushPersistence: async () => {
        this.persistenceScheduler.flush();
        await this.persistence?.flush(tab.folder);
      }
    });
    await this.captureKnowledge({
      scope: "tree",
      conversation: relocatedConversation
    });
  }

  private async captureAnswer(messageId: string): Promise<void> {
    const tab = this.tabsStore.getActiveTab();
    if (tab === undefined) return;
    for (const node of Object.values(tab.conversation.nodes)) {
      if (!node.messages.some((message) => message.id === messageId)) continue;
      await this.nodeSummaries.waitForNode(tab.id, node.id);
      const conversation = this.tabsStore.getTab(tab.id)?.conversation;
      if (conversation === undefined) return;
      await this.captureKnowledge({
        scope: "answer",
        conversation,
        nodeId: node.id,
        messageId
      });
      return;
    }
  }

  private async captureKnowledge(
    request: Parameters<KnowledgeCaptureService["capture"]>[0]
  ): Promise<void> {
    try {
      const path = await this.captureService?.capture(
        request,
        new Date().toISOString()
      );
      if (path !== undefined) new Notice(`已沉淀到 ${path}`);
    } catch (error) {
      // Vault-aware: 锚点状态错误（foreign/legacy/missing/ambiguous）映射为明确中文提示，
      // 不再显示笼统的「沉淀失败」信息；其他错误也走统一的 Notice 文案。
      const message = mapAnchorCaptureErrorToNotice(error);
      if (error instanceof AnchorCaptureError) {
        logWarning("沉淀被锚点状态阻止", error);
      } else {
        // 诉求1 debug: 沉淀失败时把真实错误打印到控制台 + 写入日志文件, 便于排查
        console.error("[TreeTalk] 沉淀失败，真实错误:", error);
        try {
          const detail = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error);
          await this.app.vault.adapter.write(
            ".obsidian/plugins/TreeTalk-Obsidian/hermes-debug-error.log",
            `[${new Date().toISOString()}] captureKnowledge 失败\nscope=${request?.scope}\nanchor=${request?.conversation?.anchorFilePath}\n${detail}\n`
          );
        } catch { /* 写日志失败也不影响主流程 */ }
        logWarning("知识沉淀失败", error);
      }
      new Notice(message);
    }
  }

  private saveTabsWorkspace(): Promise<void> {
    const tabs = serializeTabsWorkspace(this.tabsStore.getSnapshot());
    if (tabsWorkspaceDataEqual(this.pluginData.tabs, tabs)) {
      return Promise.resolve();
    }
    this.pluginData = {
      ...this.pluginData,
      tabs
    };
    return this.persistPluginData();
  }

  private persistPluginData(): Promise<void> {
    this.dataSaveTail = this.dataSaveTail
      .catch(() => undefined)
      .then(() => this.saveData(this.pluginData));
    return this.dataSaveTail;
  }
}
