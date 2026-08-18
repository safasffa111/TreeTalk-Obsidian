import { describe, expect, it } from "vitest";
import {
  continueNode,
  prepareChildDraft,
  submitChildDraft,
  type ContinueNodeInput,
  type SubmitChildDraftInput
} from "../../src/domain/tree-commands";
import { createConversation } from "../../src/domain/conversation-factory";
import { NOW } from "../fixtures";

const VAULT_ID = "11111111-2222-3333-4444-555555555555";
const FILE_CTIME = 1700000000000;

function anchorTriple(filePath: string) {
  return { anchorVaultId: VAULT_ID, anchorFilePath: filePath, anchorFileCtime: FILE_CTIME };
}

describe("tree commands atomic verified triple", () => {
  it("writes the verified triple atomically on the first continue message", () => {
    const before = createConversation();
    const startRevision = before.revision;
    const result = continueNode(before, {
      nodeId: before.rootNodeId,
      text: "第一条问题",
      messageId: "m1",
      now: NOW,
      ...anchorTriple("Notes/design.md")
    });
    expect(result.state.anchorVaultId).toBe(VAULT_ID);
    expect(result.state.anchorFilePath).toBe("Notes/design.md");
    expect(result.state.anchorFileCtime).toBe(FILE_CTIME);
    expect(result.state.revision).toBe(startRevision + 1);
  });

  it("writes the verified triple on the first submitChildDraft", () => {
    const before = createConversation();
    const prepared = prepareChildDraft(before, {
      nodeId: before.rootNodeId,
      now: NOW
    });
    const submitted = submitChildDraft(prepared, {
      text: "分支首条",
      childId: "child-1",
      messageId: "m1",
      now: NOW,
      ...anchorTriple("Notes/child.md")
    });
    expect(submitted.state.anchorVaultId).toBe(VAULT_ID);
    expect(submitted.state.anchorFilePath).toBe("Notes/child.md");
    expect(submitted.state.anchorFileCtime).toBe(FILE_CTIME);
  });

  it("ignores anchor input when any of the triple fields is missing", () => {
    const before = createConversation();
    const partial: ContinueNodeInput = {
      nodeId: before.rootNodeId,
      text: "首条但缺字段",
      messageId: "m1",
      now: NOW,
      anchorVaultId: VAULT_ID,
      anchorFilePath: "Notes/partial.md"
      // fileCtime 缺失
    };
    const result = continueNode(before, partial);
    expect(result.state.anchorVaultId).toBeUndefined();
    expect(result.state.anchorFilePath).toBeUndefined();
    expect(result.state.anchorFileCtime).toBeUndefined();
  });

  it("does not overwrite or supplement anchor fields on later messages", () => {
    const before = createConversation();
    const first = continueNode(before, {
      nodeId: before.rootNodeId,
      text: "首条",
      messageId: "m1",
      now: NOW,
      ...anchorTriple("Notes/a.md")
    });
    const second = continueNode(first.state, {
      nodeId: first.state.rootNodeId,
      text: "第二条",
      messageId: "m2",
      now: NOW,
      anchorVaultId: "different-vault-id",
      anchorFilePath: "Notes/b.md",
      anchorFileCtime: 1800000000000
    });
    expect(second.state.anchorVaultId).toBe(VAULT_ID);
    expect(second.state.anchorFilePath).toBe("Notes/a.md");
    expect(second.state.anchorFileCtime).toBe(FILE_CTIME);
  });

  it("rejects a non-markdown path even when the triple is otherwise complete", () => {
    const before = createConversation();
    const result = continueNode(before, {
      nodeId: before.rootNodeId,
      text: "首条",
      messageId: "m1",
      now: NOW,
      anchorVaultId: VAULT_ID,
      anchorFilePath: "attachments/scan.pdf",
      anchorFileCtime: FILE_CTIME
    });
    expect(result.state.anchorVaultId).toBeUndefined();
    expect(result.state.anchorFilePath).toBeUndefined();
    expect(result.state.anchorFileCtime).toBeUndefined();
  });

  it("rejects a negative fileCtime without partial writes", () => {
    const before = createConversation();
    const result = continueNode(before, {
      nodeId: before.rootNodeId,
      text: "首条",
      messageId: "m1",
      now: NOW,
      anchorVaultId: VAULT_ID,
      anchorFilePath: "Notes/neg.md",
      anchorFileCtime: -1
    });
    expect(result.state.anchorFilePath).toBeUndefined();
    expect(result.state.anchorVaultId).toBeUndefined();
    expect(result.state.anchorFileCtime).toBeUndefined();
  });

  it("supports legacy path-only anchor when vaultId/ctime are not provided", () => {
    const before = createConversation();
    const result = continueNode(before, {
      nodeId: before.rootNodeId,
      text: "旧式锚点",
      messageId: "m1",
      now: NOW,
      anchorFilePath: "Legacy/note.md"
    } satisfies ContinueNodeInput);
    expect(result.state.anchorFilePath).toBe("Legacy/note.md");
    expect(result.state.anchorVaultId).toBeUndefined();
    expect(result.state.anchorFileCtime).toBeUndefined();
  });

  it("submitChildDraft without verified triple writes nothing", () => {
    const before = createConversation();
    const prepared = prepareChildDraft(before, {
      nodeId: before.rootNodeId,
      now: NOW
    });
    const submitted = submitChildDraft(prepared, {
      text: "分支",
      childId: "child-2",
      messageId: "m1",
      now: NOW
    } satisfies SubmitChildDraftInput);
    expect(submitted.state.anchorFilePath).toBeUndefined();
    expect(submitted.state.anchorVaultId).toBeUndefined();
    expect(submitted.state.anchorFileCtime).toBeUndefined();
  });
});
