import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

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

const NOW = "2026-08-01T08:00:00.000Z";

void test("node summary prompt clips fields, strips web references, and cleans one-line titles", () => {
  const {
    buildNodeSummaryPrompt,
    cleanNodeSummaryTitle
  } = load("src/domain/node-summary.js");
  const question = {
    id: "q",
    role: "user",
    content: "Q".repeat(700),
    status: "complete",
    selectionContexts: [
      { messageId: "a", sourceNodeId: "root", sourceRole: "assistant", basis: "rendered-text-v1", startOffset: 0, endOffset: 350, quote: "S".repeat(350), prefix: "", suffix: "", contentHash: "h" }
    ],
    createdAt: NOW,
    updatedAt: NOW
  };
  const answer = {
    id: "a",
    role: "assistant",
    content: `${"A".repeat(900)}${"Z".repeat(500)}\n\n### 参考来源\n\n- [x](https://example.com)`,
    status: "complete",
    createdAt: NOW,
    updatedAt: NOW
  };
  const prompt = buildNodeSummaryPrompt({
    parentTitle: "P".repeat(60),
    question,
    answer
  });
  assert.equal([...prompt.parentTitle].length, 40);
  assert.equal([...prompt.selectionExcerpt].length, 300);
  assert.equal([...prompt.questionExcerpt].length, 500);
  assert.equal(prompt.answerExcerpt, `${"A".repeat(800)}\n…\n${"Z".repeat(400)}`);
  assert.doesNotMatch(prompt.messages.map((message) => message.content).join("\n"), /example\.com/u);
  const systemPrompt = prompt.messages[0]?.content ?? "";
  assert.match(systemPrompt, /4～10 个汉字/u);
  assert.match(systemPrompt, /核心对象和一个关键关系/u);
  assert.match(systemPrompt, /不要机械拼接父节点标题/u);
  assert.equal(cleanNodeSummaryTitle('### “旧回答冻结裁剪机制说明补充文字。”\n第二行'), "旧回答冻结裁剪机制说明补");
  assert.equal(cleanNodeSummaryTitle("One Two Three Four Five Six Seven"), "One Two Three Four Five Six");
  assert.equal(cleanNodeSummaryTitle("本节点讨论了端口号的作用"), undefined);
});

void test("legacy nodes are not backfilled unless they were created with question title metadata", () => {
  const { validConversation } = load("tests/fixtures.js");
  const { canAttemptNodeSummary } = load("src/domain/node-summary.js");
  const conversation = validConversation();
  conversation.nodes.root.messages = [
    { id: "q", role: "user", content: "旧问题", status: "complete", createdAt: NOW, updatedAt: NOW },
    { id: "a", role: "assistant", content: "旧回答", status: "complete", createdAt: NOW, updatedAt: NOW }
  ];
  assert.equal(conversation.nodes.root.titleSource, undefined);
  assert.equal(canAttemptNodeSummary(conversation.nodes.root), false);
});

void test("0.8.19 failed or interrupted summary records receive one v3 repair attempt", () => {
  const { validConversation } = load("tests/fixtures.js");
  const { canAttemptNodeSummary, markNodeSummaryPending } = load("src/domain/node-summary.js");
  for (const status of ["failed", "pending"]) {
    const conversation = validConversation();
    conversation.nodes.root.titleSource = "question";
    conversation.nodes.root.messages = [
      { id: "q", role: "user", content: "这是什么意思", status: "complete", createdAt: NOW, updatedAt: NOW },
      { id: "a", role: "assistant", content: "传输层回答", status: "complete", createdAt: NOW, updatedAt: NOW }
    ];
    conversation.nodes.root.summary = {
      protocol: "node-summary:v1",
      status,
      attemptedAt: NOW,
      providerProfileId: "default",
      modelId: "deepseek-v4-flash",
      ...(status === "failed" ? { completedAt: NOW } : {})
    };
    assert.equal(canAttemptNodeSummary(conversation.nodes.root), true);
    const repaired = markNodeSummaryPending(conversation, {
      nodeId: "root",
      now: "2026-08-01T09:00:00.000Z",
      providerProfileId: "default",
      modelId: "deepseek-v4-flash"
    });
    assert.equal(repaired.nodes.root.summary.protocol, "node-summary:v3");
    assert.equal(repaired.nodes.root.summary.status, "pending");
  }
});

