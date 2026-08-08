import { parseConversation } from "../domain/schema";
import type { ConversationFile, ConversationStatus } from "../domain/types";
import type { ConversationRepository } from "../storage/conversation-repository";
import type { ConversationRoots } from "../storage/private-paths";

export interface FolderMovePort {
  exists(path: string): Promise<boolean>;
  list(prefix: string): Promise<string[]>;
  move(source: string, destination: string): Promise<void>;
}

export type ArchiveErrorCode =
  | "destination-exists"
  | "invalid-source"
  | "invalid-status"
  | "operation-in-progress"
  | "move-failed"
  | "move-state-unknown"
  | "rollback-failed";

export class ArchiveError extends Error {
  constructor(
    public readonly code: ArchiveErrorCode,
    message: string,
    public readonly recovery?: ArchiveResult
  ) {
    super(message);
    this.name = "ArchiveError";
  }
}

export interface ArchiveResult {
  conversation: ConversationFile;
  folder: string;
}

function folderName(folder: string, root: string): string {
  const prefix = `${root}/`;
  if (!folder.startsWith(prefix)) {
    throw new ArchiveError("invalid-source", `Folder must be under ${root}`);
  }
  const name = folder.slice(prefix.length);
  if (name.length === 0 || name.includes("/")) {
    throw new ArchiveError("invalid-source", "Conversation folder is invalid");
  }
  return name;
}

function transition(
  conversation: ConversationFile,
  status: ConversationStatus
): ConversationFile {
  const next = structuredClone(conversation);
  const now = new Date().toISOString();
  next.status = status;
  next.revision += 1;
  next.updatedAt = now;
  return parseConversation(next);
}

export class ArchiveService {
  private readonly inFlightFolders = new Set<string>();

  constructor(
    private readonly repository: ConversationRepository,
    private readonly folders: FolderMovePort,
    private readonly roots: ConversationRoots
  ) {}

  archive(folder: string, conversation: ConversationFile): Promise<ArchiveResult> {
    if (conversation.status !== "active") {
      return Promise.reject(
        new ArchiveError("invalid-status", "Only active conversations can be archived")
      );
    }
    return this.moveWithStatus(
      folder,
      this.roots.active,
      this.roots.history,
      conversation,
      "archived"
    );
  }

  restore(folder: string, conversation: ConversationFile): Promise<ArchiveResult> {
    if (conversation.status !== "archived") {
      return Promise.reject(
        new ArchiveError("invalid-status", "Only archived conversations can be restored")
      );
    }
    return this.moveWithStatus(
      folder,
      this.roots.history,
      this.roots.active,
      conversation,
      "active"
    );
  }

  private async moveWithStatus(
    folder: string,
    sourceRoot: string,
    destinationRoot: string,
    conversation: ConversationFile,
    status: ConversationStatus
  ): Promise<ArchiveResult> {
    if (this.inFlightFolders.has(folder)) {
      throw new ArchiveError(
        "operation-in-progress",
        `A lifecycle operation is already running for ${folder}`
      );
    }
    this.inFlightFolders.add(folder);
    try {
      return await this.performMoveWithStatus(
        folder,
        sourceRoot,
        destinationRoot,
        conversation,
        status
      );
    } finally {
      this.inFlightFolders.delete(folder);
    }
  }

  private async performMoveWithStatus(
    folder: string,
    sourceRoot: string,
    destinationRoot: string,
    conversation: ConversationFile,
    status: ConversationStatus
  ): Promise<ArchiveResult> {
    const name = folderName(folder, sourceRoot);
    const destination = `${destinationRoot}/${name}`;
    const destinationFiles = await this.folders.list(`${destination}/`);
    if ((await this.folders.exists(destination)) || destinationFiles.length > 0) {
      throw new ArchiveError(
        "destination-exists",
        `Conversation folder already exists: ${destination}`
      );
    }

    const next = transition(conversation, status);
    const saved = await this.repository.save(folder, next, conversation.revision);
    try {
      await this.folders.move(folder, destination);
    } catch (moveError) {
      const sourcePresent =
        (await this.folders.exists(folder)) ||
        (await this.folders.list(`${folder}/`)).length > 0;
      const destinationPresent =
        (await this.folders.exists(destination)) ||
        (await this.folders.list(`${destination}/`)).length > 0;
      if (!sourcePresent && destinationPresent) {
        return { conversation: saved, folder: destination };
      }
      if (!sourcePresent || destinationPresent) {
        throw new ArchiveError(
          "move-state-unknown",
          `Folder move ended in an ambiguous state: ${String(moveError)}`
        );
      }
      try {
        const rollback = transition(saved, conversation.status);
        const recovered = await this.repository.save(folder, rollback, saved.revision);
        throw new ArchiveError(
          "move-failed",
          `Folder move failed and status was restored: ${String(moveError)}`,
          { conversation: recovered, folder }
        );
      } catch (rollbackError) {
        if (rollbackError instanceof ArchiveError && rollbackError.code === "move-failed") {
          throw rollbackError;
        }
        throw new ArchiveError(
          "rollback-failed",
          `Folder move and status rollback both failed: ${String(rollbackError)}`
        );
      }
      throw moveError;
    }
    return { conversation: saved, folder: destination };
  }
}
