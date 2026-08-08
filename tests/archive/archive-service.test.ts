import { describe, expect, it } from "vitest";
import {
  ArchiveError,
  ArchiveService
} from "../../src/archive/archive-service";
import type { ConversationFile } from "../../src/domain/types";
import { checksumConversation } from "../../src/storage/checksum";
import { ConversationRepository } from "../../src/storage/conversation-repository";
import { privateConversationRoots } from "../../src/storage/private-paths";
import { validConversation } from "../fixtures";
import { FakeVault } from "../storage/fake-vault";

const ROOTS = privateConversationRoots(".obsidian");
const ACTIVE_FOLDER = `${ROOTS.active}/id`;
const HISTORY_FOLDER = `${ROOTS.history}/id`;

async function activeConversation(): Promise<ConversationFile> {
  const conversation = structuredClone(validConversation());
  conversation.status = "active";
  conversation.checksum = await checksumConversation(conversation);
  return conversation;
}

async function fixture(): Promise<{
  conversation: ConversationFile;
  vault: FakeVault;
  service: ArchiveService;
}> {
  const conversation = await activeConversation();
  const vault = new FakeVault({
    [`${ACTIVE_FOLDER}/tree.json`]: JSON.stringify(conversation),
    [`${ACTIVE_FOLDER}/metadata.json`]: "metadata"
  });
  const service = new ArchiveService(
    new ConversationRepository(vault),
    vault,
    ROOTS
  );
  return { conversation, vault, service };
}

describe("ArchiveService", () => {
  it("archives and restores the complete conversation folder", async () => {
    const { conversation, vault, service } = await fixture();

    const archived = await service.archive(ACTIVE_FOLDER, conversation);
    expect(archived.folder).toBe(HISTORY_FOLDER);
    expect(archived.conversation.status).toBe("archived");
    expect(vault.paths()).toContain(`${HISTORY_FOLDER}/metadata.json`);
    expect(vault.paths()).not.toContain(`${ACTIVE_FOLDER}/tree.json`);

    const restored = await service.restore(archived.folder, archived.conversation);
    expect(restored.folder).toBe(ACTIVE_FOLDER);
    expect(restored.conversation.status).toBe("active");
    expect(vault.paths()).toContain(`${ACTIVE_FOLDER}/metadata.json`);
    expect(vault.paths()).not.toContain(`${HISTORY_FOLDER}/tree.json`);
  });

  it("refuses to overwrite an existing history folder", async () => {
    const { conversation, vault, service } = await fixture();
    await vault.write(`${HISTORY_FOLDER}/tree.json`, "{}");

    await expect(service.archive(ACTIVE_FOLDER, conversation)).rejects.toEqual(
      expect.objectContaining<Partial<ArchiveError>>({
        code: "destination-exists"
      })
    );
    expect(vault.paths()).toContain(`${ACTIVE_FOLDER}/tree.json`);
  });

  it("rejects folders outside the expected lifecycle root", async () => {
    const { conversation, service } = await fixture();
    await expect(service.archive("Other/topic--id", conversation)).rejects.toEqual(
      expect.objectContaining<Partial<ArchiveError>>({
        code: "invalid-source"
      })
    );
  });

  it("rolls back the status when the folder move fails", async () => {
    const { conversation, vault } = await fixture();
    const repository = new ConversationRepository(vault);
    const service = new ArchiveService(
      repository,
      {
        exists: (path) => vault.exists(path),
        list: (prefix) => vault.list(prefix),
        move: () => Promise.reject(new Error("simulated move failure"))
      },
      ROOTS
    );

    let failure: unknown;
    try {
      await service.archive(ACTIVE_FOLDER, conversation);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ArchiveError);
    if (!(failure instanceof ArchiveError)) {
      throw new Error("Expected ArchiveError");
    }
    expect(failure.code).toBe("move-failed");
    expect(failure.recovery?.folder).toBe(ACTIVE_FOLDER);
    expect(failure.recovery?.conversation.status).toBe("active");

    const recovered = await repository.load(ACTIVE_FOLDER);
    expect(recovered.conversation.status).toBe("active");
    expect(failure.recovery?.conversation.revision).toBe(
      recovered.conversation.revision
    );
    expect(vault.paths()).toContain(`${ACTIVE_FOLDER}/tree.json`);
    expect(vault.paths()).not.toContain(`${HISTORY_FOLDER}/tree.json`);
  });

  it("rejects a second lifecycle action while the same folder is moving", async () => {
    const { conversation, vault } = await fixture();
    let releaseMove: (() => void) | undefined;
    let reportStarted: (() => void) | undefined;
    const moveStarted = new Promise<void>((resolve) => {
      reportStarted = resolve;
    });
    const service = new ArchiveService(
      new ConversationRepository(vault),
      {
        exists: (path) => vault.exists(path),
        list: (prefix) => vault.list(prefix),
        move: async (source, destination) => {
          reportStarted?.();
          await new Promise<void>((resolve) => {
            releaseMove = resolve;
          });
          await vault.move(source, destination);
        }
      },
      ROOTS
    );

    const first = service.archive(ACTIVE_FOLDER, conversation);
    await moveStarted;
    await expect(service.archive(ACTIVE_FOLDER, conversation)).rejects.toEqual(
      expect.objectContaining<Partial<ArchiveError>>({
        code: "operation-in-progress"
      })
    );
    releaseMove?.();
    await first;
  });

  it("accepts a move that committed before the adapter reported an error", async () => {
    const { conversation, vault } = await fixture();
    const service = new ArchiveService(
      new ConversationRepository(vault),
      {
        exists: (path) => vault.exists(path),
        list: (prefix) => vault.list(prefix),
        move: async (source, destination) => {
          await vault.move(source, destination);
          throw new Error("link update failed after rename");
        }
      },
      ROOTS
    );

    const archived = await service.archive(ACTIVE_FOLDER, conversation);

    expect(archived.folder).toBe(HISTORY_FOLDER);
    expect(archived.conversation.status).toBe("archived");
    expect(vault.paths()).toContain(`${HISTORY_FOLDER}/tree.json`);
    expect(vault.paths()).not.toContain(`${ACTIVE_FOLDER}/tree.json`);
  });
});
