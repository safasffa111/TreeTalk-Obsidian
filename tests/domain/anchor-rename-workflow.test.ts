import { describe, expect, it, vi } from "vitest";
import { AnchorRenameWorkflow } from "../../src/domain/anchor-rename-workflow";
import {
  AnchorRenamer,
  type StoredAnchorRecord
} from "../../src/domain/anchor-renamer";
import { createConversation } from "../../src/domain/conversation-factory";
import type { ConversationFile } from "../../src/domain/types";
import { NOW } from "../fixtures";

const VAULT_ID = "11111111-2222-3333-4444-555555555555";
const CTIME = 1700000000000;

function stored(id: string, path: string): StoredAnchorRecord {
  return {
    conversationId: id,
    folder: `.obsidian/treetalk-data/active/${id}`,
    anchorFilePath: path,
    observedAnchorFilePath: path,
    anchorVaultId: VAULT_ID,
    observedAnchorVaultId: VAULT_ID,
    anchorFileCtime: CTIME,
    observedAnchorFileCtime: CTIME,
    revision: 1
  };
}

function open(path: string): ConversationFile {
  return {
    ...createConversation(),
    anchorFilePath: path,
    anchorVaultId: VAULT_ID,
    anchorFileCtime: CTIME
  };
}

describe("AnchorRenameWorkflow", () => {
  it("treats a file rename as exact without remapping unrelated siblings", async () => {
    const records = [stored("a", "Notes/a.md"), stored("other", "Notes/other.md")];
    const renamer = new AnchorRenamer({
      loadStored: async () => records,
      saveStored: async () => undefined,
      skipOpenConversationIds: new Set()
    });
    const openConversations = [open("Notes/a.md"), open("Notes/other.md")];
    const workflow = new AnchorRenameWorkflow(renamer, VAULT_ID);

    const result = await workflow.apply(
      { kind: "file", oldPath: "Notes/a.md", newPath: "Archive/a.md" },
      () => openConversations,
      NOW
    );

    expect(records.map((record) => record.anchorFilePath)).toEqual([
      "Archive/a.md",
      "Notes/other.md"
    ]);
    expect(result.openConversations.map((conversation) => conversation.anchorFilePath)).toEqual([
      "Archive/a.md",
      "Notes/other.md"
    ]);
  });

  it("remaps every pending, stored, and open anchor below a folder rename", async () => {
    const records = [stored("a", "Notes/a.md")];
    const renamer = new AnchorRenamer({
      loadStored: async () => records,
      saveStored: async () => undefined,
      skipOpenConversationIds: new Set()
    });
    renamer.setPending("tab", "Notes/pending.md");
    const openConversations = [open("Notes/open.md")];
    const workflow = new AnchorRenameWorkflow(renamer, VAULT_ID);

    const result = await workflow.apply(
      { kind: "folder", oldPath: "Notes", newPath: "Archive/Notes" },
      () => openConversations,
      NOW
    );

    expect(renamer.getPending("tab")).toBe("Archive/Notes/pending.md");
    expect(records[0]?.anchorFilePath).toBe("Archive/Notes/a.md");
    expect(result.openConversations[0]?.anchorFilePath).toBe("Archive/Notes/open.md");
  });

  it("does not mutate frozen store conversations while preparing persisted open updates", async () => {
    const renamer = new AnchorRenamer({
      loadStored: async () => [],
      saveStored: async () => undefined,
      skipOpenConversationIds: new Set()
    });
    const conversation = Object.freeze(open("Notes/a.md"));
    const workflow = new AnchorRenameWorkflow(renamer, VAULT_ID);

    const result = await workflow.apply(
      { kind: "file", oldPath: "Notes/a.md", newPath: "Notes/b.md" },
      () => [conversation],
      NOW
    );

    expect(conversation.anchorFilePath).toBe("Notes/a.md");
    expect(result.openConversations[0]?.anchorFilePath).toBe("Notes/b.md");
  });

  it("keeps complete PDF stored and open triples unchanged when a file rename ends in Markdown", async () => {
    const records = [stored("pdf", "attachments/scan.pdf")];
    const saveStored = vi.fn(async () => undefined);
    const renamer = new AnchorRenamer({
      loadStored: async () => records,
      saveStored,
      skipOpenConversationIds: new Set()
    });
    const pdfOpen = open("attachments/scan.pdf");
    const workflow = new AnchorRenameWorkflow(renamer, VAULT_ID);

    const result = await workflow.apply(
      {
        kind: "file",
        oldPath: "attachments/scan.pdf",
        newPath: "attachments/scan.md"
      },
      () => [pdfOpen],
      NOW
    );

    expect(saveStored).not.toHaveBeenCalled();
    expect(result.stored).toBeNull();
    expect(records[0]).toMatchObject({
      anchorFilePath: "attachments/scan.pdf",
      revision: 1
    });
    expect(result.openConversations[0]).toMatchObject({
      anchorFilePath: "attachments/scan.pdf",
      revision: 0
    });
  });

  it("does not upgrade invalid stored or open paths through a folder rename", async () => {
    const records = [stored("pdf", "attachments/scan.pdf")];
    const saveStored = vi.fn(async () => undefined);
    const renamer = new AnchorRenamer({
      loadStored: async () => records,
      saveStored,
      skipOpenConversationIds: new Set()
    });
    const pdfOpen = open("attachments/scan.pdf");
    const workflow = new AnchorRenameWorkflow(renamer, VAULT_ID);

    const result = await workflow.apply(
      { kind: "folder", oldPath: "attachments", newPath: "Archive/attachments" },
      () => [pdfOpen],
      NOW
    );

    expect(saveStored).not.toHaveBeenCalled();
    expect(result.stored).toBeNull();
    expect(records[0]).toMatchObject({
      anchorFilePath: "attachments/scan.pdf",
      revision: 1
    });
    expect(result.openConversations[0]).toMatchObject({
      anchorFilePath: "attachments/scan.pdf",
      revision: 0
    });
  });

  it("does not rewrite a same-path foreign open anchor", async () => {
    const saveStored = async (): Promise<undefined> => undefined;
    const renamer = new AnchorRenamer({
      loadStored: async () => [],
      saveStored,
      skipOpenConversationIds: new Set()
    });
    const foreign = open("Notes/a.md");
    foreign.anchorVaultId = "foreign-vault";
    const workflow = new AnchorRenameWorkflow(renamer, VAULT_ID);

    const result = await workflow.apply(
      { kind: "file", oldPath: "Notes/a.md", newPath: "Notes/b.md" },
      () => [foreign],
      NOW
    );

    expect(foreign.anchorFilePath).toBe("Notes/a.md");
    expect(foreign.revision).toBe(0);
    expect(result.openConversations[0]?.anchorFilePath).toBe("Notes/a.md");
    expect(result.openConversations[0]?.revision).toBe(0);
  });

  it("does not start a second event until the first stored and open phases finish", async () => {
    let releaseFirstOpen: (() => void) | undefined;
    let markFirstOpenStarted: (() => void) | undefined;
    const firstOpenStarted = new Promise<void>((resolve) => {
      markFirstOpenStarted = resolve;
    });
    const firstOpenGate = new Promise<void>((resolve) => {
      releaseFirstOpen = resolve;
    });
    const events: string[] = [];
    let saves = 0;
    const records = [stored("a", "Notes/a.md")];
    const renamer = new AnchorRenamer({
      loadStored: async () => records,
      saveStored: async () => {
        saves += 1;
        events.push(`stored-${String(saves)}`);
        return undefined;
      },
      skipOpenConversationIds: new Set()
    });
    let openPhases = 0;
    vi.spyOn(renamer, "applyExactRenameToOpen").mockImplementation(async () => {
      openPhases += 1;
      events.push(`open-start-${String(openPhases)}`);
      if (openPhases === 1) {
        markFirstOpenStarted?.();
        await firstOpenGate;
      }
      events.push(`open-finish-${String(openPhases)}`);
    });
    const workflow = new AnchorRenameWorkflow(renamer, VAULT_ID);
    const openConversations = [open("Notes/a.md")];

    const first = workflow.apply(
      { kind: "file", oldPath: "Notes/a.md", newPath: "Notes/b.md" },
      () => openConversations,
      NOW
    );
    await firstOpenStarted;
    const second = workflow.apply(
      { kind: "file", oldPath: "Notes/b.md", newPath: "Notes/c.md" },
      () => openConversations,
      NOW
    );
    await Promise.resolve();

    expect(events).toEqual(["stored-1", "open-start-1"]);
    releaseFirstOpen?.();
    await Promise.all([first, second]);
    expect(events).toEqual([
      "stored-1",
      "open-start-1",
      "open-finish-1",
      "stored-2",
      "open-start-2",
      "open-finish-2"
    ]);
  });

  it("reads open conversations inside the serialized operation so B→C does not reuse stale A", async () => {
    let releaseFirstOpen: (() => void) | undefined;
    let markFirstOpenStarted: (() => void) | undefined;
    const firstOpenStarted = new Promise<void>((resolve) => {
      markFirstOpenStarted = resolve;
    });
    const firstOpenGate = new Promise<void>((resolve) => {
      releaseFirstOpen = resolve;
    });
    const records = [stored("a", "Notes/a.md")];
    const renamer = new AnchorRenamer({
      loadStored: async () => records,
      saveStored: async () => undefined,
      skipOpenConversationIds: new Set()
    });
    let latest = [open("Notes/a.md")];
    let openPhases = 0;
    vi.spyOn(renamer, "applyExactRenameToOpen").mockImplementation(async (conversations) => {
      openPhases += 1;
      if (openPhases === 1) {
        markFirstOpenStarted?.();
        await firstOpenGate;
        latest = [open("Notes/b.md")];
      }
      const conversation = conversations[0];
      if (conversation !== undefined) {
        conversation.anchorFilePath = openPhases === 1 ? "Notes/b.md" : "Notes/c.md";
      }
    });
    const workflow = new AnchorRenameWorkflow(renamer, VAULT_ID);

    const first = workflow.apply(
      { kind: "file", oldPath: "Notes/a.md", newPath: "Notes/b.md" },
      () => latest,
      NOW
    );
    await firstOpenStarted;
    const second = workflow.apply(
      { kind: "file", oldPath: "Notes/b.md", newPath: "Notes/c.md" },
      () => latest,
      NOW
    );
    releaseFirstOpen?.();
    const [, secondResult] = await Promise.all([first, second]);

    expect(records[0]?.anchorFilePath).toBe("Notes/c.md");
    expect(secondResult.openConversations[0]?.anchorFilePath).toBe("Notes/c.md");
  });
});