import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROMPT_SECTION_TITLE,
  FULL_CONTEXT_BASE_SYSTEM_PROMPT,
  FULL_CONTEXT_PROTOCOL_VERSION,
  buildTreeTalkSystemPrompt,
  withDefaultPrompt
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

  it("keeps the system prompt untouched when no default prompt is configured", () => {
    const base = buildTreeTalkSystemPrompt(true);
    expect(withDefaultPrompt(base, "")).toBe(base);
    expect(withDefaultPrompt(base, "   \n ")).toBe(base);
  });

  it("appends the configured default prompt as its own section", () => {
    const base = buildTreeTalkSystemPrompt(false);
    const prompt = "  请用中文回答，先给结论。  ";

    const composed = withDefaultPrompt(base, prompt);

    expect(composed.startsWith(base)).toBe(true);
    expect(composed).toContain(DEFAULT_PROMPT_SECTION_TITLE);
    expect(composed).toContain("请用中文回答，先给结论。");
    expect(composed).not.toContain("  请用中文回答");
  });
});
