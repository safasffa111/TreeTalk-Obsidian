import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const root = process.cwd();
const modules = new Map();
function walk(directory) { return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)]); }
for (const file of walk(path.join(root, "src")).filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"))) {
  const id = path.relative(root, file).replaceAll(path.sep, "/").replace(/\.ts$/u, ".js");
  modules.set(id, ts.transpileModule(fs.readFileSync(file, "utf8"), { fileName: file, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.Node10, verbatimModuleSyntax: false } }).outputText);
}
const cache = new Map();
function normalize(parts) { const out=[]; for (const part of parts) { if (!part || part === ".") continue; if (part === "..") out.pop(); else out.push(part); } return out.join("/"); }
function resolve(parentId, request) { const parent=parentId.split("/"); parent.pop(); const base=normalize([...parent,...request.split("/")]); for (const candidate of request.endsWith(".js")?[base]:[`${base}.js`,`${base}/index.js`,base]) if (modules.has(candidate)) return candidate; throw new Error(`missing ${request}`); }
function load(id) { if (cache.has(id)) return cache.get(id).exports; const module={exports:{}}; cache.set(id,module); new Function("module","exports","require",modules.get(id))(module,module.exports,(request)=>request.startsWith(".")?load(resolve(id,request)):request === "obsidian"?{}:require(request)); return module.exports; }

function profile(kind) { return { id:"p", name:"p", kind, apiKey:"k", baseUrl:"" }; }

test("Pi final stream envelope releases prose incrementally and hides its control line", () => {
  const { PiAnswerStreamDecoder } = load("src/agent/pi/answer-stream-protocol.js");
  const decoder = new PiAnswerStreamDecoder();
  assert.deepEqual(decoder.push("TT_MODE: FI"), []);
  assert.deepEqual(decoder.push("NAL\n第一"), ["第一"]);
  assert.deepEqual(decoder.push("段"), ["段"]);
  const result = decoder.finish();
  assert.equal(result.mode, "final");
  assert.equal(result.text, "第一段");
});

test("Pi need-more-context stream never releases control JSON as visible text", () => {
  const { PiAnswerStreamDecoder } = load("src/agent/pi/answer-stream-protocol.js");
  const decoder = new PiAnswerStreamDecoder();
  assert.deepEqual(decoder.push('TT_MODE: NEED_MORE_CONTEXT\n{"status":"need_more_context",'), []);
  assert.deepEqual(decoder.push('"missing":"散度定义"}'), []);
  const result = decoder.finish();
  assert.equal(result.mode, "need_more_context");
  assert.match(result.text, /散度定义/u);
});

test("Pi provider requests switch genuine provider streaming fields", () => {
  const { buildPiProviderRequest } = load("src/agent/pi/pi-provider-transport.js");
  const base = { modelId:"m", systemPrompt:"s", messages:[{role:"user",content:"q"}], tools:[] };
  const openai = buildPiProviderRequest({ ...base, profile: profile("openai"), stream: true });
  assert.equal(openai.body.stream, true);
  assert.deepEqual(openai.body.stream_options, { include_usage: true });
  const anthropic = buildPiProviderRequest({ ...base, profile: profile("anthropic"), stream: true });
  assert.equal(anthropic.body.stream, true);
  const gemini = buildPiProviderRequest({ ...base, profile: profile("gemini"), stream: true });
  assert.match(gemini.url, /:streamGenerateContent\?alt=sse$/u);
});

test("Legacy disabled streaming goes directly through buffered transport", async () => {
  const { LegacyExecutionEngine } = load("src/execution/legacy-execution-engine.js");
  let streamCalls = 0;
  let bufferedCalls = 0;
  const adapter = {
    buildRequest: (input) => ({ url:"x", method:"POST", headers:{}, body:{ stream: input.stream } }),
    parseBuffered: () => [{ type:"delta", text:"完整" }, { type:"delta", text:"回答" }, { type:"done" }]
  };
  const engine = new LegacyExecutionEngine({
    resolveAdapter: () => adapter,
    stream: async function* () { streamCalls += 1; },
    bufferedRequest: async () => { bufferedCalls += 1; return { status:200, json:{} }; }
  });
  const events=[];
  for await (const event of engine.execute({ conversationId:"c", nodeId:"n", assistantMessageId:"a", contextMessages:[], roleId:"direct", route:{routeId:"r",providerProfile:profile("openai"),modelId:"m"}, webSearchEnabled:false, streamingOutputEnabled:false }, new AbortController().signal)) events.push(event);
  assert.equal(streamCalls, 0);
  assert.equal(bufferedCalls, 1);
  assert.deepEqual(events.filter((event)=>event.type === "text-delta").map((event)=>event.text), ["完整回答"]);
});

test("Pi execution streams only the final visible answer after a buffered selector", async () => {
  const { PiExecutionEngine } = load("src/agent/pi/pi-execution-engine.js");
  let bufferedCalls = 0;
  let streamCalls = 0;
  let streamedRequest;
  const engine = new PiExecutionEngine({
    strategy: "two-pass",
    bufferedRequest: async () => {
      bufferedCalls += 1;
      return {
        status: 200,
        json: {
          choices: [{
            message: { content: JSON.stringify({ notes: [], nodes: [] }) },
            finish_reason: "stop"
          }],
          usage: { prompt_tokens: 8, completion_tokens: 2 }
        }
      };
    },
    streamRequest: async function* (_profile, request) {
      streamCalls += 1;
      streamedRequest = request;
      yield { type: "delta", text: "TT_MODE: FINAL\n第一" };
      yield { type: "delta", text: "段" };
      yield { type: "usage", usage: { promptTokens: 10, completionTokens: 3, providerReported: true } };
      yield { type: "done" };
    },
    supplementaryEvidenceTokenBudget: 0
  });
  const request = {
    conversationId: "c",
    nodeId: "n",
    assistantMessageId: "a",
    contextMessages: [],
    piContext: {
      currentQuestion: "问题",
      selectedQuotes: [],
      conversationNodes: []
    },
    roleId: "direct",
    route: {
      routeId: "r",
      providerProfile: profile("openai"),
      modelId: "m"
    },
    webSearchEnabled: false,
    streamingOutputEnabled: true
  };
  const events = [];
  for await (const event of engine.execute(request, new AbortController().signal)) events.push(event);
  assert.equal(bufferedCalls, 1);
  assert.equal(streamCalls, 1);
  assert.equal(streamedRequest.body.stream, true);
  assert.deepEqual(
    events.filter((event) => event.type === "text-delta").map((event) => event.text),
    ["第一", "段"]
  );
  assert.equal(events.at(-1).type, "finish");
});
