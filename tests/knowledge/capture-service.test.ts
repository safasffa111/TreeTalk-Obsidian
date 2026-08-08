import { describe, expect, it } from "vitest";
import {
  KnowledgeCaptureService,
  type KnowledgeCaptureRequest
} from "../../src/knowledge/capture-service";
import { createNoteSelectionContext } from "../../src/domain/note-selection-context";
import { createSelectionAnchor } from "../../src/domain/selection-anchor";
import { validConversation } from "../fixtures";
import { FakeVault } from "../storage/fake-vault";
import { createRelationshipProjection, noteRelationshipNodeId, relationshipEdgeId } from "../../src/relationship-graph/model";
import { setRelationshipGraphNodeIncluded, setRelationshipEdgeOverride } from "../../src/relationship-graph/state";

const NOW = "2026-07-30T01:02:03.000Z";

function conversationWithAnswer() {
  const conversation = validConversation();
  conversation.nodes.child?.messages.push(
    {
      id: "question",
      role: "user",
      content: "ACK 如何工作？",
      status: "complete",
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt
    },
    {
      id: "answer",
      role: "assistant",
      content: "接收方通过 ACK 确认已经收到的数据。",
      status: "complete",
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt
    }
  );
  return conversation;
}

describe("KnowledgeCaptureService", () => {
  it("excludes disabled note links from tree capture while keeping the tree export", async () => {
    const vault = new FakeVault({ "Notes/network.md": "network note" });
    const conversation = conversationWithAnswer();
    const child = conversation.nodes.child;
    if (child === undefined) throw new Error("Missing child fixture");
    const question = child.messages.find((message) => message.id === "question");
    if (question === undefined) throw new Error("Missing question fixture");
    question.selectionContexts = [{
      sourceType: "note",
      filePath: "Notes/network.md",
      fileName: "network.md",
      basis: "note-source-v1",
      startOffset: 0,
      endOffset: 7,
      quote: "network",
      prefix: "",
      suffix: " note",
      contentHash: "fixture"
    }];
    conversation.depositGraphState = setRelationshipGraphNodeIncluded(
      conversation.depositGraphState,
      noteRelationshipNodeId("Notes/network.md"),
      false
    );
    const service = new KnowledgeCaptureService(vault, "TreeTalk knowledge", "TreeTalk");
    const indexPath = await service.capture({ scope: "tree", conversation }, NOW);
    expect(await vault.exists(indexPath)).toBe(true);
    expect(await vault.read("Notes/network.md")).toBe("network note");
    expect(createRelationshipProjection(conversation).enabledNoteEdges.size).toBe(0);
  });

  it("excludes disabled hierarchy edges from tree capture", async () => {
    const vault = new FakeVault();
    const conversation = conversationWithAnswer();
    const parentEdge = relationshipEdgeId("parent-child", "conversation:root", "conversation:child");
    conversation.depositGraphState = setRelationshipEdgeOverride(conversation.depositGraphState, parentEdge, false);
    const service = new KnowledgeCaptureService(vault, "TreeTalk knowledge", "TreeTalk");
    await service.capture({ scope: "tree", conversation }, NOW);
    const rootPath = vault.paths().find((path) => path.includes("TCP"));
    if (rootPath === undefined) throw new Error("Missing root export");
    expect(await vault.read(rootPath)).not.toContain("涓夋鎻℃墜");
  });
  it("captures a tree as a pure Markdown index plus one note per node", async () => {
    const vault = new FakeVault();
    const service = new KnowledgeCaptureService(vault, "TreeTalk 知识", "TreeTalk");

    const indexPath = await service.capture(
      { scope: "tree", conversation: conversationWithAnswer() },
      NOW
    );

    expect(indexPath).toMatch(/^TreeTalk\/.+\/节点列表\.md$/u);
    expect(vault.paths()).toHaveLength(3);
    expect(vault.paths().some((path) => path.endsWith(".treetalk-archive.md"))).toBe(false);

    const index = await vault.read(indexPath);
    expect(index).toContain("# 节点列表");
    expect(index).toContain("- [[TreeTalk/");
    expect(index).not.toContain("treetalk_");
    expect(index).not.toContain("TREETALK_ARCHIVE");

    const childPath = vault.paths().find((path) => path.endsWith("/三次握手.md"));
    if (childPath === undefined) throw new Error("Missing child export");
    const child = await vault.read(childPath);
    expect(child).toBe(
      "# 三次握手\n\n## 提问\n\nACK 如何工作？\n\n## 回答\n\n接收方通过 ACK 确认已经收到的数据。\n"
    );
    expect(child).not.toContain("---");
    expect(child).not.toContain("treetalk_");
  });

  it("links selected TreeTalk text to the exported child-node note", async () => {
    const vault = new FakeVault();
    const conversation = conversationWithAnswer();
    const root = conversation.nodes.root;
    const child = conversation.nodes.child;
    if (root === undefined || child === undefined) throw new Error("Missing fixture");
    root.messages.push({
      id: "root-answer",
      role: "assistant",
      content: "TCP 使用确认机制保证可靠传输。",
      status: "complete",
      createdAt: NOW,
      updatedAt: NOW
    });
    const anchor = await createSelectionAnchor({
      messageId: "root-answer",
      sourceNodeId: "root",
      sourceRole: "assistant",
      visibleText: "TCP 使用确认机制保证可靠传输。",
      startOffset: 6,
      endOffset: 10
    });
    const question = child.messages.find((message) => message.id === "question");
    if (question === undefined) throw new Error("Missing question");
    question.selectionContexts = [anchor];
    const service = new KnowledgeCaptureService(vault, "TreeTalk 知识", "TreeTalk");

    await service.capture({ scope: "tree", conversation }, NOW);
    const rootPath = vault.paths().find((path) => path.includes("TCP 为什么可靠"));
    if (rootPath === undefined) throw new Error("Missing root export");
    const rootNote = await vault.read(rootPath);
    expect(rootNote).toContain("确认机制 [[TreeTalk/");
    expect(rootNote).toContain("|三次握手]]");
    expect(rootNote).not.toContain("treetalk-");
    expect(rootNote).not.toContain("在 TreeTalk 中查看");
  });

  it("places a TreeTalk message-selection link after the complete list block", async () => {
    const vault = new FakeVault();
    const conversation = conversationWithAnswer();
    const root = conversation.nodes.root;
    const child = conversation.nodes.child;
    if (root === undefined || child === undefined) throw new Error("Missing fixture");
    const content = "- 网络层负责寻址\n- 传输层负责端到端通信";
    root.messages.push({
      id: "root-answer",
      role: "assistant",
      content,
      status: "complete",
      createdAt: NOW,
      updatedAt: NOW
    });
    const question = child.messages.find((message) => message.id === "question");
    if (question === undefined) throw new Error("Missing question");
    question.selectionContexts = [{
      messageId: "root-answer",
      sourceNodeId: "root",
      sourceRole: "assistant",
      basis: "rendered-text-v1",
      startOffset: content.indexOf("网络层"),
      endOffset: content.indexOf("网络层") + 3,
      quote: "网络层",
      prefix: "",
      suffix: "负责寻址",
      contentHash: "fixture"
    }];
    const service = new KnowledgeCaptureService(vault, "TreeTalk 知识", "TreeTalk");

    await service.capture({ scope: "tree", conversation }, NOW);
    const rootPath = vault.paths().find((path) => path.includes("TCP 为什么可靠"));
    if (rootPath === undefined) throw new Error("Missing root export");
    const rootNote = await vault.read(rootPath);
    expect(rootNote).toContain(
      "- 网络层负责寻址\n- 传输层负责端到端通信\n\n[[TreeTalk/"
    );
  });

  it("preserves source-note YAML while adding a plain selection link", async () => {
    const body = "网络层负责寻址和路由选择。";
    const source = `---\ntags: [network]\n---\n\n${body}`;
    const vault = new FakeVault({ "Notes/network.md": source });
    const conversation = conversationWithAnswer();
    const child = conversation.nodes.child;
    const question = child?.messages.find((message) => message.id === "question");
    if (question === undefined) throw new Error("Missing question");
    question.selectionContexts = [
      await createNoteSelectionContext({
        filePath: "Notes/network.md",
        fileName: "network.md",
        basis: "note-source-v1",
        visibleText: body,
        startOffset: 0,
        endOffset: 3
      })
    ];
    const service = new KnowledgeCaptureService(vault, "TreeTalk 知识", "TreeTalk");

    await service.capture({ scope: "tree", conversation }, NOW);
    const updated = await vault.read("Notes/network.md");
    expect(updated.startsWith("---\ntags: [network]\n---\n\n")).toBe(true);
    expect(updated).toContain("网络层 [[TreeTalk/");
    expect(updated).toContain("|三次握手]]");
    expect(updated).not.toContain("treetalk_note_id");
    expect(updated).not.toContain("treetalk-");
  });

  it("places a source-note selection link after the complete formula block", async () => {
    const body = "$$\na^2+b^2=c^2\n$$\n\n后文";
    const vault = new FakeVault({ "Notes/math.md": body });
    const conversation = conversationWithAnswer();
    const child = conversation.nodes.child;
    const question = child?.messages.find((message) => message.id === "question");
    if (question === undefined) throw new Error("Missing question");
    const start = body.indexOf("b^2");
    question.selectionContexts = [{
      sourceType: "note",
      filePath: "Notes/math.md",
      fileName: "math.md",
      basis: "note-source-v1",
      startOffset: start,
      endOffset: start + 3,
      quote: "b^2",
      prefix: "a^2+",
      suffix: "=c^2",
      contentHash: "fixture"
    }];
    const service = new KnowledgeCaptureService(vault, "TreeTalk 知识", "TreeTalk");

    await service.capture({ scope: "tree", conversation }, NOW);
    expect(await vault.read("Notes/math.md")).toMatch(
      /^\$\$\na\^2\+b\^2=c\^2\n\$\$\n\n\[\[TreeTalk\/[^|]+\|三次握手\]\]\n\n后文$/u
    );
  });

  it("still exports the tree when a source-note link cannot be resolved", async () => {
    const vault = new FakeVault({ "Notes/network.md": "网络层和网络层" });
    const conversation = conversationWithAnswer();
    const child = conversation.nodes.child;
    const question = child?.messages.find((message) => message.id === "question");
    if (question === undefined) throw new Error("Missing question");
    question.selectionContexts = [
      {
        sourceType: "note",
        filePath: "Notes/network.md",
        fileName: "network.md",
        basis: "note-source-v1",
        startOffset: 99,
        endOffset: 102,
        quote: "网络层",
        prefix: "",
        suffix: "",
        contentHash: "old"
      }
    ];
    const service = new KnowledgeCaptureService(vault, "TreeTalk 知识", "TreeTalk");

    const indexPath = await service.capture({ scope: "tree", conversation }, NOW);
    expect(await vault.exists(indexPath)).toBe(true);
    expect(await vault.read("Notes/network.md")).toContain("网络层和网络层");
    expect(await vault.read("Notes/network.md")).toContain("[[TreeTalk/");
  });

  it("falls back to a branch section when a message selection is unresolved", async () => {
    const vault = new FakeVault();
    const conversation = conversationWithAnswer();
    const root = conversation.nodes.root;
    const child = conversation.nodes.child;
    if (root === undefined || child === undefined) throw new Error("Missing fixture");
    root.messages.push({
      id: "root-answer",
      role: "assistant",
      content: "网络层和网络层",
      status: "complete",
      createdAt: NOW,
      updatedAt: NOW
    });
    const question = child.messages.find((message) => message.id === "question");
    if (question === undefined) throw new Error("Missing question");
    question.selectionContexts = [{
      messageId: "root-answer",
      sourceNodeId: "root",
      sourceRole: "assistant",
      basis: "rendered-text-v1",
      startOffset: 99,
      endOffset: 102,
      quote: "网络层",
      prefix: "",
      suffix: "",
      contentHash: "old"
    }];
    const service = new KnowledgeCaptureService(vault, "TreeTalk 知识", "TreeTalk");

    await service.capture({ scope: "tree", conversation }, NOW);
    const rootPath = vault.paths().find((path) => path.includes("TCP 为什么可靠"));
    if (rootPath === undefined) throw new Error("Missing root export");
    const content = await vault.read(rootPath);
    expect(content).toContain("# TCP 为什么可靠？");
    expect(content).toContain("[[TreeTalk/");
  });

  it("rejects capturing a tree while an assistant response is streaming", async () => {
    const vault = new FakeVault();
    const service = new KnowledgeCaptureService(vault, "TreeTalk 知识", "TreeTalk");
    const conversation = conversationWithAnswer();
    const answer = conversation.nodes.child?.messages.find(
      (message) => message.id === "answer"
    );
    if (answer === undefined) throw new Error("Missing answer fixture");
    answer.status = "streaming";

    await expect(
      service.capture({ scope: "tree", conversation }, NOW)
    ).rejects.toThrow(/streaming/i);
    expect(vault.paths()).toEqual([]);
  });

  it("captures one assistant answer as pure Markdown", async () => {
    const vault = new FakeVault();
    const service = new KnowledgeCaptureService(vault, "TreeTalk 知识", "TreeTalk");
    const conversation = conversationWithAnswer();

    const path = await service.capture(
      {
        scope: "answer",
        conversation,
        nodeId: "child",
        messageId: "answer"
      },
      NOW
    );

    expect(path).toBe("TreeTalk 知识/三次握手.md");
    expect(await vault.read(path)).toBe(
      "# 三次握手\n\n接收方通过 ACK 确认已经收到的数据。\n"
    );
  });

  it("adds a numeric suffix only to duplicate answer filenames, not the H1", async () => {
    const conversation = conversationWithAnswer();
    const vault = new FakeVault({ "TreeTalk 知识/三次握手.md": "existing" });
    const service = new KnowledgeCaptureService(vault, "TreeTalk 知识", "TreeTalk");

    const path = await service.capture(
      {
        scope: "answer",
        conversation,
        nodeId: "child",
        messageId: "answer"
      },
      NOW
    );

    expect(path).toBe("TreeTalk 知识/三次握手 2.md");
    expect(await vault.read(path)).toContain("# 三次握手\n");
    expect(await vault.read(path)).not.toContain("# 三次握手 2");
  });

  it("rejects the removed standalone excerpt scope", async () => {
    const vault = new FakeVault();
    const service = new KnowledgeCaptureService(vault, "TreeTalk 知识", "TreeTalk");
    const request = {
      scope: "excerpt",
      conversation: conversationWithAnswer(),
      nodeId: "child",
      messageId: "answer"
    } as unknown as KnowledgeCaptureRequest;

    await expect(service.capture(request, NOW)).rejects.toThrow(/capture scope/i);
  });
});
