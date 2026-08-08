import { buildProgressiveSystemPrompt } from "../src/agent/pi/progressive/progressive-prompts";
import { buildRequestContextTool } from "../src/agent/pi/progressive/semantic-context";
import { buildPiProviderRequest } from "../src/agent/pi/pi-provider-transport";
import type { PiConversationMessage } from "../src/agent/pi/pi-provider-transport";
import type { ProviderProfile } from "../src/providers/types";

const apiKey = process.env.DEEPSEEK_API_KEY?.trim() ?? "";
const keyFile = "D:\\treetalk-key.txt";
if (apiKey.length === 0 && (await import("node:fs")).existsSync(keyFile)) {
  const fs = await import("node:fs");
  const raw = fs.readFileSync(keyFile, "utf8").trim();
  if (raw.length > 0) (globalThis as Record<string, unknown>).__probeKey = raw;
}
const key = apiKey.length > 0 ? apiKey : ((globalThis as Record<string, unknown>).__probeKey as string | undefined) ?? "";
if (key.length === 0) { console.error("No key"); process.exit(2); }
console.log("Key loaded (masked): " + key.slice(0, 3) + "***" + key.slice(-4));

const profile: ProviderProfile = { id: "deepseek", name: "DeepSeek", kind: "deepseek", apiKey: key, baseUrl: "" };
const modelId = "deepseek-v4-flash";
const systemPrompt = buildProgressiveSystemPrompt(true, false);
const tools = [buildRequestContextTool([], false)];
const user1 = "# 当前任务\n请基于笔记内容回答：TCP 为什么可靠？\n\n# 结构语境\n已提供当前结构父文本的末尾内容。\n\n父文本：可靠传输依赖确认与重传。";
const avail1 = "本轮可用接口：current_section、current_source。";
const avail2 = "本轮可用接口：related_sections。";

function maskKey(value: string): string { return value.replaceAll(key, "sk-***"); }

async function send(label: string, messages: PiConversationMessage[], thinkingEnabled: boolean) {
  const req = buildPiProviderRequest({ profile, modelId, systemPrompt, messages, tools, maxOutputTokens: 512, stream: false, thinkingEnabled });
  const body = JSON.stringify(req.body);
  const started = Date.now();
  const response = await fetch(req.url, { method: req.method, headers: req.headers, body, signal: AbortSignal.timeout(120000) });
  const json = (await response.json()) as Record<string, unknown>;
  const ms = Date.now() - started;
  console.log(`\n[${label}] status=${response.status} (${ms}ms) thinking=${thinkingEnabled ? "enabled" : "disabled"} messages=${messages.length}`);
  if (!response.ok) {
    console.log(`[${label}] ERROR BODY: ${maskKey(JSON.stringify(json))}`);
    return undefined;
  }
  const choice = (json.choices as Array<Record<string, unknown>> | undefined)?.[0];
  const message = (choice?.message ?? {}) as Record<string, unknown>;
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls as Array<Record<string, unknown>> : [];
  const reasoning = typeof message.reasoning_content === "string" ? message.reasoning_content : "";
  const text = typeof message.content === "string" ? message.content : "";
  console.log(`[${label}] finish_reason=${String(choice?.finish_reason)} tool_calls=${calls.length} reasoning_chars=${reasoning.length} text_chars=${text.length}`);
  const usage = (json.usage ?? {}) as Record<string, unknown>;
  console.log(`[${label}] usage prompt=${String(usage.prompt_tokens)} completion=${String(usage.completion_tokens)}`);
  return { message, calls, reasoning };
}

const turn1 = await send("T1 thinking-enabled", [
  { role: "user", content: user1 },
  { role: "user", content: avail1 }
], true);

const replayMessages: PiConversationMessage[] = [
  { role: "user", content: user1 },
  { role: "user", content: avail1 },
  {
    role: "assistant",
    content: "",
    reasoningContent: turn1?.reasoning ?? "模拟思考内容（用于验证回传是否被接受）。",
    toolCalls: [{ id: "call-real-1", name: "request_context", arguments: { target: "current_source", reason: "需要更多上下文" } }]
  },
  {
    role: "toolResult",
    toolCallId: "call-real-1",
    toolName: "request_context",
    content: JSON.stringify({ source: "TreeTalk", scope: "partial-source", remaining: true, content: "补充证据：TCP 通过确认、重传与流量控制保证可靠传输。" }),
    isError: false
  },
  { role: "user", content: avail2 }
];
await send("T2 reasoning_content replay + tool (thinking enabled)", replayMessages, true);
await send("T3 reasoning_content replay + tool (thinking disabled)", replayMessages, false);

if (turn1?.calls !== undefined && turn1.calls.length > 0) {
  console.log("\n模型第一轮真的调了工具，追加真实工具循环第二轮：");
  const assistantCalls = turn1.calls.map((call) => ({
    id: typeof call.id === "string" ? call.id : "call-real",
    name: typeof (call.function as Record<string, unknown> | undefined)?.name === "string" ? ((call.function as Record<string, unknown>).name as string) : "request_context",
    arguments: (() => { try { return JSON.parse(String((call.function as Record<string, unknown> | undefined)?.arguments ?? "{}")) as Record<string, unknown>; } catch { return {}; } })()
  }));
  const realLoopMessages: PiConversationMessage[] = [
    { role: "user", content: user1 },
    { role: "user", content: avail1 },
    { role: "assistant", content: "", ...(turn1.reasoning.length > 0 ? { reasoningContent: turn1.reasoning } : {}), toolCalls: assistantCalls },
    {
      role: "toolResult",
      toolCallId: assistantCalls[0]?.id ?? "call-real",
      toolName: assistantCalls[0]?.name ?? "request_context",
      content: JSON.stringify({ source: "TreeTalk", scope: "partial-source", remaining: false, content: "真实工具结果：TCP 通过序号、确认应答、重传与流量控制保证可靠传输。" }),
      isError: false
    },
    { role: "user", content: avail2 }
  ];
  await send("T4 real tool loop turn2 (thinking enabled)", realLoopMessages, true);
} else {
  console.log("\n模型第一轮直接回答了（未调工具），T2/T3 已覆盖 reasoning_content 回传验证。");
}
