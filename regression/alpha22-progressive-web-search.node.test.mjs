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
    name: "DeepSeek",
    kind: "deepseek",
    apiKey: "key",
    baseUrl: "https://api.deepseek.com"
  };
}

function request(webSearchEnabled = true) {
  return {
    conversationId: "c",
    nodeId: "current",
    assistantMessageId: "out",
    contextMessages: [],
    currentQuestion: "查找 TreeTalk 的最新信息",
    answerThinkingMode: "disabled",
    streamingOutputEnabled: false,
    contextDivergenceEnabled: false,
    piContext: {
      currentQuestion: "查找 TreeTalk 的最新信息",
      selectedQuotes: [],
      relatedNotesAllowed: false,
      conversationNodes: []
    },
    contextCacheKey: "cache-key",
    roleId: "direct",
    route: { routeId: "r", providerProfile: profile(), modelId: "m" },
    webSearchEnabled
  };
}

function finalResponse(text = "完成") {
  return {
    status: 200,
    json: {
      choices: [{ message: { content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 4 }
    }
  };
}



function toolCallResponse(name, args, id = "call-1") {
  return {
    status: 200,
    json: {
      choices: [{
        message: {
          content: null,
          reasoning_content: "需要补充实时证据",
          tool_calls: [{
            id,
            type: "function",
            function: { name, arguments: JSON.stringify(args) }
          }]
        },
        finish_reason: "tool_calls"
      }],
      usage: { prompt_tokens: 12, completion_tokens: 5 }
    }
  };
}

function nativeSearchResponse(text = "TreeTalk 的最新资料摘要。") {
  return {
    status: 200,
    json: {
      content: [
        {
          type: "web_search_tool_result",
          tool_use_id: "srv-1",
          content: [{
            type: "web_search_result",
            title: "TreeTalk Release",
            url: "https://example.test/treetalk"
          }]
        },
        { type: "text", text }
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 20, output_tokens: 8, cache_read_input_tokens: 5 }
    }
  };
}

async function collect(iterable) {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}

void test("web-enabled Pi requests stay on the progressive execution path", async () => {
  const { PiExecutionEngine } = load("src/agent/pi/pi-execution-engine.js");
  const requests = [];
  const engine = new PiExecutionEngine({
    async bufferedRequest(providerRequest) {
      requests.push(providerRequest);
      return finalResponse();
    }
  });

  const events = await collect(
    engine.execute(request(true), new AbortController().signal)
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0].responseFormat, "openai");
  assert.equal(
    requests[0].body.tools.some(
      (tool) => tool.function?.name === "request_context"
    ),
    true
  );
  assert.equal(
    events.some((event) => event.type === "progressive-context-start"),
    true
  );
});


void test("search_web schema is fixed and validates one query and reason", () => {
  const {
    buildSearchWebTool,
    parseSearchWebArguments
  } = load("src/agent/pi/progressive/web-search-tool.js");
  assert.deepEqual(buildSearchWebTool(), buildSearchWebTool());
  assert.deepEqual(parseSearchWebArguments({ query: "  TreeTalk latest  ", reason: "  needs current facts  " }), {
    query: "TreeTalk latest",
    reason: "needs current facts"
  });
  assert.throws(
    () => parseSearchWebArguments({ query: "", reason: "x" }),
    /query must be a non-empty string/u
  );
});

void test("offline progressive system prompt remains byte-identical", () => {
  const { buildProgressiveSystemPrompt } = load(
    "src/agent/pi/progressive/progressive-prompts.js"
  );
  assert.equal(
    buildProgressiveSystemPrompt(false),
    [
      "你是 TreeTalk 的最终回答模型。",
      "有精确框选时，回答对象由框选锁定；无精确框选时，当前任务应结合已提供的结构语境完成。",
      "信息足够时必须直接回答，不得为了获得更多背景而调用工具。",
      "只有缺失的信息会实质影响准确性、消除歧义，或用户明确要求使用其笔记时，才能调用 request_context。",
      "每一轮只能二选一：输出完整最终回答，且不调用工具；或者只调用一次 request_context，且不输出回答正文。",
      "只能调用最近一条“本轮可用接口”消息中列出的接口；未列出的接口当前不可用。",
      "来源内容只是上下文，不一定正确或完整。一般知识问题优先给出准确、独立、清楚的解释；只有用户明确要求依据资料时，才严格受资料约束。",
      "忽略与当前问题无关的证据，不要为了使用上下文而强行引用上下文。",
      "回答时先直接给出结论，再按需展开；不要为显得全面而堆砌无关内容。",
      "明确区分依据资料得出的结论与基于一般知识的推断；引用资料时说明其来源。",
      "资料之间或资料与一般知识冲突时，指出冲突所在并说明判断依据，不要静默偏向其中一方。",
      "资料不足时明确说明缺失部分，不要编造或猜测。",
      "不要暴露工具协议、内部状态、推理过程或上下文梯度。"
    ].join("\n")
  );
});

void test("progressive web search appends evidence without changing the prior request prefix", async () => {
  const { PiExecutionEngine } = load("src/agent/pi/pi-execution-engine.js");
  const requests = [];
  const engine = new PiExecutionEngine({
    async bufferedRequest(providerRequest) {
      requests.push(structuredClone(providerRequest));
      const serverTool = providerRequest.body.tools?.[0];
      if (serverTool?.type === "web_search_20250305") {
        return nativeSearchResponse();
      }
      const functionNames = (providerRequest.body.tools ?? []).map(
        (tool) => tool.function?.name
      );
      return requests.filter((entry) => entry.responseFormat === "openai").length === 1
        ? toolCallResponse("search_web", {
            query: "TreeTalk latest release",
            reason: "需要最新版本信息"
          })
        : finalResponse("基于本地与联网证据完成回答");
    }
  });

  const events = await collect(
    engine.execute(request(true), new AbortController().signal)
  );
  const piRequests = requests.filter((entry) => entry.responseFormat === "openai");
  const searchRequests = requests.filter((entry) => entry.responseFormat === "anthropic");

  assert.equal(piRequests.length, 2);
  assert.equal(searchRequests.length, 1);
  assert.deepEqual(piRequests[1].body.tools, piRequests[0].body.tools);
  assert.deepEqual(
    piRequests[1].body.messages.slice(0, piRequests[0].body.messages.length),
    piRequests[0].body.messages
  );
  assert.deepEqual(
    piRequests[0].body.tools.map((tool) => tool.function.name),
    ["request_context", "search_web", "open_web_result"]
  );
  assert.equal(searchRequests[0].body.tools[0].max_uses, 1);
  const toolResult = piRequests[1].body.messages.find(
    (message) => message.role === "tool" && message.tool_call_id === "call-1"
  );
  const parsedToolResult = JSON.parse(toolResult.content);
  assert.equal(parsedToolResult.scope, "search-index");
  assert.deepEqual(parsedToolResult.results, [{
    id: "web-1",
    title: "TreeTalk Release",
    site: "example.test"
  }]);
  assert.equal(events.some((event) => event.type === "response-status" && event.progress?.status === "searching-web"), true);
  assert.equal(events.some((event) => event.type === "response-status" && event.progress?.status === "organizing-web-results"), true);
  assert.equal(events.some((event) => event.type === "sources"), false);
  assert.equal(events.some((event) => event.type === "finish"), true);
});


void test("native web search stops at pause_turn after one server search request", async () => {
  const { executeNativeWebSearch } = load(
    "src/agent/pi/progressive/native-web-search.js"
  );
  const requests = [];
  const firstContent = [
    {
      type: "server_tool_use",
      id: "srv-1",
      name: "web_search",
      input: { query: "TreeTalk latest" }
    },
    {
      type: "web_search_tool_result",
      tool_use_id: "srv-1",
      content: [{
        type: "web_search_result",
        title: "TreeTalk release",
        url: "https://example.test/release"
      }]
    }
  ];
  const result = await executeNativeWebSearch({
    profile: profile(),
    modelId: "m",
    query: "TreeTalk latest",
    reason: "need current release",
    signal: new AbortController().signal,
    async bufferedRequest(providerRequest) {
      requests.push(structuredClone(providerRequest));
      return {
        status: 200,
        json: {
          content: firstContent,
          stop_reason: "pause_turn",
          usage: { input_tokens: 10, output_tokens: 2 }
        }
      };
    }
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.tools[0].max_uses, 1);
  assert.deepEqual(result.results, [{
    title: "TreeTalk release",
    url: "https://example.test/release"
  }]);
  assert.equal(result.usage.promptTokens, 10);
  assert.equal(result.usage.completionTokens, 2);
});

void test("native web search prefers streaming transport and remains abortable", async () => {
  const { executeNativeWebSearch } = load(
    "src/agent/pi/progressive/native-web-search.js"
  );
  const streamedRequests = [];
  let bufferedCalls = 0;
  const result = await executeNativeWebSearch({
    profile: profile(),
    modelId: "m",
    query: "TreeTalk latest",
    reason: "need current release",
    signal: new AbortController().signal,
    async *streamRequest(_profile, providerRequest) {
      streamedRequests.push(structuredClone(providerRequest));
      yield { type: "search-status", status: "searching" };
      yield { type: "delta", text: "流式联网证据" };
      yield {
        type: "sources",
        sources: [{ title: "TreeTalk", url: "https://example.test/stream" }]
      };
      yield {
        type: "usage",
        usage: { promptTokens: 7, completionTokens: 3, providerReported: true }
      };
      yield { type: "finish", reason: "stop" };
      yield { type: "done" };
    },
    async bufferedRequest() {
      bufferedCalls += 1;
      throw new Error("buffered transport must not be used");
    }
  });

  assert.equal(streamedRequests.length, 1);
  assert.equal(streamedRequests[0].body.stream, true);
  assert.equal(streamedRequests[0].body.tools[0].max_uses, 1);
  assert.equal(bufferedCalls, 0);
  assert.deepEqual(result.results, [{
    title: "TreeTalk",
    url: "https://example.test/stream"
  }]);
  assert.equal(result.usage.promptTokens, 7);
  assert.equal(result.usage.completionTokens, 3);
});

void test("progressive Pi passes streaming transport into the web-search tool", async () => {
  const { PiExecutionEngine } = load("src/agent/pi/pi-execution-engine.js");
  let piTurns = 0;
  let streamedSearches = 0;
  const engine = new PiExecutionEngine({
    async bufferedRequest(providerRequest) {
      if (providerRequest.responseFormat === "anthropic") {
        throw new Error("native web search should use streaming transport");
      }
      piTurns += 1;
      return piTurns === 1
        ? toolCallResponse("search_web", {
            query: "TreeTalk current release",
            reason: "需要实时版本信息"
          })
        : finalResponse("完成");
    },
    async *streamRequest(_profile, providerRequest) {
      assert.equal(providerRequest.responseFormat, "anthropic");
      streamedSearches += 1;
      yield { type: "delta", text: "当前发布信息" };
      yield {
        type: "sources",
        sources: [{ title: "Release", url: "https://example.test/current" }]
      };
      yield { type: "finish", reason: "stop" };
      yield { type: "done" };
    }
  });

  const events = await collect(
    engine.execute(request(true), new AbortController().signal)
  );

  assert.equal(streamedSearches, 1);
  assert.equal(events.some((event) => event.type === "finish"), true);
});

function contextualWebRequest() {
  const base = request(true);
  return {
    ...base,
    currentQuestion: "结合父节点和最新发布信息回答",
    piContext: {
      currentQuestion: "结合父节点和最新发布信息回答",
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
            id: "parent-answer",
            role: "assistant",
            content: `父节点背景。${"上下文内容。".repeat(600)}末尾标记`,
            status: "complete",
            selectionQuotes: []
          }]
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
      ],
      focus: {
        interactionMode: "continue",
        defaultScope: "latest_round",
        anchors: [{
          id: "F1",
          kind: "conversation-round",
          sourceNodeId: "parent",
          sourceMessageId: "parent-answer",
          reason: "previous-turn"
        }],
        targets: [{
          kind: "conversation-round",
          anchorId: "F1",
          sourceNodeId: "parent",
          sourceMessageId: "parent-answer",
          reason: "previous-turn"
        }]
      }
    }
  };
}

