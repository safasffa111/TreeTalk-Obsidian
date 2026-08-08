import { parseConversation } from "../domain/schema";
import { verifyConversationChecksum } from "../storage/checksum";
import type { VaultPort } from "../storage/conversation-repository";
import { logWarning } from "../utils/error-log";

export interface HistoryEntry {
  id: string;
  title: string;
  folder: string;
  updatedAt: string;
}

export class HistoryIndex {
  private indexed: HistoryEntry[] = [];

  constructor(
    private readonly vault: VaultPort,
    private readonly historyRoot: string
  ) {}

  async rebuild(): Promise<void> {
    const entries: HistoryEntry[] = [];
    for (const path of await this.vault.list(`${this.historyRoot}/`)) {
      const relative = path.slice(`${this.historyRoot}/`.length);
      const parts = relative.split("/");
      if (parts.length !== 2 || parts[1] !== "tree.json") continue;
      try {
        const conversation = parseConversation(
          JSON.parse(await this.vault.read(path)) as unknown
        );
        if (
          conversation.status !== "archived" ||
          !(await verifyConversationChecksum(conversation))
        ) {
          continue;
        }
        entries.push({
          id: conversation.id,
          title: conversation.title,
          folder: path.slice(0, -"/tree.json".length),
          updatedAt: conversation.updatedAt
        });
      } catch (error) {
        logWarning(`历史索引跳过会话: ${path}`, error);
        // Corrupt canonical files remain available for repository backup recovery.
      }
    }
    entries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    this.indexed = entries;
  }

  entries(): HistoryEntry[] {
    return this.indexed.map((entry) => ({ ...entry }));
  }

  remove(conversationId: string): void {
    this.indexed = this.indexed.filter(
      (entry) => entry.id !== conversationId
    );
  }
}
