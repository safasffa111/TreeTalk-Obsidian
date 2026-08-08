import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

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

function chatMessage(id, role, content, selectionContexts = undefined) {
  return {
    id,
    role,
    content,
    status: "complete",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...(selectionContexts === undefined ? {} : { selectionContexts })
  };
}

function conversation() {
  return {
    schemaVersion: 1,
    id: "conversation-1",
    title: "Protocol test",
    rootNodeId: "root",
    currentNodeId: "child",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    nodes: {
      root: {
        id: "root",
        parentId: null,
        childIds: ["child", "sibling"],
        title: "root",
        messages: [
          chatMessage("u1", "user", "问题一"),
          chatMessage("a1", "assistant", "回答一")
        ],
        draft: { text: "", mode: "continue", selectionContexts: [] },
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z"
      },
      child: {
        id: "child",
        parentId: "root",
        childIds: [],
        title: "child",
        messages: [chatMessage("u2", "user", "问题二")],
        draft: { text: "", mode: "continue", selectionContexts: [] },
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z"
      },
      sibling: {
        id: "sibling",
        parentId: "root",
        childIds: [],
        title: "sibling",
        messages: [chatMessage("s1", "user", "兄弟分支秘密")],
        draft: { text: "", mode: "continue", selectionContexts: [] },
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z"
      }
    }
  };
}

void test("full context base protocol is always stable and Markdown guidance is optional", () => {
  const {
    FULL_CONTEXT_PROTOCOL_VERSION,
    FULL_CONTEXT_BASE_SYSTEM_PROMPT,
    buildTreeTalkSystemPrompt
  } = load("src/domain/full-context-protocol.js");
  const plain = buildTreeTalkSystemPrompt(false);
  const markdown = buildTreeTalkSystemPrompt(true);

  assert.equal(FULL_CONTEXT_PROTOCOL_VERSION, "v1");
  assert.equal(plain, FULL_CONTEXT_BASE_SYSTEM_PROMPT);
  assert.match(plain, /^TreeTalk Full Context Protocol v1\n/u);
  assert.match(plain, /直接回答当前问题/u);
  assert.doesNotMatch(plain, /Obsidian Markdown/u);
  assert.ok(markdown.startsWith(`${plain}\n\n[Obsidian Markdown 格式规则]\n`));
  assert.match(markdown, /严格兼容 Obsidian Markdown/u);
  assert.doesNotMatch(markdown, /2026|Token|messageId|联网/u);
});

void test("full mode preserves the active branch and extends the previous request byte-for-byte", () => {
  const { compileContextPlan, cacheKeyForContextPlan } = load("src/domain/context-engine.js");
  const { buildTreeTalkSystemPrompt } = load("src/domain/full-context-protocol.js");
  const value = conversation();
  const systemPrompt = buildTreeTalkSystemPrompt(false);
  const first = compileContextPlan(value, "child", {
    mode: "full",
    systemPrompt,
    maxInputTokens: 1
  });

  assert.deepEqual(first.messages.map((entry) => entry.content), [
    systemPrompt,
    "问题一",
    "回答一",
    "问题二"
  ]);
  assert.equal(first.trimmed, false);
  assert.equal(first.reducedTokens, 0);
  assert.equal(cacheKeyForContextPlan(value.id, first), "treetalk:conversation-1:full:v1");
  assert.doesNotMatch(first.messages.map((entry) => entry.content).join("\n"), /兄弟分支秘密/u);

  value.nodes.child.messages.push(
    chatMessage("a2", "assistant", "回答二"),
    chatMessage("u3", "user", "问题三")
  );
  const second = compileContextPlan(value, "child", {
    mode: "full",
    systemPrompt,
    maxInputTokens: 1
  });
  assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages);
  assert.deepEqual(second.messages.slice(-2).map((entry) => entry.content), ["回答二", "问题三"]);
});

void test("selection contexts use deterministic boundaries without rewriting quote or question text", () => {
  const { providerContentForMessage } = load("src/domain/context-engine.js");
  const quoteOne = "  原样引用 $x^2$\n```ts\nconst x = 1;\n```  ";
  const quoteTwo = "第二段\n保留换行";
  const question = "  当前问题也保留空格？  ";
  const content = providerContentForMessage(chatMessage("u", "user", question, [
    { quote: quoteOne },
    { quote: quoteTwo }
  ]));

  assert.equal(content, [
    "[TreeTalk 引用上下文 1]",
    "以下内容仅作为回答参考：",
    "---",
    quoteOne,
    "---",
    "[引用上下文结束]",
    "",
    "[TreeTalk 引用上下文 2]",
    "以下内容仅作为回答参考：",
    "---",
    quoteTwo,
    "---",
    "[引用上下文结束]",
    "",
    "[当前问题]",
    question
  ].join("\n"));
});

void test("request orchestration always compiles a ContextPlan and never injects runtime status", () => {
  const source = fs.readFileSync(path.join(root, "src/main.ts"), "utf8");
  assert.doesNotMatch(source, /buildProviderContext\(/u);
  assert.match(source, /const contextMode = "full";/u);
  assert.match(source, /buildTreeTalkSystemPrompt\(/u);

  const { compileContextPlan } = load("src/domain/context-engine.js");
  const { buildTreeTalkSystemPrompt } = load("src/domain/full-context-protocol.js");
  const plan = compileContextPlan(conversation(), "child", {
    mode: "full",
    systemPrompt: buildTreeTalkSystemPrompt(true),
    maxInputTokens: 1
  });
  const serialized = JSON.stringify(plan.messages);
  assert.doesNotMatch(serialized, /正在思考|正在搜索网页|缓存命中率|sentEstimatedTokens|messageId/u);
});