void test("local context and web search may alternate while every Pi request extends the same prefix", async () => {
  const { PiExecutionEngine } = load("src/agent/pi/pi-execution-engine.js");
  const requests = [];
  let piTurn = 0;
  const engine = new PiExecutionEngine({
    async bufferedRequest(providerRequest) {
      requests.push(structuredClone(providerRequest));
      if (providerRequest.responseFormat === "anthropic") {
        return nativeSearchResponse("联网补充证据");
      }
      piTurn += 1;
      if (piTurn === 1) {
        return toolCallResponse("request_context", {
          target: "current_source",
          reason: "需要完整父节点内容"
        }, "context-1");
      }
      if (piTurn === 2) {
        return toolCallResponse("search_web", {
          query: "TreeTalk latest release",
          reason: "需要最新发布信息"
        }, "web-1");
      }
      return finalResponse("综合回答");
    }
  });

  const events = await collect(
    engine.execute(contextualWebRequest(), new AbortController().signal)
  );
  const piRequests = requests.filter((entry) => entry.responseFormat === "openai");

  assert.equal(piRequests.length, 3);
  for (let index = 1; index < piRequests.length; index += 1) {
    assert.deepEqual(piRequests[index].body.tools, piRequests[0].body.tools);
    assert.deepEqual(
      piRequests[index].body.messages.slice(
        0,
        piRequests[index - 1].body.messages.length
      ),
      piRequests[index - 1].body.messages
    );
  }
  const finalMessages = piRequests.at(-1).body.messages;
  assert.equal(finalMessages.some(
    (message) => message.role === "tool" && message.tool_call_id === "context-1"
  ), true);
  assert.equal(finalMessages.some(
    (message) => message.role === "tool" && message.tool_call_id === "web-1"
  ), true);
  assert.equal(events.some((event) => event.type === "finish"), true);
});

