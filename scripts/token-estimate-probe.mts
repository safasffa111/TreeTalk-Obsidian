import { buildProgressiveSystemPrompt, buildProgressiveInitialUserMessage, buildProgressiveAvailabilityMessage } from "../src/agent/pi/progressive/progressive-prompts";
import { estimateTextTokens } from "../src/domain/context-engine";
import { buildRequestContextTool } from "../src/agent/pi/progressive/semantic-context";
import type { ProgressiveEvidenceBatch } from "../src/agent/pi/progressive/types";

const systemPrompt = buildProgressiveSystemPrompt(true, false);
const tools = [buildRequestContextTool([], false)];
const initialEvidence: ProgressiveEvidenceBatch = {
  id: "probe-evidence", level: 2, sourceKind: "conversation-node", sourceId: "probe",
  sourceRevision: "probe", title: "父回答 · 末尾", relationship: "structural-parent-tail",
  content: "这是模拟的结构父文本末尾内容：TCP 三次握手建立连接，四次挥手释放连接。",
  estimatedTokens: 30, truncated: false, hasMoreFromSource: false, relatedNote: false, notePaths: [], nodeIds: []
};
const initialUser = buildProgressiveInitialUserMessage({ question: "请基于已有内容回答：TCP 为什么可靠？", initialEvidence, contextDivergenceEnabled: true });
const avail1 = buildProgressiveAvailabilityMessage(["current_section", "current_source"], false, false);
const avail2 = buildProgressiveAvailabilityMessage(["current_source", "related_sections"], false, false);
const messages1 = [initialUser, avail1];
const messages2 = [...messages1,
  { role: "assistant", content: "", toolCalls: [{ id: "call-probe-1", name: "request_context", arguments: { target: "current_source", reason: "需要更多上下文" } }] },
  { role: "toolResult", toolCallId: "call-probe-1", toolName: "request_context", content: JSON.stringify({ source: "TreeTalk", scope: "partial-source", remaining: true, content: "补充证据：TCP 通过序号、确认应答、重传与流量控制保证可靠传输。" }), isError: false },
  { role: "user", content: avail2 }
];
function estimate(messages) {
  let total = 2;
  for (const m of messages) total += estimateTextTokens(typeof m === "string" ? m : m.content) + 4;
  total += estimateTextTokens(systemPrompt) + 4;
  for (const tool of tools) total += estimateTextTokens(tool.description) + estimateTextTokens(JSON.stringify(tool.parameters)) + 8;
  return total;
}
console.log("request-1 estimate:", estimate(messages1), " actual:", 679, " ratio:", (estimate(messages1)/679).toFixed(2));
console.log("request-2 estimate:", estimate(messages2), " actual:", 801, " ratio:", (estimate(messages2)/801).toFixed(2));
console.log("system prompt chars:", [...systemPrompt].length, "estimated:", estimateTextTokens(systemPrompt));
