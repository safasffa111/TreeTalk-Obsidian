import { describe, expect, it } from "vitest";
import {
  FULL_CONTEXT_BASE_SYSTEM_PROMPT,
  FULL_CONTEXT_PROTOCOL_VERSION,
  buildTreeTalkSystemPrompt
} from "../../src/domain/full-context-protocol";

describe("TreeTalk Full Context Protocol", () => {
  it("always keeps the stable base protocol", () => {
    expect(FULL_CONTEXT_PROTOCOL_VERSION).toBe("v1");
    expect(buildTreeTalkSystemPrompt(false)).toBe(FULL_CONTEXT_BASE_SYSTEM_PROMPT);
    expect(FULL_CONTEXT_BASE_SYSTEM_PROMPT).toContain("直接回答当前问题");
  });

  it("appends Markdown guidance only when compatibility is enabled", () => {
    expect(buildTreeTalkSystemPrompt(false)).not.toContain("Obsidian Markdown");
    expect(buildTreeTalkSystemPrompt(true)).toContain("[Obsidian Markdown 格式规则]");
    expect(buildTreeTalkSystemPrompt(true)).toContain("严格兼容 Obsidian Markdown");
  });
});
