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
    : request === "obsidian" ? {} : require(request);
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

function legacyRequest(question, mode = "auto") {
  return {
    conversationId: "c",
    nodeId: "n",
    assistantMessageId: "a",
    contextMessages: [{ role: "user", content: question }],
    currentQuestion: question,
    answerThinkingMode: mode,
    roleId: "direct",
    route: { routeId: "r", providerProfile: profile, modelId: "deepseek-v4-flash" },
    webSearchEnabled: false,
    streamingOutputEnabled: false
  };
}

function piRequest(question, mode = "auto") {
  return {
    ...legacyRequest(question, mode),
    piContext: {
      currentQuestion: question,
      selectedQuotes: [],
      conversationNodes: []
    }
  };
}

function anthropicText(text, stopReason = "end_turn") {
  return {
    status: 200,
    json: {
      content: [{ type: "text", text }],
      stop_reason: stopReason,
      usage: { input_tokens: 10, output_tokens: 5 }
    }
  };
}

function piOpenAi(text, finishReason = "stop") {
  return {
    status: 200,
    json: {
      choices: [{ message: { content: text }, finish_reason: finishReason }],
      usage: { prompt_tokens: 10, completion_tokens: 5 }
    }
  };
}

void test("auto mode disables thinking for restructuring and enables it for proofs", () => {
  const { resolveAnswerThinkingMode } = load("src/execution/answer-thinking.js");
  assert.equal(resolveAnswerThinkingMode({ mode: "auto", currentQuestion: "把这些节点按学习顺序重排" }).enabled, false);
  assert.equal(resolveAnswerThinkingMode({ mode: "auto", currentQuestion: "严格证明这个结论并解释每一步" }).enabled, true);
  assert.equal(resolveAnswerThinkingMode({ mode: "enabled", currentQuestion: "重排" }).enabled, true);
  assert.equal(resolveAnswerThinkingMode({ mode: "disabled", currentQuestion: "证明" }).enabled, false);
});

void test("Legacy applies the shared mode and retries a length-only thinking response without thinking", async () => {
  const { LegacyExecutionEngine } = load("src/execution/legacy-execution-engine.js");
  const { DeepSeekProvider } = load("src/providers/deepseek-provider.js");
  const adapter = new DeepSeekProvider();
  const requests = [];
  const responses = [anthropicText("", "max_tokens"), anthropicText("最终回答")];
  const engine = new LegacyExecutionEngine({
    resolveAdapter: () => adapter,
    stream: async function* () {},
    bufferedRequest: async (request) => {
      requests.push(request);
      return responses.shift();
    }
  });
  const events = [];
  for await (const event of engine.execute(legacyRequest("严格证明这个结论"), new AbortController().signal)) {
    events.push(event);
  }
  assert.deepEqual(requests.map((request) => request.body.thinking), [
    { type: "enabled" },
    { type: "disabled" }
  ]);
  assert.equal(events.filter((event) => event.type === "text-delta").map((event) => event.text).join(""), "最终回答");
});

void test("Pi keeps selectors off and retries only the answer without thinking", async () => {
  const { PiExecutionEngine } = load("src/agent/pi/pi-execution-engine.js");
  const requests = [];
  const replies = [
    piOpenAi(JSON.stringify({ focus: { scope: "latest_round", reason: "" }, notes: [], nodes: [] })),
    piOpenAi("", "length"),
    piOpenAi("TT_MODE: FINAL\n最终回答")
  ];
  const engine = new PiExecutionEngine({
    strategy: "two-pass",
    bufferedRequest: async (request) => {
      requests.push(request);
      return replies.shift();
    }
  });
  const events = [];
  for await (const event of engine.execute(piRequest("严格证明这个结论"), new AbortController().signal)) {
    events.push(event);
  }
  assert.deepEqual(requests.map((request) => request.body.thinking), [
    { type: "disabled" },
    { type: "enabled" },
    { type: "disabled" }
  ]);
  assert.equal(events.filter((event) => event.type === "text-delta").map((event) => event.text).join(""), "最终回答");
});
