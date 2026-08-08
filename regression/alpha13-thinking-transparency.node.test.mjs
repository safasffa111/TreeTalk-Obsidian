import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const root = process.cwd();

function walk(entry) {
  const stat = fs.statSync(entry);
  if (stat.isFile()) return [entry];
  return fs.readdirSync(entry, { withFileTypes: true }).flatMap((item) =>
    walk(path.join(entry, item.name))
  );
}

const modules = new Map();
for (const file of walk(path.join(root, "src")).filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"))) {
  const id = path.relative(root, file).replaceAll(path.sep, "/").replace(/\.ts$/u, ".js");
  const output = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    fileName: file,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      verbatimModuleSyntax: false
    }
  }).outputText;
  modules.set(id, output);
}

const cache = new Map();
function normalize(parts) {
  const result = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") result.pop(); else result.push(part);
  }
  return result.join("/");
}
function resolve(parentId, request) {
  const parent = parentId.split("/");
  parent.pop();
  const base = normalize([...parent, ...request.split("/")]);
  for (const candidate of request.endsWith(".js") ? [base] : [`${base}.js`, `${base}/index.js`, base]) {
    if (modules.has(candidate)) return candidate;
  }
  throw new Error(`Module not found: ${request} from ${parentId}`);
}
function load(id) {
  if (cache.has(id)) return cache.get(id).exports;
  const code = modules.get(id);
  if (code === undefined) throw new Error(`Unknown module: ${id}`);
  const module = { exports: {} };
  cache.set(id, module);
  const localRequire = (request) => request.startsWith(".")
    ? load(resolve(id, request))
    : request === "obsidian" ? { setIcon: () => undefined } : require(request);
  new Function("module", "exports", "require", code)(module, module.exports, localRequire);
  return module.exports;
}

const profile = {
  id: "deepseek",
  name: "DeepSeek",
  kind: "deepseek",
  apiKey: "secret",
  baseUrl: "https://api.deepseek.com"
};

function legacyRequest() {
  return {
    conversationId: "c",
    nodeId: "n",
    assistantMessageId: "a",
    contextMessages: [{ role: "user", content: "严格证明这个结论" }],
    currentQuestion: "严格证明这个结论",
    answerThinkingMode: "enabled",
    roleId: "direct",
    route: { routeId: "r", providerProfile: profile, modelId: "deepseek-v4-flash" },
    webSearchEnabled: false,
    streamingOutputEnabled: true
  };
}

function piRequest() {
  return {
    ...legacyRequest(),
    streamingOutputEnabled: false,
    piContext: {
      currentQuestion: "严格证明这个结论",
      selectedQuotes: [],
      conversationNodes: []
    }
  };
}

function openAiResponse(text, reasoning = "", finishReason = "stop") {
  return {
    status: 200,
    json: {
      choices: [{ message: { content: text, reasoning_content: reasoning }, finish_reason: finishReason }],
      usage: { prompt_tokens: 10, completion_tokens: 5 }
    }
  };
}

void test("OpenAI-compatible streaming exposes reasoning_content separately", () => {
  const { decodeOpenAiEvent } = load("src/providers/stream-parser.js");
  const events = decodeOpenAiEvent({
    event: "",
    data: JSON.stringify({ choices: [{ delta: { reasoning_content: "分析中" }, finish_reason: null }] })
  });
  assert.deepEqual(events, [{ type: "thinking-delta", text: "分析中" }]);
});

void test("Anthropic streaming exposes thinking_delta separately", () => {
  const { createAnthropicMessageParser } = load("src/providers/stream-parser.js");
  const parser = createAnthropicMessageParser();
  parser.push('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n');
  const events = parser.push('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"逐步分析"}}\n\n');
  assert.deepEqual(events, [{ type: "thinking-delta", text: "逐步分析" }]);
});

void test("DeepSeek buffered parsing keeps reasoning out of final text", () => {
  const { DeepSeekProvider } = load("src/providers/deepseek-provider.js");
  const adapter = new DeepSeekProvider();
  const events = adapter.parseBuffered(openAiResponse("最终回答", "隐藏分析").json, {
    responseFormat: "openai"
  });
  assert.deepEqual(events.filter((event) => event.type === "thinking-delta"), [
    { type: "thinking-delta", text: "隐藏分析" }
  ]);
  assert.equal(events.filter((event) => event.type === "delta").map((event) => event.text).join(""), "最终回答");
});

