import { describe, expect, it, vi } from "vitest";
import type { ConversationFile } from "../../src/domain/types";
import type { LoadedConversation } from "../../src/storage/conversation-repository";
import { loadStartupConversations } from "../../src/tabs/startup-conversation-loader";
import { validConversation } from "../fixtures";

function conversation(folder: string): ConversationFile {
  const value = structuredClone(validConversation());
  value.id = folder;
  value.title = folder;
  return value;
}

function loaded(folder: string): LoadedConversation {
  return {
    conversation: conversation(folder),
    source: "canonical"
  };
}

describe("startup conversation loader", () => {
  it("loads with at most four workers and returns input order", async () => {
    const folders = Array.from({ length: 8 }, (_, index) => `folder-${index}`);
    const releases: Array<{ folder: string; release(): void }> = [];
    let activeLoads = 0;
    let maximumActiveLoads = 0;
    const repository = {
      load: vi.fn(async (folder: string) => {
        activeLoads += 1;
        maximumActiveLoads = Math.max(maximumActiveLoads, activeLoads);
        await new Promise<void>((resolve) => {
          releases.push({
            folder,
            release: () => {
              activeLoads -= 1;
              resolve();
            }
          });
        });
        return loaded(folder);
      }),
      save: vi.fn()
    };

    const loading = loadStartupConversations({
      folders,
      repository,
      now: () => "2026-08-10T00:00:00.000Z"
    });
    await vi.waitFor(() => expect(activeLoads).toBe(4));

    for (let completed = 0; completed < folders.length; completed += 1) {
      await vi.waitFor(() => expect(releases.length).toBeGreaterThan(0));
      const pending = releases.pop();
      if (pending === undefined) throw new Error("Load release is missing");
      pending.release();
    }
    const results = await loading;

    expect(maximumActiveLoads).toBe(4);
    expect(results.map((result) => result.folder)).toEqual(folders);
  });

  it("isolates one load failure and preserves the remaining order", async () => {
    const reportLoadError = vi.fn();
    const repository = {
      load: vi.fn((folder: string) =>
        folder === "folder-2"
          ? Promise.reject(new Error("corrupt"))
          : Promise.resolve(loaded(folder))
      ),
      save: vi.fn()
    };

    const results = await loadStartupConversations({
      folders: ["folder-1", "folder-2", "folder-3"],
      repository,
      now: () => "2026-08-10T00:00:00.000Z",
      reportLoadError
    });

    expect(results.map((result) => result.folder)).toEqual([
      "folder-1",
      "folder-3"
    ]);
    expect(reportLoadError).toHaveBeenCalledWith(
      "folder-2",
      expect.objectContaining({ message: "corrupt" })
    );
  });

  it("persists orphaned response recovery", async () => {
    const orphaned = conversation("folder-1");
    orphaned.nodes.child?.messages.push({
      id: "stream",
      role: "assistant",
      content: "partial",
      status: "streaming",
      createdAt: orphaned.createdAt,
      updatedAt: orphaned.updatedAt
    });
    const save = vi.fn(
      (_folder: string, value: ConversationFile) => Promise.resolve(value)
    );

    const results = await loadStartupConversations({
      folders: ["folder-1"],
      repository: {
        load: () =>
          Promise.resolve({ conversation: orphaned, source: "canonical" }),
        save
      },
      now: () => "2026-08-10T00:00:00.000Z"
    });

    expect(save).toHaveBeenCalledWith(
      "folder-1",
      expect.objectContaining({ revision: 2 }),
      1
    );
    expect(
      results[0]?.conversation.nodes.child?.messages[0]?.status
    ).toBe("interrupted");
    expect(results[0]).toMatchObject({
      sourceStatus: "active",
      sourceUpdatedAt: validConversation().updatedAt
    });
  });

  it("keeps recovered memory state when recovery persistence fails", async () => {
    const orphaned = conversation("folder-1");
    orphaned.nodes.child?.messages.push({
      id: "stream",
      role: "assistant",
      content: "partial",
      status: "streaming",
      createdAt: orphaned.createdAt,
      updatedAt: orphaned.updatedAt
    });
    const reportSaveError = vi.fn();

    const results = await loadStartupConversations({
      folders: ["folder-1"],
      repository: {
        load: () =>
          Promise.resolve({ conversation: orphaned, source: "canonical" }),
        save: () => Promise.reject(new Error("write blocked"))
      },
      now: () => "2026-08-10T00:00:00.000Z",
      reportSaveError
    });

    expect(
      results[0]?.conversation.nodes.child?.messages[0]?.status
    ).toBe("interrupted");
    expect(reportSaveError).toHaveBeenCalledWith(
      "folder-1",
      expect.objectContaining({ message: "write blocked" })
    );
  });
});
