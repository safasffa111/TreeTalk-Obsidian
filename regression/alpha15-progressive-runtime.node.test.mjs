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
  return fs.readdirSync(entry, { withFileTypes: true }).flatMap((item) => walk(path.join(entry, item.name)));
}
const modules = new Map();
for (const file of walk(path.join(root, "src")).filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"))) {
  const id = path.relative(root, file).replaceAll(path.sep, "/").replace(/\.ts$/u, ".js");
  modules.set(id, ts.transpileModule(fs.readFileSync(file, "utf8"), {
    fileName: file,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.Node10, verbatimModuleSyntax: false }
  }).outputText);
}
const cache = new Map();
function normalize(parts) { const result=[]; for (const part of parts) { if (!part || part === ".") continue; if (part === "..") result.pop(); else result.push(part); } return result.join("/"); }
function resolve(parentId, request) { const parent=parentId.split("/"); parent.pop(); const base=normalize([...parent,...request.split("/")]); for (const candidate of request.endsWith(".js")?[base]:[`${base}.js`,`${base}/index.js`,base]) if (modules.has(candidate)) return candidate; throw new Error(`Module not found: ${request} from ${parentId}`); }
function load(id) { if (cache.has(id)) return cache.get(id).exports; const code=modules.get(id); if (code===undefined) throw new Error(`Unknown module: ${id}`); const module={exports:{}}; cache.set(id,module); const localRequire=(request)=>request.startsWith(".")?load(resolve(id,request)):request === "obsidian"?{}:require(request); new Function("module","exports","require",code)(module,module.exports,localRequire); return module.exports; }

function profile(kind = "deepseek") {
  return { id: kind, name: kind, kind, apiKey: "secret", baseUrl: kind === "deepseek" ? "https://api.deepseek.com" : "" };
}
function request(question = "旋度是什么意思？", kind = "deepseek") {
  return {
    conversationId: "c",
    nodeId: "current",
    assistantMessageId: "a",
    contextMessages: [],
    currentQuestion: question,
    answerThinkingMode: "auto",
    streamingOutputEnabled: false,
    piContext: {
      currentQuestion: question,
      selectedQuotes: ["旋度"],
      relatedNotesAllowed: true,
      conversationNodes: [],
      focus: {
        interactionMode: "child",
        defaultScope: "selection_only",
        anchors: [{ id: "F1", kind: "note-selection", filePath: "Math/Vector.md", fileName: "Vector.md", quote: "旋度", prefix: "", suffix: "", selectionStartOffset: 13, selectionEndOffset: 15 }],
        targets: [{ kind: "exact-selection", anchorId: "F1", text: "旋度", source: { type: "note", filePath: "Math/Vector.md", fileName: "Vector.md" } }]
      },
      noteContextGraph: {
        protocol: "note-context-graph:v1",
        rootNodeIds: ["N0"],
        fullNoteContext: true,
        relatedNotesEnabled: true,
        perNoteBudget: "full",
        maxDepth: 2,
        builtAt: "2026-08-05T00:00:00.000Z",
        nodes: [{ id: "N0", filePath: "Math/Vector.md", fileName: "Vector.md", content: "# 向量分析\n\n## 旋度\n旋度描述局部旋转。", contentHash: "h0", depth: 0, root: true, primaryChain: ["N0"], parentIds: [], outgoingNodeIds: [] }],
        edges: [], unresolvedLinks: []
      }
    },
    roleId: "direct",
    route: { routeId: "r", providerProfile: profile(kind), modelId: "model" },
    webSearchEnabled: false
  };
}
function openAiResponse(text, finishReason = "stop") {
  return { status: 200, json: { choices: [{ message: { content: text }, finish_reason: finishReason }], usage: { prompt_tokens: 10, completion_tokens: 4 } } };
}
async function collect(iterable) { const result=[]; for await (const event of iterable) result.push(event); return result; }

