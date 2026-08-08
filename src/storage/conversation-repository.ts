import { parseConversation } from "../domain/schema";
import type { ConversationFile } from "../domain/types";
import { checksumConversation, verifyConversationChecksum } from "./checksum";
import { logWarning } from "../utils/error-log";

export interface VaultPort {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  process(path: string, update: (content: string) => string): Promise<void>;
  remove(path: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  /** Includes files hidden from Obsidian's Vault cache when supported. */
  listAll?(prefix: string): Promise<string[]>;
}

export type RepositoryErrorCode =
  | "conversation-not-found"
  | "invalid-conversation"
  | "revision-conflict";

export class RepositoryError extends Error {
  constructor(
    public readonly code: RepositoryErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "RepositoryError";
  }
}

export interface LoadedConversation {
  conversation: ConversationFile;
  source: "canonical" | "backup";
}

interface Candidate {
  conversation: ConversationFile;
  source: LoadedConversation["source"];
}

async function readValidConversation(
  vault: VaultPort,
  path: string,
  source: Candidate["source"]
): Promise<Candidate | undefined> {
  if (!(await vault.exists(path))) return undefined;
  try {
    const parsed = parseConversation(JSON.parse(await vault.read(path)) as unknown);
    if (!(await verifyConversationChecksum(parsed))) return undefined;
    return { conversation: parsed, source };
  } catch (error) {
    logWarning(`读取会话数据失败: ${path}`, error);
    return undefined;
  }
}

function serialize(conversation: ConversationFile): string {
  return `${JSON.stringify(conversation, null, 2)}\n`;
}

export class ConversationRepository {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly vault: VaultPort) {}

  async load(folder: string): Promise<LoadedConversation> {
    const candidates = (
      await Promise.all([
        readValidConversation(this.vault, `${folder}/tree.json`, "canonical"),
        readValidConversation(this.vault, `${folder}/tree.backup.json`, "backup")
      ])
    ).filter((candidate): candidate is Candidate => candidate !== undefined);

    if (candidates.length === 0) {
      throw new RepositoryError(
        "conversation-not-found",
        `No valid conversation data exists in ${folder}`
      );
    }

    candidates.sort((left, right) => {
      const revisionDifference = right.conversation.revision - left.conversation.revision;
      if (revisionDifference !== 0) return revisionDifference;
      return left.source === "canonical" ? -1 : 1;
    });
    const selected = candidates[0];
    if (selected === undefined) {
      throw new RepositoryError("invalid-conversation", "Unable to choose conversation data");
    }
    return selected;
  }

  async save(
    folder: string,
    conversation: ConversationFile,
    expectedRevision: number
  ): Promise<ConversationFile> {
    let result: ConversationFile | undefined;
    await this.enqueue(folder, async () => {
      result = await this.saveNow(folder, conversation, expectedRevision);
    });
    if (result === undefined) {
      throw new RepositoryError("invalid-conversation", "Conversation was not saved");
    }
    return result;
  }

  private async saveNow(
    folder: string,
    conversation: ConversationFile,
    expectedRevision: number
  ): Promise<ConversationFile> {
    const canonicalPath = `${folder}/tree.json`;
    const backupPath = `${folder}/tree.backup.json`;
    const temporaryPath = `${folder}/tree.tmp.json`;
    const existing = await readValidConversation(this.vault, canonicalPath, "canonical");

    if (existing !== undefined && existing.conversation.revision !== expectedRevision) {
      const conflictPath = `${folder}/tree.conflict-r${String(conversation.revision)}.json`;
      await this.vault.write(conflictPath, serialize(conversation));
      throw new RepositoryError(
        "revision-conflict",
        `Expected revision ${String(expectedRevision)}, found ${String(existing.conversation.revision)}`
      );
    }

    const candidateValue = structuredClone(conversation);
    candidateValue.checksum = await checksumConversation(candidateValue);
    const candidate = parseConversation(candidateValue);
    const serialized = serialize(candidate);

    await this.vault.write(temporaryPath, serialized);
    const verifiedTemporary = await readValidConversation(this.vault, temporaryPath, "canonical");
    if (verifiedTemporary === undefined) {
      throw new RepositoryError("invalid-conversation", "Temporary conversation failed validation");
    }

    try {
      if (await this.vault.exists(canonicalPath)) {
        await this.vault.write(backupPath, await this.vault.read(canonicalPath));
      }
      await this.vault.write(canonicalPath, serialized);
    } finally {
      if (await this.vault.exists(temporaryPath)) {
        try {
          await this.vault.remove(temporaryPath);
        } catch {
          // The canonical file is already verified and committed. A stale
          // temporary file is safe to overwrite during the next save.
        }
      }
    }
    return candidate;
  }

  private async enqueue(folder: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(folder) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.queues.set(folder, current);
    try {
      await current;
    } finally {
      if (this.queues.get(folder) === current) {
        this.queues.delete(folder);
      }
    }
  }
}
