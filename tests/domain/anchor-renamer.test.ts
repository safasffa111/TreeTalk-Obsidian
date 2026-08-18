import { describe, expect, it, vi } from "vitest";
import {
  AnchorRenamer,
  type AnchorRenamerStore,
  type StoredAnchorRecord
} from "../../src/domain/anchor-renamer";
import { createConversation } from "../../src/domain/conversation-factory";
import type { ConversationFile } from "../../src/domain/types";
import { NOW } from "../fixtures";

const VAULT_ID = "11111111-2222-3333-4444-555555555555";
const CTIME = 1700000000000;

function makeStored(): StoredAnchorRecord {
  return {
    conversationId: "c1",
    folder: ".obsidian/treetalk-data/active/c1",
    anchorFilePath: "Notes/a.md",
    observedAnchorFilePath: "Notes/a.md",
    anchorVaultId: VAULT_ID,
    observedAnchorVaultId: VAULT_ID,
    anchorFileCtime: CTIME,
    observedAnchorFileCtime: CTIME,
    revision: 1
  };
}

function openConversation(): ConversationFile {
  return createConversation();
}

describe("AnchorRenamer.applyExactRename", () => {
  it("rewrites stored anchors whose file path matches exactly", async () => {
    const stored = [makeStored()];
    const renamer = new AnchorRenamer({
      loadStored: async () => stored,
      saveStored: async () => undefined,
      skipOpenConversationIds: new Set()
    });
    const result = await renamer.applyExactRename("Notes/a.md", "Notes/b.md", NOW, VAULT_ID);
    expect(result).not.toBeNull();
    expect(result?.updates).toEqual([
      expect.objectContaining({
        previousPath: "Notes/a.md",
        nextPath: "Notes/b.md"
      })
    ]);
    expect(stored[0]?.anchorFilePath).toBe("Notes/b.md");
  });

  it("does not report or mutate an update when the fresh save rejects a stale observed anchor", async () => {
    const stored = [makeStored()];
    const saveStored = vi.fn(async () => "stale" as const);
    const renamer = new AnchorRenamer({
      loadStored: async () => stored,
      saveStored,
      skipOpenConversationIds: new Set()
    });

    const result = await renamer.applyExactRename("Notes/a.md", "Notes/b.md", NOW, VAULT_ID);

    expect(saveStored).toHaveBeenCalledOnce();
    expect(result).toBeNull();
    expect(stored[0]?.anchorFilePath).toBe("Notes/a.md");
  });

  it("returns null when no stored anchor matches", async () => {
    const stored = [makeStored()];
    const renamer = new AnchorRenamer({
      loadStored: async () => stored,
      saveStored: async () => undefined,
      skipOpenConversationIds: new Set()
    });
    const result = await renamer.applyExactRename("Other/x.md", "Other/y.md", NOW);
    expect(result).toBeNull();
    expect(stored[0]?.anchorFilePath).toBe("Notes/a.md");
  });

  it("does not save a same-path foreign stored anchor", async () => {
    const foreign = { ...makeStored(), anchorVaultId: "foreign-vault" };
    const saveStored = vi.fn(async () => undefined);
    const renamer = new AnchorRenamer({
      loadStored: async () => [foreign],
      saveStored,
      skipOpenConversationIds: new Set()
    });

    const result = await renamer.applyExactRename(
      "Notes/a.md",
      "Notes/b.md",
      NOW,
      VAULT_ID
    );

    expect(result).toBeNull();
    expect(foreign.anchorFilePath).toBe("Notes/a.md");
    expect(foreign.revision).toBe(1);
    expect(saveStored).not.toHaveBeenCalled();
  });

  it("skips open conversation IDs and does not save them", async () => {
    const stored = [makeStored()];
    const saveStored = vi.fn(async () => undefined);
    const renamer = new AnchorRenamer({
      loadStored: async () => stored,
      saveStored,
      skipOpenConversationIds: new Set(["c1"])
    });
    const result = await renamer.applyExactRename("Notes/a.md", "Notes/b.md", NOW, VAULT_ID);
    expect(result?.updates).toEqual([]);
    expect(saveStored).not.toHaveBeenCalled();
  });
});

describe("AnchorRenamer.applyFolderMove", () => {
  it("rewrites stored anchors whose file path is under the moved folder", async () => {
    const stored = [makeStored()];
    const renamer = new AnchorRenamer({
      loadStored: async () => stored,
      saveStored: async () => undefined,
      skipOpenConversationIds: new Set()
    });
    const result = await renamer.applyFolderMove("Notes", "Archive/Notes", NOW, VAULT_ID);
    expect(result?.updates).toHaveLength(1);
    expect(stored[0]?.anchorFilePath).toBe("Archive/Notes/a.md");
  });

  it("does not rewrite stored anchors outside the folder", async () => {
    const stored = [makeStored()];
    const renamer = new AnchorRenamer({
      loadStored: async () => stored,
      saveStored: async () => undefined,
      skipOpenConversationIds: new Set()
    });
    const result = await renamer.applyFolderMove("Other", "Archive/Other", NOW);
    expect(result?.updates ?? []).toEqual([]);
    expect(stored[0]?.anchorFilePath).toBe("Notes/a.md");
  });

  it("skips an invalid record and continues with valid stored anchors", async () => {
    const good = makeStored();
    const bad: StoredAnchorRecord = {
      ...makeStored(),
      conversationId: "c2",
      folder: ".obsidian/treetalk-data/active/c2",
      anchorFilePath: null as unknown as string
    };
    const stored = [good, bad];
    const errors: unknown[] = [];
    const renamer = new AnchorRenamer({
      loadStored: async () => stored,
      saveStored: async (record) => {
        if (record.anchorFilePath === null) {
          throw new Error("save failure");
        }
        return undefined;
      },
      skipOpenConversationIds: new Set(),
      onError: (error) => errors.push(error)
    });
    const result = await renamer.applyExactRename("Notes/a.md", "Notes/b.md", NOW, VAULT_ID);
    expect(result?.updates.map((u) => u.nextPath)).toContain("Notes/b.md");
    expect(errors).toEqual([]);
  });
});

