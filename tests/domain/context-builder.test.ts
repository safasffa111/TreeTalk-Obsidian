import { describe, expect, it } from "vitest";
import { buildProviderContext } from "../../src/domain/context-builder";
import type { ChatMessage, ConversationFile, ConversationNode } from "../../src/domain/types";
import { NOW, requireNode, validConversation } from "../fixtures";

function message(id: string, role: ChatMessage["role"], content: string): ChatMessage {
  return {
    id,
    role,
    content,
    status: "complete",
    createdAt: NOW,
    updatedAt: NOW
  };
}

function branchingConversation(): ConversationFile {
  const value = structuredClone(validConversation());
  const root = requireNode(value, "root");
  const left = requireNode(value, "child");
  const right: ConversationNode = {
    ...structuredClone(left),
    id: "right",
    parentId: "root",
    title: "右侧分支",
    messages: [message("right-message", "user", "right sibling")]
  };
  root.childIds = ["child", "right"];
  root.messages = [
    message("root-user", "user", "root question"),
    message("root-assistant", "assistant", "root answer")
  ];
  left.messages = [message("left-user", "user", "left question")];
  value.nodes.right = right;
  value.currentNodeId = "child";
  return value;
}

describe("buildProviderContext", () => {
  it("includes ancestors and excludes siblings", () => {
    const context = buildProviderContext(branchingConversation(), "child", {
      systemPrompt: "system",
      maxCharacters: 1000
    });
    const contents = context.map((entry) => entry.content);

    expect(contents).toEqual(["system", "root question", "root answer", "left question"]);
    expect(contents).not.toContain("right sibling");
  });

  it("prioritizes selected context in a user message", () => {
    const value = branchingConversation();
    requireNode(value, "child").messages.push({
      ...message("selected-question", "user", "这意味着什么？"),
      selectionContexts: [
        {
          messageId: "root-assistant",
          sourceNodeId: "root",
          sourceRole: "assistant",
          basis: "rendered-text-v1",
          startOffset: 0,
          endOffset: 4,
          quote: "root",
          prefix: "",
          suffix: "",
          contentHash: "hash"
        },
        {
          messageId: "right-message",
          sourceNodeId: "right",
          sourceRole: "user",
          basis: "rendered-text-v1",
          startOffset: 0,
          endOffset: 5,
          quote: "right",
          prefix: "",
          suffix: "",
          contentHash: "hash-2"
        }
      ]
    });

    const context = buildProviderContext(value, "child", {
      systemPrompt: "",
      maxCharacters: 1000
    });

    expect(context.at(-1)?.content).toContain("root");
    expect(context.at(-1)?.content).toContain("right");
    expect(context.at(-1)?.content).toContain("这意味着什么？");
  });

  it("keeps every selected context when the character budget is exceeded", () => {
    const value = branchingConversation();
    requireNode(value, "child").messages.push({
      ...message("selected-question", "user", "why?"),
      selectionContexts: [
        {
          messageId: "root-assistant",
          sourceNodeId: "root",
          sourceRole: "assistant",
          basis: "rendered-text-v1",
          startOffset: 0,
          endOffset: 5,
          quote: "first",
          prefix: "",
          suffix: "",
          contentHash: "one"
        },
        {
          messageId: "root-user",
          sourceNodeId: "root",
          sourceRole: "user",
          basis: "rendered-text-v1",
          startOffset: 0,
          endOffset: 6,
          quote: "second",
          prefix: "",
          suffix: "",
          contentHash: "two"
        }
      ]
    });

    const context = buildProviderContext(value, "child", {
      systemPrompt: "",
      maxCharacters: 8
    });

    expect(context.at(-1)?.content).toContain("first");
    expect(context.at(-1)?.content).toContain("second");
    expect(context.at(-1)?.content).toContain("why?");
  });

  it("trims complete oldest messages without removing the newest current message", () => {
    const context = buildProviderContext(branchingConversation(), "child", {
      systemPrompt: "system",
      maxCharacters: 24
    });

    expect(context.at(-1)?.content).toBe("left question");
    expect(context.every((entry) => entry.content.length > 0)).toBe(true);
    expect(context.some((entry) => entry.content === "root question")).toBe(false);
  });
});
