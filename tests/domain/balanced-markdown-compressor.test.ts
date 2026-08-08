import { describe, expect, it } from "vitest";
import {
  compressAssistantMarkdown,
  parseStructuredMarkdown,
  resolveSelectionInMarkdown
} from "../../src/domain/balanced-markdown-compressor";
import type { SelectionAnchor } from "../../src/domain/types";

function anchor(overrides: Partial<SelectionAnchor> = {}): SelectionAnchor {
  return {
    messageId: "a1",
    sourceNodeId: "root",
    sourceRole: "assistant",
    basis: "rendered-text-v1",
    startOffset: 0,
    endOffset: 4,
    quote: "关键结论",
    prefix: "前文",
    suffix: "后文",
    contentHash: "hash",
    ...overrides
  };
}

describe("balanced Markdown compressor", () => {
  it("parses Obsidian Markdown into source-offset-preserving blocks", () => {
    const markdown = [
      "# 标题",
      "",
      "普通段落。",
      "",
      "- 项目一",
      "- 项目二",
      "",
      "> [!note]- 提示",
      "> 引用正文",
      "",
      "| 名称 | 值 |",
      "| --- | --- |",
      "| A | 1 |",
      "",
      "```ts",
      "const value = 1;",
      "```",
      "",
      "$$",
      "x^2=1",
      "$$"
    ].join("\n");

    const parsed = parseStructuredMarkdown(markdown);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.blocks.map((block) => block.kind)).toEqual([
      "heading",
      "paragraph",
      "list",
      "quote",
      "table",
      "code",
      "math"
    ]);
    for (const block of parsed.blocks) {
      expect(markdown.slice(block.startOffset, block.endOffset)).toBe(block.content);
    }
    expect(parsed.blocks[1]?.headingPath).toEqual(["标题"]);
  });

  it("uses an exact stored offset before treating repeated quotes as ambiguous", () => {
    const markdown = "关键结论 xx 关键结论";
    const secondStart = markdown.lastIndexOf("关键结论");
    const resolved = resolveSelectionInMarkdown(
      markdown,
      anchor({
        startOffset: secondStart,
        endOffset: secondStart + "关键结论".length,
        prefix: "",
        suffix: ""
      })
    );

    expect(resolved).toEqual({
      status: "resolved",
      start: secondStart,
      end: secondStart + "关键结论".length
    });
  });

  it("resolves source Markdown quotes and rejects ambiguous anchors", () => {
    const markdown = "# 结论\n\n前文关键结论后文\n\n另一个关键结论。";
    const resolved = resolveSelectionInMarkdown(
      markdown,
      anchor({ startOffset: 4, endOffset: 8 })
    );
    expect(resolved).toMatchObject({ status: "resolved" });
    if (resolved.status === "resolved") {
      expect(markdown.slice(resolved.start, resolved.end)).toBe("关键结论");
    }

    const ambiguous = resolveSelectionInMarkdown(
      "关键结论 xx 关键结论",
      anchor({ prefix: "", suffix: "", startOffset: 5, endOffset: 9 })
    );
    expect(ambiguous.status).toBe("unresolved");
  });

  it("keeps short answers byte-for-byte unchanged", () => {
    const markdown = "# 结论\n\n这是一个很短的回答。";
    expect(compressAssistantMarkdown(markdown).content).toBe(markdown);
  });

  it("compresses long old answers while preserving selected blocks and heading chain", () => {
    const markdown = [
      "# 总主题",
      "",
      "开头直接结论。",
      "",
      "## 原理",
      "",
      "普通铺垫。".repeat(180),
      "",
      "被框选的关键结论必须完整保留。",
      "",
      "普通扩展示例。".repeat(180),
      "",
      "## 总结",
      "",
      "最终结论。"
    ].join("\n");
    const start = markdown.indexOf("被框选的关键结论");
    const result = compressAssistantMarkdown(markdown, {
      protectedRanges: [{ start, end: start + "被框选的关键结论必须完整保留。".length }]
    });

    expect(result.compressed).toBe(true);
    expect(result.content).toContain("# 总主题");
    expect(result.content).toContain("## 原理");
    expect(result.content).toContain("被框选的关键结论必须完整保留。");
    expect(result.content).toContain("## 总结");
    expect(result.content).toContain("最终结论。");
    expect(result.content).toContain("TreeTalk 已压缩历史内容");
    expect(result.content.length).toBeLessThan(markdown.length);
    expect(compressAssistantMarkdown(markdown, {
      protectedRanges: [{ start, end: start + "被框选的关键结论必须完整保留。".length }]
    })).toEqual(result);
  });

  it("retains a high-priority conclusion block even under a tight local target", () => {
    const markdown = [
      "# 主题",
      "",
      "开头说明。",
      "",
      "普通展开。".repeat(180),
      "",
      "关键结论：必须保留这个决定。",
      "",
      "另一段普通展开。".repeat(180),
      "",
      "结束说明。"
    ].join("\n");

    const result = compressAssistantMarkdown(markdown, {
      targetRatio: 0.35,
      maxTokens: 96
    });

    expect(result.compressed).toBe(true);
    expect(result.content).toContain("关键结论：必须保留这个决定。");
  });

  it("keeps protected code, table, and math blocks structurally complete", () => {
    const markdown = [
      "# 资料",
      "",
      "铺垫。".repeat(200),
      "",
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "```ts",
      "function important() {",
      "  return 42;",
      "}",
      "```",
      "",
      "$$",
      "E = mc^2",
      "$$",
      "",
      "结论。"
    ].join("\n");
    const protectedRanges = ["| A | B |", "function important", "E = mc^2"].map((text) => {
      const start = markdown.indexOf(text);
      return { start, end: start + text.length };
    });
    const result = compressAssistantMarkdown(markdown, { protectedRanges });

    expect(result.content).toContain("| --- | --- |");
    expect(result.content).toContain("function important() {");
    expect((result.content.match(/```/gu) ?? [])).toHaveLength(2);
    expect((result.content.match(/\$\$/gu) ?? [])).toHaveLength(2);
  });
});
