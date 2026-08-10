import { parseConversation } from "../domain/schema";
import { verifyConversationChecksum } from "../storage/checksum";
import type { VaultPort } from "../storage/conversation-repository";
import { logWarning } from "../utils/error-log";
import type { ConversationFile } from "../domain/types";

const MAX_CONCURRENT_READS = 4;

export interface HistoryEntry {
  id: string;
  title: string;
  folder: string;
  updatedAt: string;
}

function canonicalHistoryPaths(
  paths: string[],
  historyRoot: string
): string[] {
  const prefix = `${historyRoot}/`;
  return paths
    .filter((path) => {
      if (!path.startsWith(prefix)) return false;
      const parts = path.slice(prefix.length).split("/");
      return parts.length === 2 && parts[1] === "tree.json";
    })
    .sort((left, right) => left.localeCompare(right));
}

function samePaths(left: string[], right: Set<string>): boolean {
  if (left.length !== right.size) return false;
  return left.every((path) => right.has(path));
}

function sortEntries(entries: HistoryEntry[]): void {
  entries.sort(
    (left, right) =>
      right.updatedAt.localeCompare(left.updatedAt) ||
      left.id.localeCompare(right.id)
  );
}

export class HistoryIndex {
  private indexed: HistoryEntry[] = [];
  private initialized = false;
  private knownCanonicalPaths = new Set<string>();
  private refreshing: Promise<void> | undefined;

  constructor(
    private readonly vault: VaultPort,
    private readonly historyRoot: string
  ) {}

  async ensureFresh(): Promise<void> {
    if (this.refreshing !== undefined) {
      await this.refreshing;
      return;
    }
    await this.trackRefresh(false);
  }

  async rebuild(): Promise<void> {
    while (this.refreshing !== undefined) await this.refreshing;
    await this.trackRefresh(true);
  }

  entries(): HistoryEntry[] {
    return this.indexed.map((entry) => ({ ...entry }));
  }

  remove(conversationId: string): void {
    const existing = this.indexed.find(
      (entry) => entry.id === conversationId
    );
    if (existing !== undefined) {
      this.knownCanonicalPaths.delete(`${existing.folder}/tree.json`);
    }
    this.indexed = this.indexed.filter(
      (entry) => entry.id !== conversationId
    );
  }

  upsert(folder: string, conversation: ConversationFile): void {
    if (conversation.status !== "archived") {
      throw new Error("History index accepts archived conversations only");
    }
    const existing = this.indexed.find(
      (entry) => entry.id === conversation.id
    );
    if (existing !== undefined) {
      this.knownCanonicalPaths.delete(`${existing.folder}/tree.json`);
    }
    this.indexed = this.indexed.filter(
      (entry) => entry.id !== conversation.id
    );
    this.indexed.push({
      id: conversation.id,
      title: conversation.title,
      folder,
      updatedAt: conversation.updatedAt
    });
    this.knownCanonicalPaths.add(`${folder}/tree.json`);
    sortEntries(this.indexed);
  }

  private async trackRefresh(force: boolean): Promise<void> {
    const refresh = this.refresh(force);
    this.refreshing = refresh;
    try {
      await refresh;
    } finally {
      if (this.refreshing === refresh) this.refreshing = undefined;
    }
  }

  private async refresh(force: boolean): Promise<void> {
    const paths = canonicalHistoryPaths(
      await this.vault.list(`${this.historyRoot}/`),
      this.historyRoot
    );
    if (
      !force &&
      this.initialized &&
      samePaths(paths, this.knownCanonicalPaths)
    ) {
      return;
    }
    const entries = await this.buildFromPaths(paths);
    this.indexed = entries;
    this.knownCanonicalPaths = new Set(paths);
    this.initialized = true;
  }

  private async buildFromPaths(paths: string[]): Promise<HistoryEntry[]> {
    const entries: HistoryEntry[] = [];
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < paths.length) {
        const path = paths[cursor];
        cursor += 1;
        if (path === undefined) continue;
        const entry = await this.readEntry(path);
        if (entry !== undefined) entries.push(entry);
      }
    };
    const workers = Array.from(
      { length: Math.min(MAX_CONCURRENT_READS, paths.length) },
      () => worker()
    );
    await Promise.all(workers);
    sortEntries(entries);
    return entries;
  }

  private async readEntry(path: string): Promise<HistoryEntry | undefined> {
    try {
      const conversation = parseConversation(
        JSON.parse(await this.vault.read(path)) as unknown
      );
      if (
        conversation.status !== "archived" ||
        !(await verifyConversationChecksum(conversation))
      ) {
        return undefined;
      }
      return {
        id: conversation.id,
        title: conversation.title,
        folder: path.slice(0, -"/tree.json".length),
        updatedAt: conversation.updatedAt
      };
    } catch (error) {
      logWarning(`历史索引跳过会话: ${path}`, error);
      // Corrupt canonical files remain available for repository backup recovery.
      return undefined;
    }
  }
}
