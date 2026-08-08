import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const root = process.cwd();
const entries = [path.join(root, "src"), path.join(root, "tests/fixtures.ts")];

function walk(entry) {
  const stat = fs.statSync(entry);
  if (stat.isFile()) return [entry];
  return fs.readdirSync(entry, { withFileTypes: true }).flatMap((item) =>
    walk(path.join(entry, item.name))
  );
}

const modules = new Map();
for (const file of entries.flatMap(walk).filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"))) {
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
  const output = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") output.pop(); else output.push(part);
  }
  return output.join("/");
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
  const localRequire = (request) => {
    if (request.startsWith(".")) return load(resolve(id, request));
    if (request === "obsidian") return {};
    return require(request);
  };
  new Function("module", "exports", "require", code)(module, module.exports, localRequire);
  return module.exports;
}

void test("balanced context is deterministic, branch-only, and trims old Markdown safely", () => {
  const { compileContextPlan } = load("src/domain/context-engine.js");
  const { validConversation } = load("tests/fixtures.js");
  const conversation = structuredClone(validConversation());
  const now = conversation.createdAt;
  conversation.nodes.root.messages = [
    { id: "u1", role: "user", content: "根问题", status: "complete", createdAt: now, updatedAt: now },
    {
      id: "a1",
      role: "assistant",
      content: [
        "# 定义",
        "",
        "核心结论：必须保持分支隔离。",
        "",
        "普通铺垫。".repeat(700),
        "",
        "```ts",
        "import x from 'x';",
        ...Array.from({ length: 180 }, (_, index) => `function f${index}() { return ${index}; }`),
        "```",
        "",
        "## 总结",
        "最终结论不能丢。"
      ].join("\n"),
      status: "complete",
      createdAt: now,
      updatedAt: now
    }
  ];
  conversation.nodes.child.messages = [
    { id: "u2", role: "user", content: "后续问题一", status: "complete", createdAt: now, updatedAt: now },
    { id: "a2", role: "assistant", content: "回答一", status: "complete", createdAt: now, updatedAt: now },
    { id: "u3", role: "user", content: "后续问题二", status: "complete", createdAt: now, updatedAt: now },
    { id: "a3", role: "assistant", content: "回答二", status: "complete", createdAt: now, updatedAt: now },
    { id: "u4", role: "user", content: "后续问题三", status: "complete", createdAt: now, updatedAt: now },
    { id: "a4", role: "assistant", content: "回答三", status: "complete", createdAt: now, updatedAt: now },
    { id: "u5", role: "user", content: "当前问题", status: "complete", createdAt: now, updatedAt: now }
  ];
  conversation.nodes.right = {
    ...structuredClone(conversation.nodes.child),
    id: "right",
    parentId: "root",
    title: "兄弟",
    messages: [{ id: "sibling", role: "user", content: "兄弟分支秘密", status: "complete", createdAt: now, updatedAt: now }]
  };
  conversation.nodes.root.childIds = ["child", "right"];
  conversation.currentNodeId = "child";

  const options = {
    mode: "balanced",
    systemPrompt: "固定规则",
    maxInputTokens: 1200,
    recentRoundTarget: 4,
    minRecentRounds: 2,
    maxRecentRounds: 6
  };
  const first = compileContextPlan(conversation, "child", options);
  const second = compileContextPlan(conversation, "child", options);
  const joined = first.messages.map((entry) => entry.content).join("\n");

  assert.deepEqual(first, second);
  assert.doesNotMatch(joined, /兄弟分支秘密/u);
  assert.match(joined, /当前问题/u);
  assert.match(joined, /最终结论不能丢/u);
  assert.match(joined, /TreeTalk 已压缩历史内容/u);
  assert.equal((joined.match(/```/gu) ?? []).length % 2, 0);
  assert.ok(first.sentEstimatedTokens < first.fullEstimatedTokens);
  assert.equal(first.mode, "balanced");
});

void test("full mode preserves the active branch exactly and still excludes siblings", () => {
  const { compileContextPlan } = load("src/domain/context-engine.js");
  const { validConversation } = load("tests/fixtures.js");
  const conversation = structuredClone(validConversation());
  const now = conversation.createdAt;
  conversation.nodes.root.messages = [
    { id: "u1", role: "user", content: "root", status: "complete", createdAt: now, updatedAt: now },
    { id: "a1", role: "assistant", content: "A".repeat(5000), status: "complete", createdAt: now, updatedAt: now }
  ];
  conversation.nodes.child.messages = [
    { id: "u2", role: "user", content: "current", status: "complete", createdAt: now, updatedAt: now }
  ];
  const plan = compileContextPlan(conversation, "child", {
    mode: "full",
    systemPrompt: "system",
    maxInputTokens: 100
  });
  assert.deepEqual(plan.messages.map((entry) => entry.content), ["system", "root", "A".repeat(5000), "current"]);
  assert.equal(plan.reducedTokens, 0);
});

void test("OpenAI and DeepSeek request cache usage without exposing fake cache controls", () => {
  const { OpenAiProvider } = load("src/providers/openai-provider.js");
  const { DeepSeekProvider } = load("src/providers/deepseek-provider.js");
  const input = {
    messages: [{ role: "user", content: "hello" }],
    model: "model",
    stream: true,
    cacheKey: "treetalk-session"
  };
  const openai = new OpenAiProvider().buildRequest(input, {
    id: "openai", name: "OpenAI", kind: "openai", apiKey: "secret", baseUrl: ""
  });
  assert.equal(openai.body.prompt_cache_key, "treetalk-session");
  assert.deepEqual(openai.body.stream_options, { include_usage: true });

  const deepseek = new DeepSeekProvider().buildRequest({ ...input, model: "deepseek-v4-flash" }, {
    id: "deepseek", name: "DeepSeek", kind: "deepseek", apiKey: "secret", baseUrl: ""
  });
  assert.equal(deepseek.url, "https://api.deepseek.com/anthropic/v1/messages");
  assert.equal(deepseek.responseFormat, "anthropic");
  assert.equal("tools" in deepseek.body, false);
  assert.equal("prompt_cache_key" in deepseek.body, false);
});

void test("DeepSeek keeps the working Anthropic transport after web search is disabled", () => {
  const { DeepSeekProvider } = load("src/providers/deepseek-provider.js");
  const provider = new DeepSeekProvider();
  const profile = {
    id: "deepseek",
    name: "DeepSeek",
    kind: "deepseek",
    apiKey: "secret",
    baseUrl: "https://api.deepseek.com/anthropic"
  };
  const input = {
    messages: [{ role: "user", content: "hello" }],
    model: "deepseek-v4-flash",
    stream: true
  };

  const online = provider.buildRequest(
    { ...input, webSearchEnabled: true },
    profile
  );
  const offline = provider.buildRequest(
    { ...input, webSearchEnabled: false },
    profile
  );

  assert.equal(online.url, "https://api.deepseek.com/anthropic/v1/messages");
  assert.equal(offline.url, "https://api.deepseek.com/anthropic/v1/messages");
  assert.equal(offline.responseFormat, "anthropic");
  assert.equal("tools" in offline.body, false);
  assert.equal("tool_choice" in offline.body, false);
});

void test("DeepSeek canonicalizes official base URL variants before choosing a transport", () => {
  const { DeepSeekProvider } = load("src/providers/deepseek-provider.js");
  const provider = new DeepSeekProvider();
  const input = {
    messages: [{ role: "user", content: "hello" }],
    model: "deepseek-v4-flash",
    stream: true,
    webSearchEnabled: false
  };
  for (const baseUrl of [
    "https://api.deepseek.com",
    "https://api.deepseek.com/v1",
    "https://api.deepseek.com/chat/completions",
    "https://api.deepseek.com/anthropic/v1/messages"
  ]) {
    const request = provider.buildRequest(input, {
      id: "deepseek",
      name: "DeepSeek",
      kind: "deepseek",
      apiKey: "secret",
      baseUrl
    });
    assert.equal(request.url, "https://api.deepseek.com/anthropic/v1/messages");
  }
});

void test("DeepSeek preserves custom OpenAI-compatible endpoints when web search is disabled", () => {
  const { DeepSeekProvider } = load("src/providers/deepseek-provider.js");
  const request = new DeepSeekProvider().buildRequest({
    messages: [{ role: "user", content: "hello" }],
    model: "deepseek-v4-flash",
    stream: true,
    webSearchEnabled: false
  }, {
    id: "deepseek",
    name: "DeepSeek",
    kind: "deepseek",
    apiKey: "secret",
    baseUrl: "https://proxy.example.test/v1"
  });

  assert.equal(request.url, "https://proxy.example.test/v1/chat/completions");
  assert.equal(request.responseFormat, "openai");
});

void test("DeepSeek web search uses the Anthropic-compatible endpoint and server tool", () => {
  const { DeepSeekProvider } = load("src/providers/deepseek-provider.js");
  const request = new DeepSeekProvider().buildRequest({
    messages: [
      { role: "system", content: "system rules" },
      { role: "user", content: "今天有什么新消息" }
    ],
    model: "deepseek-v4-flash",
    stream: true,
    webSearchEnabled: true
  }, {
    id: "deepseek", name: "DeepSeek", kind: "deepseek", apiKey: "secret", baseUrl: ""
  });
  assert.equal(request.url, "https://api.deepseek.com/anthropic/v1/messages");
  assert.equal(request.headers["x-api-key"], "secret");
  assert.equal(request.headers.Authorization, undefined);
  assert.equal(request.body.system, "system rules");
  assert.deepEqual(request.body.tools, [{
    type: "web_search_20250305",
    name: "web_search",
    max_uses: 5
  }]);
  assert.deepEqual(request.body.messages, [{
    role: "user",
    content: [{ type: "text", text: "今天有什么新消息" }]
  }]);
});

void test("DeepSeek web-search stream emits status usage text and pause continuation content", () => {
  const { DeepSeekProvider } = load("src/providers/deepseek-provider.js");
  const provider = new DeepSeekProvider();
  const request = provider.buildRequest({
    messages: [{ role: "user", content: "search" }],
    model: "deepseek-v4-flash",
    stream: true,
    webSearchEnabled: true
  }, { id: "deepseek", name: "DeepSeek", kind: "deepseek", apiKey: "secret", baseUrl: "" });
  const parser = provider.createStreamParser(request);
  const events = [
    ...parser.push('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":120,"cache_read_input_tokens":80}}}\n\n'),
    ...parser.push('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"server_tool_use","id":"srv_1","name":"web_search","input":{"query":"TreeTalk"}}}\n\n'),
    ...parser.push('event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"web_search_tool_result","tool_use_id":"srv_1","content":[{"type":"web_search_result","url":"https://example.com","title":"Example"}]}}\n\n'),
    ...parser.push('event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"text","text":""}}\n\n'),
    ...parser.push('event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"联网回答"}}\n\n'),
    ...parser.push('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"pause_turn"},"usage":{"output_tokens":30}}\n\n'),
    ...parser.push('event: message_stop\ndata: {"type":"message_stop"}\n\n')
  ];
  assert.ok(events.some((event) => event.type === "search-status" && event.status === "searching"));
  assert.ok(events.some((event) => event.type === "search-status" && event.status === "complete"));
  assert.ok(events.some((event) => event.type === "delta" && event.text === "联网回答"));
  assert.ok(events.some((event) => event.type === "usage" && event.usage.promptTokens === 200 && event.usage.cacheHitTokens === 80));
  assert.ok(events.some((event) => event.type === "usage" && event.usage.completionTokens === 30));
  const pause = events.find((event) => event.type === "pause");
  assert.ok(pause);
  assert.equal(Array.isArray(pause.content), true);
  assert.equal(pause.content.length, 3);
});

void test("OpenAI-compatible streaming decoder emits normalized OpenAI and DeepSeek usage before DONE", () => {
  const { decodeOpenAiEvent } = load("src/providers/stream-parser.js");
  assert.deepEqual(
    decodeOpenAiEvent({ event: "", data: JSON.stringify({ choices: [], usage: {
      prompt_tokens: 2000,
      completion_tokens: 300,
      prompt_tokens_details: { cached_tokens: 1400 }
    } }) }),
    [{ type: "usage", usage: { promptTokens: 2000, completionTokens: 300, cacheHitTokens: 1400, cacheMissTokens: 600, providerReported: true } }]
  );
  assert.deepEqual(
    decodeOpenAiEvent({ event: "", data: JSON.stringify({ choices: [], usage: {
      prompt_tokens: 1800,
      completion_tokens: 200,
      prompt_cache_hit_tokens: 1500,
      prompt_cache_miss_tokens: 300
    } }) }),
    [{ type: "usage", usage: { promptTokens: 1800, completionTokens: 200, cacheHitTokens: 1500, cacheMissTokens: 300, providerReported: true } }]
  );
  assert.deepEqual(
    decodeOpenAiEvent({ event: "", data: JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }) }),
    [{ type: "finish" }]
  );
  assert.deepEqual(decodeOpenAiEvent({ event: "", data: "[DONE]" }), [{ type: "done" }]);
});

void test("transient token stats use the agreed display thresholds", () => {
  const { shouldDisplayTokenStats, TransientUsageStore } = load("src/providers/transient-usage-store.js");
  assert.equal(shouldDisplayTokenStats({ reducedTokens: 255, reductionRatio: 0.049, cacheHitTokens: 0 }), false);
  assert.equal(shouldDisplayTokenStats({ reducedTokens: 256, reductionRatio: 0.01, cacheHitTokens: 0 }), true);
  assert.equal(shouldDisplayTokenStats({ mode: "balanced", reducedTokens: 0, reductionRatio: 0, cacheHitTokens: 1 }), true);
  assert.equal(shouldDisplayTokenStats({ mode: "full", reducedTokens: 0, reductionRatio: 0, sentEstimatedTokens: 80 }), true);
  const store = new TransientUsageStore();
  store.set("message", {
    mode: "balanced",
    fullEstimatedTokens: 1000,
    sentEstimatedTokens: 700,
    reducedTokens: 300,
    reductionRatio: 0.3,
    promptTokens: 680,
    completionTokens: 90,
    cacheHitTokens: 300,
    cacheMissTokens: 380
  });
  assert.equal(store.get("message").reducedTokens, 300);
  store.clear();
  assert.equal(store.get("message"), undefined);
});

void test("plugin settings normalize to fixed full context and DeepSeek", () => {
  const { parsePluginData } = load("src/tabs/plugin-data.js");
  const migrated = parsePluginData({ provider: "openai", model: "gpt-test" });
  assert.equal(migrated.settings.contextOptimizationEnabled, false);
  assert.equal(migrated.settings.contextMode, "full");
  assert.equal(migrated.settings.webSearchEnabled, false);
  const deepseek = parsePluginData({
    settings: {
      ...migrated.settings,
      provider: "deepseek",
      model: "deepseek-v4-flash",
      contextOptimizationEnabled: true,
      contextMode: "full"
    }
  });
  assert.equal(deepseek.settings.provider, "deepseek");
  assert.equal(deepseek.settings.contextMode, "full");
  assert.equal(deepseek.settings.contextOptimizationEnabled, false);
  const legacy = parsePluginData({ settings: { ...migrated.settings, provider: "deepseek", model: "deepseek-chat", webSearchEnabled: true } });
  assert.equal(legacy.settings.model, "deepseek-v4-flash");
  assert.equal(legacy.settings.webSearchEnabled, true);
});

void test("full and balanced modes use versioned OpenAI cache routing keys", () => {
  const { cacheKeyForContextPlan } = load("src/domain/context-engine.js");
  assert.equal(
    cacheKeyForContextPlan("conversation-1", { mode: "balanced" }),
    "treetalk:conversation-1:balanced:v3"
  );
  assert.equal(
    cacheKeyForContextPlan("conversation-1", { mode: "full" }),
    "treetalk:conversation-1:full:v1"
  );
});

void test("V4 selection resolver trusts an exact stored source offset before ambiguity fallback", () => {
  const { resolveSelectionInMarkdown } = load("src/domain/balanced-markdown-compressor.js");
  const markdown = "关键结论 xx 关键结论";
  const secondStart = markdown.lastIndexOf("关键结论");
  assert.deepEqual(resolveSelectionInMarkdown(markdown, {
    messageId: "a1", sourceNodeId: "root", sourceRole: "assistant", basis: "rendered-text-v1",
    startOffset: secondStart, endOffset: secondStart + "关键结论".length, quote: "关键结论",
    prefix: "", suffix: "", contentHash: "hash"
  }), { status: "resolved", start: secondStart, end: secondStart + "关键结论".length });
});

void test("V4 parser preserves Markdown source offsets and deterministic protected blocks", () => {
  const {
    compressAssistantMarkdown,
    parseStructuredMarkdown
  } = load("src/domain/balanced-markdown-compressor.js");
  const markdown = [
    "# 总主题",
    "",
    "开头结论。",
    "",
    "## 原理",
    "",
    "普通铺垫。".repeat(200),
    "",
    "被框选的关键结论必须完整保留。",
    "",
    "普通扩展。".repeat(200),
    "",
    "## 总结",
    "",
    "最终结论。"
  ].join("\n");
  const parsed = parseStructuredMarkdown(markdown);
  assert.equal(parsed.ok, true);
  for (const block of parsed.blocks) {
    assert.equal(markdown.slice(block.startOffset, block.endOffset), block.content);
  }
  const start = markdown.indexOf("被框选的关键结论");
  const first = compressAssistantMarkdown(markdown, {
    protectedRanges: [{ start, end: start + "被框选的关键结论必须完整保留。".length }]
  });
  const second = compressAssistantMarkdown(markdown, {
    protectedRanges: [{ start, end: start + "被框选的关键结论必须完整保留。".length }]
  });
  assert.deepEqual(first, second);
  assert.equal(first.compressed, true);
  assert.match(first.content, /# 总主题/u);
  assert.match(first.content, /## 原理/u);
  assert.match(first.content, /被框选的关键结论必须完整保留/u);
  assert.match(first.content, /TreeTalk 已压缩历史内容/u);
});

void test("V4 compressor retains high-priority conclusion blocks under a tight target", () => {
  const { compressAssistantMarkdown } = load("src/domain/balanced-markdown-compressor.js");
  const markdown = [
    "# 主题", "", "开头说明。", "", "普通展开。".repeat(180), "",
    "关键结论：必须保留这个决定。", "", "另一段普通展开。".repeat(180), "", "结束说明。"
  ].join("\n");
  const result = compressAssistantMarkdown(markdown, { targetRatio: 0.35, maxTokens: 96 });
  assert.equal(result.compressed, true);
  assert.match(result.content, /关键结论：必须保留这个决定/u);
});

void test("balanced:v3 keeps only the latest completed round and all user turns byte-identical", () => {
  const { compileContextPlan } = load("src/domain/context-engine.js");
  const { validConversation } = load("tests/fixtures.js");
  const conversation = structuredClone(validConversation());
  const now = conversation.createdAt;
  const oldAnswer = ["# 回答一", ...Array.from({ length: 40 }, (_, index) => `段落 ${String(index)}：${"旧内容。".repeat(12)}`), "最终结论。"].join("\n\n");
  conversation.nodes.root.messages = [
    { id: "u1", role: "user", content: "问题一", status: "complete", createdAt: now, updatedAt: now },
    { id: "a1", role: "assistant", content: oldAnswer, status: "complete", createdAt: now, updatedAt: now }
  ];
  conversation.nodes.child.messages = [
    { id: "u2", role: "user", content: "问题二", status: "complete", createdAt: now, updatedAt: now },
    { id: "a2", role: "assistant", content: "回答二原文", status: "complete", createdAt: now, updatedAt: now },
    { id: "u3", role: "user", content: "当前问题", status: "complete", createdAt: now, updatedAt: now }
  ];
  const plan = compileContextPlan(conversation, "child", { mode: "balanced", systemPrompt: "system", maxInputTokens: 100000 });
  const contents = plan.messages.map((entry) => entry.content);
  assert.equal(contents[0], "system");
  assert.equal(contents[1], "问题一");
  assert.match(contents[2], /TreeTalk 已省略部分较早的回答内容/u);
  assert.equal(contents[3], "问题二");
  assert.equal(contents[4], "回答二原文");
  assert.equal(contents[5], "当前问题");
  assert.ok(plan.reducedTokens > 0);
});

void test("V4 compressor preserves protected table code math and rejects unsafe fences", () => {
  const { compressAssistantMarkdown, parseStructuredMarkdown } = load("src/domain/balanced-markdown-compressor.js");
  const markdown = [
    "# 资料", "", "铺垫。".repeat(200), "",
    "| A | B |", "| --- | --- |", "| 1 | 2 |", "",
    "```ts", "function important() {", "  return 42;", "}", "```", "",
    "$$", "E = mc^2", "$$", "", "结论。"
  ].join("\n");
  const ranges = ["| A | B |", "function important", "E = mc^2"].map((text) => {
    const start = markdown.indexOf(text);
    return { start, end: start + text.length };
  });
  const result = compressAssistantMarkdown(markdown, { protectedRanges: ranges });
  assert.match(result.content, /\| --- \| --- \|/u);
  assert.match(result.content, /function important\(\)/u);
  assert.equal((result.content.match(/```/gu) ?? []).length, 2);
  assert.equal((result.content.match(/\$\$/gu) ?? []).length, 2);
  const unsafe = "# 标题\n\n```ts\nconst broken = true;";
  assert.equal(parseStructuredMarkdown(unsafe).ok, false);
  assert.equal(compressAssistantMarkdown(unsafe).content, unsafe);
});

