import { describe, expect, it } from "vitest";
import {
  AnchorCaptureError,
  KnowledgeCaptureService
} from "../../src/knowledge/capture-service";
import type { ConversationFile } from "../../src/domain/types";
import type { AnchorStatus } from "../../src/domain/anchor-status";
import { continueNode } from "../../src/domain/tree-commands";
import { createConversation } from "../../src/domain/conversation-factory";
import { NOW } from "../fixtures";
import { FakeVault } from "../storage/fake-vault";

const VAULT_ID = "11111111-2222-3333-4444-555555555555";
const CTIME = 1700000000000;

function withAnchorTriple(): ConversationFile {
  const before = createConversation();
  return continueNode(before, {
    nodeId: before.rootNodeId,
    text: "首条问题",
    messageId: "m1",
    now: NOW,
    anchorVaultId: VAULT_ID,
    anchorFilePath: "Notes/design.md",
    anchorFileCtime: CTIME
  }).state;
}

function withLegacyAnchor(): ConversationFile {
  const before = createConversation();
  return continueNode(before, {
    nodeId: before.rootNodeId,
    text: "旧数据",
    messageId: "m1",
    now: NOW,
    anchorFilePath: "Legacy/note.md"
  }).state;
}

describe("KnowledgeCaptureService anchor preflight", () => {
  it("captures to the verified anchor's <anchorStem>-tree root directory", async () => {
    const vault = new FakeVault({
      "Notes/design.md": "design body"
    });
    const conversation = withAnchorTriple();
    const resolver = (): AnchorStatus => ({
      kind: "verified",
      vaultId: VAULT_ID,
      filePath: "Notes/design.md",
      fileCtime: CTIME
    });
    const service = new KnowledgeCaptureService(
      vault,
      "TreeTalk 知识",
      "TreeTalk",
      { anchorStatusResolver: resolver }
    );
    const indexPath = await service.capture(
      { scope: "tree", conversation },
      NOW
    );
    expect(indexPath).toMatch(/^Notes\/design-tree\/.+\/节点列表\.md$/u);
    expect(vault.paths().some((p) => p.startsWith("Notes/design-tree/"))).toBe(true);
  });

  it("uses the resolved verified path even after rename", async () => {
    const vault = new FakeVault({
      "Projects/system-design.md": "new name"
    });
    const conversation = withAnchorTriple();
    const resolver = (): AnchorStatus => ({
      kind: "verified",
      vaultId: VAULT_ID,
      filePath: "Projects/system-design.md",
      fileCtime: CTIME
    });
    const service = new KnowledgeCaptureService(
      vault,
      "TreeTalk 知识",
      "TreeTalk",
      { anchorStatusResolver: resolver }
    );
    const indexPath = await service.capture(
      { scope: "tree", conversation },
      NOW
    );
    expect(indexPath).toMatch(/^Projects\/system-design-tree\/.+\/节点列表\.md$/u);
  });

  it.each([
    ["foreign", { kind: "foreign-vault" } as AnchorStatus, "anchor-foreign-vault"],
    ["legacy", { kind: "legacy-unverified" } as AnchorStatus, "anchor-legacy-unverified"],
    ["missing", { kind: "missing" } as AnchorStatus, "anchor-missing"],
    ["ambiguous", { kind: "ambiguous" } as AnchorStatus, "anchor-ambiguous"]
  ])(
    "rejects %s anchor capture with zero writes for both answer and tree",
    async (_kind, status, code) => {
      for (const scope of ["answer", "tree"] as const) {
        const vault = new FakeVault();
        const conversation = structuredClone(withAnchorTriple()) as ConversationFile;
        const service = new KnowledgeCaptureService(
          vault,
          "TreeTalk 知识",
          "TreeTalk",
          { anchorStatusResolver: () => status }
        );
        const request =
          scope === "answer"
            ? (() => {
                const node = conversation.nodes[conversation.currentNodeId];
                if (node === undefined) throw new Error("Missing current node");
                node.messages.push({
                  id: "answer",
                  role: "assistant",
                  content: "answer",
                  status: "complete",
                  createdAt: NOW,
                  updatedAt: NOW
                });
                return {
                  scope,
                  conversation,
                  nodeId: node.id,
                  messageId: "answer"
                };
              })()
            : { scope, conversation };

        await expect(service.capture(request, NOW)).rejects.toMatchObject({ code });
        expect(vault.paths()).toEqual([]);
      }
    }
  );

  it("rejects a non-Markdown verified resolver result with zero writes for both answer and tree", async () => {
    for (const scope of ["answer", "tree"] as const) {
      const vault = new FakeVault();
      const conversation = structuredClone(withAnchorTriple()) as ConversationFile;
      const service = new KnowledgeCaptureService(vault, "TreeTalk 知识", "TreeTalk", {
        anchorStatusResolver: () => ({
          kind: "verified",
          vaultId: VAULT_ID,
          filePath: "attachments/scan.pdf",
          fileCtime: CTIME
        })
      });
      const request =
        scope === "answer"
          ? (() => {
              const node = conversation.nodes[conversation.currentNodeId];
              if (node === undefined) throw new Error("Missing current node");
              node.messages.push({
                id: "answer",
                role: "assistant",
                content: "answer",
                status: "complete",
                createdAt: NOW,
                updatedAt: NOW
              });
              return { scope, conversation, nodeId: node.id, messageId: "answer" };
            })()
          : { scope, conversation };
      await expect(service.capture(request, NOW)).rejects.toBeInstanceOf(AnchorCaptureError);
      expect(vault.paths()).toEqual([]);
    }
  });

  it("rejects capture with zero writes when anchor is foreign", async () => {
    const vault = new FakeVault();
    const conversation = withAnchorTriple();
    const resolver = (): AnchorStatus => ({ kind: "foreign-vault" });
    const service = new KnowledgeCaptureService(
      vault,
      "TreeTalk 知识",
      "TreeTalk",
      { anchorStatusResolver: resolver }
    );
    await expect(
      service.capture({ scope: "tree", conversation }, NOW)
    ).rejects.toBeInstanceOf(AnchorCaptureError);
    expect(vault.paths()).toEqual([]);
  });

  it("rejects capture with zero writes when anchor is missing", async () => {
    const vault = new FakeVault();
    const conversation = withAnchorTriple();
    const resolver = (): AnchorStatus => ({ kind: "missing" });
    const service = new KnowledgeCaptureService(
      vault,
      "TreeTalk 知识",
      "TreeTalk",
      { anchorStatusResolver: resolver }
    );
    await expect(
      service.capture({ scope: "tree", conversation }, NOW)
    ).rejects.toMatchObject({ code: "anchor-missing" });
    expect(vault.paths()).toEqual([]);
  });

  it("rejects capture with zero writes when anchor is ambiguous", async () => {
    const vault = new FakeVault();
    const conversation = withAnchorTriple();
    const resolver = (): AnchorStatus => ({ kind: "ambiguous" });
    const service = new KnowledgeCaptureService(
      vault,
      "TreeTalk 知识",
      "TreeTalk",
      { anchorStatusResolver: resolver }
    );
    await expect(
      service.capture({ scope: "tree", conversation }, NOW)
    ).rejects.toMatchObject({ code: "anchor-ambiguous" });
    expect(vault.paths()).toEqual([]);
  });

  it("rejects capture with zero writes for legacy-unverified anchors", async () => {
    const vault = new FakeVault();
    const conversation = withLegacyAnchor();
    const resolver = (): AnchorStatus => ({ kind: "legacy-unverified" });
    const service = new KnowledgeCaptureService(
      vault,
      "TreeTalk 知识",
      "TreeTalk",
      { anchorStatusResolver: resolver }
    );
    await expect(
      service.capture({ scope: "tree", conversation }, NOW)
    ).rejects.toMatchObject({ code: "anchor-legacy-unverified" });
    expect(vault.paths()).toEqual([]);
  });

  it("falls back to treeCaptureFolder when anchor status is none", async () => {
    const vault = new FakeVault();
    const conversation = createConversation();
    const resolver = (): AnchorStatus => ({ kind: "none" });
    const service = new KnowledgeCaptureService(
      vault,
      "TreeTalk 知识",
      "TreeTalk",
      { anchorStatusResolver: resolver }
    );
    const indexPath = await service.capture(
      { scope: "tree", conversation },
      NOW
    );
    expect(indexPath).toMatch(/^TreeTalk\/.+\/节点列表\.md$/u);
  });

  it("groups multiple verified sessions under the same <anchorStem>-tree root", async () => {
    const vault = new FakeVault();
    const resolver = (): AnchorStatus => ({
      kind: "verified",
      vaultId: VAULT_ID,
      filePath: "Projects/design.md",
      fileCtime: CTIME
    });
    const service = new KnowledgeCaptureService(
      vault,
      "TreeTalk 知识",
      "TreeTalk",
      { anchorStatusResolver: resolver }
    );
    const a = withAnchorTriple();
    const b = withAnchorTriple();
    const aId = a.id;
    const bId = b.id;
    void aId;
    void bId;
    const idxA = await service.capture({ scope: "tree", conversation: a }, NOW);
    const idxB = await service.capture({ scope: "tree", conversation: b }, NOW);
    expect(idxA.startsWith("Projects/design-tree/")).toBe(true);
    expect(idxB.startsWith("Projects/design-tree/")).toBe(true);
    // 不同对话产生不同子目录；根目录本身相同。
    expect(idxA).not.toBe(idxB);
  });
});
