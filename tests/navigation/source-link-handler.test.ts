import { describe, expect, it, vi } from "vitest";
import type { SelectionAnchor } from "../../src/domain/types";
import { encodeSourceAnchor } from "../../src/knowledge/excerpt-drag";
import {
  conversationContainsSource,
  SourceLinkHandler
} from "../../src/navigation/source-link-handler";
import { validConversation } from "../fixtures";

function workspace(active: boolean, history: boolean) {
  return {
    openActive: vi.fn(() => Promise.resolve(active)),
    openHistory: vi.fn(() => Promise.resolve(history)),
    selectNode: vi.fn()
  };
}

const anchor: SelectionAnchor = {
  messageId: "message-1",
  sourceNodeId: "node-1",
  sourceRole: "assistant",
  basis: "rendered-text-v1",
  startOffset: 4,
  endOffset: 10,
  quote: "source",
  prefix: "pre ",
  suffix: " post",
  contentHash: "hash"
};

const parameters = {
  conversationId: "conversation-1",
  nodeId: "node-1",
  messageId: "message-1",
  anchor: encodeSourceAnchor(anchor)
};

describe("SourceLinkHandler", () => {
  it("opens an active conversation with its exact source anchor before consulting history", async () => {
    const port = workspace(true, false);

    await expect(new SourceLinkHandler(port).open(parameters)).resolves.toBe(
      "opened"
    );
    expect(port.openActive).toHaveBeenCalledWith({
      conversationId: "conversation-1",
      nodeId: "node-1",
      messageId: "message-1",
      anchor
    });
    expect(port.openHistory).not.toHaveBeenCalled();
    expect(port.selectNode).not.toHaveBeenCalled();
  });

  it("falls back to archived history and still carries the exact anchor", async () => {
    const port = {
      ...workspace(false, true),
      selectNode: vi.fn(() => {
        throw new Error("Archived conversations are read-only");
      })
    };

    await expect(new SourceLinkHandler(port).open(parameters)).resolves.toBe(
      "opened"
    );
    expect(port.openHistory).toHaveBeenCalledWith({
      conversationId: "conversation-1",
      nodeId: "node-1",
      messageId: "message-1",
      anchor
    });
    expect(port.selectNode).not.toHaveBeenCalled();
  });

  it("keeps opening legacy links without an anchor", async () => {
    const port = workspace(true, false);

    await expect(
      new SourceLinkHandler(port).open({
        conversationId: "conversation-1",
        nodeId: "node-1",
        messageId: "message-1"
      })
    ).resolves.toBe("opened");
    expect(port.openActive).toHaveBeenCalledWith({
      conversationId: "conversation-1",
      nodeId: "node-1",
      messageId: "message-1"
    });
  });

  it("rejects malformed anchored links instead of navigating imprecisely", async () => {
    const port = workspace(false, false);
    const handler = new SourceLinkHandler(port);

    await expect(
      handler.open({ ...parameters, anchor: "broken-anchor" })
    ).resolves.toBe("missing");
    expect(port.openActive).not.toHaveBeenCalled();
    expect(port.openHistory).not.toHaveBeenCalled();
  });

  it("returns missing without mutating selection for invalid or deleted sources", async () => {
    const port = workspace(false, false);
    const handler = new SourceLinkHandler(port);

    await expect(handler.open(parameters)).resolves.toBe("missing");
    await expect(
      handler.open({ conversationId: "", nodeId: "node-1" })
    ).resolves.toBe("missing");
    expect(port.selectNode).not.toHaveBeenCalled();
  });
  it("requires the exact message to exist in a candidate conversation", () => {
    const conversation = validConversation();
    conversation.nodes.child?.messages.push({
      id: "message-1",
      role: "assistant",
      content: "answer",
      status: "complete",
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt
    });

    expect(
      conversationContainsSource(conversation, {
        conversationId: "conversation-1",
        nodeId: "child",
        messageId: "message-1"
      })
    ).toBe(true);
    expect(
      conversationContainsSource(conversation, {
        conversationId: "conversation-1",
        nodeId: "child",
        messageId: "missing"
      })
    ).toBe(false);
  });

});
