import type { ConversationFile } from "../domain/types";
import type { ConversationRepository } from "./conversation-repository";

export type PersistenceErrorHandler = (error: unknown) => void;

interface PendingSave {
  folder: string;
  conversation: ConversationFile;
  sequence: number;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export class SessionPersistence {
  private readonly revisions = new Map<string, number>();
  private readonly renamedFolders = new Map<string, string>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly pending = new Map<string, PendingSave>();
  private readonly failures = new Map<string, Error>();
  private nextSequence = 0;

  constructor(
    private readonly repository: ConversationRepository,
    private readonly onError?: PersistenceErrorHandler
  ) {}

  seed(folder: string, revision: number): void {
    this.revisions.set(folder, revision);
  }

  forget(folder: string): void {
    const resolved = this.resolveFolder(folder);
    this.revisions.delete(resolved);
    this.failures.delete(resolved);
    for (const candidate of [...this.pending.keys()]) {
      if (this.resolveFolder(candidate) === resolved) {
        this.pending.delete(candidate);
      }
    }
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
    const resolvedFolder = this.resolveFolder(folder);
    if (
      this.revisions.get(resolvedFolder) === conversation.revision &&
      !this.failures.has(resolvedFolder)
    ) {
      return;
    }
    const pending: PendingSave = {
      folder,
      conversation: structuredClone(conversation),
      sequence: this.nextSequence
    };
    this.nextSequence += 1;
    for (const candidate of [...this.pending.keys()]) {
      if (this.resolveFolder(candidate) === resolvedFolder) {
        this.pending.delete(candidate);
      }
    }
    this.pending.set(resolvedFolder, pending);
    this.ensureWorker(resolvedFolder);
  }

  async flush(folder?: string): Promise<void> {
    const target = folder === undefined ? undefined : this.resolveFolder(folder);
    while (true) {
      const queues =
        target === undefined
          ? [...this.queues.values()]
          : this.queuesFor(target);
      if (queues.length === 0) {
        const pendingFolder = this.pendingFolder(target);
        if (pendingFolder === undefined) break;
        this.ensureWorker(pendingFolder);
        continue;
      }
      await Promise.all(queues);
    }
    const failures =
      target === undefined
        ? [...this.failures.values()]
        : [...this.failures.entries()]
            .filter(
              ([candidate]) => this.resolveFolder(candidate) === target
            )
            .map(([, error]) => error);
    const failure = failures[0];
    if (failure !== undefined) throw failure;
  }

  private ensureWorker(folder: string): void {
    const resolved = this.resolveFolder(folder);
    if (this.queuesFor(resolved).length > 0) return;
    const worker = Promise.resolve().then(() => this.drain(resolved));
    this.queues.set(resolved, worker);
    void worker.finally(() => {
      if (this.queues.get(resolved) === worker) {
        this.queues.delete(resolved);
      }
      const pendingFolder = this.pendingFolder(this.resolveFolder(resolved));
      if (pendingFolder !== undefined) this.ensureWorker(pendingFolder);
    });
  }

  private async drain(folder: string): Promise<void> {
    while (true) {
      const pending = this.takeLatestPending(this.resolveFolder(folder));
      if (pending === undefined) return;
      try {
        await this.persist(pending);
        this.failures.delete(this.resolveFolder(pending.folder));
      } catch (error) {
        const failure = asError(error);
        this.failures.set(this.resolveFolder(pending.folder), failure);
        this.onError?.(error);
      }
    }
  }

  private takeLatestPending(folder: string): PendingSave | undefined {
    let latest: PendingSave | undefined;
    for (const [candidate, pending] of [...this.pending.entries()]) {
      if (this.resolveFolder(candidate) !== folder) continue;
      this.pending.delete(candidate);
      if (latest === undefined || pending.sequence > latest.sequence) {
        latest = pending;
      }
    }
    return latest;
  }

  private pendingFolder(target?: string): string | undefined {
    for (const candidate of this.pending.keys()) {
      const resolved = this.resolveFolder(candidate);
      if (target === undefined || resolved === target) return resolved;
    }
    return undefined;
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
