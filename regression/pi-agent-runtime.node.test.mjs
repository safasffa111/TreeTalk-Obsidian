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

function graph() {
  return {
    protocol: "note-context-graph:v1",
    rootNodeIds: ["N0"],
    fullNoteContext: true,
    relatedNotesEnabled: true,
    perNoteBudget: "full",
    maxDepth: 2,
    builtAt: "2026-08-04T00:00:00.000Z",
    nodes: [
      {
        id: "N0",
        filePath: "Math/Gauss.md",
        fileName: "Gauss.md",
        content: "# Gauss\nRoot body",
        contentHash: "h0",
        depth: 0,
        root: true,
        primaryChain: ["N0"],
        parentIds: ["N1"],
        outgoingNodeIds: []
      },
      {
        id: "N1",
        filePath: "Math/Divergence.md",
        fileName: "Divergence.md",
        content: "# Divergence\nImportant linked body",
        contentHash: "h1",
        depth: 1,
        root: false,
        primaryParentId: "N0",
        primaryChain: ["N0", "N1"],
        parentIds: [],
        outgoingNodeIds: ["N0"]
      }
    ],
    edges: [{ sourceNodeId: "N1", targetNodeId: "N0", labels: ["backlink"] }],
    unresolvedLinks: []
  };
}

test("Pi context workspace restricts tools to the frozen selected graph", async () => {
  const { PiContextWorkspace } = load("src/agent/pi/context-workspace.js");
  const workspace = new PiContextWorkspace(graph());
  const listedResult = await workspace.execute("list_context_notes", {});
  const listed = JSON.parse(listedResult.content);
  assert.equal(listed.notes.length, 2);
  const readResult = await workspace.execute("read_context_note", { path: "Math/Divergence.md" });
  const read = JSON.parse(readResult.content);
  assert.match(read.content, /Important linked body/u);
  const linksResult = await workspace.execute("get_context_links", { path: "Math/Gauss.md" });
  const links = JSON.parse(linksResult.content);
  assert.deepEqual(links.backlinks.map((entry) => entry.path), ["Math/Divergence.md"]);
  await assert.rejects(
    () => workspace.execute("read_context_note", { path: "Outside.md" }),
    /outside the frozen TreeTalk context/u
  );
});

