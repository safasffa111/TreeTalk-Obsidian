import { describe, expect, it } from "vitest";
import {
  OBSIDIAN_MARKDOWN_SYSTEM_PROMPT,
  normalizeObsidianMarkdown,
  splitStreamingMarkdown
} from "../../src/domain/markdown-compatibility";

describe("Obsidian Markdown compatibility", () => {
  it("keeps the provider guidance internal and Obsidian-specific", () => {
    expect(OBSIDIAN_MARKDOWN_SYSTEM_PROMPT).toContain("Obsidian Markdown");
    expect(OBSIDIAN_MARKDOWN_SYSTEM_PROMPT).toContain("$...$");
    expect(OBSIDIAN_MARKDOWN_SYSTEM_PROMPT).toContain("$$...$$");
    expect(OBSIDIAN_MARKDOWN_SYSTEM_PROMPT).not.toContain("TreeTalk 设置");
  });

  it("holds an incomplete block formula as literal streaming source", () => {
    expect(splitStreamingMarkdown("before\n\n$$\nx^2")).toEqual({
      stableMarkdown: "before\n\n",
      pendingSource: "$$\nx^2"
    });
  });

  it("renders a complete formula normally", () => {
    expect(splitStreamingMarkdown("before\n\n$$\nx^2\n$$")).toEqual({
      stableMarkdown: "before\n\n$$\nx^2\n$$",
      pendingSource: ""
    });
  });

  it("holds an unfinished fenced code block from its opening fence", () => {
    expect(splitStreamingMarkdown("intro\n\n```ts\nconst x = 1;")).toEqual({
      stableMarkdown: "intro\n\n",
      pendingSource: "```ts\nconst x = 1;"
    });
  });

  it("holds an unfinished table group instead of partially rendering it", () => {
    expect(splitStreamingMarkdown("intro\n\n| A | B |\n| --- | --- |\n| 1 |")).toEqual({
      stableMarkdown: "intro\n\n",
      pendingSource: "| A | B |\n| --- | --- |\n| 1 |"
    });
  });

  it("converts alternate math delimiters outside code fences", () => {
    const input = "Use \\(x+1\\).\n\n\\[x^2\\]\n\n```txt\n\\(keep\\)\n```";
    expect(normalizeObsidianMarkdown(input)).toBe(
      "Use $x+1$.\n\n$$\nx^2\n$$\n\n```txt\n\\(keep\\)\n```"
    );
  });

  it("closes unambiguous block math and fenced code at completion", () => {
    expect(normalizeObsidianMarkdown("$$\nx^2")).toBe("$$\nx^2\n$$");
    expect(normalizeObsidianMarkdown("```js\nconsole.log(1)")).toBe(
      "```js\nconsole.log(1)\n```"
    );
  });

  it("adds an obvious missing table separator conservatively", () => {
    expect(normalizeObsidianMarkdown("| A | B |\n| 1 | 2 |")).toBe(
      "| A | B |\n| --- | --- |\n| 1 | 2 |"
    );
  });
});
