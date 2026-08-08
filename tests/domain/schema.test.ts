import { describe, expect, it } from "vitest";
import { parseConversation } from "../../src/domain/schema";
import { requireNode, validConversation } from "../fixtures";

describe("parseConversation", () => {
  it("accepts a valid root and child tree", () => {
    expect(parseConversation(validConversation()).rootNodeId).toBe("root");
  });

  it("rejects cycles", () => {
    const value = validConversation();
    requireNode(value, "root").parentId = "child";
    requireNode(value, "child").childIds = ["root"];

    expect(() => parseConversation(value)).toThrow(/cycle/i);
  });

  it("rejects a child whose parent does not point back", () => {
    const value = validConversation();
    requireNode(value, "root").childIds = [];

    expect(() => parseConversation(value)).toThrow(/parent/i);
  });

  it("rejects unreachable nodes", () => {
    const value = validConversation();
    value.nodes.orphan = {
      ...requireNode(value, "child"),
      id: "orphan",
      parentId: null,
      title: "孤立节点"
    };

    expect(() => parseConversation(value)).toThrow(/unreachable/i);
  });

  it("returns frozen canonical state", () => {
    const parsed = parseConversation(validConversation());

    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.nodes.root)).toBe(true);
  });

  it("normalizes legacy singular selection contexts into frozen arrays", () => {
    const value = validConversation() as unknown as Record<string, unknown>;
    const nodes = value.nodes as Record<string, Record<string, unknown>>;
    const child = nodes.child;
    if (child === undefined) throw new Error("Child fixture is missing");
    child.draft = {
      text: "",
      mode: "continue",
      selectionContext: {
        messageId: "answer",
        startOffset: 0,
        endOffset: 4,
        quote: "text",
        prefix: "",
        suffix: "",
        contentHash: "hash"
      }
    };

    const parsed = parseConversation(value);

    expect(parsed.nodes.child?.draft.selectionContexts).toEqual([
      expect.objectContaining({
        messageId: "answer",
        quote: "text",
        basis: "rendered-text-v1"
      })
    ]);
    expect(Object.isFrozen(parsed.nodes.child?.draft.selectionContexts)).toBe(
      true
    );
  });

  it("preserves the optional visible quote used by source-aware message anchors", () => {
    const value = validConversation();
    value.nodes.child?.draft.selectionContexts.push({
      messageId: "answer",
      sourceNodeId: "child",
      sourceRole: "assistant",
      basis: "rendered-text-v1",
      startOffset: 0,
      endOffset: 2,
      quote: "$x^2$",
      visibleQuote: "x²",
      prefix: "",
      suffix: "",
      contentHash: "hash"
    });

    expect(parseConversation(value).nodes.child?.draft.selectionContexts[0]).toEqual(
      expect.objectContaining({ quote: "$x^2$", visibleQuote: "x²" })
    );
  });

  it("round-trips the optional mode captured before a message selection", () => {
    const value = validConversation();
    const child = requireNode(value, "child");
    child.draft.mode = "child";
    child.draft.selectionModeBeforeCapture = "continue";

    expect(
      parseConversation(value).nodes.child?.draft.selectionModeBeforeCapture
    ).toBe("continue");
  });

  it("parses note contexts alongside legacy message anchors", () => {
    const value = validConversation();
    value.nodes.child?.draft.selectionContexts.push({
      sourceType: "note",
      filePath: "课程/网络分层.md",
      fileName: "网络分层.md",
      basis: "note-source-v1",
      startOffset: 2,
      endOffset: 5,
      quote: "网络层",
      prefix: "前文",
      suffix: "后文",
      contentHash: "note-hash",
      snapshot: {
        version: "note-snapshot-v1",
        content: "# 网络分层\n\n网络层",
        contentHash: "snapshot-hash",
        selectionStartOffset: 8,
        selectionEndOffset: 11
      }
    });

    expect(parseConversation(value).nodes.child?.draft.selectionContexts[0]).toEqual(
      expect.objectContaining({
        sourceType: "note",
        filePath: "课程/网络分层.md",
        quote: "网络层",
        snapshot: expect.objectContaining({
          version: "note-snapshot-v1",
          contentHash: "snapshot-hash"
        })
      })
    );
  });
  it("round-trips optional node title lifecycle fields", () => {
    const value = validConversation();
    const root = requireNode(value, "root");
    root.titleSource = "auto";
    root.summary = {
      protocol: "node-summary:v1",
      status: "complete",
      attemptedAt: "2026-08-01T08:00:00.000Z",
      completedAt: "2026-08-01T08:00:01.000Z",
      providerProfileId: "default",
      modelId: "model",
      generatedTitle: "TCP 可靠传输机制"
    };

    expect(parseConversation(value).nodes.root).toMatchObject({
      titleSource: "auto",
      summary: {
        protocol: "node-summary:v1",
        status: "complete",
        generatedTitle: "TCP 可靠传输机制"
      }
    });
  });

  it("accepts node-summary:v2 records", () => {
    const value = validConversation();
    const root = requireNode(value, "root");
    root.titleSource = "auto";
    root.summary = {
      protocol: "node-summary:v2",
      status: "complete",
      attemptedAt: "2026-08-01T08:00:00.000Z",
      completedAt: "2026-08-01T08:00:01.000Z",
      providerProfileId: "default",
      modelId: "deepseek-v4-flash",
      generatedTitle: "TCP 可靠传输机制"
    };
    expect(parseConversation(value).nodes.root?.summary?.protocol).toBe(
      "node-summary:v2"
    );
  });

  it("accepts node-summary:v3 records", () => {
    const value = validConversation();
    const root = requireNode(value, "root");
    root.titleSource = "auto";
    root.summary = {
      protocol: "node-summary:v3",
      status: "complete",
      attemptedAt: "2026-08-01T08:00:00.000Z",
      completedAt: "2026-08-01T08:00:01.000Z",
      providerProfileId: "default",
      modelId: "deepseek-v4-flash",
      generatedTitle: "冻结与缓存命中"
    };
    expect(parseConversation(value).nodes.root?.summary?.protocol).toBe(
      "node-summary:v3"
    );
  });

});
