import {
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  requestUrl,
  Setting,
  TFile,
  type App
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
import { KnowledgeCaptureService } from "./knowledge/capture-service";
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
import { ConversationRepository } from "./storage/conversation-repository";
import type { ObsidianPrivateStoragePort } from "./storage/obsidian-private-storage-port";
import { ObsidianNoteLinkResolver } from "./storage/obsidian-note-link-resolver";
import { ObsidianVaultPort } from "./storage/obsidian-vault-port";
import {
  conversationFolder,
  type ConversationRoots
} from "./storage/private-paths";
import { BatchedPersistenceScheduler } from "./storage/persistence-scheduler";
import { createPrivateStorageRuntime } from "./storage/runtime-private-storage";
import { SessionPersistence } from "./storage/session-persistence";
import { ProgressiveRunCheckpointStore } from "./state/progressive-run-checkpoint-store";
import { ActiveConversationStore } from "./tabs/active-conversation-store";
import { ConversationTabsStore } from "./tabs/conversation-tabs-store";
import {
  DEFAULT_SETTINGS,
  normalizeConfiguredModel,
  normalizeTreeTalkSettings,
  parsePluginData,
  type TreeTalkPluginData,
  type TreeTalkSettings
} from "./tabs/plugin-data";
import { TabLifecycleController } from "./tabs/tab-lifecycle-controller";
import { TabResponseRouter } from "./tabs/tab-response-router";
import type { TabResponseTicket } from "./tabs/tab-response-router";
import type { ConversationTab } from "./tabs/types";
import {
  openConversationTab,
  selectAdjacentTab
} from "./tabs/tab-workspace-operations";
import {
  restoreTabsWorkspace,
  serializeTabsWorkspace,
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
        const response = await requestUrl({
          url: request.url,
          method: request.method,
          headers: request.headers,
          body: JSON.stringify(request.body),
          throw: false
        });
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
    bufferedRequest: async (request) => {
      const response = await requestUrl({
        url: request.url,
        method: request.method,
        headers: request.headers,
        body: JSON.stringify(request.body),
        throw: false
      });
      return { status: response.status, json: response.json };
    }
  });
  private readonly piExecutionEngine = new PiExecutionEngine({
    streamRequest: (profile, request, signal) =>
      this.streamingTransport.stream(this.providers.get(profile), request, signal),
    bufferedRequest: async (request) => {
      const response = await requestUrl({
        url: request.url,
        method: request.method,
        headers: request.headers,
        body: JSON.stringify(request.body),
        throw: false
      });
      return { status: response.status, json: response.json };
    },
    webPageRequest: async (url, signal) => {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const response = await requestUrl({
        url,
        method: "GET",
        headers: {
          Accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.8,*/*;q=0.1"
        },
        throw: false
      });
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
    this.responseRouter
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
      this.pluginSettings.treeCaptureFolder
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
      (conversationId) => this.closeOpenHistory(conversationId),
      () => {
        new Notice(
          "历史对话已永久删除，但打开视图或历史列表刷新未完全完成"
        );
      }
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
    this.tabLifecycle = new TabLifecycleController(
      this.tabsStore,
      this.persistence,
      this.archiveService,
      this.lifecycleQueue,
      () => this.saveTabsWorkspace()
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
      normalized.treeCaptureFolder
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
    const available = new Map<string, RestoredTabDescriptor>();
    let latestActive: RestoredTabDescriptor | undefined;
    for (const root of [roots.active, roots.history]) {
      const paths = (await vaultPort.list(`${root}/`)).filter((path) =>
        path.endsWith("/tree.json")
      );
      for (const path of paths) {
        const folder = path.slice(0, -"/tree.json".length);
        try {
          const loaded = await this.repository?.load(folder);
          if (loaded === undefined) continue;
          const entry = descriptor(folder, loaded.conversation);
          if (!available.has(entry.conversationId)) {
            available.set(entry.conversationId, entry);
          }
          if (
            loaded.conversation.status === "active" &&
            (latestActive === undefined ||
              loaded.conversation.updatedAt >
                latestActive.conversation.updatedAt)
          ) {
            latestActive = entry;
          }
        } catch (error) {
          logWarning(`读取会话失败: ${folder}`, error);
          // Corrupt canonical files remain untouched for repository recovery.
        }
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
    const userMessageId = crypto.randomUUID();
    const command =
      current.draft.mode === "child"
        ? submitChildDraft(before, {
            text,
            childId: crypto.randomUUID(),
            messageId: userMessageId,
            now
          })
        : continueNode(before, {
            nodeId: before.currentNodeId,
            text,
            messageId: userMessageId,
            now
          });
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
            this.responseRouter.delta(ticket, {
              conversationId: ticket.conversationId,
              nodeId: ticket.nodeId,
              messageId,
              delta: text,
              now: new Date().toISOString()
            });
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

  private async openHistoryManager(): Promise<void> {
    const index = this.historyIndex;
    if (index === undefined) return;
    await this.lifecycleQueue.run(async () => {
      await this.lifecycleReconciler?.reconcile();
      await index.rebuild();
    });
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
    await this.lifecycleQueue.run(async () => {
      await this.lifecycleReconciler?.reconcile();
      await index.rebuild();
    });
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
    await this.captureKnowledge({
      scope: "tree",
      conversation
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
      logWarning("知识沉淀失败", error);
      new Notice("知识沉淀失败，对话内容未受影响");
    }
  }

  private saveTabsWorkspace(): Promise<void> {
    this.pluginData = {
      ...this.pluginData,
      tabs: serializeTabsWorkspace(this.tabsStore.getSnapshot())
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

class TreeTalkSettingTab extends PluginSettingTab {
  private webSearchUnsubscribe: (() => void) | undefined;
  private controlStateUnsubscribe: (() => void) | undefined;

  constructor(
    app: App,
    private readonly plugin: TreeTalkPlugin
  ) {
    super(app, plugin);
  }

  display(): void {
    this.webSearchUnsubscribe?.();
    this.webSearchUnsubscribe = undefined;
    this.controlStateUnsubscribe?.();
    this.controlStateUnsubscribe = undefined;
    this.containerEl.empty();
    const settings = this.plugin.getSettings();
    new Setting(this.containerEl)
      .setName("上下文发散")
      .setDesc("开启后，Pi 可在当前权限范围内跨级请求可用上下文；关闭时按相邻层级扩展。")
      .addToggle((toggle) =>
        toggle
          .setValue(settings.contextDivergenceEnabled)
          .onChange(async (contextDivergenceEnabled) => {
            await this.plugin.updateSettings({
              ...this.plugin.getSettings(),
              contextDivergenceEnabled
            });
          })
      );
    new Setting(this.containerEl)
      .setName("流式输出")
      .setDesc("开启后回答会边生成边显示；关闭后等待完整回答后一次性显示。")
      .addToggle((toggle) =>
        toggle
          .setValue(settings.streamingOutputEnabled)
          .onChange(async (streamingOutputEnabled) => {
            await this.plugin.updateSettings({
              ...this.plugin.getSettings(),
              streamingOutputEnabled
            });
          })
      );
    new Setting(this.containerEl)
      .setName("回答思考模式")
      .setDesc("控制 DeepSeek 是否启用思考；输入框按钮与此处实时同步。")
      .addToggle((toggle) =>
        toggle
          .setValue(settings.answerThinkingMode === "enabled")
          .onChange(async (enabled) => {
            await this.plugin.updateSettings({
              ...this.plugin.getSettings(),
              answerThinkingMode: enabled ? "enabled" : "disabled"
            });
          })
      );
    this.containerEl.createEl("h3", { text: "DeepSeek API" });
    new Setting(this.containerEl).setName("模型").addText((text) =>
      text.setValue(settings.model).onChange(async (model) => {
        await this.plugin.updateSettings({
          ...this.plugin.getSettings(),
          model: normalizeConfiguredModel("deepseek", model)
        });
      })
    );
    new Setting(this.containerEl).setName("API 地址").addText((text) =>
      text
        .setPlaceholder("留空使用 DeepSeek 官方地址")
        .setValue(settings.baseUrl)
        .onChange(async (baseUrl) => {
          await this.plugin.updateSettings({
            ...this.plugin.getSettings(),
            baseUrl
          });
        })
    );
    new Setting(this.containerEl).setName("API Key").addText((text) => {
      text.inputEl.type = "password";
      text
        .setValue(this.plugin.getApiKey())
        .onChange((value) => this.plugin.setApiKey(value));
    });
    new Setting(this.containerEl)
      .setName("Obsidian Markdown 兼容模式")
      .setDesc("约束 AI 输出格式、保护流式未闭合语法，并在完成后保守规范化")
      .addToggle((toggle) =>
        toggle
          .setValue(settings.obsidianMarkdownCompatibility)
          .onChange(async (obsidianMarkdownCompatibility) => {
            await this.plugin.updateSettings({
              ...this.plugin.getSettings(),
              obsidianMarkdownCompatibility
            });
          })
      );
    new Setting(this.containerEl)
      .setName("联网模式")
      .setDesc("开启后，DeepSeek 会根据问题自动判断是否需要搜索网页。当前仅支持 DeepSeek。")
      .addToggle((toggle) => {
        const sync = (): void => {
          const current = this.plugin.getSettings();
          toggle.setValue(current.webSearchEnabled);
          toggle.setDisabled(current.provider !== "deepseek");
        };
        sync();
        toggle.onChange(async (webSearchEnabled) => {
          await this.plugin.updateSettings({
            ...this.plugin.getSettings(),
            webSearchEnabled
          });
        });
        this.webSearchUnsubscribe = this.plugin.subscribeWebSearch(sync);
      });
    this.containerEl.createEl("h3", { text: "关联笔记" });
    new Setting(this.containerEl)
      .setName("关联笔记上下文")
      .setDesc("沿笔记中的正向和反向内部链接读取关联笔记。两种方向享有相同的读取、递归和上下文优先级，并发送按路径去重、保留真实链接方向的关联图。输入框按钮与此处实时同步。")
      .addToggle((toggle) =>
        toggle
          .setValue(settings.relatedNoteContextEnabled)
          .onChange(async (relatedNoteContextEnabled) => {
            await this.plugin.updateSettings({
              ...this.plugin.getSettings(),
              relatedNoteContextEnabled
            });
          })
      );

    const depthPresets = new Set([1, 2, 3, 5, 10]);
    const depthMode =
      settings.relatedNoteDepth === "unlimited"
        ? "unlimited"
        : depthPresets.has(settings.relatedNoteDepth)
          ? String(settings.relatedNoteDepth)
          : "custom";
    let customDepthInput: HTMLInputElement | undefined;
    new Setting(this.containerEl)
      .setName("关联笔记深度")
      .setDesc("当前框选笔记为第 0 层。无限模式会读取所有通过正向或反向链接可达的 Markdown 笔记，并自动处理循环和重复节点。")
      .addDropdown((dropdown) => {
        dropdown
          .addOptions({
            "1": "1 层",
            "2": "2 层",
            "3": "3 层",
            "5": "5 层",
            "10": "10 层",
            custom: "自定义",
            unlimited: "无限"
          })
          .setValue(depthMode)
          .setDisabled(!settings.relatedNoteContextEnabled)
          .onChange(async (value) => {
            if (value === "custom") {
              if (customDepthInput !== undefined) {
                customDepthInput.disabled = false;
                customDepthInput.focus();
              }
              return;
            }
            const relatedNoteDepth =
              value === "unlimited" ? "unlimited" : Number.parseInt(value, 10);
            await this.plugin.updateSettings({
              ...this.plugin.getSettings(),
              relatedNoteDepth
            });
          });
      })
      .addText((text) => {
        customDepthInput = text.inputEl;
        text.inputEl.type = "number";
        text.inputEl.min = "1";
        text.inputEl.step = "1";
        const numericDepth =
          typeof settings.relatedNoteDepth === "number"
            ? settings.relatedNoteDepth
            : 1;
        text
          .setPlaceholder("自定义深度")
          .setValue(String(numericDepth))
          .setDisabled(
            !settings.relatedNoteContextEnabled || depthMode !== "custom"
          )
          .onChange(async (raw) => {
            const value = Number.parseInt(raw, 10);
            if (!Number.isInteger(value) || value < 1) return;
            await this.plugin.updateSettings({
              ...this.plugin.getSettings(),
              relatedNoteDepth: value
            });
          });
      });

    new Setting(this.containerEl)
      .setName("知识沉淀文件夹")
      .setDesc("单个回答将保存为可自由编辑的纯 Markdown 笔记")
      .addText((text) =>
        text
          .setPlaceholder("TreeTalk 知识")
          .setValue(settings.knowledgeFolder)
          .onChange(async (knowledgeFolder) => {
            await this.plugin.updateSettings({
              ...this.plugin.getSettings(),
              knowledgeFolder:
                knowledgeFolder.trim().length > 0
                  ? knowledgeFolder.trim()
                  : DEFAULT_SETTINGS.knowledgeFolder
            });
          })
      );
    new Setting(this.containerEl)
      .setName("沉淀对话树目录")
      .setDesc("每次沉淀会在该目录中创建纯 Markdown 对话树文件夹")
      .addText((text) =>
        text
          .setPlaceholder("TreeTalk")
          .setValue(settings.treeCaptureFolder)
          .onChange(async (treeCaptureFolder) => {
            await this.plugin.updateSettings({
              ...this.plugin.getSettings(),
              treeCaptureFolder:
                treeCaptureFolder.trim().length > 0
                  ? treeCaptureFolder.trim()
                  : DEFAULT_SETTINGS.treeCaptureFolder
            });
          })
      );

    const syncControls = (): void => this.display();
    this.controlStateUnsubscribe =
      this.plugin.subscribeComposerControls(syncControls);
  }

  hide(): void {
    this.webSearchUnsubscribe?.();
    this.webSearchUnsubscribe = undefined;
    this.controlStateUnsubscribe?.();
    this.controlStateUnsubscribe = undefined;
  }
}
