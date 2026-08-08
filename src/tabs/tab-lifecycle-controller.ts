import {
  ArchiveError,
  type ArchiveResult
} from "../archive/archive-service";
import type { LifecycleQueue } from "../archive/lifecycle-queue";
import type { ConversationFile } from "../domain/types";
import type { SessionPersistence } from "../storage/session-persistence";
import type { ConversationTabsStore } from "./conversation-tabs-store";

export interface ArchiveLifecyclePort {
  archive(
    folder: string,
    conversation: ConversationFile
  ): Promise<ArchiveResult>;
  restore(
    folder: string,
    conversation: ConversationFile
  ): Promise<ArchiveResult>;
}

export type TabPersistencePort = Pick<
  SessionPersistence,
  "flush" | "renameFolder" | "seed"
>;

export type SaveTabsWorkspace = () => Promise<void> | void;

export class TabLifecycleController {
  constructor(
    private readonly tabs: ConversationTabsStore,
    private readonly persistence: TabPersistencePort,
    private readonly archive: ArchiveLifecyclePort,
    private readonly queue: LifecycleQueue,
    private readonly saveWorkspace: SaveTabsWorkspace
  ) {}

  async close(tabId: string): Promise<void> {
    const initial = this.requireIdle(tabId);
    const requestEpoch = initial.requestEpoch + 1;
    if (initial.mode === "archived") {
      this.tabs.updateTab(tabId, (tab) => ({ ...tab, requestEpoch }));
      this.tabs.remove(tabId);
      await this.saveWorkspace();
      return;
    }

    this.tabs.updateTab(tabId, (tab) => ({
      ...tab,
      lifecycle: "closing",
      requestEpoch
    }));
    try {
      await this.persistence.flush(initial.folder);
      const current = this.requireLifecycle(tabId, "closing", requestEpoch);
      const archived = await this.queue.run(() =>
        this.archive.archive(current.folder, current.conversation)
      );
      this.persistence.renameFolder(current.folder, archived.folder);
      this.persistence.seed(
        archived.folder,
        archived.conversation.revision
      );
      this.tabs.remove(tabId);
      await this.saveWorkspace();
    } catch (error) {
      this.recover(tabId, requestEpoch, error);
      throw error;
    }
  }

  async restore(tabId: string): Promise<void> {
    const initial = this.requireIdle(tabId);
    if (initial.mode !== "archived") {
      throw new Error("Only a historical tab can be restored");
    }
    const requestEpoch = initial.requestEpoch + 1;
    this.tabs.updateTab(tabId, (tab) => ({
      ...tab,
      lifecycle: "restoring",
      requestEpoch
    }));
    try {
      await this.persistence.flush(initial.folder);
      const current = this.requireLifecycle(tabId, "restoring", requestEpoch);
      const restored = await this.queue.run(() =>
        this.archive.restore(current.folder, current.conversation)
      );
      this.persistence.renameFolder(current.folder, restored.folder);
      this.persistence.seed(
        restored.folder,
        restored.conversation.revision
      );
      this.tabs.updateTab(tabId, (tab) => ({
        ...tab,
        folder: restored.folder,
        title: restored.conversation.title,
        mode: "active",
        lifecycle: "idle",
        conversation: restored.conversation
      }));
      await this.saveWorkspace();
    } catch (error) {
      this.recover(tabId, requestEpoch, error);
      throw error;
    }
  }

  private requireIdle(tabId: string) {
    const tab = this.tabs.getTab(tabId);
    if (tab === undefined) throw new Error(`Tab not found: ${tabId}`);
    if (tab.lifecycle !== "idle") {
      throw new Error(`Tab lifecycle is already ${tab.lifecycle}`);
    }
    return tab;
  }

  private requireLifecycle(
    tabId: string,
    lifecycle: "closing" | "restoring",
    requestEpoch: number
  ) {
    const tab = this.tabs.getTab(tabId);
    if (
      tab === undefined ||
      tab.lifecycle !== lifecycle ||
      tab.requestEpoch !== requestEpoch
    ) {
      throw new Error("Tab lifecycle operation is stale");
    }
    return tab;
  }

  private recover(
    tabId: string,
    requestEpoch: number,
    error: unknown
  ): void {
    const current = this.tabs.getTab(tabId);
    if (current === undefined || current.requestEpoch !== requestEpoch) return;
    if (error instanceof ArchiveError && error.recovery !== undefined) {
      const recovery = error.recovery;
      if (current.folder !== recovery.folder) {
        this.persistence.renameFolder(current.folder, recovery.folder);
      }
      this.persistence.seed(recovery.folder, recovery.conversation.revision);
      this.tabs.updateTab(tabId, (tab) => ({
        ...tab,
        folder: recovery.folder,
        title: recovery.conversation.title,
        mode: recovery.conversation.status,
        lifecycle: "idle",
        conversation: recovery.conversation
      }));
      return;
    }
    this.tabs.updateTab(tabId, (tab) => ({
      ...tab,
      lifecycle: "idle"
    }));
  }
}
