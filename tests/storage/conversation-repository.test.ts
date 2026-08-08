import { describe, expect, it } from "vitest";
import { ConversationRepository } from "../../src/storage/conversation-repository";
import type { RepositoryError } from "../../src/storage/conversation-repository";
import { checksumConversation } from "../../src/storage/checksum";
import type { ConversationFile } from "../../src/domain/types";
import { validConversation } from "../fixtures";
import { FakeVault } from "./fake-vault";

const FOLDER = "TreeTalk/活动对话/topic--id";

async function revision(number: number): Promise<ConversationFile> {
  const value = structuredClone(validConversation());
  value.revision = number;
  value.checksum = await checksumConversation(value);
  return value;
}

describe("ConversationRepository", () => {
  it("promotes the previous canonical file to backup before replacing it", async () => {
    const first = await revision(1);
    const vault = new FakeVault({
      [`${FOLDER}/tree.json`]: JSON.stringify(first)
    });
    const repository = new ConversationRepository(vault);

    await repository.save(FOLDER, await revision(2), 1);

    expect(JSON.parse(await vault.read(`${FOLDER}/tree.backup.json`))).toMatchObject({
      revision: 1
    });
    expect(JSON.parse(await vault.read(`${FOLDER}/tree.json`))).toMatchObject({
      revision: 2
    });
    expect(vault.paths()).not.toContain(`${FOLDER}/tree.tmp.json`);
  });

  it("treats a verified canonical write as committed when temp cleanup fails", async () => {
    const first = await revision(1);
    const vault = new FakeVault({
      [`${FOLDER}/tree.json`]: JSON.stringify(first)
    });
    const repository = new ConversationRepository({
      exists: (path) => vault.exists(path),
      read: (path) => vault.read(path),
      write: (path, content) => vault.write(path, content),
      process: (path, update) => vault.process(path, update),
      remove: (path) =>
        path.endsWith("/tree.tmp.json")
          ? Promise.reject(new Error("temporary file is locked"))
          : vault.remove(path),
      list: (prefix) => vault.list(prefix)
    });

    const saved = await repository.save(FOLDER, await revision(2), 1);

    expect(saved.revision).toBe(2);
    expect((await repository.load(FOLDER)).conversation.revision).toBe(2);
  });

  it("recovers from a valid backup when canonical JSON is malformed", async () => {
    const backup = await revision(3);
    const vault = new FakeVault({
      [`${FOLDER}/tree.json`]: "{broken",
      [`${FOLDER}/tree.backup.json`]: JSON.stringify(backup)
    });
    const repository = new ConversationRepository(vault);

    const loaded = await repository.load(FOLDER);

    expect(loaded.source).toBe("backup");
    expect(loaded.conversation.revision).toBe(3);
  });

  it("creates a conflict copy instead of overwriting an unexpected revision", async () => {
    const vault = new FakeVault({
      [`${FOLDER}/tree.json`]: JSON.stringify(await revision(2))
    });
    const repository = new ConversationRepository(vault);

    await expect(repository.save(FOLDER, await revision(2), 1)).rejects.toEqual(
      expect.objectContaining<Partial<RepositoryError>>({
        code: "revision-conflict"
      })
    );
    expect(vault.paths()).toContain(`${FOLDER}/tree.conflict-r2.json`);
    expect(JSON.parse(await vault.read(`${FOLDER}/tree.json`))).toMatchObject({
      revision: 2
    });
  });

});