void test("node title lifecycle synchronizes roots and preserves manual titles", () => {
  const { validConversation } = load("tests/fixtures.js");
  const {
    markNodeSummaryPending,
    applyNodeSummarySuccess,
    applyNodeSummaryFailure
  } = load("src/domain/node-summary.js");
  const conversation = validConversation();
  conversation.nodes.root.titleSource = "question";
  let next = markNodeSummaryPending(conversation, {
    nodeId: "root",
    now: NOW,
    providerProfileId: "default",
    modelId: "model"
  });
  next = applyNodeSummarySuccess(next, { nodeId: "root", title: "TCP 可靠传输机制", now: NOW });
  assert.equal(next.nodes.root.title, "TCP 可靠传输机制");
  assert.equal(next.title, "TCP 可靠传输机制");
  assert.equal(next.nodes.root.titleSource, "auto");

  next = structuredClone(next);
  next.nodes.child.title = "人工节点名";
  next.nodes.child.titleSource = "manual";
  next = markNodeSummaryPending(next, {
    nodeId: "child",
    now: NOW,
    providerProfileId: "default",
    modelId: "model"
  });
  next = applyNodeSummarySuccess(next, { nodeId: "child", title: "自动标题", now: NOW });
  assert.equal(next.nodes.child.title, "人工节点名");
  assert.equal(next.nodes.child.summary.generatedTitle, "自动标题");
  next = applyNodeSummaryFailure(next, { nodeId: "child", now: NOW });
  assert.equal(next.nodes.child.title, "人工节点名");
});

void test("DeepSeek node-summary requests disable thinking so the title is returned within the small budget", () => {
  const { DeepSeekProvider } = load("src/providers/deepseek-provider.js");
  const provider = new DeepSeekProvider();
  const profile = {
    id: "default",
    name: "DeepSeek",
    kind: "deepseek",
    apiKey: "secret",
    baseUrl: "https://api.deepseek.com"
  };
  const request = provider.buildRequest(
    {
      messages: [{ role: "user", content: "生成节点提要" }],
      model: "deepseek-v4-flash",
      stream: false,
      maxOutputTokens: 64,
      thinkingEnabled: false
    },
    profile
  );
  assert.deepEqual(request.body.thinking, { type: "disabled" });
  assert.equal(request.body.max_tokens, 64);
});

void test("providers cap summary output without changing normal request defaults", () => {
  const { OpenAiProvider } = load("src/providers/openai-provider.js");
  const { AnthropicProvider } = load("src/providers/anthropic-provider.js");
  const { DeepSeekProvider } = load("src/providers/deepseek-provider.js");
  const { GeminiProvider } = load("src/providers/gemini-provider.js");
  const messages = [{ role: "user", content: "hello" }];
  const profile = (kind, baseUrl = "") => ({ id: "default", name: kind, kind, apiKey: "secret", baseUrl });

  assert.equal(new OpenAiProvider().buildRequest({ messages, model: "m", stream: false, maxOutputTokens: 32 }, profile("openai")).body.max_tokens, 32);
  assert.equal(new AnthropicProvider().buildRequest({ messages, model: "m", stream: false, maxOutputTokens: 32 }, profile("anthropic")).body.max_tokens, 32);
  assert.equal(new DeepSeekProvider().buildRequest({ messages, model: "m", stream: false, maxOutputTokens: 32 }, profile("deepseek", "https://api.deepseek.com")).body.max_tokens, 32);
  assert.equal(new GeminiProvider().buildRequest({ messages, model: "m", stream: false, maxOutputTokens: 32 }, profile("gemini")).body.generationConfig.maxOutputTokens, 32);
  assert.equal("max_tokens" in new OpenAiProvider().buildRequest({ messages, model: "m", stream: false }, profile("openai")).body, false);
});

