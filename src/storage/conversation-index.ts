import { parseConversation } from "../domain/schema";
import type { VaultPort } from "./conversation-repository";
import { logWarning } from "../utils/error-log";

export class ConversationIndex {
  private readonly foldersByConversationId = new Map<string, string>();

  constructor(
    private readonly vault: VaultPort,
    private readonly root: string
  ) {}

  async rebuild(): Promise<void> {
    const next = new Map<string, string>();
    const paths = await this.vault.list(`${this.root}/`);
    for (const path of paths) {
      if (!path.endsWith("/tree.json")) continue;
      try {
        const conversation = parseConversation(JSON.parse(await this.vault.read(path)) as unknown);
        next.set(conversation.id, path.slice(0, -"/tree.json".length));
      } catch (error) {
        logWarning(`会话索引跳过文件: ${path}`, error);
        // Invalid conversation files remain available for repository recovery.
      }
    }
    this.foldersByConversationId.clear();
    for (const [id, folder] of next) {
      this.foldersByConversationId.set(id, folder);
    }
  }

  resolve(conversationId: string): string | undefined {
    return this.foldersByConversationId.get(conversationId);
  }

  onRename(oldPath: string, newPath: string): void {
    for (const [conversationId, folder] of this.foldersByConversationId) {
      if (folder === oldPath || folder.startsWith(`${oldPath}/`)) {
        this.foldersByConversationId.set(
          conversationId,
          `${newPath}${folder.slice(oldPath.length)}`
        );
      }
    }
  }
}