void test("duplicate normalized web queries are rejected without another network search", async () => {
  const { PiExecutionEngine } = load("src/agent/pi/pi-execution-engine.js");
  const requests = [];
  let piTurn = 0;
  let nativeSearches = 0;
  const engine = new PiExecutionEngine({
    async bufferedRequest(providerRequest) {
      requests.push(structuredClone(providerRequest));
      if (providerRequest.responseFormat === "anthropic") {
        nativeSearches += 1;
        return nativeSearchResponse();
      }
      piTurn += 1;
      if (piTurn === 1) {
        return toolCallResponse("search_web", {
          query: "TreeTalk Latest Release",
          reason: "第一次搜索"
        }, "web-first");
      }
      if (piTurn === 2) {
        return toolCallResponse("search_web", {
          query: "  treetalk   latest   release  ",
          reason: "重复搜索"
        }, "web-duplicate");
      }
      return finalResponse("使用第一次搜索结果回答");
    }
  });

  const events = await collect(
    engine.execute(request(true), new AbortController().signal)
  );
  const piRequests = requests.filter((entry) => entry.responseFormat === "openai");
  const duplicateResult = piRequests.at(-1).body.messages.find(
    (message) => message.role === "tool" && message.tool_call_id === "web-duplicate"
  );

  assert.equal(nativeSearches, 1);
  assert.match(duplicateResult.content, /已经执行过/u);
  assert.equal(events.filter(
    (event) => event.type === "tool-end" && event.toolCallId === "web-duplicate" && event.isError
  ).length, 1);
  assert.equal(events.some((event) => event.type === "finish"), true);
});

