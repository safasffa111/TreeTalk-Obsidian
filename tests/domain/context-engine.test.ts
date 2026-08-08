import { describe, expect, it } from "vitest";
import {
  cacheKeyForContextPlan,
  compileContextPlan,
  trimAssistantMarkdown
} from "../../src/domain/context-engine";
import { validConversation } from "../fixtures";

function message(
  id: string,
  role: "user" | "assistant",
  content: string,
  now: string
) {
  return {
    id,
    role,
    content,
    status: "complete" as const,
    createdAt: now,
    updatedAt: now
  };
}

describe("cache-aware tree context compiler", () => {
  it("keeps only the active branch and trims old assistant Markdown in balanced mode", () => {
    const conversation = validConversation();
    const now = conversation.createdAt;
    conversation.nodes.root!.messages = [
      message("u1", "user", "根问题", now),
      message(
        "a1",
        "assistant",
        [
          "# 定义",
          "",
          "必须保持分支隔离。",
          "",
          "普通解释。".repeat(600),
          "",
          "```ts",
          "import x from 'x';",
          ...Array.from({ length: 120 }, (_, index) =>
            `function f${String(index)}() { return ${String(index)}; }`
          ),
          "```",
          "",
          "## 总结",
          "最终结论不能丢。"
        ].join("\n"),
        now
      )
    ];
    conversation.nodes.child!.messages = [
      message("u2", "user", "问题二", now),
      message("a2", "assistant", "回答二", now),
      message("u3", "user", "问题三", now),
      message("a3", "assistant", "回答三", now),
      message("u4", "user", "当前问题", now)
    ];
    conversation.nodes.sibling = {
      ...structuredClone(conversation.nodes.child!),
      id: "sibling",
      parentId: "root",
      messages: [message("s1", "user", "兄弟分支秘密", now)]
    };
    conversation.nodes.root!.childIds = ["child", "sibling"];

    const plan = compileContextPlan(conversation, "child", {
      mode: "balanced",
      systemPrompt: "固定规则",
      maxInputTokens: 900,
      recentRoundTarget: 4,
      minRecentRounds: 2,
      maxRecentRounds: 6
    });
    const rendered = plan.messages.map((item) => item.content).join("\n");

    expect(rendered).not.toContain("兄弟分支秘密");
    expect(rendered).toContain("当前问题");
    expect(rendered).toContain("最终结论不能丢");
    expect(rendered).toContain("TreeTalk 已压缩历史内容");
    expect(plan.sentEstimatedTokens).toBeLessThan(plan.fullEstimatedTokens);
  });

  it("keeps balanced mode byte-identical when there are only two completed rounds", () => {
    const conversation = validConversation();
    const now = conversation.createdAt;
    conversation.nodes.root!.messages = [
      message("u1", "user", "问题一", now),
      message("a1", "assistant", "回答一原文", now)
    ];
    conversation.nodes.child!.messages = [
      message("u2", "user", "问题二", now),
      message("a2", "assistant", "回答二原文", now),
      message("u3", "user", "当前问题", now)
    ];

    const plan = compileContextPlan(conversation, "child", {
      mode: "balanced",
      systemPrompt: "system",
      maxInputTokens: 100000
    });

    expect(plan.messages.map((item) => item.content)).toEqual([
      "system",
      "问题一",
      "回答一原文",
      "问题二",
      "回答二原文",
      "当前问题"
    ]);
    expect(plan.reducedTokens).toBe(0);
  });

  it("preserves the active branch exactly in full mode", () => {
    const conversation = validConversation();
    const now = conversation.createdAt;
    conversation.nodes.root!.messages = [
      message("u1", "user", "root", now),
      message("a1", "assistant", "A".repeat(5000), now)
    ];
    conversation.nodes.child!.messages = [
      message("u2", "user", "current", now)
    ];

    const plan = compileContextPlan(conversation, "child", {
      mode: "full",
      systemPrompt: "system",
      maxInputTokens: 100
    });

    expect(plan.messages.map((item) => item.content)).toEqual([
      "system",
      "root",
      "A".repeat(5000),
      "current"
    ]);
    expect(plan.reducedTokens).toBe(0);
    expect(cacheKeyForContextPlan(conversation.id, plan)).toBe(
      `treetalk:${conversation.id}:full:v1`
    );
  });

  it("creates versioned cache routing keys for both context modes", () => {
    expect(
      cacheKeyForContextPlan("conversation-1", { mode: "balanced" })
    ).toBe("treetalk:conversation-1:balanced:v3");
    expect(
      cacheKeyForContextPlan("conversation-1", { mode: "full" })
    ).toBe("treetalk:conversation-1:full:v1");
  });

  it("never leaves a structurally trimmed code fence open", () => {
    const compact = trimAssistantMarkdown(
      [
        "```ts",
        ...Array.from({ length: 300 }, (_, index) =>
          `function f${String(index)}() { return ${String(index)}; }`
        ),
        "```"
      ].join("\n"),
      180
    );

    expect((compact.match(/```/gu) ?? [])).toHaveLength(2);
    expect(compact).toContain("TreeTalk 为控制上下文长度省略了未引用代码");
  });

  it("protects selected Markdown blocks in old assistant answers", () => {
    const conversation = validConversation();
    const now = conversation.createdAt;
    const oldAnswer = [
      "# 总主题",
      "",
      "开头结论。",
      "",
      "## 关键章节",
      "",
      "普通铺垫。".repeat(220),
      "",
      "精确框选内容必须保留。",
      "",
      "普通扩展。".repeat(220),
      "",
      "## 总结",
      "",
      "最终结论。"
    ].join("\n");
    conversation.nodes.root!.messages = [
      message("u1", "user", "问题一", now),
      message("a1", "assistant", oldAnswer, now)
    ];
    conversation.nodes.child!.messages = [
      message("u2", "user", "问题二", now),
      message("a2", "assistant", "回答二", now),
      {
        ...message("u3", "user", "问题三", now),
        selectionContexts: [{
          messageId: "a1",
          sourceNodeId: "root",
          sourceRole: "assistant" as const,
          basis: "rendered-text-v1" as const,
          startOffset: 0,
          endOffset: 12,
          quote: "精确框选内容必须保留。",
          prefix: "",
          suffix: "",
          contentHash: "hash"
        }]
      },
      message("a3", "assistant", "回答三", now),
      message("u4", "user", "当前问题", now)
    ];

    const plan = compileContextPlan(conversation, "child", {
      mode: "balanced",
      systemPrompt: "system",
      maxInputTokens: 100000
    });
    const oldSent = plan.messages[2]?.content ?? "";

    expect(oldSent).toContain("# 总主题");
    expect(oldSent).toContain("## 关键章节");
    expect(oldSent).toContain("精确框选内容必须保留。");
    expect(oldSent).toContain("TreeTalk 已省略部分较早的回答");
  });

  it("keeps an old source answer whole when a selection anchor is ambiguous", () => {
    const conversation = validConversation();
    const now = conversation.createdAt;
    const oldAnswer = [
      "# 内容",
      "",
      "重复目标。",
      "",
      "无关说明。".repeat(240),
      "",
      "重复目标。",
      "",
      "最终结论。"
    ].join("\n");
    conversation.nodes.root!.messages = [
      message("u1", "user", "问题一", now),
      message("a1", "assistant", oldAnswer, now)
    ];
    conversation.nodes.child!.messages = [
      message("u2", "user", "问题二", now),
      message("a2", "assistant", "回答二", now),
      {
        ...message("u3", "user", "问题三", now),
        selectionContexts: [{
          messageId: "a1",
          sourceNodeId: "root",
          sourceRole: "assistant" as const,
          basis: "rendered-text-v1" as const,
          startOffset: 4,
          endOffset: 9,
          quote: "重复目标。",
          prefix: "",
          suffix: "",
          contentHash: "hash"
        }]
      },
      message("a3", "assistant", "回答三", now),
      message("u4", "user", "当前问题", now)
    ];

    const plan = compileContextPlan(conversation, "child", {
      mode: "balanced",
      systemPrompt: "system",
      maxInputTokens: 100000
    });

    expect(plan.messages[2]?.content).not.toBe(oldAnswer);
    expect(plan.messages[2]?.content).toContain(
      "TreeTalk 已省略部分较早的回答"
    );
    const serialized = plan.messages
      .map((message) => message.content)
      .join("\n---\n");
    expect(serialized).toContain("[TreeTalk 恢复引用]");
  });

  it("uses a stronger deterministic pass only when the hard budget is exceeded", () => {
    const conversation = validConversation();
    const now = conversation.createdAt;
    const longAnswer = (label: string): string => [
      `# ${label}`,
      "",
      "核心结论。",
      ...Array.from({ length: 24 }, (_, index) => `\n\n中性说明 ${String(index)}：${"内容。".repeat(45)}`),
      "",
      "## 总结",
      "",
      "最终结论。"
    ].join("");
    conversation.nodes.root!.messages = [
      message("u1", "user", "问题一", now),
      message("a1", "assistant", longAnswer("旧回答一"), now)
    ];
    conversation.nodes.child!.messages = [
      message("u2", "user", "问题二", now),
      message("a2", "assistant", longAnswer("旧回答二"), now),
      message("u3", "user", "问题三", now),
      message("a3", "assistant", "回答三原文", now),
      message("u4", "user", "问题四", now),
      message("a4", "assistant", "回答四原文", now),
      message("u5", "user", "当前问题", now)
    ];

    const roomy = compileContextPlan(conversation, "child", {
      mode: "balanced",
      systemPrompt: "system",
      maxInputTokens: 100000
    });
    const constrained = compileContextPlan(conversation, "child", {
      mode: "balanced",
      systemPrompt: "system",
      maxInputTokens: Math.max(500, Math.floor(roomy.sentEstimatedTokens * 0.8))
    });

    expect(constrained.sentEstimatedTokens).toBeLessThan(roomy.sentEstimatedTokens);
    expect(constrained.messages.at(-4)?.content).toBe("回答三原文");
    expect(constrained.messages.at(-2)?.content).toBe("回答四原文");
    expect(constrained.messages.at(-1)?.content).toBe("当前问题");
    expect(compileContextPlan(conversation, "child", {
      mode: "balanced",
      systemPrompt: "system",
      maxInputTokens: Math.max(500, Math.floor(roomy.sentEstimatedTokens * 0.8))
    })).toEqual(constrained);
  });

});