void test("explicit two-pass strategy preserves the alpha.14 selector path", async () => {
  const { PiExecutionEngine, TwoPassPiExecutionEngine } = load("src/agent/pi/pi-execution-engine.js");
  assert.equal(typeof TwoPassPiExecutionEngine, "function");
  const requests = [];
  const engine = new PiExecutionEngine({
    strategy: "two-pass",
    async bufferedRequest(providerRequest) {
      requests.push(providerRequest);
      if (requests.length === 1) return openAiResponse(JSON.stringify({ focusScope: "selection_only", notes: [], nodes: [] }));
      return openAiResponse("TT_MODE: FINAL\n直接回答");
    }
  });
  const events = await collect(engine.execute(request(), new AbortController().signal));
  assert.match(JSON.stringify(requests[0].body), /Output Contract/u);
  assert.equal(events.some((event) => event.type === "finish" && event.reason === "stop"), true);
});

function openAiToolResponse(providerRequest, reason, id = "call-expand", thinking = "需要局部上下文", requestedTarget) {
  const latestAvailability = [...(providerRequest.body.messages ?? [])]
    .reverse()
    .find((message) => message.role === "user" && typeof message.content === "string" && message.content.startsWith("本轮可用接口："));
  const offered = latestAvailability === undefined
    ? []
    : latestAvailability.content
        .replace(/^本轮可用接口：/u, "")
        .replace(/。$/u, "")
        .split("、")
        .filter((target) => target !== "无" && target.length > 0);
  const target = requestedTarget ?? offered[0];
  return {
    status: 200,
    json: {
      choices: [{
        message: {
          content: null,
          reasoning_content: thinking,
          tool_calls: [{
            id,
            type: "function",
            function: {
              name: "request_context",
              arguments: JSON.stringify({ target, reason })
            }
          }]
        },
        finish_reason: "tool_calls"
      }],
      usage: { prompt_tokens: 12, completion_tokens: 3, reasoning_tokens: 2 }
    }
  };
}

function expandedRequest(question = "旋度是什么意思？", relatedNotesAllowed = true) {
  const base = request(question);
  base.piContext.relatedNotesAllowed = relatedNotesAllowed;
  base.piContext.noteContextGraph = {
    protocol: "note-context-graph:v1",
    rootNodeIds: ["N0"],
    fullNoteContext: true,
    relatedNotesEnabled: relatedNotesAllowed,
    perNoteBudget: "full",
    maxDepth: 2,
    builtAt: "2026-08-05T00:00:00.000Z",
    nodes: [
      {
        id: "N0",
        filePath: "Math/Vector.md",
        fileName: "Vector.md",
        content: [
          "# 向量分析",
          "",
          "## 旋度",
          "旋度描述局部旋转。",
          "",
          "## 定义",
          "旋度由向量微分算子与向量场的叉积给出。",
          "",
          "## 几何意义",
          "它可以理解为流体微团的局部旋转趋势。",
          "",
          "## 应用",
          "旋度用于流体力学和电磁学。"
        ].join("\n"),
        contentHash: "h0",
        depth: 0,
        root: true,
        primaryChain: ["N0"],
        parentIds: [],
        outgoingNodeIds: ["N1"]
      },
      {
        id: "N1",
        filePath: "Math/Stokes.md",
        fileName: "Stokes.md",
        content: "# 斯托克斯公式\n\n## 旋度与环流\n斯托克斯公式联系旋度的曲面积分与边界环流。",
        contentHash: "h1",
        depth: 1,
        root: false,
        primaryParentId: "N0",
        primaryChain: ["N0", "N1"],
        parentIds: ["N0"],
        outgoingNodeIds: []
      }
    ],
    edges: [{ sourceNodeId: "N0", targetNodeId: "N1", labels: ["link"] }],
    unresolvedLinks: []
  };
  return base;
}

void test("progressive L0 answers in one request without Selector or TT_MODE", async () => {
  const { PiExecutionEngine } = load("src/agent/pi/pi-execution-engine.js");
  const requests = [];
  const engine = new PiExecutionEngine({
    strategy: "progressive",
    async bufferedRequest(providerRequest) {
      requests.push(providerRequest);
      return openAiResponse("旋度描述向量场在一点附近的局部旋转趋势。");
    }
  });

  const events = await collect(engine.execute(request(), new AbortController().signal));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.max_tokens, 16_384);
  assert.equal(requests[0].body.tools.length, 1);
  assert.equal(requests[0].body.tools[0].function.name, "request_context");
  assert.doesNotMatch(JSON.stringify(requests[0].body), /Output Contract|TT_MODE|context selection JSON/u);
  assert.equal(events.filter((event) => event.type === "text-delta").map((event) => event.text).join(""), "旋度描述向量场在一点附近的局部旋转趋势。");
  assert.equal(events.some((event) => event.type === "finish" && event.reason === "stop"), true);
});

