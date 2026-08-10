import { describe, expect, it, vi } from "vitest";
import { isStrictMessagePrefix } from "../../../src/agent/pi/progressive/prefix-integrity";
import type { PiConversationMessage } from "../../../src/agent/pi/pi-provider-transport";

describe("isStrictMessagePrefix", () => {
  it("does not serialize an unchanged identity prefix", () => {
    const first: PiConversationMessage = { role: "user", content: "A" };
    const previous = [first];
    const current: PiConversationMessage[] = [
      first,
      { role: "assistant", content: "B", toolCalls: [] }
    ];
    const stringify = vi.spyOn(JSON, "stringify");

    expect(isStrictMessagePrefix(previous, current)).toBe(true);
    expect(stringify).not.toHaveBeenCalled();

    stringify.mockRestore();
  });

  it("falls back to byte comparison for equal distinct messages", () => {
    const previous: PiConversationMessage[] = [
      { role: "user", content: "A" }
    ];
    const current: PiConversationMessage[] = [
      structuredClone(previous[0]!),
      { role: "user", content: "B" }
    ];

    expect(isStrictMessagePrefix(previous, current)).toBe(true);
    current[0] = { role: "user", content: "changed" };
    expect(isStrictMessagePrefix(previous, current)).toBe(false);
  });
});
