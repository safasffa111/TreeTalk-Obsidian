import { parseConversation } from "../domain/schema";
import type {
  ConversationFile,
  ConversationStatus
} from "../domain/types";
import type {
  ConversationRepository,
  VaultPort
} from "../storage/conversation-repository";
import type { ConversationRoots } from "../storage/private-paths";
import { logWarning } from "../utils/error-log";

export interface ReconcileResult {
  repaired: number;
  failed: number;
}

function withStatus(
  conversation: ConversationFile,
  status: ConversationStatus
): ConversationFile {
  const next = structuredClone(conversation);
  next.status = status;
  next.revision += 1;
  next.updatedAt = new Date().toISOString();
  return parseConversation(next);
}

function directConversationFolders(paths: string[], root: string): string[] {
  const folders = new Set<string>();
  const prefix = `${root}/`;
  for (const path of paths) {
    if (!path.startsWith(prefix)) continue;
    const relative = path.slice(prefix.length);
    const parts = relative.split("/");
    if (
      parts.length === 2 &&
      (parts[1] === "tree.json" || parts[1] === "tree.backup.json")
    ) {
      folders.add(`${root}/${parts[0] ?? ""}`);
    }
  }
  return [...folders];
}

export class LifecycleReconciler {
  constructor(
    private readonly repository: ConversationRepository,
    private readonly vault: VaultPort,
    private readonly roots: ConversationRoots
  ) {}

  async reconcile(): Promise<ReconcileResult> {
    let repaired = 0;
    let failed = 0;
    const lifecycleRoots: ReadonlyArray<{
      path: string;
      status: ConversationStatus;
    }> = [
      { path: this.roots.active, status: "active" },
      { path: this.roots.history, status: "archived" }
    ];
    for (const root of lifecycleRoots) {
      const folders = directConversationFolders(
        await this.vault.list(`${root.path}/`),
        root.path
      );
      for (const folder of folders) {
        try {
          const loaded = await this.repository.load(folder);
          if (loaded.conversation.status === root.status) continue;
          await this.repository.save(
            folder,
            withStatus(loaded.conversation, root.status),
            loaded.conversation.revision
          );
          repaired += 1;
        } catch (error) {
          logWarning(`修复会话状态失败: ${folder}`, error);
          failed += 1;
        }
      }
    }
    return { repaired, failed };
  }
}