void test("progressive request_context appends the current section to the same answer conversation", async () => {
  const { PiExecutionEngine } = load("src/agent/pi/pi-execution-engine.js");
  const requests = [];
  const engine = new PiExecutionEngine({
    strategy: "progressive",
    async bufferedRequest(providerRequest) {
      requests.push(providerRequest);
      return requests.length === 1
        ? openAiToolResponse(providerRequest, "需要查看词语所在章节")
        : openAiResponse("结合所在章节，旋度表示局部旋转趋势。");
    }
  });

  const events = await collect(engine.execute(expandedRequest(), new AbortController().signal));
  assert.equal(requests.length, 2);
  const secondMessages = requests[1].body.messages;
  const assistant = secondMessages.find((message) => message.role === "assistant");
  const tool = secondMessages.find((message) => message.role === "tool");
  assert.equal(assistant.reasoning_content, "需要局部上下文");
  assert.equal(assistant.tool_calls[0].function.name, "request_context");
  const toolPayload = JSON.parse(tool.content);
  assert.deepEqual(Object.keys(toolPayload).sort(), ["content", "remaining", "scope", "source"]);
  assert.equal(toolPayload.scope, "section");
  assert.match(toolPayload.content, /旋度描述局部旋转/u);
  assert.equal(events.some((event) => event.type === "tool-start"), true);
  assert.equal(events.some((event) => event.type === "tool-end" && event.isError === false), true);
  assert.equal(events.filter((event) => event.type === "text-delta").map((event) => event.text).join(""), "结合所在章节，旋度表示局部旋转趋势。");
});

void test("custom maxTurns 5 caps four expansions and forces the fifth request to answer", async () => {
  const { PiExecutionEngine } = load("src/agent/pi/pi-execution-engine.js");
  const requests = [];
  const engine = new PiExecutionEngine({
    strategy: "progressive",
    maxTurns: 5,
    async bufferedRequest(providerRequest) {
      requests.push(providerRequest);
      if (requests.length <= 4) {
        return openAiToolResponse(providerRequest, `还需要第 ${String(requests.length)} 批`, `call-${String(requests.length)}`);
      }
      return openAiResponse("基于现有证据给出最终回答。");
    }
  });

  const events = await collect(engine.execute(expandedRequest("请全面分析旋度。"), new AbortController().signal));
  assert.equal(requests.length, 5);
  assert.equal(Array.isArray(requests[4].body.tools), true);
  assert.equal(Object.hasOwn(requests[4].body, "tool_choice"), false);
  assert.match(JSON.stringify(requests[4].body.messages), /上下文扩展已结束或达到限制/u);
  const toolEnds = events.filter((event) => event.type === "tool-end");
  assert.equal(toolEnds.length, 4);
  assert.equal(new Set(toolEnds.flatMap((event) => [...event.notePaths, ...(event.nodeIds ?? [])])).size > 0, true);
  assert.equal(events.filter((event) => event.type === "text-delta").map((event) => event.text).join(""), "基于现有证据给出最终回答。");
});

