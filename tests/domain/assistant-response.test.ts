import { describe, expect, it } from "vitest";
import {
  appendAssistantDelta,
  appendAssistantResponse,
  finishAssistantResponse,
  startAssistantResponse
} from "../../src/domain/assistant-response";
import { validConversation } from "../fixtures";

describe("appendAssistantResponse", () => {
  it("writes to the captured node even after navigation within the same conversation", () => {
    const conversation = validConversation();
    conversation.currentNodeId = "root";
    const result = appendAssistantResponse(conversation, {
      conversationId: conversation.id,
      nodeId: "child",
      messageId: "answer",
      content: "captured answer",
      modelId: "model",
      now: conversation.updatedAt
    });
    expect(result.nodes.child?.messages.at(-1)?.content).toBe("captured answer");
    expect(result.nodes.root?.messages).toHaveLength(0);
  });

  it("refuses a reply after the conversation was archived or switched", () => {
    const archived = validConversation();
    archived.status = "archived";
    expect(() =>
      appendAssistantResponse(archived, {
        conversationId: archived.id,
        nodeId: archived.currentNodeId,
        messageId: "answer",
        content: "late",
        modelId: "model",
        now: archived.updatedAt
      })
    ).toThrow("no longer active");

    const switched = validConversation();
    expect(() =>
      appendAssistantResponse(switched, {
        conversationId: "different",
        nodeId: switched.currentNodeId,
        messageId: "answer",
        content: "late",
        modelId: "model",
        now: switched.updatedAt
      })
    ).toThrow("no longer active");
  });

  it("builds one streaming message from ordered deltas", () => {
    const conversation = validConversation();
    const started = startAssistantResponse(conversation, {
      conversationId: conversation.id,
      nodeId: "child",
      messageId: "stream",
      modelId: "model",
      now: conversation.updatedAt
    });
    const first = appendAssistantDelta(started, {
      conversationId: conversation.id,
      nodeId: "child",
      messageId: "stream",
      delta: "你",
      now: conversation.updatedAt
    });
    const second = appendAssistantDelta(first, {
      conversationId: conversation.id,
      nodeId: "child",
      messageId: "stream",
      delta: "好",
      now: conversation.updatedAt
    });
    const finished = finishAssistantResponse(second, {
      conversationId: conversation.id,
      nodeId: "child",
      messageId: "stream",
      status: "complete",
      now: conversation.updatedAt
    });

    expect(finished.nodes.child?.messages.at(-1)).toMatchObject({
      id: "stream",
      content: "你好",
      status: "complete"
    });
  });

  it("replaces streaming content atomically when completion provides normalized Markdown", () => {
    const conversation = validConversation();
    const started = startAssistantResponse(conversation, {
      conversationId: conversation.id,
      nodeId: "child",
      messageId: "stream",
      modelId: "model",
      now: conversation.updatedAt
    });
    const partial = appendAssistantDelta(started, {
      conversationId: conversation.id,
      nodeId: "child",
      messageId: "stream",
      delta: "\\[x^2\\]",
      now: conversation.updatedAt
    });
    const finished = finishAssistantResponse(partial, {
      conversationId: conversation.id,
      nodeId: "child",
      messageId: "stream",
      status: "complete",
      finalContent: "$$\nx^2\n$$",
      now: conversation.updatedAt
    });

    expect(finished.nodes.child?.messages.at(-1)).toMatchObject({
      content: "$$\nx^2\n$$",
      status: "complete"
    });
  });

  it("keeps partial content when a stream is interrupted", () => {
    const conversation = validConversation();
    const started = startAssistantResponse(conversation, {
      conversationId: conversation.id,
      nodeId: "child",
      messageId: "stream",
      modelId: "model",
      now: conversation.updatedAt
    });
    const partial = appendAssistantDelta(started, {
      conversationId: conversation.id,
      nodeId: "child",
      messageId: "stream",
      delta: "partial",
      now: conversation.updatedAt
    });
    const interrupted = finishAssistantResponse(partial, {
      conversationId: conversation.id,
      nodeId: "child",
      messageId: "stream",
      status: "interrupted",
      now: conversation.updatedAt
    });

    expect(interrupted.nodes.child?.messages.at(-1)).toMatchObject({
      content: "partial",
      status: "interrupted"
    });
  });
});