void test("coordinator performs one background request and updates root tab title", async () => {
  const { validConversation } = load("tests/fixtures.js");
  const { ConversationTabsStore } = load("src/tabs/conversation-tabs-store.js");
  const { ProviderRegistry } = load("src/providers/provider-registry.js");
  const { NodeSummaryCoordinator } = load("src/providers/node-summary-coordinator.js");
  const conversation = validConversation();
  conversation.currentNodeId = "root";
  conversation.nodes.root.titleSource = "question";
  conversation.nodes.root.messages = [
    { id: "q", role: "user", content: "这是什么意思", status: "complete", createdAt: NOW, updatedAt: NOW },
    { id: "a", role: "assistant", content: "传输层通过端口号区分不同应用进程。", status: "complete", createdAt: NOW, updatedAt: NOW }
  ];
  const tabs = new ConversationTabsStore();
  tabs.open({
    id: conversation.id,
    conversationId: conversation.id,
    folder: "active/c1",
    title: conversation.title,
    mode: "active",
    lifecycle: "idle",
    unread: false,
    requestEpoch: 0,
    conversation
  });
  const requests = [];
  const order = [];
  const coordinator = new NodeSummaryCoordinator(
    tabs,
    new ProviderRegistry(),
    {
      async request(request) {
        order.push("request");
        requests.push(request);
        return { choices: [{ message: { content: "端口号与进程寻址" } }] };
      }
    },
    {
      getProfile: () => ({ id: "default", name: "OpenAI", kind: "openai", apiKey: "secret", baseUrl: "" }),
      getModel: () => "gpt-test",
      now: () => NOW,
      persistPending: async () => { order.push("persist"); }
    }
  );
  await Promise.all([
    coordinator.trigger({ tabId: conversation.id, conversationId: conversation.id, nodeId: "root", answerMessageId: "a" }),
    coordinator.trigger({ tabId: conversation.id, conversationId: conversation.id, nodeId: "root", answerMessageId: "a" })
  ]);
  assert.equal(requests.length, 1);
  assert.deepEqual(order, ["persist", "request"]);
  assert.equal(requests[0].body.stream, false);
  assert.equal(requests[0].body.max_tokens, 64);
  assert.equal(tabs.getTab(conversation.id).conversation.nodes.root.title, "端口号与进程寻址");
  assert.equal(tabs.getTab(conversation.id).title, "端口号与进程寻址");
  await coordinator.trigger({ tabId: conversation.id, conversationId: conversation.id, nodeId: "root", answerMessageId: "a" });
  assert.equal(requests.length, 1);
  coordinator.dispose();
});

void test("startup repair waits for an API key instead of consuming the one v2 repair attempt", async () => {
  const { validConversation } = load("tests/fixtures.js");
  const { ConversationTabsStore } = load("src/tabs/conversation-tabs-store.js");
  const { ProviderRegistry } = load("src/providers/provider-registry.js");
  const { NodeSummaryCoordinator } = load("src/providers/node-summary-coordinator.js");
  const conversation = validConversation();
  conversation.nodes.root.titleSource = "question";
  conversation.nodes.root.messages = [
    { id: "q", role: "user", content: "这是什么意思", status: "complete", createdAt: NOW, updatedAt: NOW },
    { id: "a", role: "assistant", content: "回答", status: "complete", createdAt: NOW, updatedAt: NOW }
  ];
  conversation.nodes.root.summary = {
    protocol: "node-summary:v1", status: "failed", attemptedAt: NOW, completedAt: NOW,
    providerProfileId: "default", modelId: "deepseek-v4-flash"
  };
  const tabs = new ConversationTabsStore();
  tabs.open({ id: conversation.id, conversationId: conversation.id, folder: "active/c1", title: conversation.title, mode: "active", lifecycle: "idle", unread: false, requestEpoch: 0, conversation });
  let requests = 0;
  const coordinator = new NodeSummaryCoordinator(
    tabs,
    new ProviderRegistry(),
    { async request() { requests += 1; return { choices: [{ message: { content: "提要" } }] }; } },
    { getProfile: () => ({ id: "default", name: "DeepSeek", kind: "deepseek", apiKey: "", baseUrl: "https://api.deepseek.com" }), getModel: () => "deepseek-v4-flash", now: () => NOW }
  );
  assert.equal(await coordinator.repairOpenTabs(), 0);
  assert.equal(requests, 0);
  assert.equal(tabs.getTab(conversation.id).conversation.nodes.root.summary.protocol, "node-summary:v1");
  coordinator.dispose();
});

