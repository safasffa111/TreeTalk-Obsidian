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

function profile(kind = "deepseek") {
  return {
    id: kind,
    kind,
    displayName: kind,
    baseUrl: kind === "deepseek" ? "https://api.deepseek.com" : "https://api.openai.com/v1",
    apiKey: "key",
    models: ["m"]
  };
}

function request(kind = "deepseek", overrides = {}) {
  return {
    conversationId: "c",
    nodeId: "current",
    assistantMessageId: "out",
    contextMessages: [],
    currentQuestion: "继续处理",
    answerThinkingMode: "disabled",
    streamingOutputEnabled: false,
    contextDivergenceEnabled: false,
    piContext: {
      currentQuestion: "继续处理",
      selectedQuotes: [],
      relatedNotesAllowed: false,
      conversationNodes: [
        {
          id: "parent",
          parentId: null,
          title: "父节点",
          depth: 0,
          root: true,
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
          depth: 1,
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
    route: { routeId: "r", providerProfile: profile(kind), modelId: "m" },
    webSearchEnabled: false,
    ...overrides
  };
}

function response(text, usage = { prompt_tokens: 10, completion_tokens: 4 }) {
  return {
    status: 200,
    json: {
      choices: [{ message: { content: text }, finish_reason: "stop" }],
      usage
    }
  };
}

function lengthWithoutText(usage) {
  return {
    status: 200,
    json: {
      choices: [{
        message: { content: null, reasoning_content: "思考但未输出正文" },
        finish_reason: "length"
      }],
      usage
    }
  };
}

function lengthWithText(text, usage) {
  return {
    status: 200,
    json: {
      choices: [{
        message: { content: text },
        finish_reason: "length"
      }],
      usage: usage ?? { prompt_tokens: 10, completion_tokens: 4 }
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
              name: "request_context",
              arguments: JSON.stringify({ target: call.target, reason: "需要上下文" })
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

void test("DeepSeek progressive requests never send tool_choice, including the forced final turn", async () => {
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

  await collect(engine.execute(request("deepseek"), new AbortController().signal));

  assert.equal(requests.length, 2);
  assert.equal(Object.hasOwn(requests[0].body, "tool_choice"), false);
  assert.equal(Object.hasOwn(requests[1].body, "tool_choice"), false);
  assert.deepEqual(requests[1].body.tools, requests[0].body.tools);
});

void test("OpenAI-compatible progressive requests keep auto and none tool_choice behavior", async () => {
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

  await collect(engine.execute(request("openai-compatible"), new AbortController().signal));

  assert.equal(requests[0].body.tool_choice, "auto");
  assert.equal(requests[1].body.tool_choice, "none");
});

void test("one tool call after forced-answer mode is acknowledged and retried without expanding context", async () => {
  const { PiExecutionEngine } = load("src/agent/pi/pi-execution-engine.js");
  const requests = [];
  const noExpansionRequest = request("deepseek");
  noExpansionRequest.piContext.conversationNodes = [];
  noExpansionRequest.piContext.focus = {
    interactionMode: "continue",
    defaultScope: "latest_round",
    anchors: [],
    targets: []
  };
  const engine = new PiExecutionEngine({
    strategy: "progressive",
    maxTurns: 3,
    async bufferedRequest(req) {
      requests.push(req);
      return requests.length === 1
        ? toolCallsResponse([{ id: "call-after-final", target: "current_source" }])
        : response("最终完成");
    }
  });

  const events = await collect(
    engine.execute(noExpansionRequest, new AbortController().signal)
  );

  assert.equal(requests.length, 2);
  const finalRetryMessages = requests[1].body.messages;
  const delayedResult = finalRetryMessages.find(
    (message) => message.role === "tool" && message.tool_call_id === "call-after-final"
  );
  assert.ok(delayedResult);
  assert.match(delayedResult.content, /上下文扩展已结束/u);
  assert.equal(
    events.filter(
      (event) => event.type === "progressive-context-batch" && event.expansionReason !== "initial"
    ).length,
    0
  );
  assert.equal(events.some((event) => event.type === "finish"), true);
});

void test("a transient provider error is retried once with the identical message prefix", async () => {
  const { PiExecutionEngine } = load("src/agent/pi/pi-execution-engine.js");
  const requests = [];
  const engine = new PiExecutionEngine({
    strategy: "progressive",
    maxTurns: 2,
    async bufferedRequest(req) {
      requests.push(req);
      if (requests.length === 1) {
        return { status: 500, json: { error: { message: "temporary" } } };
      }
      if (requests.length === 2) {
        return toolCallsResponse([{ id: "call-retry", target: "current_source" }]);
      }
      return response("最终回答");
    }
  });

  const events = await collect(
    engine.execute(request("deepseek"), new AbortController().signal)
  );

  assert.equal(requests.length, 3);
  assert.deepEqual(requests[1].body.messages, requests[0].body.messages);
  assert.deepEqual(requests[1].body.tools, requests[0].body.tools);
  assert.equal(
    events.some((event) => event.type === "error"),
    false
  );
  assert.equal(events.some((event) => event.type === "finish"), true);
});

void test("every Progressive Pi turn emits a preserved prefix check", async () => {
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

  const events = await collect(
    engine.execute(request("deepseek"), new AbortController().signal)
  );

  assert.equal(requests.length, 2);
  const checks = events.filter(
    (event) => event.type === "progressive-prefix-check"
  );
  assert.equal(checks.length, 2);
  assert.ok(checks.every((check) => check.preserved === true));
  assert.equal(checks[0].messageCount, 2);
  assert.equal(checks[1].messageCount, 6);
});

void test("stable string comparison is a deterministic total order", () => {
  const { compareStable } = load("src/agent/pi/cache-identity.js");
  assert.equal(compareStable("x", "x"), 0);
  assert.ok(compareStable("a", "b") < 0);
  assert.ok(compareStable("b", "a") > 0);
  assert.ok(compareStable("B", "a") > 0);
  assert.ok(compareStable("A", "a") < 0);
  const samples = ["中", "A", "z", "B", "a", "ä", "Z"];
  const first = [...samples].sort(compareStable);
  const second = [...samples].sort(compareStable);
  assert.deepEqual(first, second);
});

void test("Progressive engine emits a checkpoint after every tool turn and resumes from it", async () => {
  const { PiExecutionEngine } = load("src/agent/pi/pi-execution-engine.js");
  const originalRequests = [];
  const engine = new PiExecutionEngine({
    strategy: "progressive",
    maxTurns: 3,
    async bufferedRequest(req) {
      originalRequests.push(req);
      if (originalRequests.length === 1) {
        return toolCallsResponse([{ id: "call-1", target: "current_source" }]);
      }
      if (originalRequests.length === 2) {
        return toolCallsResponse([{ id: "call-2", target: "current_source" }]);
      }
      return response("最终回答");
    }
  });

  const events = await collect(
    engine.execute(request("deepseek"), new AbortController().signal)
  );
  const checkpoints = events.filter(
    (event) => event.type === "progressive-run-checkpoint"
  );
  assert.equal(checkpoints.length, 2);
  assert.equal(checkpoints[0].checkpoint.turnIndex, 1);
  assert.equal(checkpoints[1].checkpoint.turnIndex, 2);
  assert.ok(checkpoints[0].checkpoint.calibration.samples >= 1);
  assert.equal(
    checkpoints[0].checkpoint.messages.length,
    originalRequests[1].body.messages.length - 2
  );

  const resumedRequests = [];
  const resumed = new PiExecutionEngine({
    strategy: "progressive",
    maxTurns: 3,
    async bufferedRequest(req) {
      resumedRequests.push(req);
      return response("续跑完成");
    }
  });
  const resumedRequest = request("deepseek");
  resumedRequest.progressiveResume = structuredClone(checkpoints[1].checkpoint);
  const resumedEvents = await collect(
    resumed.execute(resumedRequest, new AbortController().signal)
  );

  assert.equal(resumedRequests.length, 1);
  assert.equal(
    resumedRequests[0].body.messages.length,
    originalRequests[2].body.messages.length
  );
  assert.deepEqual(
    resumedRequests[0].body.messages,
    originalRequests[2].body.messages
  );
  assert.equal(resumedEvents.some((event) => event.type === "finish"), true);
  const replayedBatches = resumedEvents.filter(
    (event) => event.type === "progressive-context-batch"
  );
  assert.equal(replayedBatches.length, 3);
});

void test("checkpoint store keeps, prunes, and deletes records by assistant message", () => {
  const { ProgressiveRunCheckpointStore } = load(
    "src/state/progressive-run-checkpoint-store.js"
  );
  const store = new ProgressiveRunCheckpointStore();
  const base = request("deepseek");
  const record = {
    userMessageId: "u1",
    assistantMessageId: "a1",
    request: base,
    checkpoint: { turnIndex: 1, messages: [] },
    contextPlan: { mode: "full" },
    updatedAt: "now"
  };
  const otherRecord = {
    ...record,
    assistantMessageId: "a2",
    request: { ...base, conversationId: "other" }
  };
  store.set(record);
  store.set(otherRecord);
  assert.equal(store.get("a1"), record);
  store.prune("c");
  assert.equal(store.get("a1"), undefined);
  assert.equal(store.get("a2"), otherRecord);
  store.delete("a2");
  assert.equal(store.get("a2"), undefined);
  store.clear();
});

void test("token calibrator adjusts estimates toward reported usage and survives snapshots", () => {
  const { TokenCalibrator } = load(
    "src/agent/pi/progressive/token-calibration.js"
  );
  const calibrator = new TokenCalibrator();
  assert.equal(calibrator.ratio(), 1);
  assert.equal(calibrator.adjust(100), 100);
  calibrator.record(1000, 1100);
  calibrator.record(1000, 1300);
  assert.ok(Math.abs(calibrator.ratio() - 1.2) < 0.0001);
  assert.equal(calibrator.adjust(100), 120);
  const snapshot = calibrator.snapshot();
  const restored = TokenCalibrator.restore(snapshot);
  assert.equal(restored.ratio(), calibrator.ratio());
  assert.equal(restored.adjust(250), calibrator.adjust(250));
  assert.equal(TokenCalibrator.restore(undefined).ratio(), 1);
  const clamped = new TokenCalibrator();
  clamped.record(100, 1000);
  assert.equal(clamped.ratio(), 3);
});

void test("a length-truncated final answer continues from the interruption point", async () => {
  const { PiExecutionEngine } = load("src/agent/pi/pi-execution-engine.js");
  const requests = [];
  const engine = new PiExecutionEngine({
    strategy: "progressive",
    maxTurns: 4,
    async bufferedRequest(req) {
      requests.push(req);
      return requests.length === 1
        ? lengthWithText("部分回答内容。")
        : response("部分回答内容。续写完成。");
    }
  });

  const events = await collect(
    engine.execute(request("deepseek"), new AbortController().signal)
  );

  assert.equal(requests.length, 2);
  const continuation = requests[1].body.messages.find(
    (message) =>
      message.role === "user" && message.content.includes("输出长度限制")
  );
  assert.ok(continuation);
  const partial = requests[1].body.messages.find(
    (message) => message.role === "assistant" && message.content === "部分回答内容。"
  );
  assert.ok(partial);
  const text = events
    .filter((event) => event.type === "text-delta")
    .map((event) => event.text)
    .join("");
  assert.equal(text, "部分回答内容。部分回答内容。续写完成。");
  assert.equal(
    events.some((event) => event.type === "finish" && event.reason === "stop"),
    true
  );
});

void test("continuation stops after two truncated rounds", async () => {
  const { PiExecutionEngine } = load("src/agent/pi/pi-execution-engine.js");
  const requests = [];
  const engine = new PiExecutionEngine({
    strategy: "progressive",
    maxTurns: 6,
    async bufferedRequest(req) {
      requests.push(req);
      return lengthWithText(`片段${String(requests.length)}。`);
    }
  });

  const events = await collect(
    engine.execute(request("deepseek"), new AbortController().signal)
  );

  assert.equal(requests.length, 3);
  const finish = events.find((event) => event.type === "finish");
  assert.equal(finish?.reason, "length");
});

void test("restartAssistantResponse resets a failed assistant message for in-place retry", () => {
  const { restartAssistantResponse } = load(
    "src/domain/assistant-response.js"
  );
  const now = "2026-08-06T00:00:00.000Z";
  const conversation = {
    schemaVersion: 1,
    id: "c",
    title: "C",
    status: "active",
    revision: 1,
    checksum: "x",
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
          id: "a",
          role: "assistant",
          content: "回复失败，请重试。",
          status: "failed",
          createdAt: now,
          updatedAt: now
        }],
        draft: { text: "", mode: "continue", selectionContexts: [] },
        createdAt: now,
        updatedAt: now
      }
    },
    ui: { expandedNodeIds: [], treeScrollTop: 0, messageScrollTopByNode: {} }
  };
  const restarted = restartAssistantResponse(conversation, {
    conversationId: "c",
    nodeId: "root",
    messageId: "a",
    now
  });
  const message = restarted.nodes.root.messages[0];
  assert.equal(message.status, "streaming");
  assert.equal(message.content, "");
  assert.equal(restarted.revision, 2);
  const complete = structuredClone(conversation);
  complete.nodes.root.messages[0].status = "complete";
  assert.throws(
    () => restartAssistantResponse(complete, {
      conversationId: "c",
      nodeId: "root",
      messageId: "a",
      now
    }),
    /failed or interrupted/u
  );
});

void test("failed assistant messages expose an in-place retry wired to the resume path", () => {
  const view = fs.readFileSync(
    path.join(root, "src/views/conversation-view.ts"),
    "utf8"
  );
  const main = fs.readFileSync(path.join(root, "src/main.ts"), "utf8");
  const styles = fs.readFileSync(path.join(root, "styles.css"), "utf8");
  assert.match(view, /retryAnswer\?\(messageId: string\)/u);
  assert.match(view, /treetalk-retry-answer/u);
  assert.match(view, /message\.status\s*===\s*"failed"/u);
  assert.match(
    main,
    /retryAnswer:\s*\(messageId\)\s*=>\s*this\.retryAssistant\(messageId\)/u
  );
  assert.match(
    main,
    /progressiveResume:\s*structuredClone\(input\.resume\)/u
  );
  assert.match(main, /onProgressiveRunCheckpoint/u);
  assert.match(styles, /button\.treetalk-retry-answer/u);
});

void test("thinking-disabled recovery is reported as a separate provider stage", async () => {
  const { PiExecutionEngine } = load("src/agent/pi/pi-execution-engine.js");
  const requests = [];
  const engine = new PiExecutionEngine({
    strategy: "progressive",
    maxTurns: 1,
    async bufferedRequest(req) {
      requests.push(req);
      return requests.length === 1
        ? lengthWithoutText({
            prompt_tokens: 100,
            completion_tokens: 40,
            completion_tokens_details: { reasoning_tokens: 40 },
            prompt_cache_hit_tokens: 80,
            prompt_cache_miss_tokens: 20
          })
        : response("恢复后的最终回答", {
            prompt_tokens: 110,
            completion_tokens: 20,
            prompt_cache_hit_tokens: 100,
            prompt_cache_miss_tokens: 10
          });
    }
  });

  const events = await collect(
    engine.execute(
      request("deepseek", { answerThinkingMode: "enabled" }),
      new AbortController().signal
    )
  );

  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.thinking.type, "enabled");
  assert.equal(requests[1].body.thinking.type, "disabled");
  assert.equal(Object.hasOwn(requests[0].body, "tool_choice"), false);
  assert.equal(Object.hasOwn(requests[1].body, "tool_choice"), false);

  const stageStarts = events.filter((event) => event.type === "stage-start");
  assert.deepEqual(
    stageStarts.map((event) => event.stageId),
    [
      "pi-progressive-answer-1",
      "pi-progressive-answer-1-thinking-recovery-1"
    ]
  );
  const stageUsages = events.filter((event) => event.type === "stage-usage");
  assert.equal(stageUsages.length, 2);
  assert.equal(stageUsages[0].usage.promptTokens, 100);
  assert.equal(stageUsages[0].usage.cacheHitTokens, 80);
  assert.equal(stageUsages[1].usage.promptTokens, 110);
  assert.equal(stageUsages[1].usage.cacheHitTokens, 100);

  const totalUsage = events.filter((event) => event.type === "usage").at(-1)?.usage;
  assert.equal(totalUsage.promptTokens, 210);
  assert.equal(totalUsage.cacheHitTokens, 180);
});

void test("execution details label thinking-disabled recovery separately", () => {
  const { agentExecutionViewModel } = load("src/agent/ui/execution-view-model.js");
  const view = agentExecutionViewModel({
    protocol: "pi-agent-run:v1",
    executionMode: "pi",
    status: "completed",
    roleId: "direct",
    routeId: "r",
    providerId: "deepseek",
    modelId: "m",
    stages: [
      {
        stageId: "pi-progressive-answer-1",
        roleId: "direct",
        routeId: "r",
        status: "completed",
        startedAt: "2026-08-06T00:00:00.000Z",
        usage: { promptTokens: 100, cacheHitTokens: 80, providerReported: true }
      },
      {
        stageId: "pi-progressive-answer-1-thinking-recovery-1",
        roleId: "direct",
        routeId: "r",
        status: "completed",
        startedAt: "2026-08-06T00:00:01.000Z",
        usage: { promptTokens: 110, cacheHitTokens: 100, providerReported: true }
      }
    ],
    toolExecutions: [],
    sources: [],
    startedAt: "2026-08-06T00:00:00.000Z",
    finishedAt: "2026-08-06T00:00:02.000Z"
  });

  assert.equal(
    view.rows.some(([label]) => label === "缓存 · Direct（无思考恢复）"),
    true
  );
});
