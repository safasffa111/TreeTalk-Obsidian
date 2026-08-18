import { describe, expect, it } from "vitest";
import {
  relocateVerifiedAnchor,
  type AnchorRelocatorPort
} from "../../src/domain/anchor-relocator";
import type { ConversationFile } from "../../src/domain/types";

const VAULT_ID = "11111111-2222-3333-4444-555555555555";
const CTIME = 1700000000000;

function makeConversation(overrides: Partial<ConversationFile>): ConversationFile {
  return {
    schemaVersion: 1,
    id: "c1",
    title: "t",
    status: "active",
    revision: 0,
    checksum: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    rootNodeId: "r",
    currentNodeId: "r",
    nodes: {
      r: {
        id: "r",
        parentId: null,
        childIds: [],
        title: "t",
        titleSource: "question",
        messages: [],
        draft: { text: "", mode: "continue", selectionContexts: [] },
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }
    },
    ui: { expandedNodeIds: [], treeScrollTop: 0, messageScrollTopByNode: {} },
    ...overrides
  };
}

describe("relocateVerifiedAnchor", () => {
  it("returns the original anchor unchanged when the current path resolves and ctime matches", async () => {
    const conversation = makeConversation({
      anchorVaultId: VAULT_ID,
      anchorFilePath: "Notes/a.md",
      anchorFileCtime: CTIME
    });
    const port: AnchorRelocatorPort = {
      resolveCurrentPath: async () => "Notes/a.md",
      getCtime: async () => CTIME,
      findCandidatesByCtime: async () => []
    };
    const result = await relocateVerifiedAnchor(conversation, port);
    expect(result.kind).toBe("unchanged");
    expect(result.conversation.anchorFilePath).toBe("Notes/a.md");
    expect(result.conversation.revision).toBe(0);
  });

  it("rewrites the stored path when an exact ctime match is found uniquely", async () => {
    const conversation = makeConversation({
      anchorVaultId: VAULT_ID,
      anchorFilePath: "Notes/a.md",
      anchorFileCtime: CTIME,
      revision: 3
    });
    const port: AnchorRelocatorPort = {
      resolveCurrentPath: async () => undefined,
      getCtime: async () => undefined,
      findCandidatesByCtime: async () => ["Notes/only.md"]
    };
    const result = await relocateVerifiedAnchor(conversation, port);
    expect(result.kind).toBe("relocated");
    expect(result.conversation.anchorFilePath).toBe("Notes/only.md");
    expect(result.conversation.revision).toBe(4);
    expect(result.conversation.updatedAt).not.toBe("2026-01-01T00:00:00.000Z");
  });

  it("marks the anchor ambiguous when multiple candidates share the ctime", async () => {
    const conversation = makeConversation({
      anchorVaultId: VAULT_ID,
      anchorFilePath: "Notes/a.md",
      anchorFileCtime: CTIME
    });
    const port: AnchorRelocatorPort = {
      resolveCurrentPath: async () => undefined,
      getCtime: async () => undefined,
      findCandidatesByCtime: async () => ["Notes/b.md", "Notes/c.md"]
    };
    const result = await relocateVerifiedAnchor(conversation, port);
    expect(result.kind).toBe("ambiguous");
    expect(result.conversation.anchorFilePath).toBe("Notes/a.md");
  });

  it("marks the anchor missing when no candidate is found", async () => {
    const conversation = makeConversation({
      anchorVaultId: VAULT_ID,
      anchorFilePath: "Notes/a.md",
      anchorFileCtime: CTIME
    });
    const port: AnchorRelocatorPort = {
      resolveCurrentPath: async () => undefined,
      getCtime: async () => undefined,
      findCandidatesByCtime: async () => []
    };
    const result = await relocateVerifiedAnchor(conversation, port);
    expect(result.kind).toBe("missing");
  });

  it("ignores anchors without the verified triple (legacy)", async () => {
    const conversation = makeConversation({ anchorFilePath: "Legacy/n.md" });
    const port: AnchorRelocatorPort = {
      resolveCurrentPath: async () => "Legacy/n.md",
      getCtime: async () => CTIME,
      findCandidatesByCtime: async () => []
    };
    const result = await relocateVerifiedAnchor(conversation, port);
    expect(result.kind).toBe("skipped");
    expect(result.conversation.anchorFilePath).toBe("Legacy/n.md");
  });

  it("skips a complete triple whose stored path is not Vault-relative Markdown", async () => {
    const conversation = makeConversation({
      anchorVaultId: VAULT_ID,
      anchorFilePath: "attachments/scan.pdf",
      anchorFileCtime: CTIME
    });
    const port: AnchorRelocatorPort = {
      resolveCurrentPath: async () => "attachments/scan.pdf",
      getCtime: async () => CTIME,
      findCandidatesByCtime: async () => ["Notes/recovered.md"]
    };
    await expect(relocateVerifiedAnchor(conversation, port)).resolves.toMatchObject({
      kind: "skipped",
      conversation
    });
  });

  it("updates path when current path resolves but ctime mismatches and a unique candidate exists", async () => {
    const conversation = makeConversation({
      anchorVaultId: VAULT_ID,
      anchorFilePath: "Notes/old.md",
      anchorFileCtime: CTIME
    });
    const port: AnchorRelocatorPort = {
      resolveCurrentPath: async () => "Notes/old.md",
      getCtime: async () => CTIME + 1,
      findCandidatesByCtime: async () => ["Notes/new.md"]
    };
    const result = await relocateVerifiedAnchor(conversation, port);
    expect(result.kind).toBe("relocated");
    expect(result.conversation.anchorFilePath).toBe("Notes/new.md");
  });
});