void test("startup repair updates every eligible 0.8.19 tree label without backfilling legacy nodes", async () => {
  const { validConversation } = load("tests/fixtures.js");
  const { ConversationTabsStore } = load("src/tabs/conversation-tabs-store.js");
  const { ProviderRegistry } = load("src/providers/provider-registry.js");
  const { NodeSummaryCoordinator } = load("src/providers/node-summary-coordinator.js");
  const conversation = validConversation();
  conversation.nodes.root.title = "这是什么意思";
  conversation.nodes.root.titleSource = "question";
  conversation.nodes.root.messages = [
    { id: "q1", role: "user", content: "这是什么意思", status: "complete", createdAt: NOW, updatedAt: NOW },
    { id: "a1", role: "assistant", content: "根节点回答", status: "complete", createdAt: NOW, updatedAt: NOW }
  ];
  conversation.nodes.root.summary = {
    protocol: "node-summary:v1", status: "failed", attemptedAt: NOW, completedAt: NOW,
    providerProfileId: "default", modelId: "deepseek-v4-flash"
  };
  conversation.nodes.child.title = "继续解释";
  conversation.nodes.child.titleSource = "question";
  conversation.nodes.child.messages = [
    { id: "q2", role: "user", content: "继续解释", status: "complete", createdAt: NOW, updatedAt: NOW },
    { id: "a2", role: "assistant", content: "子节点回答", status: "complete", createdAt: NOW, updatedAt: NOW }
  ];
  const legacyId = "legacy";
  conversation.nodes[legacyId] = {
    id: legacyId, parentId: "root", childIds: [], title: "旧问题", messages: [
      { id: "ql", role: "user", content: "旧问题", status: "complete", createdAt: NOW, updatedAt: NOW },
      { id: "al", role: "assistant", content: "旧回答", status: "complete", createdAt: NOW, updatedAt: NOW }
    ], draft: { mode: "continue", text: "", selectionContexts: [] }, createdAt: NOW, updatedAt: NOW
  };
  conversation.nodes.root.childIds.push(legacyId);
  const tabs = new ConversationTabsStore();
  tabs.open({ id: conversation.id, conversationId: conversation.id, folder: "active/c1", title: conversation.title, mode: "active", lifecycle: "idle", unread: false, requestEpoch: 0, conversation });
  let requests = 0;
  const coordinator = new NodeSummaryCoordinator(
    tabs,
    new ProviderRegistry(),
    { async request() { requests += 1; return { choices: [{ message: { content: requests === 1 ? "根节点提要" : "子节点提要" } }] }; } },
    { getProfile: () => ({ id: "default", name: "OpenAI", kind: "openai", apiKey: "secret", baseUrl: "" }), getModel: () => "gpt-test", now: () => NOW }
  );
  assert.equal(await coordinator.repairOpenTabs(), 2);
  const repaired = tabs.getTab(conversation.id).conversation;
  assert.equal(repaired.nodes.root.title, "根节点提要");
  assert.equal(repaired.nodes.child.title, "子节点提要");
  assert.equal(repaired.nodes[legacyId].title, "旧问题");
  assert.equal(tabs.getTab(conversation.id).title, "根节点提要");
  coordinator.dispose();
});

