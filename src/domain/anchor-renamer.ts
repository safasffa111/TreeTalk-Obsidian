import { isVaultRelativeMarkdownPath } from "./anchor-path";
import { parseConversation } from "./schema";
import type { ConversationFile } from "./types";

export interface StoredAnchorRecord {
  conversationId: string;
  folder: string;
  anchorFilePath: string;
  /** Anchor triple observed during enumeration, before this rename's rewrite. */
  observedAnchorFilePath: string;
  anchorVaultId: string;
  observedAnchorVaultId: string;
  anchorFileCtime: number;
  observedAnchorFileCtime: number;
  revision: number;
}

export interface AnchorRenamerStore {
  /** 枚举当前所有未打开的 active/history 会话锚点。 */
  loadStored: () => Promise<StoredAnchorRecord[]>;
  /**
   * 单条保存：调用方负责 expected revision 校验（沿用 ConversationRepository 的
   * revision-conflict 语义），由本服务透传异常并隔离。
   */
  saveStored: (record: StoredAnchorRecord) => Promise<"saved" | "stale" | undefined>;
  /** 当前在 tab 中已打开的 conversation IDs，跳过以避免双写。 */
  skipOpenConversationIds: Set<string>;
  onError?: (error: unknown, record: StoredAnchorRecord) => void;
}

export interface AnchorUpdate {
  conversationId: string;
  folder: string;
  previousPath: string;
  nextPath: string;
}

export interface RenameResult {
  updates: AnchorUpdate[];
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/gu, "/");
}

function rewritePath(
  value: string | null | undefined,
  exact: { from: string; to: string } | { oldPrefix: string; newPrefix: string }
): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = normalizeSlashes(value);
  if ("from" in exact) {
    if (normalized === normalizeSlashes(exact.from)) {
      return normalizeSlashes(exact.to);
    }
    if (normalized.startsWith(`${normalizeSlashes(exact.from)}/`)) {
      return `${normalizeSlashes(exact.to)}/${normalized.slice(
        normalizeSlashes(exact.from).length + 1
      )}`;
    }
    return undefined;
  }
  const oldPrefix = normalizeSlashes(exact.oldPrefix).replace(/\/+$/u, "");
  const newPrefix = normalizeSlashes(exact.newPrefix).replace(/\/+$/u, "");
  if (normalized === oldPrefix) return newPrefix;
  if (normalized.startsWith(`${oldPrefix}/`)) {
    return `${newPrefix}/${normalized.slice(oldPrefix.length + 1)}`;
  }
  return undefined;
}

function isVerifiedInCurrentVault(
  anchor: {
    anchorVaultId?: string;
    anchorFilePath?: string;
    anchorFileCtime?: number;
  },
  currentVaultId: string | undefined
): boolean {
  return (
    currentVaultId !== undefined &&
    anchor.anchorVaultId === currentVaultId &&
    isVaultRelativeMarkdownPath(anchor.anchorFilePath) &&
    typeof anchor.anchorFileCtime === "number"
  );
}

/**
 * Stored records carry the original triple observed during enumeration. Both the
 * current candidate and the observed triple must already be eligible; a rename
 * event must never upgrade an invalid path into a verified Markdown anchor.
 */
function isStoredVerifiedInCurrentVault(
  record: StoredAnchorRecord,
  currentVaultId: string | undefined
): boolean {
  return (
    isVerifiedInCurrentVault(record, currentVaultId) &&
    record.observedAnchorVaultId === currentVaultId &&
    isVaultRelativeMarkdownPath(record.observedAnchorFilePath) &&
    typeof record.observedAnchorFileCtime === "number"
  );
}

/**
 * Vault rename 事件的串行处理器：
 *
 * - `applyExactRename(oldPath, newPath)`：精确文件 / 文件夹名变更。
 * - `applyFolderMove(oldPrefix, newPrefix)`：父文件夹移动。
 *
 * 两个入口都通过共享队列串行执行，保证同 Vault 下事件按入队顺序生效。
 * 单条 stored 记录失败时，仅记录 `onError`，不影响其他记录。
 * 打开中的 conversation 由调用方通过 `applyExactRenameToOpen` /
 * `applyFolderMoveToOpen` 同步更新内存，存储侧由 `skipOpenConversationIds` 跳过。
 */
