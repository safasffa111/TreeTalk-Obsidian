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
for (const file of walk(path.join(root, "src")).filter(
  (file) => file.endsWith(".ts") && !file.endsWith(".d.ts")
)) {
  const id = path.relative(root, file).replaceAll(path.sep, "/").replace(/\.ts$/u, ".js");
  modules.set(id, ts.transpileModule(fs.readFileSync(file, "utf8"), {
    fileName: file,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      verbatimModuleSyntax: false
    }
  }).outputText);
}

const cache = new Map();
function normalize(parts) {
  const result = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") result.pop();
    else result.push(part);
  }
  return result.join("/");
}
function resolve(parentId, request) {
  const parent = parentId.split("/");
  parent.pop();
  const base = normalize([...parent, ...request.split("/")]);
  for (const candidate of request.endsWith(".js")
    ? [base]
    : [`${base}.js`, `${base}/index.js`, base]) {
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

function profile() {
  return {
    id: "deepseek",
    kind: "deepseek",
    displayName: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    apiKey: "key",
    models: ["m"]
  };
}

function unselectedRequest(divergence = false) {
  return {
    conversationId: "c",
    nodeId: "current",
    assistantMessageId: "out",
    contextMessages: [],
    currentQuestion: "汇总关联内容",
    answerThinkingMode: "disabled",
    streamingOutputEnabled: false,
    contextDivergenceEnabled: divergence,
    piContext: {
      currentQuestion: "汇总关联内容",
      selectedQuotes: [],
      relatedNotesAllowed: false,
      conversationNodes: [
        {
          id: "ancestor",
          parentId: null,
          title: "祖先",
          depth: 0,
          root: true,
          current: false,
          messages: [{
            id: "aa",
            role: "assistant",
            content: "## 背景\n祖先相关章节。",
            status: "complete",
            selectionQuotes: []
          }]
        },
        {
          id: "parent",
          parentId: "ancestor",
          title: "父节点",
          depth: 1,
          root: false,
          current: false,
          messages: [{
            id: "p",
            role: "assistant",
            content: `开头。${"父文本内容。".repeat(1000)}末尾标记 END_MARKER`,
            status: "complete",
            selectionQuotes: []
          }]
        },
        {
          id: "current",
          parentId: "parent",
          title: "当前",
          depth: 2,
          root: false,
          current: true,
          messages: []
        }
      ],
      focus: {
        interactionMode: "continue",
        defaultScope: "latest_round",
        anchors: [{
          id: "F1",
          kind: "conversation-round",
          sourceNodeId: "parent",
          sourceMessageId: "p",
          reason: "previous-turn"
        }],
        targets: [{
          kind: "conversation-round",
          anchorId: "F1",
          sourceNodeId: "parent",
          sourceMessageId: "p",
          reason: "previous-turn"
        }]
      }
    },
    roleId: "direct",
    route: { routeId: "r", providerProfile: profile(), modelId: "m" },
    webSearchEnabled: false
  };
}

function exactRequest() {
  return {
    conversationId: "c",
    nodeId: "current",
    assistantMessageId: "out",
    contextMessages: [],
    currentQuestion: "解释",
    answerThinkingMode: "disabled",
    streamingOutputEnabled: false,
    contextDivergenceEnabled: false,
    piContext: {
      currentQuestion: "解释",
      selectedQuotes: ["旋度"],
      relatedNotesAllowed: false,
      conversationNodes: [],
      noteContextGraph: {
        protocol: "note-context-graph:v1",
        rootNodeIds: ["n"],
        fullNoteContext: true,
        relatedNotesEnabled: false,
        perNoteBudget: "full",
        maxDepth: 0,
        builtAt: "x",
        nodes: [{
          id: "n",
          filePath: "A.md",
          fileName: "A.md",
          content: "## 旋度\n旋度描述局部旋转。\n\n## 其他\n更多正文",
          contentHash: "h",
          depth: 0,
          root: true,
          primaryChain: ["n"],
          parentIds: [],
          outgoingNodeIds: []
        }],
        edges: [],
        unresolvedLinks: []
      },
      focus: {
        interactionMode: "child",
        defaultScope: "selection_only",
        anchors: [{
          id: "F1",
          kind: "note-selection",
          filePath: "A.md",
          fileName: "A.md",
          quote: "旋度",
          prefix: "",
          suffix: "",
          selectionStartOffset: 3,
          selectionEndOffset: 5
        }],
        targets: [{
          kind: "exact-selection",
          anchorId: "F1",
          text: "旋度",
          source: { type: "note", filePath: "A.md", fileName: "A.md" }
        }]
      }
    },
    roleId: "direct",
    route: { routeId: "r", providerProfile: profile(), modelId: "m" },
    webSearchEnabled: false
  };
}

function response(text) {
  return {
    status: 200,
    json: {
      choices: [{ message: { content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 4 }
    }
  };
}

function toolCallsResponse(calls) {
  return {
    status: 200,
    json: {
      choices: [{
        message: {
          content: null,
          tool_calls: calls.map((call) => ({
            id: call.id,
            type: "function",
            function: {
              name: call.name ?? "request_context",
              arguments: JSON.stringify({
                target: call.target,
                reason: call.reason ?? "需要上下文"
              })
            }
          }))
        },
        finish_reason: "tool_calls"
      }],
      usage: { prompt_tokens: 10, completion_tokens: 4 }
    }
  };
}

async function collect(iterable) {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}

void test("request_context schema stays byte-stable for every availability state", () => {
  const { buildRequestContextTool } = load("src/agent/pi/progressive/semantic-context.js");
  const first = buildRequestContextTool(
    [{ target: "current_section", nextLevel: 1 }],
    false
  );
  const later = buildRequestContextTool(
    [
      { target: "current_source", nextLevel: 2 },
      { target: "related_sections", nextLevel: 3 }
    ],
    false
  );
  assert.deepEqual(later, first);
  assert.deepEqual(first.parameters.properties.target.enum, [
    "current_section",
    "current_source",
    "related_sections",
    "related_full_source"
  ]);
});

void test("progressive turns keep the same tools and append availability at the message tail", async () => {
  const { PiExecutionEngine } = load("src/agent/pi/pi-execution-engine.js");
  const requests = [];
  const engine = new PiExecutionEngine({
    strategy: "progressive",
    async bufferedRequest(req) {
      requests.push(req);
      return requests.length === 1
        ? toolCallsResponse([{ id: "call-1", target: "current_source" }])
        : response("完成");
    }
  });
  await collect(engine.execute(unselectedRequest(false), new AbortController().signal));
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].body.tools, requests[0].body.tools);
  assert.deepEqual(
    requests[1].body.messages.slice(0, requests[0].body.messages.length),
    requests[0].body.messages
  );
  assert.match(
    requests[0].body.messages.at(-1).content,
    /本轮可用接口：current_source、related_sections/u
  );
  assert.match(
    requests[1].body.messages.at(-1).content,
    /本轮可用接口：current_source、related_sections/u
  );
});

void test("forced final turn retains fixed tools and omits tool_choice for DeepSeek", async () => {
  const { PiExecutionEngine } = load("src/agent/pi/pi-execution-engine.js");
  const requests = [];
  const engine = new PiExecutionEngine({
    strategy: "progressive",
    maxTurns: 2,
    async bufferedRequest(req) {
      requests.push(req);
      return requests.length === 1
        ? toolCallsResponse([{ id: "call-1", target: "current_source" }])
        : response("最终回答");
    }
  });
  await collect(engine.execute(unselectedRequest(false), new AbortController().signal));
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].body.tools, requests[0].body.tools);
  assert.equal(Object.hasOwn(requests[0].body, "tool_choice"), false);
  assert.equal(Object.hasOwn(requests[1].body, "tool_choice"), false);
});

