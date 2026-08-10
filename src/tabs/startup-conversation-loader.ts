import { interruptOrphanedResponses } from "../domain/response-recovery";
import type {
  ConversationFile,
  ConversationStatus
} from "../domain/types";
import type { LoadedConversation } from "../storage/conversation-repository";

const DEFAULT_CONCURRENCY = 4;

export interface StartupConversationRepositoryPort {
  load(folder: string): Promise<LoadedConversation>;
  save(
    folder: string,
    conversation: ConversationFile,
    expectedRevision: number
  ): Promise<ConversationFile>;
}

export interface StartupConversationLoadResult {
  folder: string;
  conversation: ConversationFile;
  sourceStatus: ConversationStatus;
  sourceUpdatedAt: string;
}

export interface StartupConversationLoadOptions {
  folders: string[];
  repository: StartupConversationRepositoryPort;
  now(): string;
  concurrency?: number;
  reportLoadError?(folder: string, error: unknown): void;
  reportSaveError?(folder: string, error: unknown): void;
}

export async function loadStartupConversations(
  options: StartupConversationLoadOptions
): Promise<StartupConversationLoadResult[]> {
  const results: Array<StartupConversationLoadResult | undefined> =
    new Array(options.folders.length);
  let cursor = 0;
  const concurrency = Math.max(
    1,
    Math.trunc(options.concurrency ?? DEFAULT_CONCURRENCY)
  );
  const worker = async (): Promise<void> => {
    while (cursor < options.folders.length) {
      const index = cursor;
      cursor += 1;
      const folder = options.folders[index];
      if (folder === undefined) continue;
      try {
        const loaded = await options.repository.load(folder);
        const sourceStatus = loaded.conversation.status;
        const sourceUpdatedAt = loaded.conversation.updatedAt;
        const recovered = interruptOrphanedResponses(
          loaded.conversation,
          options.now()
        );
        let conversation = recovered;
        if (recovered !== loaded.conversation) {
          try {
            conversation = await options.repository.save(
              folder,
              recovered,
              loaded.conversation.revision
            );
          } catch (error) {
            options.reportSaveError?.(folder, error);
          }
        }
        results[index] = {
          folder,
          conversation,
          sourceStatus,
          sourceUpdatedAt
        };
      } catch (error) {
        options.reportLoadError?.(folder, error);
      }
    }
  };
  const workers = Array.from(
    { length: Math.min(concurrency, options.folders.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results.filter(
    (result): result is StartupConversationLoadResult => result !== undefined
  );
}