export class AnchorRenamer {
  private readonly pending = new Map<string, string>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly store: AnchorRenamerStore) {}

  // 串行队列：保证事件按到达顺序串行处理。
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    // The queue tail always recovers, while callers still receive their own result.
    this.queue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  setPending(tabId: string, filePath: string): void {
    this.pending.set(tabId, filePath);
  }

  getPending(tabId: string): string | undefined {
    return this.pending.get(tabId);
  }

  clearPending(tabId: string): void {
    this.pending.delete(tabId);
  }

  applyExactRename(
    oldPath: string,
    newPath: string,
    now: string,
    currentVaultId?: string
  ): Promise<RenameResult | null> {
    return this.enqueue(async () => {
      const stored = await this.store.loadStored();
      const updates: AnchorUpdate[] = [];
      let anySkipped = false;
      for (const record of stored) {
        if (!isStoredVerifiedInCurrentVault(record, currentVaultId)) continue;
        if (this.store.skipOpenConversationIds.has(record.conversationId)) {
          anySkipped = true;
          continue;
        }
        if (typeof record.anchorFilePath !== "string") {
          this.store.onError?.(
            new Error(
              `Stored anchor record ${record.conversationId} has invalid anchorFilePath; skipped rename.`
            ),
            record
          );
          continue;
        }
        const previousPath = record.anchorFilePath;
        const next = rewritePath(previousPath, { from: oldPath, to: newPath });
        if (next === undefined) continue;
        const updated: StoredAnchorRecord = {
          ...record,
          anchorFilePath: next,
          revision: record.revision + 1
        };
        try {
          const saveResult = await this.store.saveStored(updated);
          if (saveResult === "stale") continue;
          record.anchorFilePath = next;
          updates.push({
            conversationId: record.conversationId,
            folder: record.folder,
            previousPath,
            nextPath: next
          });
        } catch (error) {
          this.store.onError?.(error, record);
        }
      }
      this.remapPendingExact(oldPath, newPath);
      const result: RenameResult | null =
        updates.length > 0 || anySkipped ? { updates } : null;
      void now;
      return result;
    });
  }

  applyFolderMove(
    oldPrefix: string,
    newPrefix: string,
    now: string,
    currentVaultId?: string
  ): Promise<RenameResult | null> {
    return this.enqueue(async () => {
      const stored = await this.store.loadStored();
      const updates: AnchorUpdate[] = [];
      let anySkipped = false;
      for (const record of stored) {
        if (!isStoredVerifiedInCurrentVault(record, currentVaultId)) continue;
        if (this.store.skipOpenConversationIds.has(record.conversationId)) {
          anySkipped = true;
          continue;
        }
        if (typeof record.anchorFilePath !== "string") {
          this.store.onError?.(
            new Error(
              `Stored anchor record ${record.conversationId} has invalid anchorFilePath; skipped rename.`
            ),
            record
          );
          continue;
        }
        const previousPath = record.anchorFilePath;
        const next = rewritePath(previousPath, {
          oldPrefix,
          newPrefix
        });
        if (next === undefined) continue;
        const updated: StoredAnchorRecord = {
          ...record,
          anchorFilePath: next,
          revision: record.revision + 1
        };
        try {
          const saveResult = await this.store.saveStored(updated);
          if (saveResult === "stale") continue;
          record.anchorFilePath = next;
          updates.push({
            conversationId: record.conversationId,
            folder: record.folder,
            previousPath,
            nextPath: next
          });
        } catch (error) {
          this.store.onError?.(error, record);
        }
      }
      this.remapPendingPrefix(oldPrefix, newPrefix);
      const result: RenameResult | null =
        updates.length > 0 || anySkipped ? { updates } : null;
      void now;
      return result;
    });
  }

  applyExactRenameToOpen(
    openConversations: ConversationFile[],
    oldPath: string,
    newPath: string,
    currentVaultId?: string
  ): Promise<void> {
    return this.enqueue(async () => {
      for (const conversation of openConversations) {
        if (!isVerifiedInCurrentVault(conversation, currentVaultId)) continue;
        const next = rewritePath(conversation.anchorFilePath ?? "", {
          from: oldPath,
          to: newPath
        });
        if (next === undefined) continue;
        const updated = structuredClone(conversation) as ConversationFile;
        updated.anchorFilePath = next;
        updated.revision += 1;
        updated.updatedAt = new Date().toISOString();
        const parsed = parseConversation(updated);
        // 通过 mutation 把更新写回原数组中的引用（不重新赋值引用本身）。
        Object.assign(conversation, parsed);
      }
    });
  }

  applyFolderMoveToOpen(
    openConversations: ConversationFile[],
    oldPrefix: string,
    newPrefix: string,
    currentVaultId?: string
  ): Promise<void> {
    return this.enqueue(async () => {
      for (const conversation of openConversations) {
        if (!isVerifiedInCurrentVault(conversation, currentVaultId)) continue;
        const next = rewritePath(conversation.anchorFilePath ?? "", {
          oldPrefix,
          newPrefix
        });
        if (next === undefined) continue;
        const updated = structuredClone(conversation) as ConversationFile;
        updated.anchorFilePath = next;
        updated.revision += 1;
        updated.updatedAt = new Date().toISOString();
        const parsed = parseConversation(updated);
        Object.assign(conversation, parsed);
      }
    });
  }

  private remapPendingExact(oldPath: string, newPath: string): void {
    for (const [tabId, path] of [...this.pending.entries()]) {
      const next = rewritePath(path, { from: oldPath, to: newPath });
      if (next !== undefined) this.pending.set(tabId, next);
    }
  }

  private remapPendingPrefix(oldPrefix: string, newPrefix: string): void {
    for (const [tabId, path] of [...this.pending.entries()]) {
      const next = rewritePath(path, { oldPrefix, newPrefix });
      if (next !== undefined) this.pending.set(tabId, next);
    }
  }
}
