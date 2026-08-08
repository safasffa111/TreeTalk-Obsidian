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

test("agent run records are persisted without credentials", () => {
  const { createAgentRunRecord, applyAgentRunEvent, finishAgentRunRecord } = load("src/domain/agent-run.js");
  let record = createAgentRunRecord({
    executionMode: "pi",
    roleId: "direct",
    routeId: "default",
    providerId: "openai",
    modelId: "gpt-test",
    startedAt: "2026-08-04T00:00:00.000Z"
  });
  record = applyAgentRunEvent(record, {
    type: "context-routing",
    phase: "initial",
    candidateNoteCount: 18,
    candidateNodeCount: 6,
    selectedNoteCount: 12,
    selectedNodeCount: 5,
    materializedNotePaths: ["Math/Gauss.md"],
    materializedNodeIds: ["node-1"],
    evidenceEstimatedTokens: 11870,
    evidenceTokenBudget: 18000,
    omittedSourceCount: 2,
    truncated: true,
    supplementaryUsed: false
  });
  record = applyAgentRunEvent(record, {
    type: "usage",
    usage: { promptTokens: 10, completionTokens: 4, providerReported: true }
  });
  record = finishAgentRunRecord(record, {
    status: "completed",
    finishedAt: "2026-08-04T00:00:01.000Z"
  });
  assert.equal(record.protocol, "pi-agent-run:v1");
  assert.equal(record.status, "completed");
  assert.equal(record.usage.promptTokens, 10);
  assert.equal(record.contextRouting.candidateNoteCount, 18);
  assert.equal(record.contextRouting.materializedNotePaths[0], "Math/Gauss.md");
  assert.doesNotMatch(JSON.stringify(record), /apiKey|secret|Gauss body/u);
});

test("execution router keeps legacy default and exposes Pi direct mode", () => {
  const { ExecutionRouter } = load("src/execution/execution-router.js");
  const legacy = { execute() {} };
  const pi = { execute() {} };
  const router = new ExecutionRouter({ legacy, pi });
  assert.equal(router.resolve("legacy"), legacy);
  assert.equal(router.resolve("pi"), pi);
});

test("settings always normalize execution to Pi", () => {
  const { DEFAULT_SETTINGS, parsePluginData } = load("src/tabs/plugin-data.js");
  assert.equal(parsePluginData({}).settings.executionMode, "pi");
  assert.equal(
    parsePluginData({ settings: { ...DEFAULT_SETTINGS, executionMode: "legacy" } }).settings.executionMode,
    "pi"
  );
});

test("agent run metadata survives canonical conversation parsing", () => {
  const { parseConversation } = load("src/domain/schema.js");
  const now = "2026-08-04T00:00:00.000Z";
  const parsed = parseConversation({
    schemaVersion: 1,
    id: "conversation",
    title: "Agent",
    status: "active",
    revision: 1,
    checksum: "checksum",
    createdAt: now,
    updatedAt: now,
    rootNodeId: "root",
    currentNodeId: "root",
    nodes: {
      root: {
        id: "root",
        parentId: null,
        childIds: [],
        title: "Agent",
        messages: [{
          id: "assistant",
          role: "assistant",
          content: "answer",
          status: "complete",
          createdAt: now,
          updatedAt: now,
          agentRun: {
            protocol: "pi-agent-run:v1",
            executionMode: "pi",
            status: "completed",
            roleId: "direct",
            routeId: "default",
            providerId: "openai",
            modelId: "gpt-test",
            runtime: "pi-agent-core-v0.82.1-vendored",
            stages: [],
            toolExecutions: [],
            contextRouting: {
              phase: "supplementary",
              candidateNoteCount: 18,
              candidateNodeCount: 6,
              selectedNoteCount: 12,
              selectedNodeCount: 5,
              materializedNotePaths: ["Math/Gauss.md"],
              materializedNodeIds: ["node-1"],
              evidenceEstimatedTokens: 11870,
              evidenceTokenBudget: 18000,
              omittedSourceCount: 2,
              truncated: true,
              supplementaryUsed: true
            },
            sources: [],
            startedAt: now,
            finishedAt: now
          }
        }],
        draft: { text: "", mode: "continue", selectionContexts: [] },
        createdAt: now,
        updatedAt: now
      }
    },
    ui: { expandedNodeIds: [], treeScrollTop: 0, messageScrollTopByNode: {} }
  });
  assert.equal(parsed.nodes.root.messages[0].agentRun.status, "completed");
  assert.equal(parsed.nodes.root.messages[0].agentRun.executionMode, "pi");
  assert.equal(parsed.nodes.root.messages[0].agentRun.contextRouting.phase, "supplementary");
  assert.equal(parsed.nodes.root.messages[0].agentRun.contextRouting.evidenceTokenBudget, 18000);
});

