import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const root = process.cwd();
function walk(entry) {
  const stat = fs.statSync(entry);
  if (stat.isFile()) return [entry];
  return fs.readdirSync(entry, { withFileTypes: true }).flatMap((item) => walk(path.join(entry, item.name)));
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

function message(id, role, content, selectionContexts = undefined) {
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
function noteContext({ quote, content, hash = "snapshot-1", start = content.indexOf(quote), pathName = "课程/网络.md" }) {
  return {
    sourceType: "note",
    filePath: pathName,
    fileName: path.basename(pathName),
    basis: "note-source-v1",
    startOffset: start,
    endOffset: start + quote.length,
    quote,
    prefix: "",
    suffix: "",
    contentHash: hash,
    snapshot: {
      version: "note-snapshot-v1",
      content,
      contentHash: hash,
      selectionStartOffset: start,
      selectionEndOffset: start + quote.length
    }
  };
}
function conversation(messages) {
  return {
    schemaVersion: 1,
    id: "conversation-note",
    title: "note",
    status: "active",
    revision: 0,
    checksum: "",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    rootNodeId: "root",
    currentNodeId: "root",
    nodes: {
      root: {
        id: "root",
        parentId: null,
        childIds: [],
        title: "root",
        messages,
        draft: { text: "", mode: "continue", selectionContexts: [] },
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z"
      }
    },
    ui: { expandedNodeIds: ["root"], treeScrollTop: 0, messageScrollTopByNode: {} }
  };
}

void test("note snapshot strips YAML and keeps selection offsets in the YAML-free body", async () => {
  const { createNoteSelectionContext } = load("src/domain/note-selection-context.js");
  const source = "---\ntags: [network]\naliases: [OSI]\n---\n# 网络分层\n\n网络层负责寻址。";
  const quote = "网络层负责寻址";
  const start = source.indexOf(quote);
  const context = await createNoteSelectionContext({
    filePath: "课程/网络.md",
    fileName: "网络.md",
    basis: "note-source-v1",
    visibleText: source,
    sourceText: source,
    startOffset: start,
    endOffset: start + quote.length
  });
  assert.equal(context.snapshot.version, "note-snapshot-v1");
  assert.doesNotMatch(context.snapshot.content, /tags:|aliases:/u);
  assert.match(context.snapshot.content, /^# 网络分层/u);
  assert.equal(
    context.snapshot.content.slice(context.snapshot.selectionStartOffset, context.snapshot.selectionEndOffset),
    quote
  );
});

void test("context compiler sends one immutable note background and keeps every selection focus", () => {
  const { compileContextPlan } = load("src/domain/context-engine.js");
  const content = "# 网络分层\n\n## 网络层\n网络层负责寻址与路由。\n\n## 传输层\n传输层负责端到端通信。";
  const first = noteContext({ quote: "网络层负责寻址", content });
  const second = noteContext({ quote: "传输层负责端到端通信", content, start: content.indexOf("传输层负责端到端通信") });
  const plan = compileContextPlan(conversation([
    message("u1", "user", "解释第一处", [first]),
    message("a1", "assistant", "第一处解释"),
    message("u2", "user", "再解释第二处", [second])
  ]), "root", { mode: "full", systemPrompt: "system", maxInputTokens: 30000 });
  const joined = plan.messages.map((entry) => entry.content).join("\n");
  assert.equal((joined.match(/\[TreeTalk 笔记背景\]/gu) ?? []).length, 1);
  assert.equal((joined.match(/\[TreeTalk 框选重点\]/gu) ?? []).length, 2);
  assert.match(joined, /# 网络分层/u);
  assert.match(joined, /解释第一处/u);
  assert.match(joined, /再解释第二处/u);
  assert.equal(plan.noteContextTrimmed, false);
  assert.ok(plan.noteContextOriginalEstimatedTokens > 0);
  assert.equal(plan.noteContextSentEstimatedTokens, plan.noteContextOriginalEstimatedTokens);
});

void test("over-budget note context deterministically keeps the selected section and marks omissions", () => {
  const { compileContextPlan } = load("src/domain/context-engine.js");
  const sections = Array.from({ length: 30 }, (_, index) =>
    `## 章节 ${index}\n${index === 17 ? "关键选中内容：路由表决定下一跳。" : `普通内容 ${index} `.repeat(180)}`
  );
  const content = `# 大笔记\n\n${sections.join("\n\n")}`;
  const quote = "关键选中内容：路由表决定下一跳。";
  const context = noteContext({ quote, content, start: content.indexOf(quote) });
  const value = conversation([message("u1", "user", "解释这段", [context])]);
  const options = { mode: "full", systemPrompt: "system", maxInputTokens: 1200 };
  const first = compileContextPlan(value, "root", options);
  const second = compileContextPlan(value, "root", options);
  const joined = first.messages.map((entry) => entry.content).join("\n");
  assert.deepEqual(first, second);
  assert.equal(first.noteContextTrimmed, true);
  assert.ok(first.noteContextSentEstimatedTokens < first.noteContextOriginalEstimatedTokens);
  assert.match(joined, /## 章节 17/u);
  assert.match(joined, /关键选中内容：路由表决定下一跳/u);
  assert.match(joined, /此处省略了距离框选位置较远的笔记内容/u);
  assert.doesNotMatch(joined, /普通内容 0 普通内容 0 普通内容 0/u);
});


void test("source-mode note capture stores the editor snapshot at selection time", async () => {
  const { captureNoteSelection } = load("src/editor/note-selection-capture.js");
  const sourceText = "---\ntags: [x]\n---\n# 标题\n\n框选内容";
  const quote = "框选内容";
  const start = sourceText.indexOf(quote);
  const context = await captureNoteSelection(
    {
      filePath: "笔记.md",
      fileName: "笔记.md",
      mode: "source",
      contentEl: {},
      editor: {
        getSelection: () => quote,
        getCursor: (which) =>
          which === "from" ? { line: 5, ch: 0 } : { line: 5, ch: quote.length },
        posToOffset: (position) => start + position.ch,
        getValue: () => sourceText
      }
    },
    null
  );
  assert.equal(context.snapshot.content, "# 标题\n\n框选内容");
  assert.equal(
    context.snapshot.content.slice(
      context.snapshot.selectionStartOffset,
      context.snapshot.selectionEndOffset
    ),
    quote
  );
});


void test("changed note snapshots are emitted separately and snapshot schema remains backward compatible", () => {
  const { compileContextPlan } = load("src/domain/context-engine.js");
  const { parseConversation } = load("src/domain/schema.js");
  const oldContent = "# 版本一\n\n共同框选";
  const newContent = "# 版本二\n\n共同框选";
  const oldContext = noteContext({
    quote: "共同框选",
    content: oldContent,
    hash: "old-hash"
  });
  const newContext = noteContext({
    quote: "共同框选",
    content: newContent,
    hash: "new-hash"
  });
  const value = conversation([
    message("u1", "user", "旧版本", [oldContext]),
    message("a1", "assistant", "旧回答"),
    message("u2", "user", "新版本", [newContext])
  ]);
  const parsed = parseConversation(value);
  const plan = compileContextPlan(parsed, "root", {
    mode: "full",
    systemPrompt: "system",
    maxInputTokens: 30000
  });
  const joined = plan.messages.map((entry) => entry.content).join("\n");
  assert.equal((joined.match(/\[TreeTalk 笔记背景\]/gu) ?? []).length, 2);
  assert.match(joined, /# 版本一/u);
  assert.match(joined, /# 版本二/u);

  const legacy = conversation([
    message("legacy", "user", "旧格式问题", [{
      sourceType: "note",
      filePath: "legacy.md",
      fileName: "legacy.md",
      basis: "note-source-v1",
      startOffset: 0,
      endOffset: 2,
      quote: "旧文",
      prefix: "",
      suffix: "",
      contentHash: "legacy"
    }])
  ]);
  const legacyParsed = parseConversation(legacy);
  assert.equal(
    legacyParsed.nodes.root.messages[0].selectionContexts[0].snapshot,
    undefined
  );
});

void test("note snapshot capture and transient labels are wired without persisting runtime statistics", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.ts"), "utf8");
  const captureSource = fs.readFileSync(
    path.join(root, "src/editor/note-selection-capture.ts"),
    "utf8"
  );
  const viewSource = fs.readFileSync(
    path.join(root, "src/views/conversation-view.ts"),
    "utf8"
  );
  assert.match(mainSource, /loadSourceText:\s*\(\) => this\.app\.vault\.cachedRead\(file\)/u);
  assert.match(captureSource, /sourceText = await source\.loadSourceText\?\.\(\)/u);
  assert.match(viewSource, /笔记上下文/u);
  assert.match(viewSource, /笔记原始估算/u);
  assert.match(viewSource, /笔记实际发送/u);
  assert.doesNotMatch(
    fs.readFileSync(path.join(root, "src/domain/types.ts"), "utf8"),
    /noteContextTrimmed/u
  );
});

void test("context plan records ordered deduplicated note names from the active branch", () => {
  const { compileContextPlan } = load("src/domain/context-engine.js");
  const firstContent = "# 网络分层\n\n网络层负责路由。";
  const secondContent = "# TCP\n\nTCP 提供可靠传输。";
  const duplicateFirst = noteContext({
    quote: "网络层负责路由",
    content: firstContent,
    pathName: "课程/网络分层.md",
    hash: "network-v1"
  });
  const firstAgain = noteContext({
    quote: "网络层负责路由",
    content: firstContent,
    pathName: "课程/网络分层.md",
    hash: "network-v1"
  });
  const second = noteContext({
    quote: "TCP 提供可靠传输",
    content: secondContent,
    pathName: "课程/TCP协议.md",
    hash: "tcp-v1"
  });
  const plan = compileContextPlan(conversation([
    message("u1", "user", "解释网络层", [duplicateFirst]),
    message("a1", "assistant", "解释"),
    message("u2", "user", "继续", [firstAgain, second])
  ]), "root", { mode: "full", systemPrompt: "system", maxInputTokens: 30000 });

  assert.deepEqual(plan.referencedNoteNames, ["网络分层.md", "TCP协议.md"]);
});

void test("different snapshot identities may keep the same visible note name", () => {
  const { compileContextPlan } = load("src/domain/context-engine.js");
  const first = noteContext({
    quote: "第一份",
    content: "# 一\n\n第一份",
    pathName: "课程A/同名.md",
    hash: "same-a"
  });
  const second = noteContext({
    quote: "第二份",
    content: "# 二\n\n第二份",
    pathName: "课程B/同名.md",
    hash: "same-b"
  });
  const plan = compileContextPlan(conversation([
    message("u1", "user", "比较", [first, second])
  ]), "root", { mode: "balanced", systemPrompt: "", maxInputTokens: 30000 });

  assert.deepEqual(plan.referencedNoteNames, ["同名.md", "同名.md"]);
});

void test("completed assistant responses persist referenced note names and schema ignores invalid values", () => {
  const { startAssistantResponse, finishAssistantResponse } = load("src/domain/assistant-response.js");
  const { parseConversation } = load("src/domain/schema.js");
  const now = "2026-08-01T00:00:00.000Z";
  let value = conversation([]);
  value = startAssistantResponse(value, {
    conversationId: value.id,
    nodeId: "root",
    messageId: "assistant-persisted",
    modelId: "deepseek-v4-flash",
    now
  });
  value = finishAssistantResponse(value, {
    conversationId: value.id,
    nodeId: "root",
    messageId: "assistant-persisted",
    status: "complete",
    finalContent: "回答",
    referencedNoteNames: ["网络分层.md", "TCP协议.md"],
    now
  });
  assert.deepEqual(
    value.nodes.root.messages.at(-1).referencedNoteNames,
    ["网络分层.md", "TCP协议.md"]
  );

  const reloaded = parseConversation(structuredClone(value));
  assert.deepEqual(
    reloaded.nodes.root.messages.at(-1).referencedNoteNames,
    ["网络分层.md", "TCP协议.md"]
  );

  const invalid = structuredClone(value);
  invalid.nodes.root.messages.at(-1).referencedNoteNames = ["A.md", 123];
  const parsedInvalid = parseConversation(invalid);
  assert.equal(parsedInvalid.nodes.root.messages.at(-1).referencedNoteNames, undefined);
});