function externalRequest(relatedNotesAllowed) {
  const base = request("旋度是什么意思？", "deepseek");
  const content = "## 旋度\n旋度描述局部旋转。";
  const offset = content.lastIndexOf("旋度");
  base.piContext.relatedNotesAllowed = relatedNotesAllowed;
  base.piContext.focus.anchors[0].selectionStartOffset = offset;
  base.piContext.focus.anchors[0].selectionEndOffset = offset + 2;
  base.piContext.conversationNodes = [
    {
      id: "parent",
      parentId: null,
      title: "父节点",
      depth: 0,
      root: true,
      current: false,
      messages: [{ id: "pm", role: "assistant", content: "## 旧背景\n这段父节点内容与问题关系较弱。", status: "complete", selectionQuotes: [] }]
    },
    {
      id: "current",
      parentId: "parent",
      title: "当前节点",
      depth: 1,
      root: false,
      current: true,
      messages: []
    }
  ];
  base.piContext.noteContextGraph = {
    protocol: "note-context-graph:v1",
    rootNodeIds: ["N0"],
    fullNoteContext: true,
    relatedNotesEnabled: relatedNotesAllowed,
    perNoteBudget: "full",
    maxDepth: 2,
    builtAt: "2026-08-05T00:00:00.000Z",
    nodes: [
      {
        id: "N0",
        filePath: "Math/Vector.md",
        fileName: "Vector.md",
        content,
        contentHash: "h0",
        depth: 0,
        root: true,
        primaryChain: ["N0"],
        parentIds: [],
        outgoingNodeIds: ["N1"]
      },
      {
        id: "N1",
        filePath: "Math/Related-Curl.md",
        fileName: "Related-Curl.md",
        content: "## 旋度定义与几何意义\n旋度刻画向量场局部旋转，方向遵循右手定则。",
        contentHash: "h1",
        depth: 1,
        root: false,
        primaryParentId: "N0",
        primaryChain: ["N0", "N1"],
        parentIds: ["N0"],
        outgoingNodeIds: []
      }
    ],
    edges: [{ sourceNodeId: "N0", targetNodeId: "N1", labels: ["link"] }],
    unresolvedLinks: []
  };
  return base;
}

void test("progressive ladder skips exhausted L2 and respects related-note permission at L3", async () => {
  const { PiExecutionEngine } = load("src/agent/pi/pi-execution-engine.js");
  for (const relatedNotesAllowed of [false, true]) {
    const requests = [];
    const engine = new PiExecutionEngine({
      strategy: "progressive",
      async bufferedRequest(providerRequest) {
        requests.push(providerRequest);
        if (requests.length <= 2) return openAiToolResponse(providerRequest, "还缺少外部语境", `call-${String(requests.length)}`);
        return openAiResponse("最终比较结果");
      }
    });
    const events = await collect(engine.execute(externalRequest(relatedNotesAllowed), new AbortController().signal));
    const expanded = events.filter((event) => event.type === "progressive-context-batch" && event.expansionReason !== "initial");
    assert.deepEqual(expanded.map((event) => event.level), [1, 3]);
    assert.equal(expanded[1].relatedNote, relatedNotesAllowed);
    if (relatedNotesAllowed) {
      assert.deepEqual(expanded[1].notePaths, ["Math/Related-Curl.md"]);
    } else {
      assert.deepEqual(expanded[1].nodeIds, ["parent"]);
      assert.deepEqual(expanded[1].notePaths, []);
    }
  }
});

void test("progressive expansion IDs remain unique and levels never decrease", async () => {
  const { PiExecutionEngine } = load("src/agent/pi/pi-execution-engine.js");
  const requests = [];
  const engine = new PiExecutionEngine({
    strategy: "progressive",
    async bufferedRequest(providerRequest) {
      requests.push(providerRequest);
      return requests.length <= 4
        ? openAiToolResponse(providerRequest, "继续扩展", `unique-${String(requests.length)}`)
        : openAiResponse("完成");
    }
  });
  const events = await collect(engine.execute(expandedRequest("请全面分析旋度。"), new AbortController().signal));
  const expanded = events.filter((event) => event.type === "progressive-context-batch" && event.expansionReason !== "initial");
  const ids = expanded.map((event) => event.evidenceId);
  const levels = expanded.map((event) => event.level);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(levels.every((level, index) => index === 0 || level >= levels[index - 1]), true);
});

void test("progressive abort finishes aborted without making a provider request", async () => {
  const { PiExecutionEngine } = load("src/agent/pi/pi-execution-engine.js");
  let calls = 0;
  const engine = new PiExecutionEngine({
    strategy: "progressive",
    async bufferedRequest() {
      calls += 1;
      return openAiResponse("不应调用");
    }
  });
  const controller = new AbortController();
  controller.abort();
  const events = await collect(engine.execute(request(), controller.signal));
  assert.equal(calls, 0);
  assert.equal(events.at(-1).type, "finish");
  assert.equal(events.at(-1).reason, "aborted");
  assert.equal(events.some((event) => event.type === "text-delta"), false);
});