void test("balanced:v3 freezes every completed round older than the latest one", () => {
  const { compileContextPlan } = load("src/domain/context-engine.js");
  const { validConversation } = load("tests/fixtures.js");
  const conversation = structuredClone(validConversation());
  const now = conversation.createdAt;
  conversation.nodes.root.messages = [
    { id: "u1", role: "user", content: "问题一", status: "complete", createdAt: now, updatedAt: now },
    { id: "a1", role: "assistant", content: `# 旧回答\n\n核心结论。\n\n${"冗长解释。".repeat(500)}\n\n## 总结\n\n结论一。`, status: "complete", createdAt: now, updatedAt: now }
  ];
  conversation.nodes.child.messages = [
    { id: "u2", role: "user", content: "问题二", status: "complete", createdAt: now, updatedAt: now },
    { id: "a2", role: "assistant", content: "回答二原文", status: "complete", createdAt: now, updatedAt: now },
    { id: "u3", role: "user", content: "问题三", status: "complete", createdAt: now, updatedAt: now },
    { id: "a3", role: "assistant", content: "回答三原文", status: "complete", createdAt: now, updatedAt: now },
    { id: "u4", role: "user", content: "当前问题", status: "complete", createdAt: now, updatedAt: now }
  ];
  const plan = compileContextPlan(conversation, "child", {
    mode: "balanced",
    systemPrompt: "固定规则",
    maxInputTokens: 100000
  });
  const contents = plan.messages.map((entry) => entry.content);
  assert.match(contents[2], /TreeTalk 已省略部分较早的回答内容/u);
  assert.equal(contents.at(-4), "回答二原文");
  assert.equal(contents.at(-2), "回答三原文");
  assert.equal(contents.at(-1), "当前问题");
  assert.ok(plan.reducedTokens > 0);
});


