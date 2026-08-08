import { parseConversation } from "./schema";
import type { ProviderMessage } from "./context-builder";
import type {
  ChatMessage,
  ConversationFile,
  ConversationNode
} from "./types";

export const NODE_SUMMARY_PROTOCOL = "node-summary:v3" as const;

export const NODE_SUMMARY_SYSTEM_PROMPT = [
  "TreeTalk Node Summary Protocol v3",
  "",
  "请根据父节点主题、框选内容、当前问题和回答节选，生成一个适合树状列表回溯的短索引标题。",
  "要求：",
  "1. 只输出一行标题。",
  "2. 中文目标为 4～10 个汉字，必要时最多 12 个字符。",
  "3. 英文目标为 2～6 个单词。",
  "4. 优先保留一个核心对象和一个关键关系。",
  "5. 标题应简短、直观、能够与相邻节点区分。",
  "6. 不完整复述用户问题。",
  "7. 不使用‘如何’‘为什么’‘怎么理解’等问句开头。",
  "8. 可以使用‘原因’‘作用’‘区别’‘机制’‘流程’‘故障’‘优化’等短关系词。",
  "9. 不生成过于模糊的单个名词，如‘问题’‘说明’‘功能’。",
  "10. 父节点只用于理解语境，不要机械拼接父节点标题。",
  "11. 不使用引号、句号、冒号、序号或 Markdown。",
  "12. 不回答问题，只生成标题。"
].join("\n");

export interface NodeSummaryPromptInput {
  parentTitle?: string;
  question: ChatMessage;
  answer: ChatMessage;
}

export interface NodeSummaryPrompt {
  messages: ProviderMessage[];
  parentTitle: string;
  selectionExcerpt: string;
  questionExcerpt: string;
  answerExcerpt: string;
}

function clip(value: string, limit: number): string {
  return [...value].slice(0, limit).join("");
}

function answerWithoutSources(value: string): string {
  const boundary = value.search(/^### 参考来源\s*$/mu);
  return (boundary < 0 ? value : value.slice(0, boundary)).trim();
}

function answerExcerpt(value: string): string {
  const clean = answerWithoutSources(value);
  const characters = [...clean];
  if (characters.length <= 1200) return clean;
  return `${characters.slice(0, 800).join("")}\n…\n${characters
    .slice(-400)
    .join("")}`;
}

export function buildNodeSummaryPrompt(
  input: NodeSummaryPromptInput
): NodeSummaryPrompt {
  const parentTitle = clip(input.parentTitle?.trim() || "无", 40);
  const selectionExcerpt = clip(
    (input.question.selectionContexts ?? [])
      .map((context) => context.quote.trim())
      .filter((quote) => quote.length > 0)
      .join("\n\n"),
    300
  );
  const questionExcerpt = clip(input.question.content.trim(), 500);
  const excerpt = answerExcerpt(input.answer.content);
  const user = [
    "[父节点提要]",
    parentTitle,
    "",
    "[框选原文]",
    selectionExcerpt || "无",
    "",
    "[当前问题]",
    questionExcerpt,
    "",
    "[AI 回答节选]",
    excerpt
  ].join("\n");
  return {
    messages: [
      { role: "system", content: NODE_SUMMARY_SYSTEM_PROMPT },
      { role: "user", content: user }
    ],
    parentTitle,
    selectionExcerpt,
    questionExcerpt,
    answerExcerpt: excerpt
  };
}

export function cleanNodeSummaryTitle(value: string): string | undefined {
  const firstLine = value.split(/\r?\n/u)[0] ?? "";
  let title = firstLine
    .replace(/^\s{0,3}#{1,6}\s*/u, "")
    .replace(/^\s*(?:[-*+] |\d+[.)]\s*)/u, "")
    .trim()
    .replace(/^["'“”‘’「」『』《》]+|["'“”‘’「」『』《》]+$/gu, "")
    .trim()
    .replace(/[。！？!?；;：:、,.，]+$/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  const hasHan = /\p{Script=Han}/u.test(title);
  if (hasHan) {
    title = [...title].slice(0, 12).join("").trim();
  } else {
    title = title.split(/\s+/u).slice(0, 6).join(" ").trim();
    title = [...title].slice(0, 40).join("").trim();
  }
  if (title.length === 0) return undefined;
  if (/^(?:本节点|本段|本文|这段内容|关于)/u.test(title)) return undefined;
  return title;
}

function canRepairLegacySummary(node: ConversationNode): boolean {
  return (
    node.summary?.protocol === "node-summary:v1" &&
    node.summary.status !== "complete"
  );
}

export function canAttemptNodeSummary(node: ConversationNode): boolean {
  return (
    (node.summary === undefined || canRepairLegacySummary(node)) &&
    node.titleSource === "question" &&
    node.messages.some(
      (message) => message.role === "assistant" && message.status === "complete"
    )
  );
}

function mutable(
  conversation: ConversationFile,
  nodeId: string
): { next: ConversationFile; node: ConversationNode } {
  const next = structuredClone(conversation);
  const node = next.nodes[nodeId];
  if (node === undefined) throw new Error(`Node not found: ${nodeId}`);
  return { next, node };
}

function commit(
  conversation: ConversationFile,
  node: ConversationNode,
  now: string
): ConversationFile {
  node.updatedAt = now;
  conversation.updatedAt = now;
  conversation.revision += 1;
  return parseConversation(conversation);
}

export function markNodeSummaryPending(
  conversation: ConversationFile,
  input: {
    nodeId: string;
    now: string;
    providerProfileId: string;
    modelId: string;
  }
): ConversationFile {
  const { next, node } = mutable(conversation, input.nodeId);
  if (node.summary !== undefined && !canRepairLegacySummary(node)) {
    return parseConversation(next);
  }
  node.summary = {
    protocol: NODE_SUMMARY_PROTOCOL,
    status: "pending",
    attemptedAt: input.now,
    providerProfileId: input.providerProfileId,
    modelId: input.modelId
  };
  return commit(next, node, input.now);
}

export function applyNodeSummarySuccess(
  conversation: ConversationFile,
  input: { nodeId: string; title: string; now: string }
): ConversationFile {
  const { next, node } = mutable(conversation, input.nodeId);
  const generatedTitle = cleanNodeSummaryTitle(input.title);
  if (generatedTitle === undefined) {
    return applyNodeSummaryFailure(conversation, {
      nodeId: input.nodeId,
      now: input.now
    });
  }
  const existing = node.summary;
  if (existing === undefined) return parseConversation(next);
  node.summary = {
    ...existing,
    status: "complete",
    completedAt: input.now,
    generatedTitle
  };
  if (node.titleSource !== "manual") {
    node.title = generatedTitle;
    node.titleSource = "auto";
    if (node.id === next.rootNodeId) next.title = generatedTitle;
  }
  return commit(next, node, input.now);
}

export function applyNodeSummaryFailure(
  conversation: ConversationFile,
  input: { nodeId: string; now: string }
): ConversationFile {
  const { next, node } = mutable(conversation, input.nodeId);
  if (node.summary === undefined) return parseConversation(next);
  node.summary = {
    ...node.summary,
    status: "failed",
    completedAt: input.now
  };
  return commit(next, node, input.now);
}