void test("progressive web search stops after three searches and forces a final answer", async () => {
  const { PiExecutionEngine } = load("src/agent/pi/pi-execution-engine.js");
  const requests = [];
  let piTurn = 0;
  let nativeSearches = 0;
  const engine = new PiExecutionEngine({
    async bufferedRequest(providerRequest) {
      requests.push(structuredClone(providerRequest));
      if (providerRequest.responseFormat === "anthropic") {
        nativeSearches += 1;
        return nativeSearchResponse(`第 ${String(nativeSearches)} 批证据`);
      }
      piTurn += 1;
      if (piTurn <= 4) {
        return toolCallResponse("search_web", {
          query: `TreeTalk query ${String(piTurn)}`,
          reason: `第 ${String(piTurn)} 次补充`
        }, `web-${String(piTurn)}`);
      }
      return finalResponse("预算结束后的最终回答");
    }
  });

  const events = await collect(
    engine.execute(request(true), new AbortController().signal)
  );
  const piRequests = requests.filter((entry) => entry.responseFormat === "openai");
  const fourthResult = piRequests.at(-1).body.messages.find(
    (message) => message.role === "tool" && message.tool_call_id === "web-4"
  );

  assert.equal(nativeSearches, 3);
  assert.match(fourthResult.content, /扩展已结束|直接给出最终回答/u);
  assert.equal(events.some(
    (event) => event.type === "text-delta" && event.text === "预算结束后的最终回答"
  ), true);
  assert.equal(events.some((event) => event.type === "finish"), true);
});