void test("failed summary requests are recorded once and are not retried", async () => {
  const { validConversation } = load("tests/fixtures.js");
  const { ConversationTabsStore } = load("src/tabs/conversation-tabs-store.js");
  const { ProviderRegistry } = load("src/providers/provider-registry.js");
  const { NodeSummaryCoordinator } = load("src/providers/node-summary-coordinator.js");
  const conversation = validConversation();
  conversation.currentNodeId = "root";
  conversation.nodes.root.titleSource = "question";
  conversation.nodes.root.messages = [
    { id: "q", role: "user", content: "问题", status: "complete", createdAt: NOW, updatedAt: NOW },
    { id: "a", role: "assistant", content: "回答", status: "complete", createdAt: NOW, updatedAt: NOW }
  ];
  const tabs = new ConversationTabsStore();
  tabs.open({
    id: conversation.id, conversationId: conversation.id, folder: "active/c1",
    title: conversation.title, mode: "active", lifecycle: "idle", unread: false,
    requestEpoch: 0, conversation
  });
  let requests = 0;
  const coordinator = new NodeSummaryCoordinator(
    tabs,
    new ProviderRegistry(),
    { async request() { requests += 1; throw new Error("offline"); } },
    {
      getProfile: () => ({ id: "default", name: "OpenAI", kind: "openai", apiKey: "secret", baseUrl: "" }),
      getModel: () => "gpt-test",
      now: () => NOW
    }
  );
  const trigger = { tabId: conversation.id, conversationId: conversation.id, nodeId: "root", answerMessageId: "a" };
  await coordinator.trigger(trigger);
  assert.equal(requests, 1);
  assert.equal(tabs.getTab(conversation.id).conversation.nodes.root.summary.status, "failed");
  await coordinator.trigger(trigger);
  assert.equal(requests, 1);
  coordinator.dispose();
});

