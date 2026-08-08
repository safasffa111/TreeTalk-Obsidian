import { describe, expect, it } from "vitest";
import { estimateTextTokens } from "../../../src/domain/context-engine";
import { createStructuralParentDigest } from "../../../src/agent/pi/progressive/structural-parent-context";
import {
  buildProgressiveInitialUserMessage,
  formatProvenanceList
} from "../../../src/agent/pi/progressive/progressive-prompts";

describe("createStructuralParentDigest", () => {
  it("returns the full short answer without truncation", () => {
    const result = createStructuralParentDigest("结论：A。\n\n细节。");
    expect(result.truncated).toBe(false);
    expect(result.content).toContain("结论");
  });

  it("combines the opening conclusion with the tail for long answers", () => {
    const body = `结论：核心结论。\n\n${"中间内容。".repeat(2000)}\n\n结尾标记。`;
    const result = createStructuralParentDigest(body);
    expect(result.truncated).toBe(true);
    expect(result.content).toMatch(/^结论：核心结论/u);
    expect(result.content).toContain("结尾标记");
    expect(result.content).toContain("中略");
    expect(estimateTextTokens(result.content)).toBeLessThan(800);
  });
});

describe("formatProvenanceList", () => {
  it("deduplicates entries by title and labels the level", () => {
    const text = formatProvenanceList([
      {
        level: 2,
        title: "笔记A · 章节一",
        relationship: "target-full-source",
        notePaths: ["A.md"],
        nodeIds: []
      },
      {
        level: 3,
        title: "笔记B · 结论",
        relationship: "related-note-depth-1",
        notePaths: ["B.md"],
        nodeIds: []
      },
      {
        level: 3,
        title: "笔记A · 章节一",
        relationship: "target-full-source",
        notePaths: ["A.md"],
        nodeIds: []
      }
    ]);
    expect(text).toBe("- 笔记A · 章节一（L2）\n- 笔记B · 结论（L3）");
  });

  it("returns undefined for an empty list", () => {
    expect(formatProvenanceList([])).toBeUndefined();
  });
});

describe("buildProgressiveInitialUserMessage continue sections", () => {
  const evidence = {
    id: "b",
    level: 2 as const,
    sourceKind: "conversation-node" as const,
    sourceId: "parent",
    sourceRevision: "r",
    title: "父回答 · 结论与结尾",
    relationship: "structural-parent-digest",
    content: "父回答摘要",
    estimatedTokens: 20,
    truncated: false,
    hasMoreFromSource: true,
    relatedNote: false,
    notePaths: [],
    nodeIds: ["parent"]
  };

  it("injects provenance and the continuation constraint in continue mode", () => {
    const message = buildProgressiveInitialUserMessage({
      question: "继续",
      initialEvidence: evidence,
      contextDivergenceEnabled: false,
      continueMode: true,
      continueProvenance: "- 笔记A · 章节一（L2）"
    });
    expect(message).toContain("已提供上一轮回答的开头结论与结尾");
    expect(message).toContain("# 上一轮回答依据");
    expect(message).toContain("- 笔记A · 章节一（L2）");
    expect(message).toContain("# 续问约束");
    expect(message).toContain("这是对上一轮回答的延续");
  });

  it("omits the sections when not continuing", () => {
    const message = buildProgressiveInitialUserMessage({
      question: "新问题",
      initialEvidence: evidence,
      contextDivergenceEnabled: false
    });
    expect(message).not.toContain("上一轮回答依据");
    expect(message).not.toContain("续问约束");
  });
});