void test("a failed web search returns a tool error and Pi can still answer", async () => {
  const { PiExecutionEngine } = load("src/agent/pi/pi-execution-engine.js");
  const requests = [];
  let piTurn = 0;
  const engine = new PiExecutionEngine({
    async bufferedRequest(providerRequest) {
      requests.push(structuredClone(providerRequest));
      if (providerRequest.responseFormat === "anthropic") {
        return {
          status: 503,
          json: { error: { message: "search temporarily unavailable" } }
        };
      }
      piTurn += 1;
      return piTurn === 1
        ? toolCallResponse("search_web", {
            query: "TreeTalk status",
            reason: "需要当前状态"
          }, "web-failed")
        : finalResponse("联网失败，基于已有上下文回答");
    }
  });

  const events = await collect(
    engine.execute(request(true), new AbortController().signal)
  );
  const piRequests = requests.filter((entry) => entry.responseFormat === "openai");
  const failedResult = piRequests.at(-1).body.messages.find(
    (message) => message.role === "tool" && message.tool_call_id === "web-failed"
  );

  assert.match(failedResult.content, /search temporarily unavailable/u);
  assert.equal(events.some(
    (event) => event.type === "tool-end" && event.toolCallId === "web-failed" && event.isError
  ), true);
  assert.equal(events.some(
    (event) => event.type === "text-delta" && event.text === "联网失败，基于已有上下文回答"
  ), true);
  assert.equal(events.some((event) => event.type === "finish"), true);
});

void test("native web search falls back only when streaming fails before evidence", async () => {
  const { executeNativeWebSearch } = load(
    "src/agent/pi/progressive/native-web-search.js"
  );
  let streamCalls = 0;
  let bufferedCalls = 0;
  const result = await executeNativeWebSearch({
    profile: profile(),
    modelId: "m",
    query: "TreeTalk fallback",
    reason: "verify fallback",
    signal: new AbortController().signal,
    async *streamRequest() {
      streamCalls += 1;
      throw new Error("stream unavailable");
    },
    canUseBufferedFallback(error) {
      return error instanceof Error && error.message === "stream unavailable";
    },
    async bufferedRequest(providerRequest) {
      bufferedCalls += 1;
      assert.equal(providerRequest.body.stream, false);
      return nativeSearchResponse("缓冲回退证据");
    }
  });

  assert.equal(streamCalls, 1);
  assert.equal(bufferedCalls, 1);
  assert.deepEqual(result.results, [{
    title: "TreeTalk Release",
    url: "https://example.test/treetalk"
  }]);
});

void test("native web search never replays a stream after evidence was released", async () => {
  const { executeNativeWebSearch } = load(
    "src/agent/pi/progressive/native-web-search.js"
  );
  let bufferedCalls = 0;
  await assert.rejects(
    executeNativeWebSearch({
      profile: profile(),
      modelId: "m",
      query: "TreeTalk no replay",
      reason: "avoid duplicate search",
      signal: new AbortController().signal,
      async *streamRequest() {
        yield { type: "delta", text: "已经释放证据" };
        throw new Error("stream failed after evidence");
      },
      canUseBufferedFallback() {
        return true;
      },
      async bufferedRequest() {
        bufferedCalls += 1;
        return nativeSearchResponse();
      }
    }),
    /stream failed after evidence/u
  );
  assert.equal(bufferedCalls, 0);
});

void test("search indexes do not consume opened-page evidence budget", async () => {
  const { PiExecutionEngine } = load("src/agent/pi/pi-execution-engine.js");
  let piTurn = 0;
  let nativeSearches = 0;
  const engine = new PiExecutionEngine({
    async bufferedRequest(providerRequest) {
      if (providerRequest.responseFormat === "anthropic") {
        nativeSearches += 1;
        return nativeSearchResponse("ignored search summary text");
      }
      piTurn += 1;
      if (piTurn <= 2) {
        return toolCallResponse("search_web", {
          query: `TreeTalk budget query ${String(piTurn)}`,
          reason: `第 ${String(piTurn)} 次搜索`
        }, `web-budget-${String(piTurn)}`);
      }
      return finalResponse("索引不占网页正文预算后的最终回答");
    }
  });

  const events = await collect(
    engine.execute(request(true), new AbortController().signal)
  );

  assert.equal(nativeSearches, 2);
  assert.equal(events.some(
    (event) => event.type === "tool-end" &&
      event.toolCallId === "web-budget-2" &&
      event.isError
  ), false);
  assert.equal(events.some(
    (event) => event.type === "text-delta" &&
      event.text === "索引不占网页正文预算后的最终回答"
  ), true);
});
