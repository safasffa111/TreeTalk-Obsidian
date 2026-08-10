import { describe, expect, it } from "vitest";
import { interruptOrphanedResponses } from "../../src/domain/response-recovery";
import { NOW, requireNode, validConversation } from "../fixtures";

const RECOVERED_AT = "2026-08-10T00:00:00.000Z";

describe("interruptOrphanedResponses", () => {
  it("interrupts every orphaned streaming assistant response in one revision", () => {
    const conversation = validConversation();
    const child = requireNode(conversation, "child");
    child.messages.push(
      {
        id: "assistant-one",
        role: "assistant",
        content: "partial one",
        status: "streaming",
        createdAt: NOW,
        updatedAt: NOW
      },
      {
        id: "assistant-two",
        role: "assistant",
        content: "partial two",
        status: "streaming",
        createdAt: NOW,
        updatedAt: NOW
      }
    );

    const recovered = interruptOrphanedResponses(
      conversation,
      RECOVERED_AT
    );

    expect(
      requireNode(recovered, "child").messages.map((message) => message.status)
    ).toEqual(["interrupted", "interrupted"]);
    expect(
      requireNode(recovered, "child").messages.map((message) =>
        message.updatedAt
      )
    ).toEqual([RECOVERED_AT, RECOVERED_AT]);
    expect(requireNode(recovered, "child").updatedAt).toBe(RECOVERED_AT);
    expect(recovered.updatedAt).toBe(RECOVERED_AT);
    expect(recovered.revision).toBe(conversation.revision + 1);
    expect(
      requireNode(conversation, "child").messages.map((message) =>
        message.status
      )
    ).toEqual(["streaming", "streaming"]);
  });

  it("preserves identity when no recovery is required", () => {
    const conversation = validConversation();

    expect(interruptOrphanedResponses(conversation, RECOVERED_AT)).toBe(
      conversation
    );
  });

  it("does not change completed or already interrupted responses", () => {
    const conversation = validConversation();
    requireNode(conversation, "child").messages.push(
      {
        id: "complete",
        role: "assistant",
        content: "done",
        status: "complete",
        createdAt: NOW,
        updatedAt: NOW
      },
      {
        id: "interrupted",
        role: "assistant",
        content: "partial",
        status: "interrupted",
        createdAt: NOW,
        updatedAt: NOW
      }
    );

    expect(interruptOrphanedResponses(conversation, RECOVERED_AT)).toBe(
      conversation
    );
  });
});
