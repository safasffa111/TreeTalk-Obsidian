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

function request() {
  return {
    conversationId: "conversation",
    nodeId: "current",
    assistantMessageId: "assistant",
    contextMessages: [{ role: "system", content: "TREE_SYSTEM" }],
    piContext: {
      currentQuestion: "解释当前概念",
      selectedQuotes: [],
      conversationNodes: [
        {
          id: "current",
          parentId: null,
          title: "当前概念",
          depth: 0,
          root: true,
          current: true,
          messages: [
            { id: "q", role: "user", content: "解释当前概念", status: "complete", selectionQuotes: [] }
          ]
        }
      ]
    },
    roleId: "direct",
    route: {
      routeId: "default",
      providerProfile: {
        id: "deepseek",
        name: "DeepSeek",
        kind: "deepseek",
        apiKey: "secret",
        baseUrl: ""
      },
      modelId: "deepseek-v4-flash"
    },
    streamingOutputEnabled: false,
    webSearchEnabled: false
  };
}

function response(content, promptTokens = 10, completionTokens = 5) {
  return {
    status: 200,
    json: {
      choices: [{ message: { content }, finish_reason: "stop" }],
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens }
    }
  };
}

test("selector calls disable thinking and use a compact output budget while DeepSeek answers use the expanded ceiling", async () => {
  const { PiExecutionEngine } = load("src/agent/pi/pi-execution-engine.js");
  const requests = [];
  const replies = [
    response("{\"focus\":"),
    response('TT_MODE: NEED_MORE_CONTEXT\n{"status":"need_more_context","missing":"补充背景"}'),
    response("not-json"),
    response("FINAL_ANSWER")
  ];
  const engine = new PiExecutionEngine({
    strategy: "two-pass",
    bufferedRequest: async (providerRequest) => {
      requests.push(providerRequest);
      return replies.shift();
    },
    now: () => "2026-08-05T04:00:00.000Z"
  });

  const events = [];
  for await (const event of engine.execute(request(), new AbortController().signal)) {
    events.push(event);
  }

  assert.equal(requests.length, 4);
  assert.equal(requests[0].body.max_tokens, 1024);
  assert.deepEqual(requests[0].body.thinking, { type: "disabled" });
  assert.equal(requests[2].body.max_tokens, 1024);
  assert.deepEqual(requests[2].body.thinking, { type: "disabled" });

  assert.equal(requests[1].body.max_tokens, 16384);
  assert.deepEqual(requests[1].body.thinking, { type: "disabled" });
  assert.equal(requests[3].body.max_tokens, 16384);
  assert.deepEqual(requests[3].body.thinking, { type: "disabled" });

  assert.deepEqual(
    events.filter((event) => event.type === "text-delta").map((event) => event.text),
    ["FINAL_ANSWER"]
  );
  assert.equal(events.some((event) => event.type === "error"), false);
});

test("selector contract keeps candidate freedom while selector requests stay compact", () => {
  const { buildPiSelectorPrompt } = load("src/agent/pi/two-pass-prompts.js");
  const { parsePiContextSelection } = load("src/agent/pi/context-selection.js");
  const prompt = buildPiSelectorPrompt(request(), "# Stable Note Catalog\n\n# Dynamic Conversation Branch");

  assert.doesNotMatch(prompt.userPrompt, /最多选择/u);
  assert.doesNotMatch(prompt.userPrompt, /理由可省略/u);
  assert.doesNotMatch(prompt.userPrompt, /不得重复/u);

  const parsed = parsePiContextSelection(JSON.stringify({
    notes: Array.from({ length: 30 }, (_, index) => ({
      id: `P${index + 1}`,
      priority: "supporting",
      sections: Array.from({ length: 12 }, (_, section) => `章节-${section}`),
      reason: "R".repeat(300)
    })),
    nodes: Array.from({ length: 30 }, (_, index) => ({
      id: `N${index + 1}`,
      priority: "supporting",
      parts: ["question", "answer", "selection", "all"],
      reason: "N".repeat(300)
    }))
  }));

  assert.equal(parsed.notes.length, 30);
  assert.equal(parsed.nodes.length, 30);
  assert.equal(parsed.notes[0].sections.length, 12);
  assert.equal(parsed.notes[0].reason.length, 300);
  assert.equal(parsed.nodes[0].reason.length, 300);
});
