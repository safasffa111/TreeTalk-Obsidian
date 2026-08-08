import type { ConversationFile } from "../domain/types";
import type { ConversationRepository } from "./conversation-repository";

export type PersistenceErrorHandler = (error: unknown) => void;

interface PendingSave {
  folder: string;
  conversation: ConversationFile;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export class SessionPersistence {
  private readonly revisions = new Map<string, number>();
  private readonly renamedFolders = new Map<string, string>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly failures = new Map<string, Error>();

  constructor(
    private readonly repository: ConversationRepository,
    private readonly onError?: PersistenceErrorHandler
  ) {}

  seed(folder: string, revision: number): void {
    this.revisions.set(folder, revision);
  }

  forget(folder: string): void {
    this.revisions.delete(folder);
    this.failures.delete(folder);
  }

  renameFolder(oldFolder: string, newFolder: string): void {
    const resolvedOld = this.resolveFolder(oldFolder);
    this.renamedFolders.delete(newFolder);
    for (const [source, destination] of this.renamedFolders) {
      if (destination === resolvedOld) {
        this.renamedFolders.set(source, newFolder);
      }
    }
    this.renamedFolders.set(resolvedOld, newFolder);
    this.renamedFolders.set(oldFolder, newFolder);
    const revision = this.revisions.get(resolvedOld) ?? this.revisions.get(oldFolder);
    const failure = this.failures.get(resolvedOld) ?? this.failures.get(oldFolder);
    this.revisions.delete(resolvedOld);
    this.revisions.delete(oldFolder);
    this.failures.delete(resolvedOld);
    this.failures.delete(oldFolder);
    if (revision !== undefined) this.revisions.set(newFolder, revision);
    if (failure !== undefined) this.failures.set(newFolder, failure);
  }

  schedule(
    folder: string,
    conversation: ConversationFile
  ): void {
    const pending: PendingSave = {
      folder,
      conversation: structuredClone(conversation)
    };
    const queueFolder = this.resolveFolder(folder);
    const previousQueues = this.queuesFor(queueFolder);
    const previous = Promise.all(
      previousQueues.map((queue) => queue.catch(() => undefined))
    ).then(() => undefined);
    const next = previous.then(async () => {
      try {
        await this.persist(pending);
        this.failures.delete(this.resolveFolder(pending.folder));
      } catch (error) {
        const failure = asError(error);
        this.failures.set(this.resolveFolder(pending.folder), failure);
        this.onError?.(error);
      }
    });
    this.queues.set(queueFolder, next);
  }

  async flush(folder?: string): Promise<void> {
    const queues =
      folder === undefined
        ? [...this.queues.values()]
        : this.queuesFor(this.resolveFolder(folder));
    await Promise.all(queues);
    const failures =
      folder === undefined
        ? [...this.failures.values()]
        : [...this.failures.entries()]
            .filter(
              ([candidate]) =>
                this.resolveFolder(candidate) === this.resolveFolder(folder)
            )
            .map(([, error]) => error);
    const failure = failures[0];
    if (failure !== undefined) throw failure;
  }

  private async persist(pending: PendingSave): Promise<void> {
    const folder = this.resolveFolder(pending.folder);
    const savedRevision = this.revisions.get(folder);
    if (savedRevision === pending.conversation.revision) {
      return;
    }
    const expectedRevision = savedRevision ?? pending.conversation.revision;
    let saved = await this.repository.save(
      folder,
      pending.conversation,
      expectedRevision
    );
    this.revisions.set(folder, saved.revision);
    const finalFolder = this.resolveFolder(pending.folder);
    if (finalFolder !== folder) {
      const finalRevision = this.revisions.get(finalFolder);
      saved = await this.repository.save(
        finalFolder,
        saved,
        finalRevision ?? saved.revision
      );
      this.revisions.set(finalFolder, saved.revision);
    }
  }

  private resolveFolder(folder: string): string {
    let current = folder;
    const visited = new Set<string>();
    while (!visited.has(current)) {
      visited.add(current);
      const renamed = this.renamedFolders.get(current);
      if (renamed === undefined) break;
      current = renamed;
    }
    return current;
  }

  private queuesFor(folder: string): Promise<void>[] {
    return [...this.queues.entries()]
      .filter(([candidate]) => this.resolveFolder(candidate) === folder)
      .map(([, queue]) => queue);
  }
}