void test("multiple tool calls execute only the first valid request and answer every call id", async () => {
  const { PiExecutionEngine } = load("src/agent/pi/pi-execution-engine.js");
  const requests = [];
  const engine = new PiExecutionEngine({
    strategy: "progressive",
    async bufferedRequest(req) {
      requests.push(req);
      return requests.length === 1
        ? toolCallsResponse([
            { id: "call-current", target: "current_source" },
            { id: "call-related", target: "related_sections" }
          ])
        : response("完成");
    }
  });
  const events = await collect(
    engine.execute(unselectedRequest(false), new AbortController().signal)
  );
  assert.equal(requests.length, 2);
  const secondMessages = requests[1].body.messages;
  const assistant = secondMessages.find(
    (message) => message.role === "assistant" && Array.isArray(message.tool_calls)
  );
  assert.deepEqual(
    assistant.tool_calls.map((call) => call.id),
    ["call-current", "call-related"]
  );
  const results = secondMessages.filter((message) => message.role === "tool");
  assert.deepEqual(
    results.map((message) => message.tool_call_id),
    ["call-current", "call-related"]
  );
  assert.match(results[1].content, /本轮只执行一个接口/u);
  assert.equal(
    events.filter(
      (event) => event.type === "progressive-context-batch" && event.expansionReason !== "initial"
    ).length,
    1
  );
  assert.equal(events.some((event) => event.type === "finish"), true);
});

void test("when the first call is unavailable the first later valid call is executed", async () => {
  const { PiExecutionEngine } = load("src/agent/pi/pi-execution-engine.js");
  const requests = [];
  const engine = new PiExecutionEngine({
    strategy: "progressive",
    async bufferedRequest(req) {
      requests.push(req);
      return requests.length === 1
        ? toolCallsResponse([
            { id: "call-invalid", target: "related_full_source" },
            { id: "call-valid", target: "current_section" }
          ])
        : response("完成");
    }
  });
  const events = await collect(
    engine.execute(exactRequest(), new AbortController().signal)
  );
  const results = requests[1].body.messages.filter((message) => message.role === "tool");
  assert.equal(results.length, 2);
  assert.match(results[0].content, /不可用/u);
  assert.match(results[1].content, /旋度描述局部旋转/u);
  const expansion = events.find(
    (event) => event.type === "progressive-context-batch" && event.expansionReason !== "initial"
  );
  assert.equal(expansion?.requestedTarget, "current_section");
});