describe("AnchorRenamer.open conversation path updates", () => {
  function withAnchor(overrides: Partial<ConversationFile>): ConversationFile {
    const base = openConversation();
    return { ...structuredClone(base) as ConversationFile, ...overrides };
  }

  it("updates open conversations in place via the provided mutator", async () => {
    const open: ConversationFile[] = [
      withAnchor({
        anchorVaultId: VAULT_ID,
        anchorFilePath: "Notes/a.md",
        anchorFileCtime: CTIME
      })
    ];
    const renamer = new AnchorRenamer({
      loadStored: async () => [],
      saveStored: async () => undefined,
      skipOpenConversationIds: new Set()
    });
    await renamer.applyExactRenameToOpen(open, "Notes/a.md", "Notes/b.md", VAULT_ID);
    expect(open[0]?.anchorFilePath).toBe("Notes/b.md");
  });

  it("updates folder prefix in open conversations", async () => {
    const open: ConversationFile[] = [
      withAnchor({
        anchorVaultId: VAULT_ID,
        anchorFilePath: "Notes/sub/note.md",
        anchorFileCtime: CTIME
      })
    ];
    const renamer = new AnchorRenamer({
      loadStored: async () => [],
      saveStored: async () => undefined,
      skipOpenConversationIds: new Set()
    });
    await renamer.applyFolderMoveToOpen(open, "Notes", "Archive/Notes", VAULT_ID);
    expect(open[0]?.anchorFilePath).toBe("Archive/Notes/sub/note.md");
  });

  it("keeps a concurrent second rename from loading until the first operation releases", async () => {
    let releaseFirstLoad: (() => void) | undefined;
    const firstLoadGate = new Promise<void>((resolve) => {
      releaseFirstLoad = resolve;
    });
    let loadCalls = 0;
    let active = 0;
    let maxConcurrent = 0;
    const renamer = new AnchorRenamer({
      loadStored: async () => {
        loadCalls += 1;
        active += 1;
        maxConcurrent = Math.max(maxConcurrent, active);
        if (loadCalls === 1) await firstLoadGate;
        active -= 1;
        return [];
      },
      saveStored: async () => undefined,
      skipOpenConversationIds: new Set()
    });

    const first = renamer.applyExactRename("Notes/a.md", "Notes/b.md", NOW);
    const second = renamer.applyFolderMove("Notes", "Archive/Notes", NOW);
    await Promise.resolve();

    expect(loadCalls).toBe(1);
    expect(maxConcurrent).toBe(1);
    releaseFirstLoad?.();
    await Promise.all([first, second]);
    expect(loadCalls).toBe(2);
    expect(maxConcurrent).toBe(1);
  });

  it("runs the next queued rename after an operation rejects", async () => {
    let calls = 0;
    const renamer = new AnchorRenamer({
      loadStored: async () => {
        calls += 1;
        if (calls === 1) throw new Error("first load fails");
        return [];
      },
      saveStored: async () => undefined,
      skipOpenConversationIds: new Set()
    });

    await expect(renamer.applyExactRename("Notes/a.md", "Notes/b.md", NOW)).rejects.toThrow(
      "first load fails"
    );
    await expect(renamer.applyFolderMove("Notes", "Archive/Notes", NOW)).resolves.toBeNull();
    expect(calls).toBe(2);
  });
});

describe("AnchorRenamer pending anchors", () => {
  it("records a pending anchor by file path and clears after first message lock", async () => {
    const renamer = new AnchorRenamer({
      loadStored: async () => [],
      saveStored: async () => undefined,
      skipOpenConversationIds: new Set()
    });
    renamer.setPending("tab-1", "Notes/a.md");
    expect(renamer.getPending("tab-1")).toBe("Notes/a.md");
    renamer.clearPending("tab-1");
    expect(renamer.getPending("tab-1")).toBeUndefined();
  });

  it("remaps pending anchors on rename", async () => {
    const renamer = new AnchorRenamer({
      loadStored: async () => [],
      saveStored: async () => undefined,
      skipOpenConversationIds: new Set()
    });
    renamer.setPending("tab-1", "Notes/a.md");
    renamer.setPending("tab-2", "Notes/sub/note.md");
    await renamer.applyFolderMove("Notes", "Archive/Notes", NOW);
    expect(renamer.getPending("tab-1")).toBe("Archive/Notes/a.md");
    expect(renamer.getPending("tab-2")).toBe("Archive/Notes/sub/note.md");
  });

  it("remaps pending anchor on exact rename", async () => {
    const renamer = new AnchorRenamer({
      loadStored: async () => [],
      saveStored: async () => undefined,
      skipOpenConversationIds: new Set()
    });
    renamer.setPending("tab-1", "Notes/a.md");
    await renamer.applyExactRename("Notes/a.md", "Notes/b.md", NOW);
    expect(renamer.getPending("tab-1")).toBe("Notes/b.md");
  });
});

// AnchorRenamer must export a constructor that accepts AnchorRenamerStore.
function _typecheck(): AnchorRenamerStore {
  return {
    loadStored: async () => [],
    saveStored: async () => undefined,
    skipOpenConversationIds: new Set()
  };
}
void _typecheck;