void test("balanced:v3 selection protection keeps the selected Markdown block and heading chain", () => {
  const { compileContextPlan } = load("src/domain/context-engine.js");
  const { validConversation } = load("tests/fixtures.js");
  const conversation = structuredClone(validConversation());
  const now = conversation.createdAt;
  const oldAnswer = [
    "# 总主题",
    "",
    "开头结论。",
    "",
    "## 关键章节",
    "",
    "普通铺垫。".repeat(220),
    "",
    "精确框选内容必须保留。",
    "",
    "普通扩展。".repeat(220),
    "",
    "## 总结",
    "",
    "最终结论。"
  ].join("\n");
  conversation.nodes.root.messages = [
    { id: "u1", role: "user", content: "问题一", status: "complete", createdAt: now, updatedAt: now },
    { id: "a1", role: "assistant", content: oldAnswer, status: "complete", createdAt: now, updatedAt: now }
  ];
  conversation.nodes.child.messages = [
    { id: "u2", role: "user", content: "问题二", status: "complete", createdAt: now, updatedAt: now },
    { id: "a2", role: "assistant", content: "回答二", status: "complete", createdAt: now, updatedAt: now },
    {
      id: "u3", role: "user", content: "问题三", status: "complete", createdAt: now, updatedAt: now,
      selectionContexts: [{
        messageId: "a1", sourceNodeId: "root", sourceRole: "assistant", basis: "rendered-text-v1",
        startOffset: 0, endOffset: 12, quote: "精确框选内容必须保留。", prefix: "", suffix: "", contentHash: "hash"
      }]
    },
    { id: "a3", role: "assistant", content: "回答三", status: "complete", createdAt: now, updatedAt: now },
    { id: "u4", role: "user", content: "当前问题", status: "complete", createdAt: now, updatedAt: now }
  ];
  const plan = compileContextPlan(conversation, "child", {
    mode: "balanced", systemPrompt: "system", maxInputTokens: 100000
  });
  const oldSent = plan.messages[2].content;
  assert.match(oldSent, /# 总主题/u);
  assert.match(oldSent, /## 关键章节/u);
  assert.match(oldSent, /精确框选内容必须保留/u);
  assert.match(oldSent, /TreeTalk 已省略部分较早的回答内容/u);
});

void test("balanced:v3 ambiguous historical selection uses a recovery patch without expanding the frozen answer", () => {
  const { compileContextPlan } = load("src/domain/context-engine.js");
  const { validConversation } = load("tests/fixtures.js");
  const conversation = structuredClone(validConversation());
  const now = conversation.createdAt;
  const oldAnswer = `# 内容\n\n重复目标。\n\n${"无关说明。".repeat(240)}\n\n重复目标。\n\n最终结论。`;
  conversation.nodes.root.messages = [
    { id: "u1", role: "user", content: "问题一", status: "complete", createdAt: now, updatedAt: now },
    { id: "a1", role: "assistant", content: oldAnswer, status: "complete", createdAt: now, updatedAt: now }
  ];
  conversation.nodes.child.messages = [
    { id: "u2", role: "user", content: "问题二", status: "complete", createdAt: now, updatedAt: now },
    { id: "a2", role: "assistant", content: "回答二", status: "complete", createdAt: now, updatedAt: now },
    {
      id: "u3", role: "user", content: "问题三", status: "complete", createdAt: now, updatedAt: now,
      selectionContexts: [{
        messageId: "a1", sourceNodeId: "root", sourceRole: "assistant", basis: "rendered-text-v1",
        startOffset: 4, endOffset: 9, quote: "重复目标。", prefix: "", suffix: "", contentHash: "hash"
      }]
    },
    { id: "a3", role: "assistant", content: "回答三", status: "complete", createdAt: now, updatedAt: now },
    { id: "u4", role: "user", content: "当前问题", status: "complete", createdAt: now, updatedAt: now }
  ];
  const plan = compileContextPlan(conversation, "child", {
    mode: "balanced", systemPrompt: "system", maxInputTokens: 100000
  });
  assert.notEqual(plan.messages[2].content, oldAnswer);
  assert.match(plan.messages[2].content, /TreeTalk 已省略部分较早的回答内容/u);
  const serialized = plan.messages.map((message) => message.content).join("\n---\n");
  assert.match(serialized, /\[TreeTalk 恢复引用\]/u);
  assert.match(serialized, /用户框选原文：\n---\n重复目标。\n---/u);
});

void test("balanced:v3 hard budget pass further reduces only old compressible assistant answers", () => {
  const { compileContextPlan } = load("src/domain/context-engine.js");
  const { validConversation } = load("tests/fixtures.js");
  const conversation = structuredClone(validConversation());
  const now = conversation.createdAt;
  const longAnswer = (label) => [
    `# ${label}`, "", "核心结论。",
    ...Array.from({ length: 24 }, (_, index) => `\n\n中性说明 ${String(index)}：${"内容。".repeat(45)}`),
    "", "## 总结", "", "最终结论。"
  ].join("");
  conversation.nodes.root.messages = [
    { id: "u1", role: "user", content: "问题一", status: "complete", createdAt: now, updatedAt: now },
    { id: "a1", role: "assistant", content: longAnswer("旧回答一"), status: "complete", createdAt: now, updatedAt: now }
  ];
  conversation.nodes.child.messages = [
    { id: "u2", role: "user", content: "问题二", status: "complete", createdAt: now, updatedAt: now },
    { id: "a2", role: "assistant", content: longAnswer("旧回答二"), status: "complete", createdAt: now, updatedAt: now },
    { id: "u3", role: "user", content: "问题三", status: "complete", createdAt: now, updatedAt: now },
    { id: "a3", role: "assistant", content: "回答三原文", status: "complete", createdAt: now, updatedAt: now },
    { id: "u4", role: "user", content: "问题四", status: "complete", createdAt: now, updatedAt: now },
    { id: "a4", role: "assistant", content: "回答四原文", status: "complete", createdAt: now, updatedAt: now },
    { id: "u5", role: "user", content: "当前问题", status: "complete", createdAt: now, updatedAt: now }
  ];
  const roomy = compileContextPlan(conversation, "child", { mode: "balanced", systemPrompt: "system", maxInputTokens: 100000 });
  const limit = Math.max(500, Math.floor(roomy.sentEstimatedTokens * 0.8));
  const constrained = compileContextPlan(conversation, "child", { mode: "balanced", systemPrompt: "system", maxInputTokens: limit });
  assert.ok(constrained.sentEstimatedTokens < roomy.sentEstimatedTokens);
  assert.equal(constrained.messages.at(-4).content, "回答三原文");
  assert.equal(constrained.messages.at(-2).content, "回答四原文");
  assert.equal(constrained.messages.at(-1).content, "当前问题");
  assert.deepEqual(compileContextPlan(conversation, "child", { mode: "balanced", systemPrompt: "system", maxInputTokens: limit }), constrained);
});
