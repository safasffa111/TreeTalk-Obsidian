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

function request() {
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
    webSearchEnabled: true
  };
}

function toolCallResponse(name, args, id) {
  return {
    status: 200,
    json: {
      choices: [{
        message: {
          content: null,
          reasoning_content: "需要补充证据",
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

function finalResponse(text) {
  return {
    status: 200,
    json: {
      choices: [{ message: { content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 20, completion_tokens: 6, prompt_cache_hit_tokens: 12 }
    }
  };
}

function pausedSearchIndexResponse(results = [
  { title: "TreeTalk Release", url: "https://example.test/release" },
  { title: "TreeTalk Docs", url: "https://example.test/docs" }
]) {
  const content = [
    {
      type: "server_tool_use",
      id: "srv-1",
      name: "web_search",
      input: { query: "TreeTalk latest" }
    },
    {
      type: "web_search_tool_result",
      tool_use_id: "srv-1",
      content: results.map((result) => ({
        type: "web_search_result",
        ...result
      }))
    }
  ];
  return {
    status: 200,
    json: {
      content,
      stop_reason: "pause_turn",
      usage: { input_tokens: 18, output_tokens: 4 }
    }
  };
}

async function collect(iterable) {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}

void test("native web search stops at the first search index without replaying pause_turn", async () => {
  const { executeNativeWebSearch } = load(
    "src/agent/pi/progressive/native-web-search.js"
  );
  const requests = [];
  const result = await executeNativeWebSearch({
    profile: profile(),
    modelId: "m",
    query: "TreeTalk latest",
    reason: "need current release",
    signal: new AbortController().signal,
    async bufferedRequest(providerRequest) {
      requests.push(structuredClone(providerRequest));
      return pausedSearchIndexResponse();
    }
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.tools[0].max_uses, 1);
  assert.deepEqual(result.results, [
    { title: "TreeTalk Release", url: "https://example.test/release" },
    { title: "TreeTalk Docs", url: "https://example.test/docs" }
  ]);
  assert.equal("content" in result, false);
  assert.equal(result.usage.promptTokens, 18);
});

void test("web-enabled Pi fixes all three tool definitions before the first request", async () => {
  const { PiExecutionEngine } = load("src/agent/pi/pi-execution-engine.js");
  const requests = [];
  const engine = new PiExecutionEngine({
    async bufferedRequest(providerRequest) {
      requests.push(structuredClone(providerRequest));
      return finalResponse("完成");
    },
    async webPageRequest() {
      throw new Error("unused");
    }
  });

  await collect(engine.execute(request(), new AbortController().signal));
  assert.deepEqual(
    requests[0].body.tools.map((tool) => tool.function.name),
    ["request_context", "search_web", "open_web_result"]
  );
});

void test("Pi searches an index, opens one chosen page, and only cites the opened page", async () => {
  const { PiExecutionEngine } = load("src/agent/pi/pi-execution-engine.js");
  const requests = [];
  const fetchedUrls = [];
  let piTurn = 0;
  let searchCalls = 0;
  const engine = new PiExecutionEngine({
    async bufferedRequest(providerRequest) {
      requests.push(structuredClone(providerRequest));
      if (providerRequest.responseFormat === "anthropic") {
        searchCalls += 1;
        return pausedSearchIndexResponse();
      }
      piTurn += 1;
      if (piTurn === 1) {
        return toolCallResponse("search_web", {
          query: "TreeTalk latest",
          reason: "需要最新发布信息"
        }, "search-1");
      }
      if (piTurn === 2) {
        const searchMessage = [...providerRequest.body.messages].reverse().find(
          (message) => message.role === "tool" && message.tool_call_id === "search-1"
        );
        const searchResult = JSON.parse(searchMessage.content);
        return toolCallResponse("open_web_result", {
          resultId: searchResult.results[0].id,
          reason: "读取官方发布说明"
        }, "open-1");
      }
      return finalResponse("根据已打开网页完成回答");
    },
    async webPageRequest(url) {
      fetchedUrls.push(url);
      return {
        status: 200,
        contentType: "text/html; charset=utf-8",
        text: "<!doctype html><html><head><title>Noise</title><script>ignore()</script></head><body><nav>菜单</nav><main><h1>TreeTalk Release</h1><p>版本 alpha.23 引入渐进式网页读取。</p></main><footer>页脚</footer></body></html>"
      };
    }
  });

  const events = await collect(
    engine.execute(request(), new AbortController().signal)
  );
  const piRequests = requests.filter((entry) => entry.responseFormat === "openai");
  const searchRequests = requests.filter((entry) => entry.responseFormat === "anthropic");

  assert.equal(searchCalls, 1);
  assert.equal(searchRequests.length, 1);
  assert.deepEqual(fetchedUrls, ["https://example.test/release"]);
  assert.equal(piRequests.length, 3);
  for (let index = 1; index < piRequests.length; index += 1) {
    assert.deepEqual(piRequests[index].body.tools, piRequests[0].body.tools);
    assert.deepEqual(
      piRequests[index].body.messages.slice(0, piRequests[index - 1].body.messages.length),
      piRequests[index - 1].body.messages
    );
  }
  const searchToolResult = JSON.parse(
    piRequests[1].body.messages.find((message) => message.tool_call_id === "search-1").content
  );
  assert.equal(searchToolResult.scope, "search-index");
  assert.equal(searchToolResult.results.length, 2);
  assert.equal(searchToolResult.results[0].url, undefined);
  const openedToolResult = JSON.parse(
    piRequests[2].body.messages.find((message) => message.tool_call_id === "open-1").content
  );
  assert.equal(openedToolResult.scope, "web-page");
  assert.match(openedToolResult.content, /alpha\.23 引入渐进式网页读取/u);
  assert.doesNotMatch(openedToolResult.content, /菜单|页脚|ignore/u);
  assert.deepEqual(
    events.filter((event) => event.type === "sources").flatMap((event) => event.sources),
    [{ title: "TreeTalk Release", url: "https://example.test/release" }]
  );
});

void test("web page reader rejects local targets and extracts readable text within budget", async () => {
  const {
    assertSafeWebUrl,
    extractReadableWebText
  } = load("src/agent/pi/progressive/web-page-reader.js");

  assert.throws(() => assertSafeWebUrl("http://127.0.0.1/private"), /不安全/u);
  assert.throws(() => assertSafeWebUrl("https://localhost/private"), /不安全/u);
  assert.equal(assertSafeWebUrl("https://example.com/article").href, "https://example.com/article");

  const extracted = extractReadableWebText({
    text: "<html><body><header>顶部</header><article><h1>标题</h1><p>正文 &amp; 证据。</p></article><footer>底部</footer></body></html>",
    contentType: "text/html",
    maximumTokens: 100
  });
  assert.match(extracted.content, /标题/u);
  assert.match(extracted.content, /正文 & 证据/u);
  assert.doesNotMatch(extracted.content, /顶部|底部/u);
  assert.ok(extracted.estimatedTokens <= 100);
});

void test("opening the same result twice does not fetch the page again", async () => {
  const { PiExecutionEngine } = load("src/agent/pi/pi-execution-engine.js");
  let piTurn = 0;
  let pageFetches = 0;
  const engine = new PiExecutionEngine({
    async bufferedRequest(providerRequest) {
      if (providerRequest.responseFormat === "anthropic") {
        return pausedSearchIndexResponse();
      }
      piTurn += 1;
      if (piTurn === 1) {
        return toolCallResponse("search_web", {
          query: "TreeTalk latest",
          reason: "需要来源"
        }, "search-duplicate");
      }
      if (piTurn === 2) {
        return toolCallResponse("open_web_result", {
          resultId: "web-1",
          reason: "第一次读取"
        }, "open-first");
      }
      if (piTurn === 3) {
        return toolCallResponse("open_web_result", {
          resultId: "web-1",
          reason: "重复读取"
        }, "open-duplicate");
      }
      return finalResponse("完成");
    },
    async webPageRequest() {
      pageFetches += 1;
      return {
        status: 200,
        contentType: "text/plain",
        text: "第一次读取的网页正文"
      };
    }
  });

  const events = await collect(
    engine.execute(request(), new AbortController().signal)
  );

  assert.equal(pageFetches, 1);
  assert.equal(events.some(
    (event) => event.type === "tool-end" &&
      event.toolCallId === "open-duplicate" &&
      event.isError
  ), true);
});

void test("only two web pages may be opened in one answer", async () => {
  const { PiExecutionEngine } = load("src/agent/pi/pi-execution-engine.js");
  let piTurn = 0;
  const fetchedUrls = [];
  const engine = new PiExecutionEngine({
    async bufferedRequest(providerRequest) {
      if (providerRequest.responseFormat === "anthropic") {
        return pausedSearchIndexResponse([
          { title: "One", url: "https://example.test/one" },
          { title: "Two", url: "https://example.test/two" },
          { title: "Three", url: "https://example.test/three" }
        ]);
      }
      piTurn += 1;
      if (piTurn === 1) {
        return toolCallResponse("search_web", {
          query: "TreeTalk sources",
          reason: "需要多个来源"
        }, "search-three");
      }
      if (piTurn >= 2 && piTurn <= 4) {
        return toolCallResponse("open_web_result", {
          resultId: `web-${String(piTurn - 1)}`,
          reason: `读取第 ${String(piTurn - 1)} 个来源`
        }, `open-${String(piTurn - 1)}`);
      }
      return finalResponse("两个网页已经足够");
    },
    async webPageRequest(url) {
      fetchedUrls.push(url);
      return {
        status: 200,
        contentType: "text/plain",
        text: `网页正文 ${url}`
      };
    }
  });

  const events = await collect(
    engine.execute(request(), new AbortController().signal)
  );

  assert.deepEqual(fetchedUrls, [
    "https://example.test/one",
    "https://example.test/two"
  ]);
  assert.equal(events.some(
    (event) => event.type === "tool-end" &&
      event.toolCallId === "open-3" &&
      event.isError
  ), true);
  assert.equal(events.some(
    (event) => event.type === "text-delta" &&
      event.text === "两个网页已经足够"
  ), true);
});
