import type {
  ArchiveResult
} from "../../src/archive/archive-service";
import type { ConversationFile } from "../../src/domain/types";

export const ACTIVE_FOLDER = "TreeTalk/活动对话/conversation";
export const HISTORY_FOLDER = "TreeTalk/历史对话/conversation";

export class FakeArchiveLifecycle {
  readonly archivedFolders: string[] = [];
  readonly restoredFolders: string[] = [];
  private archiveFailure: Error | undefined;
  private restoreFailure: Error | undefined;

  failArchive(error: Error): void {
    this.archiveFailure = error;
  }

  failRestore(error: Error): void {
    this.restoreFailure = error;
  }

  archive(
    folder: string,
    conversation: ConversationFile
  ): Promise<ArchiveResult> {
    if (this.archiveFailure !== undefined) {
      return Promise.reject(this.archiveFailure);
    }
    this.archivedFolders.push(folder);
    return Promise.resolve({
      folder: HISTORY_FOLDER,
      conversation: {
        ...structuredClone(conversation),
        status: "archived"
      }
    });
  }

  restore(
    folder: string,
    conversation: ConversationFile
  ): Promise<ArchiveResult> {
    if (this.restoreFailure !== undefined) {
      return Promise.reject(this.restoreFailure);
    }
    this.restoredFolders.push(folder);
    return Promise.resolve({
      folder: ACTIVE_FOLDER,
      conversation: {
        ...structuredClone(conversation),
        status: "active"
      }
    });
  }
}

export class FakeTabPersistence {
  readonly flushed: string[] = [];
  readonly renames: Array<[string, string]> = [];
  readonly seeds: Array<[string, number]> = [];
  private flushFailure: Error | undefined;

  failFlush(error: Error): void {
    this.flushFailure = error;
  }

  flush(folder?: string): Promise<void> {
    if (this.flushFailure !== undefined) {
      return Promise.reject(this.flushFailure);
    }
    if (folder !== undefined) this.flushed.push(folder);
    return Promise.resolve();
  }

  renameFolder(oldFolder: string, newFolder: string): void {
    this.renames.push([oldFolder, newFolder]);
  }

  seed(folder: string, revision: number): void {
    this.seeds.push([folder, revision]);
  }
}
