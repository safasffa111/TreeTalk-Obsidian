import type { AnchorRenamer, RenameResult } from "./anchor-renamer";
import type { ConversationFile } from "./types";

export type VaultRename =
  | { kind: "file"; oldPath: string; newPath: string }
  | { kind: "folder"; oldPath: string; newPath: string };

export interface AnchorRenameWorkflowResult {
  stored: RenameResult | null;
  openConversations: ConversationFile[];
}

/**
 * Applies one Vault rename event to every anchor population.
 *
 * File and folder events have intentionally separate routes. A file move between
 * directories MUST NOT be broadened into a parent-directory remap, because that
 * would rewrite anchors for unrelated sibling files.
 */
export class AnchorRenameWorkflow {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly renamer: AnchorRenamer,
    private readonly currentVaultId: string | undefined
  ) {}

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  apply(
    rename: VaultRename,
    getOpenConversations: () => ConversationFile[],
    now: string
  ): Promise<AnchorRenameWorkflowResult> {
    return this.enqueue(async () => {
      const currentVaultId = this.currentVaultId ?? "";
      // Read current tabs only after all preceding rename work has completed.
      const updatedOpenConversations = getOpenConversations().map(
        (conversation) => structuredClone(conversation) as ConversationFile
      );
      if (rename.kind === "file") {
        const stored = await this.renamer.applyExactRename(
          rename.oldPath,
          rename.newPath,
          now,
          currentVaultId
        );
        await this.renamer.applyExactRenameToOpen(
          updatedOpenConversations,
          rename.oldPath,
          rename.newPath,
          currentVaultId
        );
        return { stored, openConversations: updatedOpenConversations };
      }

      const stored = await this.renamer.applyFolderMove(
        rename.oldPath,
        rename.newPath,
        now,
        currentVaultId
      );
      await this.renamer.applyFolderMoveToOpen(
        updatedOpenConversations,
        rename.oldPath,
        rename.newPath,
        currentVaultId
      );
      return { stored, openConversations: updatedOpenConversations };
    });
  }
}