test("legacy engine preserves streaming text usage and completion", async () => {
  const { LegacyExecutionEngine } = load("src/execution/legacy-execution-engine.js");
  const adapter = {
    buildRequest(input) {
      return { url: "https://example.test", method: "POST", headers: {}, body: input };
    },
    parseBuffered() { return []; }
  };
  const engine = new LegacyExecutionEngine({
    resolveAdapter: () => adapter,
    stream: async function* () {
      yield { type: "delta", text: "你" };
      yield { type: "usage", usage: { promptTokens: 3, completionTokens: 1, providerReported: true } };
      yield { type: "delta", text: "好" };
      yield { type: "done" };
    },
    bufferedRequest: async () => ({ status: 200, json: {} }),
    now: () => "2026-08-04T00:00:00.000Z"
  });
  const events = [];
  const request = {
    conversationId: "conversation",
    nodeId: "node",
    assistantMessageId: "assistant",
    contextMessages: [{ role: "user", content: "hello" }],
    roleId: "direct",
    route: {
      routeId: "default",
      providerProfile: { id: "default", name: "Default", kind: "openai", apiKey: "secret", baseUrl: "" },
      modelId: "gpt-test"
    },
    webSearchEnabled: false
  };
  for await (const event of engine.execute(request, new AbortController().signal)) events.push(event);
  assert.deepEqual(events.filter((event) => event.type === "text-delta").map((event) => event.text), ["你", "好"]);
  assert.equal(events.find((event) => event.type === "usage").usage.promptTokens, 3);
  assert.deepEqual(events.at(-1), { type: "finish", reason: "stop" });
});