test("Pi engine selects frozen evidence and answers in a clean second pass", async () => {
  const { PiExecutionEngine } = load("src/agent/pi/pi-execution-engine.js");
  const requests = [];
  const replies = [
    {
      status: 200,
      json: {
        choices: [{
          message: {
            content: JSON.stringify({
              notes: [{ id: "P2", priority: "essential", sections: [], reason: "contains the needed backlink evidence" }],
              nodes: []
            })
          },
          finish_reason: "stop"
        }],
        usage: { prompt_tokens: 20, completion_tokens: 4 }
      }
    },
    {
      status: 200,
      json: {
        choices: [{ message: { content: "基于散度笔记得出的最终回答。" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 30, completion_tokens: 8 }
      }
    }
  ];
  const engine = new PiExecutionEngine({
    strategy: "two-pass",
    bufferedRequest: async (request) => {
      requests.push(request);
      return replies.shift();
    },
    now: () => "2026-08-04T00:00:00.000Z"
  });
  const events = [];
  for await (const event of engine.execute({
    conversationId: "c",
    nodeId: "n",
    assistantMessageId: "a",
    contextMessages: [
      { role: "system", content: "system" },
      { role: "user", content: "COMPILED_CONTEXT_THAT_MUST_NOT_LEAK" }
    ],
    piContext: {
      currentQuestion: "请分析",
      noteContextGraph: graph(),
      selectedQuotes: ["Gauss quote"]
    },
    roleId: "direct",
    route: {
      routeId: "default",
      providerProfile: { id: "default", name: "Default", kind: "openai", apiKey: "secret", baseUrl: "" },
      modelId: "gpt-test"
    },
    webSearchEnabled: false
  }, new AbortController().signal)) events.push(event);

  assert.equal(requests.length, 2);
  assert.equal("tools" in requests[0].body, false);
  assert.equal("tools" in requests[1].body, false);
  assert.doesNotMatch(JSON.stringify(requests[0].body.messages), /Important linked body|Root body|COMPILED_CONTEXT_THAT_MUST_NOT_LEAK/u);
  assert.match(JSON.stringify(requests[1].body.messages), /Important linked body/u);
  assert.doesNotMatch(JSON.stringify(requests[1].body.messages), /TreeTalk Context Index|COMPILED_CONTEXT_THAT_MUST_NOT_LEAK/u);
  assert.equal(events[0].type, "agent-start");
  assert.equal(events[0].runtime, "pi-agent-core-v0.82.1-vendored");
  const routing = events.find((event) => event.type === "context-routing");
  assert.equal(routing.candidateNoteCount, 2);
  assert.equal(routing.selectedNoteCount, 1);
  assert.deepEqual(routing.materializedNotePaths, ["Math/Divergence.md"]);
  assert.equal(events.some((event) => event.type === "tool-start"), false);
  assert.deepEqual(events.filter((event) => event.type === "text-delta").map((event) => event.text), ["基于散度笔记得出的最终回答。"]);
  assert.deepEqual(events.at(-1), { type: "finish", reason: "stop" });
});

test("Pi provider transport uses tool-compatible request shapes", () => {
  const { buildPiProviderRequest } = load("src/agent/pi/pi-provider-transport.js");
  const common = {
    modelId: "model",
    systemPrompt: "system",
    messages: [{ role: "user", content: "question" }],
    tools: [{
      name: "read_context_note",
      description: "read",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false
      }
    }],
    maxOutputTokens: 2048
  };
  const openai = buildPiProviderRequest({
    ...common,
    profile: { id: "openai", name: "OpenAI", kind: "openai", apiKey: "secret", baseUrl: "" }
  });
  assert.equal(openai.body.max_completion_tokens, 2048);
  assert.equal("max_tokens" in openai.body, false);
  assert.equal("parallel_tool_calls" in openai.body, false);

  const compatible = buildPiProviderRequest({
    ...common,
    profile: { id: "compatible", name: "Compatible", kind: "openai-compatible", apiKey: "secret", baseUrl: "https://example.test/v1" }
  });
  assert.equal(compatible.body.max_tokens, 2048);

  const gemini = buildPiProviderRequest({
    ...common,
    profile: { id: "gemini", name: "Gemini", kind: "gemini", apiKey: "secret", baseUrl: "" }
  });
  const declaration = gemini.body.tools[0].functionDeclarations[0];
  assert.equal("additionalProperties" in declaration.parameters, false);
});

test("Pi provider transport parses Anthropic and Gemini native tool calls", () => {
  const { parsePiProviderResponse } = load("src/agent/pi/pi-provider-transport.js");
  const anthropic = parsePiProviderResponse(
    { id: "anthropic", name: "Anthropic", kind: "anthropic", apiKey: "secret", baseUrl: "" },
    {
      content: [
        { type: "thinking", thinking: "inspect" },
        { type: "tool_use", id: "tool-a", name: "search_context_notes", input: { query: "Gauss" } }
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 2 }
    }
  );
  assert.equal(anthropic.thinking, "inspect");
  assert.deepEqual(anthropic.toolCalls, [{ id: "tool-a", name: "search_context_notes", arguments: { query: "Gauss" } }]);

  const gemini = parsePiProviderResponse(
    { id: "gemini", name: "Gemini", kind: "gemini", apiKey: "secret", baseUrl: "" },
    {
      candidates: [{
        content: { parts: [{ functionCall: { name: "get_context_links", args: { path: "Math/Gauss.md" } } }] },
        finishReason: "STOP"
      }],
      usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 3 }
    }
  );
  assert.equal(gemini.toolCalls[0].name, "get_context_links");
  assert.equal(gemini.usage.promptTokens, 11);
});

test("Pi tool audit records the exact frozen notes actually used", () => {
  const { ExecutionEventRecorder } = load("src/execution/event-recorder.js");
  const recorder = new ExecutionEventRecorder({
    executionMode: "pi",
    roleId: "direct",
    routeId: "default",
    providerId: "openai",
    modelId: "gpt-test",
    startedAt: "2026-08-04T00:00:00.000Z"
  });
  recorder.apply({
    type: "tool-start",
    toolCallId: "call-1",
    toolName: "read_context_note",
    arguments: { path: "Math/Divergence.md" },
    startedAt: "2026-08-04T00:00:00.100Z"
  });
  recorder.apply({
    type: "tool-end",
    toolCallId: "call-1",
    toolName: "read_context_note",
    isError: false,
    summary: "Read Math/Divergence.md",
    notePaths: ["Math/Divergence.md"],
    finishedAt: "2026-08-04T00:00:00.200Z"
  });
  const record = recorder.finish("completed", "2026-08-04T00:00:01.000Z");
  assert.deepEqual(record.toolExecutions[0].notePaths, ["Math/Divergence.md"]);
  assert.equal(record.toolExecutions[0].status, "completed");
  assert.doesNotMatch(JSON.stringify(record), /Important linked body|secret/u);
});
