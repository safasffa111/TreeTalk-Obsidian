import { buildProgressiveSystemPrompt, buildProgressiveInitialUserMessage, buildProgressiveAvailabilityMessage } from "../src/agent/pi/progressive/progressive-prompts";
import { buildRequestContextTool } from "../src/agent/pi/progressive/semantic-context";
import { buildPiProviderRequest } from "../src/agent/pi/pi-provider-transport";
import type { PiConversationMessage } from "../src/agent/pi/pi-provider-transport";
import type { ProgressiveEvidenceBatch } from "../src/agent/pi/progressive/types";
import type { ProviderProfile } from "../src/providers/types";

const apiKey = process.env.DEEPSEEK_API_KEY?.trim() ?? "";
const keyFile = "D:\\treetalk-key.txt";
if (apiKey.length === 0 && (await import("node:fs")).existsSync(keyFile)) {
  const fs = await import("node:fs");
  const raw = fs.readFileSync(keyFile, "utf8").trim();
  if (raw.length > 0) (globalThis as Record<string, unknown>).__probeKey = raw;
}
const key = apiKey.length > 0 ? apiKey : ((globalThis as Record<string, unknown>).__probeKey as string | undefined) ?? "";
if (key.length === 0) {
  console.error("No API key. Set $env:DEEPSEEK_API_KEY or write the key to D:\\treetalk-key.txt");
  process.exit(2);
}
console.log("Key loaded (masked): " + key.slice(0, 3) + "***" + key.slice(-4));

const profile: ProviderProfile = {
  id: "deepseek",
  name: "DeepSeek",
  kind: "deepseek",
  apiKey: key,
  baseUrl: ""
};
const modelId = "deepseek-v4-flash";

const systemPrompt = buildProgressiveSystemPrompt(true, false);
const tools = [buildRequestContextTool([], false)];
const initialEvidence: ProgressiveEvidenceBatch = {
  id: "probe-evidence",
  level: 2,
  sourceKind: "conversation-node",
  sourceId: "probe",
  sourceRevision: "probe",
  title: "父回答 · 末尾",
  relationship: "structural-parent-tail",
  content: "这是模拟的结构父文本末尾内容：TCP 三次握手建立连接，四次挥手释放连接。",
  estimatedTokens: 30,
  truncated: false,
  hasMoreFromSource: false,
  relatedNote: false,
  notePaths: [],
  nodeIds: []
};
const initialUser = buildProgressiveInitialUserMessage({
  question: "请基于已有内容回答：TCP 为什么可靠？",
  initialEvidence,
  contextDivergenceEnabled: true
});
const avail1 = buildProgressiveAvailabilityMessage(["current_section", "current_source"], false, false);
const avail2 = buildProgressiveAvailabilityMessage(["current_source", "related_sections"], false, false);

const messages1: PiConversationMessage[] = [
  { role: "user", content: initialUser },
  { role: "user", content: avail1 }
];
const messages2: PiConversationMessage[] = [
  ...messages1,
  {
    role: "assistant",
    content: "",
    toolCalls: [{ id: "call-probe-1", name: "request_context", arguments: { target: "current_source", reason: "需要更多上下文" } }]
  },
  {
    role: "toolResult",
    toolCallId: "call-probe-1",
    toolName: "request_context",
    content: JSON.stringify({ source: "TreeTalk", scope: "partial-source", remaining: true, content: "补充证据：TCP 通过序号、确认应答、重传与流量控制保证可靠传输。" }),
    isError: false
  },
  { role: "user", content: avail2 }
];

function requestFor(messages: PiConversationMessage[]) {
  return buildPiProviderRequest({
    profile,
    modelId,
    systemPrompt,
    messages,
    tools,
    maxOutputTokens: 256,
    stream: false,
    thinkingEnabled: false
  });
}

function maskKey(value: string): string {
  return value.replaceAll(key, "sk-***");
}

async function send(label: string, messages: PiConversationMessage[]) {
  const req = requestFor(messages);
  const body = JSON.stringify(req.body);
  console.log(`\n[${label}] POST ${req.url}`);
  console.log(`[${label}] messages=${messages.length} tools=${req.body.tools.length} input-json-bytes=${body.length}`);
  const response = await fetch(req.url, { method: req.method, headers: req.headers, body, signal: AbortSignal.timeout(120000) });
  const json = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    console.error(`[${label}] HTTP ${response.status}: ${maskKey(JSON.stringify(json))}`);
    process.exit(1);
  }
  const usage = (json.usage ?? {}) as Record<string, unknown>;
  const hit = Number(usage.prompt_cache_hit_tokens ?? 0);
  const miss = Number(usage.prompt_cache_miss_tokens ?? 0);
  const prompt = Number(usage.prompt_tokens ?? 0);
  console.log(`[${label}] prompt_tokens=${prompt} cache_hit=${hit} cache_miss=${miss}` +
    ` hit_ratio=${prompt === 0 ? 0 : (hit / prompt * 100).toFixed(1)}%`);
  return { hit, miss, prompt, usage };
}

const first = await send("request-1 (initial+avail1)", messages1);
const second = await send("request-2 (same prefix + tool append)", messages2);

console.log("\n=== 结果 ===");
console.log(`请求1: 全部 miss（预期）`);
console.log(`请求2: 前缀命中 ${second.hit} tokens / 总输入 ${second.prompt} tokens（预期 ≈ 请求1 输入减去尾部差异）`);
console.log(`前缀复用率: ${second.prompt === 0 ? 0 : (second.hit / second.prompt * 100).toFixed(1)}%`);
