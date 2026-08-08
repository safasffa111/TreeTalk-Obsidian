import type { FolderDeletePort } from "../storage/obsidian-private-storage-port";
import type {
  HistoryIndex,
  HistoryEntry
} from "./history-index";

export class HistoryDeleteService {
  constructor(
    private readonly folders: FolderDeletePort,
    private readonly index: HistoryIndex,
    private readonly closeOpenHistory: (
      conversationId: string
    ) => Promise<void>,
    private readonly reportCleanupErrors: (
      errors: readonly unknown[]
    ) => void = () => undefined
  ) {}

  async delete(entry: HistoryEntry): Promise<HistoryEntry[]> {
    await this.closeOpenHistory(entry.id);
    await this.folders.removeFolder(entry.folder);
    this.index.remove(entry.id);
    try {
      await this.index.rebuild();
    } catch (error) {
      this.reportCleanupErrors([error]);
    }
    return this.index.entries();
  }
}