void test("Legacy forwards answer thinking and uses 16384 tokens for DeepSeek", async () => {
  const { LegacyExecutionEngine } = load("src/execution/legacy-execution-engine.js");
  const { DeepSeekProvider } = load("src/providers/deepseek-provider.js");
  const requests = [];
  const engine = new LegacyExecutionEngine({
    resolveAdapter: () => new DeepSeekProvider(),
    stream: async function* (_adapter, request) {
      requests.push(request);
      yield { type: "thinking-delta", text: "分析关系" };
      yield { type: "delta", text: "最终回答" };
      yield { type: "finish", reason: "stop" };
      yield { type: "done" };
    },
    bufferedRequest: async () => openAiResponse("最终回答")
  });
  const events = [];
  for await (const event of engine.execute(legacyRequest(), new AbortController().signal)) {
    events.push(event);
  }
  assert.equal(requests[0].body.max_tokens, 16384);
  assert.deepEqual(events.filter((event) => event.type === "thinking-delta"), [
    { type: "thinking-delta", text: "分析关系" }
  ]);
});

void test("Pi hides selector thinking, exposes answer thinking, and keeps 1024/16384 limits", async () => {
  const { PiExecutionEngine } = load("src/agent/pi/pi-execution-engine.js");
  const requests = [];
  const replies = [
    openAiResponse(JSON.stringify({ focus: { scope: "latest_round", reason: "" }, notes: [], nodes: [] }), "selector-secret"),
    openAiResponse("TT_MODE: FINAL\n最终回答", "answer-visible")
  ];
  const engine = new PiExecutionEngine({
    strategy: "two-pass",
    bufferedRequest: async (request) => {
      requests.push(request);
      return replies.shift();
    }
  });
  const events = [];
  for await (const event of engine.execute(piRequest(), new AbortController().signal)) {
    events.push(event);
  }
  assert.deepEqual(requests.map((request) => request.body.max_tokens), [1024, 16384]);
  assert.deepEqual(events.filter((event) => event.type === "thinking-delta"), [
    { type: "thinking-delta", text: "answer-visible" }
  ]);
});

void test("runtime thinking store appends, copies, deletes, and clears without persistence", () => {
  assert.equal(fs.existsSync(path.join(root, "src/providers/transient-thinking-store.ts")), true);
  const { TransientThinkingStore } = load("src/providers/transient-thinking-store.js");
  const store = new TransientThinkingStore();
  let notifications = 0;
  store.subscribe(() => { notifications += 1; });
  store.append("m1", "第一步");
  store.append("m1", "，第二步");
  assert.deepEqual(store.get("m1"), { content: "第一步，第二步" });
  const snapshot = store.get("m1");
  snapshot.content = "被修改";
  assert.deepEqual(store.get("m1"), { content: "第一步，第二步" });
  store.delete("m1");
  assert.equal(store.get("m1"), undefined);
  store.append("m2", "临时");
  store.clear();
  assert.equal(store.get("m2"), undefined);
  assert.equal(notifications, 2);
});

void test("conversation view renders thinking only for active streaming messages", () => {
  const view = fs.readFileSync(path.join(root, "src/views/conversation-view.ts"), "utf8");
  assert.match(view, /transientThinking\?:\s*TransientThinkingPort/u);
  assert.match(view, /treetalk-thinking-panel/u);
  assert.match(view, /message\.status\s*===\s*"streaming"/u);
  assert.match(view, /textContent\s*=\s*record\.content/u);
});

void test("main deletes transient thinking in every terminal request lifecycle", () => {
  const main = fs.readFileSync(path.join(root, "src/main.ts"), "utf8");
  assert.match(main, /new TransientThinkingStore\(\)/u);
  assert.match(main, /onThinkingDelta:\s*\(text\)\s*=>\s*\{[\s\S]*?transientThinking\.append\(messageId,\s*text\)/u);
  assert.match(main, /finally\s*\{[\s\S]*?transientThinking\.delete\(messageId\)/u);
  assert.match(main, /onunload\(\):\s*void\s*\{[\s\S]*?transientThinking\.clear\(\)/u);
});

void test("thinking text is not added to canonical conversation messages", () => {
  const domain = fs.readFileSync(path.join(root, "src/domain/types.ts"), "utf8");
  assert.doesNotMatch(domain, /thinkingContent|reasoningContent/u);
  const capture = fs.readFileSync(path.join(root, "src/knowledge/capture-service.ts"), "utf8");
  assert.doesNotMatch(capture, /TransientThinking|thinkingContent|reasoningContent/u);
});

void test("reported reasoning token counts remain visible without persisting reasoning text", () => {
  const { normalizeOpenAiCompatibleUsage } = load("src/providers/stream-parser.js");
  assert.deepEqual(
    normalizeOpenAiCompatibleUsage({
      usage: {
        prompt_tokens: 20,
        completion_tokens: 100,
        completion_tokens_details: { reasoning_tokens: 80 }
      }
    }),
    {
      promptTokens: 20,
      completionTokens: 100,
      reasoningTokens: 80,
      providerReported: true
    }
  );
  const view = fs.readFileSync(path.join(root, "src/views/conversation-view.ts"), "utf8");
  assert.match(view, /其中推理/u);
  const schema = fs.readFileSync(path.join(root, "src/domain/schema.ts"), "utf8");
  assert.match(schema, /"reasoningTokens"/u);
});
