import { describe, expect, it } from "vitest";
import { validConversation } from "../fixtures";
import { checksumConversation } from "../../src/storage/checksum";
import { ConversationRepository } from "../../src/storage/conversation-repository";
import { SessionPersistence } from "../../src/storage/session-persistence";
import { FakeVault } from "./fake-vault";

const FIRST = "TreeTalk/活动对话/first--1";
const SECOND = "TreeTalk/历史对话/second--2";

describe("SessionPersistence", () => {
  it("flushes one folder without waiting for an unrelated blocked folder", async () => {
    const savedFolders: string[] = [];
    let releaseSecond: (() => void) | undefined;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const repository = {
      save: async (
        folder: string,
        conversation: ReturnType<typeof validConversation>
      ) => {
        if (folder === SECOND) await secondGate;
        savedFolders.push(folder);
        return conversation;
      }
    };
    const persistence = new SessionPersistence(repository as never);
    const first = structuredClone(validConversation());
    const second = structuredClone(validConversation());
    second.id = "second";
    second.status = "archived";

    persistence.schedule(FIRST, first);
    persistence.schedule(SECOND, second);
    const folderPersistence = persistence as unknown as {
      flush(folder?: string): Promise<void>;
    };

    try {
      const firstFinished = await Promise.race([
        folderPersistence.flush(FIRST).then(() => true),
        new Promise<false>((resolve) => {
          setTimeout(() => resolve(false), 25);
        })
      ]);
      expect(firstFinished).toBe(true);
      expect(savedFolders).toContain(FIRST);
      expect(savedFolders).not.toContain(SECOND);
    } finally {
      releaseSecond?.();
      await persistence.flush();
    }
  });

  it("captures each folder and conversation before a session switch", async () => {
    const initial = structuredClone(validConversation());
    initial.revision = 1;
    initial.checksum = await checksumConversation(initial);
    const vault = new FakeVault({
      [`${FIRST}/tree.json`]: JSON.stringify(initial)
    });
    const persistence = new SessionPersistence(new ConversationRepository(vault));
    persistence.seed(FIRST, 1);

    const firstUpdate = structuredClone(initial);
    firstUpdate.revision = 2;
    firstUpdate.title = "First";
    const history = structuredClone(validConversation());
    history.id = "history";
    history.title = "Second";
    history.status = "archived";
    history.revision = 0;

    persistence.schedule(FIRST, firstUpdate);
    persistence.schedule(SECOND, history);
    await persistence.flush();

    expect(JSON.parse(await vault.read(`${FIRST}/tree.json`))).toMatchObject({
      title: "First",
      revision: 2
    });
    expect(JSON.parse(await vault.read(`${SECOND}/tree.json`))).toMatchObject({
      title: "Second",
      status: "archived"
    });
  });

  it("serializes rapid revisions using the last saved revision per folder", async () => {
    const initial = structuredClone(validConversation());
    initial.checksum = await checksumConversation(initial);
    const vault = new FakeVault({
      [`${FIRST}/tree.json`]: JSON.stringify(initial)
    });
    const persistence = new SessionPersistence(new ConversationRepository(vault));
    persistence.seed(FIRST, initial.revision);
    const second = structuredClone(initial);
    second.revision += 1;
    const third = structuredClone(second);
    third.revision += 1;

    persistence.schedule(FIRST, second);
    persistence.schedule(FIRST, third);
    await persistence.flush();

    expect(JSON.parse(await vault.read(`${FIRST}/tree.json`))).toMatchObject({
      revision: third.revision
    });
  });

  it("redirects a queued save when Obsidian renames the conversation folder", async () => {
    const savedFolders: string[] = [];
    const repository = {
      save: (folder: string, conversation: ReturnType<typeof validConversation>) => {
        savedFolders.push(folder);
        return Promise.resolve(conversation);
      }
    };
    const persistence = new SessionPersistence(repository as never);
    const renamed = "TreeTalk/活动对话/renamed--1";

    persistence.schedule(FIRST, validConversation());
    persistence.renameFolder(FIRST, renamed);
    await persistence.flush();
    const next = structuredClone(validConversation());
    next.revision += 1;
    persistence.schedule(renamed, next);
    persistence.renameFolder(renamed, FIRST);
    await persistence.flush();

    expect(savedFolders).toEqual([renamed, FIRST]);
  });

  it("reports one folder failure without poisoning unrelated folders", async () => {
    const repository = {
      save: (
        folder: string,
        conversation: ReturnType<typeof validConversation>
      ) =>
        folder === FIRST
          ? Promise.reject(new Error("first is locked"))
          : Promise.resolve(conversation)
    };
    const persistence = new SessionPersistence(repository as never);
    const second = structuredClone(validConversation());
    second.id = "second";
    second.status = "archived";

    persistence.schedule(FIRST, validConversation());
    persistence.schedule(SECOND, second);

    await expect(persistence.flush(FIRST)).rejects.toThrow("first is locked");
    await expect(persistence.flush(SECOND)).resolves.toBeUndefined();
  });
});