test("Pi Agent uses a selector pass followed by a clean answer pass", async () => {
  const { PiExecutionEngine } = load("src/agent/pi/pi-execution-engine.js");
  const requests = [];
  const replies = [
    {
      status: 200,
      json: {
        choices: [{ message: { content: JSON.stringify({ notes: [], nodes: [] }) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 1 }
      }
    },
    {
      status: 200,
      json: {
        choices: [{ message: { content: "answer" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 4, completion_tokens: 1 }
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
  const request = {
    conversationId: "conversation",
    nodeId: "node",
    assistantMessageId: "assistant",
    contextMessages: [{ role: "user", content: "hello" }],
    piContext: {
      currentQuestion: "hello",
      selectedQuotes: [],
      conversationNodes: []
    },
    roleId: "direct",
    route: {
      routeId: "default",
      providerProfile: { id: "default", name: "Default", kind: "openai", apiKey: "secret", baseUrl: "" },
      modelId: "gpt-test"
    },
    webSearchEnabled: false
  };
  for await (const event of engine.execute(request, new AbortController().signal)) events.push(event);
  assert.equal(requests.length, 2);
  assert.equal("tools" in requests[0].body, false);
  assert.equal("tools" in requests[1].body, false);
  assert.equal(events[0].runtime, "pi-agent-core-v0.82.1-vendored");
  assert.deepEqual(events.filter((event) => event.type === "text-delta").map((event) => event.text), ["answer"]);
  assert.equal(events.filter((event) => event.type === "usage").at(-1).usage.promptTokens, 7);
  assert.deepEqual(events.at(-1), { type: "finish", reason: "stop" });
});

test("assistant lifecycle stores and finalizes AgentRun metadata", () => {
  const { startAssistantResponse, finishAssistantResponse } = load("src/domain/assistant-response.js");
  const now = "2026-08-04T00:00:00.000Z";
  const conversation = {
    schemaVersion: 1,
    id: "conversation",
    title: "Agent",
    status: "active",
    revision: 1,
    checksum: "checksum",
    createdAt: now,
    updatedAt: now,
    rootNodeId: "root",
    currentNodeId: "root",
    nodes: {
      root: {
        id: "root",
        parentId: null,
        childIds: [],
        title: "Agent",
        messages: [],
        draft: { text: "", mode: "continue", selectionContexts: [] },
        createdAt: now,
        updatedAt: now
      }
    },
    ui: { expandedNodeIds: [], treeScrollTop: 0, messageScrollTopByNode: {} }
  };
  const run = {
    protocol: "pi-agent-run:v1",
    executionMode: "pi",
    status: "running",
    roleId: "direct",
    routeId: "default",
    providerId: "openai",
    modelId: "gpt-test",
    stages: [],
    toolExecutions: [],
    sources: [],
    startedAt: now
  };
  const started = startAssistantResponse(conversation, {
    conversationId: "conversation",
    nodeId: "root",
    messageId: "assistant",
    modelId: "gpt-test",
    now,
    agentRun: run
  });
  assert.equal(started.nodes.root.messages[0].agentRun.status, "running");
  const finished = finishAssistantResponse(started, {
    conversationId: "conversation",
    nodeId: "root",
    messageId: "assistant",
    status: "complete",
    now,
    agentRun: { ...run, status: "completed", finishedAt: now }
  });
  assert.equal(finished.nodes.root.messages[0].agentRun.status, "completed");
});

test("main retains compatibility engines but routes normal sends through fixed Pi", () => {
  const source = fs.readFileSync(path.join(root, "src/main.ts"), "utf8");
  assert.match(source, /ExecutionRouter/);
  assert.match(source, /LegacyExecutionEngine/);
  assert.match(source, /PiExecutionEngine/);
  assert.match(source, /executionRouter\.resolve\(executionMode\)/);
  assert.match(source, /sendCoordinator\.execute/);
  assert.doesNotMatch(source, /for await \(const event of engine\.execute/);
  assert.match(source, /const executionMode = "pi";/);
  assert.doesNotMatch(source, /setExecutionMode/);
  assert.match(source, /piContext:/);
  assert.doesNotMatch(source, /while \(!receivedDone\)/);
});

test("agent execution trace renders as a collapsed message-local detail", () => {
  const view = fs.readFileSync(path.join(root, "src/views/conversation-view.ts"), "utf8");
  const styles = fs.readFileSync(path.join(root, "styles.css"), "utf8");
  assert.match(view, /agentExecutionViewModel/);
  assert.match(view, /treetalk-agent-execution/);
  assert.match(view, /message\.agentRun/);
  assert.match(styles, /\.treetalk-agent-execution/);
});

test("agent execution view exposes two-pass routing and evidence budget", () => {
  const { agentExecutionViewModel } = load("src/agent/ui/execution-view-model.js");
  const model = agentExecutionViewModel({
    protocol: "pi-agent-run:v1",
    executionMode: "pi",
    status: "completed",
    roleId: "direct",
    routeId: "default",
    providerId: "deepseek",
    modelId: "deepseek-test",
    stages: [
      { stageId: "pi-context-selector", roleId: "direct", routeId: "default", status: "completed", startedAt: "2026-08-04T00:00:00.000Z", finishedAt: "2026-08-04T00:00:01.000Z" },
      { stageId: "pi-evidence-answer", roleId: "direct", routeId: "default", status: "completed", startedAt: "2026-08-04T00:00:01.000Z", finishedAt: "2026-08-04T00:00:02.000Z" }
    ],
    toolExecutions: [],
    contextRouting: {
      phase: "initial",
      candidateNoteCount: 27,
      candidateNodeCount: 8,
      selectedNoteCount: 12,
      selectedNodeCount: 5,
      materializedNotePaths: ["Math/Gauss.md", "Math/Divergence.md"],
      materializedNodeIds: ["node-1"],
      evidenceEstimatedTokens: 11870,
      evidenceTokenBudget: 18000,
      omittedSourceCount: 2,
      truncated: true,
      supplementaryUsed: false
    },
    sources: [],
    startedAt: "2026-08-04T00:00:00.000Z",
    finishedAt: "2026-08-04T00:00:02.000Z"
  });
  assert.deepEqual(model.rows.find(([label]) => label === "阶段"), ["阶段", "上下文选择 → 证据回答"]);
  assert.deepEqual(model.rows.find(([label]) => label === "候选笔记"), ["候选笔记", "27"]);
  assert.deepEqual(model.rows.find(([label]) => label === "证据 Token"), ["证据 Token", "11,870 / 18,000"]);
  assert.deepEqual(model.rows.find(([label]) => label === "补充读取"), ["补充读取", "未使用"]);
  assert.deepEqual(model.rows.find(([label]) => label === "证据裁剪"), ["证据裁剪", "已按 Token 预算裁剪"]);
});

test("send coordinator owns the engine-neutral execution lifecycle", async () => {
  const { SendCoordinator } = load("src/execution/send-coordinator.js");
  const { ExecutionEventRecorder } = load("src/execution/event-recorder.js");
  const engine = {
    async *execute() {
      yield { type: "agent-start", runtime: "pi-agent-core-compatible", roleId: "direct" };
      yield { type: "stage-start", stageId: "direct", roleId: "direct", routeId: "default", startedAt: "2026-08-04T00:00:00.000Z" };
      yield { type: "context-routing", phase: "initial", candidateNoteCount: 4, candidateNodeCount: 2, selectedNoteCount: 3, selectedNodeCount: 1, materializedNotePaths: ["Math/Gauss.md"], materializedNodeIds: ["node-1"], evidenceEstimatedTokens: 900, evidenceTokenBudget: 12000, omittedSourceCount: 0, truncated: false, supplementaryUsed: false };
      yield { type: "text-delta", text: "answer" };
      yield { type: "sources", sources: [{ title: "Source", url: "https://example.test" }] };
      yield { type: "usage", usage: { promptTokens: 7, completionTokens: 2, providerReported: true } };
      yield { type: "finish", reason: "stop" };
    }
  };
  const recorder = new ExecutionEventRecorder({
    executionMode: "pi",
    roleId: "direct",
    routeId: "default",
    providerId: "openai",
    modelId: "gpt-test",
    startedAt: "2026-08-04T00:00:00.000Z"
  });
  const deltas = [];
  const records = [];
  const result = await new SendCoordinator({
    now: () => "2026-08-04T00:00:01.000Z"
  }).execute({
    engine,
    request: {},
    signal: new AbortController().signal,
    recorder,
    hooks: {
      onTextDelta: (text) => deltas.push(text),
      onThinkingDelta: () => {},
      onResponseStatus: () => {},
      onAgentRun: (record) => records.push(record)
    }
  });
  assert.equal(result.status, "completed");
  assert.equal(result.receivedText, true);
  assert.deepEqual(deltas, ["answer"]);
  assert.equal(result.sources[0].title, "Source");
  assert.equal(result.agentRun.status, "completed");
  assert.equal(result.agentRun.usage.promptTokens, 7);
  assert.equal(result.agentRun.contextRouting.selectedNoteCount, 3);
  assert.ok(records.length >= 3);
});

test("active response failure preserves the recorded error message", () => {
  const { ActiveResponseRequests } = load("src/providers/active-response-requests.js");
  const finished = [];
  const router = {
    finish(_ticket, response) { finished.push(response); },
    agentRun() {}
  };
  const requests = new ActiveResponseRequests(router);
  const run = {
    protocol: "pi-agent-run:v1",
    executionMode: "pi",
    status: "failed",
    roleId: "direct",
    routeId: "default",
    providerId: "openai",
    modelId: "gpt-test",
    stages: [],
    toolExecutions: [],
    sources: [],
    startedAt: "2026-08-04T00:00:00.000Z",
    finishedAt: "2026-08-04T00:00:01.000Z",
    errorMessage: "provider failed"
  };
  const ticket = { tabId: "tab", conversationId: "conversation", nodeId: "node", requestEpoch: 0 };
  const handle = requests.begin("conversation", ticket, "assistant", run);
  requests.finish(handle, "failed", "2026-08-04T00:00:02.000Z");
  assert.equal(finished[0].agentRun.errorMessage, "provider failed");
});

test("progressive context diagnostics persist metadata without evidence or reasoning content", () => {
  const { createAgentRunRecord, applyAgentRunEvent, finishAgentRunRecord } = load("src/domain/agent-run.js");
  let record = createAgentRunRecord({
    executionMode: "pi",
    roleId: "direct",
    routeId: "default",
    providerId: "deepseek",
    modelId: "deepseek-test",
    startedAt: "2026-08-05T00:00:00.000Z"
  });
  record = applyAgentRunEvent(record, {
    type: "progressive-context-start",
    initialLevel: 0,
    reason: "精确目标或自包含任务",
    maximumEvidenceTokens: 8000,
    maximumExpansions: 4,
    relatedNotesAllowed: true
  });
  record = applyAgentRunEvent(record, {
    type: "progressive-context-batch",
    level: 0,
    evidenceId: "e0",
    sourceKind: "selection",
    sourceId: "N0",
    title: "旋度",
    relationship: "primary-target",
    estimatedTokens: 40,
    notePaths: ["Math/Vector.md"],
    nodeIds: [],
    relatedNote: false,
    expansionReason: "initial",
    exhausted: false
  });
  record = applyAgentRunEvent(record, {
    type: "progressive-context-batch",
    level: 3,
    evidenceId: "e1",
    sourceKind: "section",
    sourceId: "N1",
    title: "斯托克斯公式 · 旋度",
    relationship: "related-note-depth-1",
    estimatedTokens: 300,
    notePaths: ["Math/Stokes.md"],
    nodeIds: [],
    relatedNote: true,
    expansionReason: "需要比较相关公式",
    exhausted: false
  });
  record = finishAgentRunRecord(record, {
    status: "completed",
    finishedAt: "2026-08-05T00:00:01.000Z"
  });
  assert.equal(record.progressiveContext.initialLevel, 0);
  assert.equal(record.progressiveContext.finalLevel, 3);
  assert.equal(record.progressiveContext.expansionCount, 1);
  assert.equal(record.progressiveContext.deliveredEvidenceTokens, 340);
  assert.equal(record.progressiveContext.relatedNotesUsed, true);
  assert.equal(record.progressiveContext.batches.length, 2);
  const serialized = JSON.stringify(record);
  assert.doesNotMatch(serialized, /旋度刻画向量场|reasoningContent|thinking-delta|tool_calls/u);
});

test("progressive context diagnostics survive schema parsing and render concise rows", () => {
  const { parseConversation } = load("src/domain/schema.js");
  const { agentExecutionViewModel } = load("src/agent/ui/execution-view-model.js");
  const now = "2026-08-05T00:00:00.000Z";
  const progressiveContext = {
    initialLevel: 0,
    finalLevel: 2,
    startReason: "精确目标或自包含任务",
    maximumEvidenceTokens: 8000,
    maximumExpansions: 4,
    deliveredEvidenceTokens: 2340,
    expansionCount: 2,
    relatedNotesAllowed: true,
    relatedNotesUsed: false,
    batches: [{
      level: 2,
      evidenceId: "e2",
      sourceKind: "note",
      sourceId: "N0",
      title: "Vector.md · 定义",
      relationship: "target-full-source",
      estimatedTokens: 1200,
      notePaths: ["Math/Vector.md"],
      nodeIds: [],
      expansionReason: "缺少定义"
    }]
  };
  const parsed = parseConversation({
    schemaVersion: 1,
    id: "conversation",
    title: "Progressive",
    status: "active",
    revision: 1,
    checksum: "checksum",
    createdAt: now,
    updatedAt: now,
    rootNodeId: "root",
    currentNodeId: "root",
    nodes: {
      root: {
        id: "root",
        parentId: null,
        childIds: [],
        title: "Root",
        messages: [{
          id: "assistant",
          role: "assistant",
          content: "answer",
          status: "complete",
          createdAt: now,
          updatedAt: now,
          agentRun: {
            protocol: "pi-agent-run:v1",
            executionMode: "pi",
            status: "completed",
            roleId: "direct",
            routeId: "default",
            providerId: "deepseek",
            modelId: "deepseek-test",
            stages: [],
            toolExecutions: [],
            progressiveContext,
            sources: [],
            startedAt: now,
            finishedAt: now
          }
        }],
        draft: { text: "", mode: "continue", selectionContexts: [] },
        createdAt: now,
        updatedAt: now
      }
    },
    ui: { expandedNodeIds: [], treeScrollTop: 0, messageScrollTopByNode: {} }
  });
  const record = parsed.nodes.root.messages[0].agentRun;
  assert.deepEqual(record.progressiveContext, progressiveContext);
  const model = agentExecutionViewModel(record);
  assert.deepEqual(model.rows.find(([label]) => label === "上下文起点"), ["上下文起点", "L0 · 精确目标"]);
  assert.deepEqual(model.rows.find(([label]) => label === "最终层级"), ["最终层级", "L2"]);
  assert.deepEqual(model.rows.find(([label]) => label === "上下文扩展"), ["上下文扩展", "2 / 4"]);
  assert.deepEqual(model.rows.find(([label]) => label === "关联笔记"), ["关联笔记", "允许，但未使用"]);
});

void test("send and retry hold a sending placeholder across the async freeze gap", () => {
  const source = fs.readFileSync(path.join(root, "src/main.ts"), "utf8");
  assert.match(source, /sendingConversations/u);
  assert.match(source, /this\.sendingConversations\.add\(tab\.conversationId\)/u);
  assert.match(
    source,
    /finally\s*\{[\s\S]*?this\.sendingConversations\.delete\(tab\.conversationId\)/u
  );
  assert.match(source, /TreeTalk 无法开始回复/u);
});