void test("progressive length retry keeps the expanded message sequence and does not rerun expansion", async () => {
  const { PiExecutionEngine } = load("src/agent/pi/pi-execution-engine.js");
  const requests = [];
  const engine = new PiExecutionEngine({
    strategy: "progressive",
    async bufferedRequest(providerRequest) {
      requests.push(providerRequest);
      if (requests.length === 1) return openAiToolResponse(providerRequest, "证明需要局部章节", "proof-expand");
      if (requests.length === 2) {
        return {
          status: 200,
          json: {
            choices: [{ message: { content: "", reasoning_content: "长推理" }, finish_reason: "length" }],
            usage: { prompt_tokens: 20, completion_tokens: 16, reasoning_tokens: 16 }
          }
        };
      }
      return openAiResponse("无思考重试后的证明回答。");
    }
  });
  const proofRequest = expandedRequest("请证明旋度定义为什么具有这个几何意义。");
  const events = await collect(engine.execute(proofRequest, new AbortController().signal));
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[1].body.messages, requests[2].body.messages);
  assert.equal(requests[1].body.thinking.type, "enabled");
  assert.equal(requests[2].body.thinking.type, "disabled");
  assert.equal(events.filter((event) => event.type === "tool-end").length, 1);
  assert.equal(events.filter((event) => event.type === "text-delta").map((event) => event.text).join(""), "无思考重试后的证明回答。");
});

void test("provider-aware default uses progressive for DeepSeek without an explicit strategy", async () => {
  const { PiExecutionEngine } = load("src/agent/pi/pi-execution-engine.js");
  const requests = [];
  const engine = new PiExecutionEngine({
    async bufferedRequest(providerRequest) {
      requests.push(providerRequest);
      return openAiResponse("默认渐进式回答");
    }
  });
  const events = await collect(engine.execute(request(), new AbortController().signal));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.tools[0].function.name, "request_context");
  assert.doesNotMatch(JSON.stringify(requests[0].body), /Output Contract|TT_MODE/u);
  assert.equal(events.some((event) => event.type === "progressive-context-start"), true);
});

function anthropicResponse(text) {
  return { status: 200, json: { content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 4 } } };
}
function geminiResponse(text) {
  return { status: 200, json: { candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4 } } };
}

void test("Anthropic and Gemini defaults retain the explicit two-pass compatibility path", async () => {
  const { PiExecutionEngine } = load("src/agent/pi/pi-execution-engine.js");
  for (const kind of ["anthropic", "gemini"]) {
    const requests = [];
    const engine = new PiExecutionEngine({
      async bufferedRequest(providerRequest) {
        requests.push(providerRequest);
        const text = requests.length === 1
          ? JSON.stringify({ focusScope: "selection_only", notes: [], nodes: [] })
          : "TT_MODE: FINAL\n兼容回答";
        return kind === "anthropic" ? anthropicResponse(text) : geminiResponse(text);
      }
    });
    const events = await collect(engine.execute(request("旋度是什么意思？", kind), new AbortController().signal));
    assert.equal(requests.length, 2);
    assert.match(JSON.stringify(requests[0].body), /Output Contract/u);
    assert.equal(events.some((event) => event.type === "progressive-context-start"), false);
    assert.equal(events.some((event) => event.type === "finish" && event.reason === "stop"), true);
  }
});

void test("web search requests stay inside the progressive semantic-tool ladder", async () => {
  const { PiExecutionEngine } = load("src/agent/pi/pi-execution-engine.js");
  const requests = [];
  const engine = new PiExecutionEngine({
    async bufferedRequest(providerRequest) {
      requests.push(providerRequest);
      return openAiResponse("联网渐进式回答");
    }
  });
  const webRequest = request();
  webRequest.webSearchEnabled = true;
  const events = await collect(engine.execute(webRequest, new AbortController().signal));
  assert.equal(requests.length, 1);
  assert.deepEqual(
    requests[0].body.tools.map((tool) => tool.function.name),
    ["request_context", "search_web", "open_web_result"]
  );
  assert.doesNotMatch(JSON.stringify(requests[0].body), /Output Contract|TT_MODE/u);
  assert.equal(events.some((event) => event.type === "progressive-context-start"), true);
});
