import { describe, expect, it } from "vitest";
import {
  continueNode,
  hasUserMessage,
  isMarkdownPath,
  prepareChildDraft,
  submitChildDraft
} from "../../src/domain/tree-commands";
import { createConversation } from "../../src/domain/conversation-factory";
import { NOW } from "../fixtures";

describe("isMarkdownPath", () => {
  it("accepts .md paths case-insensitively", () => {
    expect(isMarkdownPath("日记/2026.md")).toBe(true);
    expect(isMarkdownPath("Note.MD")).toBe(true);
  });

  it("rejects non-markdown paths", () => {
    expect(isMarkdownPath("images/a.png")).toBe(false);
    expect(isMarkdownPath("canvas.canvas")).toBe(false);
    expect(isMarkdownPath("note.pdf")).toBe(false);
    expect(isMarkdownPath("README")).toBe(false);
  });
});

describe("anchorFilePath on first message", () => {
  it("locks the anchor on the first continue message", () => {
    const before = createConversation();
    const result = continueNode(before, {
      nodeId: before.rootNodeId,
      text: "第一条问题",
      messageId: "m1",
      now: NOW,
      anchorFilePath: "日记/2026-08-18.md"
    });
    expect(result.state.anchorFilePath).toBe("日记/2026-08-18.md");
  });

  it("does not write a non-markdown anchor", () => {
    const before = createConversation();
    const result = continueNode(before, {
      nodeId: before.rootNodeId,
      text: "第一条问题",
      messageId: "m1",
      now: NOW,
      anchorFilePath: "attachments/scan.pdf"
    });
    expect(result.state.anchorFilePath).toBeUndefined();
  });

  it("does not overwrite the anchor on a later message", () => {
    const before = createConversation();
    const first = continueNode(before, {
      nodeId: before.rootNodeId,
      text: "第一条",
      messageId: "m1",
      now: NOW,
      anchorFilePath: "笔记A.md"
    });
    const second = continueNode(first.state, {
      nodeId: first.state.rootNodeId,
      text: "第二条",
      messageId: "m2",
      now: NOW,
      anchorFilePath: "笔记B.md"
    });
    expect(second.state.anchorFilePath).toBe("笔记A.md");
  });

  it("does not add an anchor once a conversation already has a user message", () => {
    const before = createConversation();
    const first = continueNode(before, {
      nodeId: before.rootNodeId,
      text: "第一条（无锚）",
      messageId: "m1",
      now: NOW
    });
    expect(first.state.anchorFilePath).toBeUndefined();
    const second = continueNode(first.state, {
      nodeId: first.state.rootNodeId,
      text: "第二条（补锚点应被拒绝）",
      messageId: "m2",
      now: NOW,
      anchorFilePath: "迟到.md"
    });
    expect(second.state.anchorFilePath).toBeUndefined();
  });

  it("locks the anchor when the first message opens a child branch", () => {
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
      anchorFilePath: "分支来源.md"
    });
    expect(submitted.state.anchorFilePath).toBe("分支来源.md");
  });

  it("increments revision exactly once when locking the anchor", () => {
    const before = createConversation();
    const startRevision = before.revision;
    const result = continueNode(before, {
      nodeId: before.rootNodeId,
      text: "原子提交",
      messageId: "m1",
      now: NOW,
      anchorFilePath: "锚.md"
    });
    expect(result.state.revision).toBe(startRevision + 1);
    expect(result.state.anchorFilePath).toBe("锚.md");
    expect(hasUserMessage(result.state)).toBe(true);
  });
});