void test("answer capture uses only the current node summary and suffixes only the physical filename", async () => {
  const { validConversation } = load("tests/fixtures.js");
  const { KnowledgeCaptureService } = load("src/knowledge/capture-service.js");
  const conversation = validConversation();
  conversation.nodes.root.title = "OSI 七层模型";
  conversation.nodes.child.title = "传输层的端到端通信";
  conversation.nodes.child.messages = [
    { id: "q", role: "user", content: "问题", status: "complete", createdAt: NOW, updatedAt: NOW },
    { id: "a", role: "assistant", content: "回答正文", status: "complete", createdAt: NOW, updatedAt: NOW }
  ];
  const files = new Map([[
    "TreeTalk 知识/传输层的端到端通信.md",
    "existing"
  ]]);
  const vault = {
    async exists(filePath) { return files.has(filePath); },
    async read(filePath) {
      const value = files.get(filePath);
      if (value === undefined) throw new Error(`Missing: ${filePath}`);
      return value;
    },
    async write(filePath, content) { files.set(filePath, content); },
    async list() { return [...files.keys()]; },
    async rename(from, to) {
      const value = files.get(from);
      if (value === undefined) throw new Error(`Missing: ${from}`);
      files.delete(from); files.set(to, value);
    },
    async remove(filePath) { files.delete(filePath); }
  };
  const service = new KnowledgeCaptureService(vault, "TreeTalk 知识", "TreeTalk");
  const path = await service.capture({
    scope: "answer", conversation, nodeId: "child", messageId: "a"
  }, NOW);
  assert.equal(path, "TreeTalk 知识/传输层的端到端通信 2.md");
  const markdown = files.get(path);
  assert.match(markdown, /^# 传输层的端到端通信$/mu);
  assert.doesNotMatch(markdown, /^# .* 2$/mu);
});

void test("node summary metadata does not change full or balanced provider context", () => {
  const { validConversation } = load("tests/fixtures.js");
  const { compileContextPlan } = load("src/domain/context-engine.js");
  const conversation = validConversation();
  conversation.currentNodeId = "child";
  conversation.nodes.root.messages = [
    { id: "q1", role: "user", content: "问题一", status: "complete", createdAt: NOW, updatedAt: NOW },
    { id: "a1", role: "assistant", content: "回答一", status: "complete", createdAt: NOW, updatedAt: NOW }
  ];
  conversation.nodes.child.messages = [
    { id: "q2", role: "user", content: "问题二", status: "complete", createdAt: NOW, updatedAt: NOW }
  ];
  const options = (mode) => ({ mode, systemPrompt: "", maxInputTokens: 30000, recentRoundTarget: 4, minRecentRounds: 2, maxRecentRounds: 6 });
  const beforeFull = compileContextPlan(conversation, "child", options("full")).messages;
  const beforeBalanced = compileContextPlan(conversation, "child", options("balanced")).messages;
  const titled = structuredClone(conversation);
  titled.title = "自动根提要";
  titled.nodes.root.title = "自动根提要";
  titled.nodes.root.titleSource = "auto";
  titled.nodes.root.summary = { protocol: "node-summary:v1", status: "complete", attemptedAt: NOW, completedAt: NOW, providerProfileId: "default", modelId: "m", generatedTitle: "自动根提要" };
  titled.nodes.child.title = "自动子提要";
  titled.nodes.child.titleSource = "auto";
  titled.nodes.child.summary = { protocol: "node-summary:v1", status: "complete", attemptedAt: NOW, completedAt: NOW, providerProfileId: "default", modelId: "m", generatedTitle: "自动子提要" };
  assert.deepEqual(compileContextPlan(titled, "child", options("full")).messages, beforeFull);
  assert.deepEqual(compileContextPlan(titled, "child", options("balanced")).messages, beforeBalanced);
});

void test("main request flow triggers summaries after successful answers and waits before capture", () => {
  const source = fs.readFileSync(path.join(root, "src/main.ts"), "utf8");
  assert.match(source, /void this\.nodeSummaries\.trigger\(/u);
  assert.match(source, /await this\.nodeSummaries\.waitForNode\(/u);
  assert.match(source, /void this\.nodeSummaries\.repairOpenTabs\(\)/u);
  assert.match(source, /if \(apiKey\.length > 0\) void this\.nodeSummaries\.repairOpenTabs\(\)/u);
  assert.match(source, /this\.nodeSummaries\.dispose\(\)/u);
});

void test("knowledge note titles use only the current node summary", async () => {
  const { validConversation } = load("tests/fixtures.js");
  const { KnowledgeCaptureService } = load("src/knowledge/capture-service.js");
  const conversation = validConversation();
  conversation.nodes.root.title = "OSI 七层模型";
  conversation.nodes.child.title = "传输层的端到端通信";
  const files = new Map();
  const vault = {
    async exists(filePath) { return files.has(filePath); },
    async list(prefix) { return [...files.keys()].filter((filePath) => filePath.startsWith(prefix)); },
    async read(filePath) { const value = files.get(filePath); if (value === undefined) throw new Error(`Missing: ${filePath}`); return value; },
    async write(filePath, content) { files.set(filePath, content); },
    async process(filePath, update) { files.set(filePath, update(await this.read(filePath))); },
    async remove(filePath) { files.delete(filePath); },
    async move(from, to) { const value = files.get(from); if (value === undefined) throw new Error(`Missing: ${from}`); files.delete(from); files.set(to, value); }
  };
  const service = new KnowledgeCaptureService(vault, "TreeTalk 知识", "TreeTalk");
  await service.capture({ scope: "tree", conversation }, NOW);
  assert.ok([...files.keys()].some((filePath) => filePath.endsWith("/OSI 七层模型.md")));
  assert.ok([...files.keys()].some((filePath) => filePath.endsWith("/传输层的端到端通信.md")));
});
