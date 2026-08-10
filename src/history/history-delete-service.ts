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
    ) => Promise<void>
  ) {}

  async delete(entry: HistoryEntry): Promise<HistoryEntry[]> {
    await this.closeOpenHistory(entry.id);
    await this.folders.removeFolder(entry.folder);
    this.index.remove(entry.id);
    return this.index.entries();
  }
}
