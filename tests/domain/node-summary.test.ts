import { describe, expect, it } from "vitest";
import {
  applyNodeSummaryFailure,
  applyNodeSummarySuccess,
  buildNodeSummaryPrompt,
  canAttemptNodeSummary,
  cleanNodeSummaryTitle,
  markNodeSummaryPending
} from "../../src/domain/node-summary";
import type { ChatMessage } from "../../src/domain/types";
import { validConversation } from "../fixtures";

const NOW = "2026-08-01T08:00:00.000Z";

function message(
  role: "user" | "assistant",
  content: string,
  id: string
): ChatMessage {
  return {
    id,
    role,
    content,
    status: "complete",
    createdAt: NOW,
    updatedAt: NOW
  };
}

describe("node summaries", () => {
  it("builds the compact four-field prompt with deterministic limits", () => {
    const question = message("user", "Q".repeat(700), "q");
    question.selectionContexts = [
      {
        messageId: "a",
        sourceNodeId: "root",
        sourceRole: "assistant",
        basis: "rendered-text-v1",
        startOffset: 0,
        endOffset: 350,
        quote: "S".repeat(350),
        prefix: "",
        suffix: "",
        contentHash: "hash"
      }
    ];
    const answer = message(
      "assistant",
      `${"A".repeat(900)}${"Z".repeat(500)}\n\n### 参考来源\n\n- [Example](https://example.com)`,
      "a"
    );

    const prompt = buildNodeSummaryPrompt({
      parentTitle: "P".repeat(60),
      question,
      answer
    });

    expect([...prompt.parentTitle]).toHaveLength(40);
    expect([...prompt.selectionExcerpt]).toHaveLength(300);
    expect([...prompt.questionExcerpt]).toHaveLength(500);
    expect(prompt.answerExcerpt).toBe(
      `${"A".repeat(800)}\n…\n${"Z".repeat(400)}`
    );
    expect(prompt.messages.map((entry) => entry.content).join("\n")).not.toContain(
      "example.com"
    );
    const systemPrompt = prompt.messages[0]?.content ?? "";
    expect(systemPrompt).toContain("4～10 个汉字");
    expect(systemPrompt).toContain("核心对象和一个关键关系");
    expect(systemPrompt).toContain("不要机械拼接父节点标题");
  });

  it("cleans one-line names and rejects generic sentence prefixes", () => {
    expect(cleanNodeSummaryTitle('### “旧回答冻结裁剪机制说明补充文字。”\n解释')).toBe(
      "旧回答冻结裁剪机制说明补"
    );
    expect(cleanNodeSummaryTitle("Cache Hit Cost Reduction Strategy Notes")).toBe(
      "Cache Hit Cost Reduction Strategy Notes"
    );
    expect(cleanNodeSummaryTitle("One Two Three Four Five Six Seven")).toBe(
      "One Two Three Four Five Six"
    );
    expect(cleanNodeSummaryTitle("本节点讨论了端口号的作用")).toBeUndefined();
    expect(cleanNodeSummaryTitle("   ")).toBeUndefined();
  });

  it("does not backfill legacy nodes without title source metadata", () => {
    const conversation = validConversation();
    const root = conversation.nodes.root;
    if (root === undefined) throw new Error("Missing root");
    root.messages = [message("user", "旧问题", "q"), message("assistant", "旧回答", "a")];
    expect(root.titleSource).toBeUndefined();
    expect(canAttemptNodeSummary(root)).toBe(false);
  });

  it("repairs one failed v1 summary with the v3 protocol", () => {
    const conversation = validConversation();
    const root = conversation.nodes.root;
    if (root === undefined) throw new Error("Missing root");
    root.titleSource = "question";
    root.messages = [message("user", "问题", "q"), message("assistant", "回答", "a")];
    root.summary = {
      protocol: "node-summary:v1",
      status: "failed",
      attemptedAt: NOW,
      completedAt: NOW,
      providerProfileId: "default",
      modelId: "deepseek-v4-flash"
    };
    expect(canAttemptNodeSummary(root)).toBe(true);
    const next = markNodeSummaryPending(conversation, {
      nodeId: "root",
      now: NOW,
      providerProfileId: "default",
      modelId: "deepseek-v4-flash"
    });
    expect(next.nodes.root?.summary).toMatchObject({
      protocol: "node-summary:v3",
      status: "pending"
    });
  });

  it("persists one attempt, synchronizes roots, and preserves manual names", () => {
    const conversation = validConversation();
    const root = conversation.nodes.root;
    if (root === undefined) throw new Error("Missing root");
    root.titleSource = "question";
    root.messages = [message("user", "问题", "q"), message("assistant", "回答", "a")];
    expect(canAttemptNodeSummary(root)).toBe(true);

    let next = markNodeSummaryPending(conversation, {
      nodeId: "root",
      now: NOW,
      providerProfileId: "default",
      modelId: "model"
    });
    next = applyNodeSummarySuccess(next, {
      nodeId: "root",
      title: "TCP 可靠传输机制",
      now: NOW
    });
    expect(next.title).toBe("TCP 可靠传输机制");
    expect(next.nodes.root?.titleSource).toBe("auto");
    expect(canAttemptNodeSummary(next.nodes.root!)).toBe(false);

    next = structuredClone(next);
    const child = next.nodes.child;
    if (child === undefined) throw new Error("Missing child");
    child.title = "人工名称";
    child.titleSource = "manual";
    child.summary = {
      protocol: "node-summary:v2",
      status: "pending",
      attemptedAt: NOW,
      providerProfileId: "default",
      modelId: "model"
    };
    next = applyNodeSummarySuccess(next, {
      nodeId: "child",
      title: "自动名称",
      now: NOW
    });
    expect(next.nodes.child?.title).toBe("人工名称");
    expect(next.nodes.child?.summary?.generatedTitle).toBe("自动名称");
    next = applyNodeSummaryFailure(next, { nodeId: "child", now: NOW });
    expect(next.nodes.child?.title).toBe("人工名称");
  });
});
