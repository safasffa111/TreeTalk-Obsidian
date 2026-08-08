import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const root = process.cwd();
const entries = [path.join(root, "src"), path.join(root, "tests/storage/fake-vault.ts"), path.join(root, "tests/fixtures.ts")];

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
    return require(request);
  };
  new Function("module", "exports", "require", code)(module, module.exports, localRequire);
  return module.exports;
}

const links = load("src/knowledge/markdown-branch-links.js");
const capture = load("src/knowledge/capture-service.js");
const anchors = load("src/domain/selection-anchor.js");
const noteSelections = load("src/domain/note-selection-context.js");
const { FakeVault } = load("tests/storage/fake-vault.js");
const { validConversation } = load("tests/fixtures.js");

void test("TreeTalk emits ordinary graph-indexable WikiLinks without maintenance markers", () => {
  const rendered = links.markdownWikiLink("Tree|Talk/a.md", "追问|一");
  assert.equal(rendered, "[[Tree-Talk/a|追问-一]]");
  assert.doesNotMatch(rendered, /treetalk-(?:branches|node-link|source-note-link)/u);
});


void test("selection links move outside Markdown lists, fenced code, and display math", () => {
  const link = { path: "TreeTalk/session/child.md", title: "子节点" };
  const cases = [
    {
      name: "list",
      content: "- 第一项里的网络层\n- 第二项\n\n后文",
      quote: "网络层",
      expected: "- 第一项里的网络层\n- 第二项\n\n[[TreeTalk/session/child|子节点]]\n\n后文"
    },
    {
      name: "fenced code",
      content: "```ts\nconst network = true;\n```\n\n后文",
      quote: "network",
      expected: "```ts\nconst network = true;\n```\n\n[[TreeTalk/session/child|子节点]]\n\n后文"
    },
    {
      name: "display math",
      content: "$$\na^2+b^2=c^2\n$$\n\n后文",
      quote: "b^2",
      expected: "$$\na^2+b^2=c^2\n$$\n\n[[TreeTalk/session/child|子节点]]\n\n后文"
    },
    {
      name: "blockquote",
      content: "> 网络层负责寻址。\n> 第二行。\n\n后文",
      quote: "网络层",
      expected: "> 网络层负责寻址。\n> 第二行。\n\n[[TreeTalk/session/child|子节点]]\n\n后文"
    },
    {
      name: "table",
      content: "| 层级 | 作用 |\n| --- | --- |\n| 网络层 | 寻址 |\n\n后文",
      quote: "网络层",
      expected: "| 层级 | 作用 |\n| --- | --- |\n| 网络层 | 寻址 |\n\n[[TreeTalk/session/child|子节点]]\n\n后文"
    },
    {
      name: "inline math",
      content: "公式 $a^2+b^2=c^2$ 用于说明。\n\n后文",
      quote: "b^2",
      expected: "公式 $a^2+b^2=c^2$ 用于说明。\n\n[[TreeTalk/session/child|子节点]]\n\n后文"
    },
    {
      name: "inline code",
      content: "调用 `console.log(value)` 输出。\n\n后文",
      quote: "value",
      expected: "调用 `console.log(value)` 输出。\n\n[[TreeTalk/session/child|子节点]]\n\n后文"
    }
  ];
  for (const item of cases) {
    const start = item.content.indexOf(item.quote);
    const actual = links.insertMarkdownLinks(item.content, [{
      anchor: { start, end: start + item.quote.length },
      links: [link]
    }]);
    assert.equal(actual, item.expected, item.name);
  }
});

void test("captured tree and message-selection relations contain only plain WikiLinks", async () => {
  const now = "2026-07-30T01:02:03.000Z";
  const conversation = validConversation();
  const rootNode = conversation.nodes.root;
  const child = conversation.nodes.child;
  rootNode.messages.push({ id: "root-answer", role: "assistant", content: "TCP 使用确认机制保证可靠传输。", status: "complete", createdAt: now, updatedAt: now });
  child.messages.push({ id: "question", role: "user", content: "ACK 如何工作？", status: "complete", createdAt: now, updatedAt: now });
  child.messages[0].selectionContexts = [await anchors.createSelectionAnchor({
    messageId: "root-answer", sourceNodeId: "root", sourceRole: "assistant",
    visibleText: "TCP 使用确认机制保证可靠传输。", startOffset: 6, endOffset: 10
  })];
  const vault = new FakeVault();
  const service = new capture.KnowledgeCaptureService(vault, "Knowledge", "TreeTalk");
  const indexPath = await service.capture({ scope: "tree", conversation }, now);
  const rootPath = vault.paths().find((filePath) => filePath.includes("TCP 为什么可靠"));
  assert.ok(rootPath);
  const rootNote = await vault.read(rootPath);
  const index = await vault.read(indexPath);
  assert.match(rootNote, /确认机制 \[\[[^\]]+\]\]/u);
  assert.equal(indexPath.endsWith("/节点列表.md"), true);
  assert.match(index, /^# 节点列表$/mu);
  assert.doesNotMatch(`${rootNote}\n${index}`, /treetalk_|TREETALK_ARCHIVE|\.treetalk-archive/u);
  assert.equal(vault.paths().some((filePath) => filePath.endsWith(".treetalk-archive.md")), false);
});

void test("captured TreeTalk list selections place their links after the whole list", async () => {
  const now = "2026-07-30T01:02:03.000Z";
  const content = "- 网络层负责寻址\n- 传输层负责端到端通信";
  const conversation = validConversation();
  const rootNode = conversation.nodes.root;
  const child = conversation.nodes.child;
  rootNode.messages.push({ id: "root-answer", role: "assistant", content, status: "complete", createdAt: now, updatedAt: now });
  child.messages.push({
    id: "question", role: "user", content: "网络层是什么？", status: "complete", createdAt: now, updatedAt: now,
    selectionContexts: [{
      messageId: "root-answer", sourceNodeId: "root", sourceRole: "assistant", basis: "rendered-text-v1",
      startOffset: content.indexOf("网络层"), endOffset: content.indexOf("网络层") + 3, quote: "网络层",
      prefix: "", suffix: "负责寻址", contentHash: "fixture"
    }]
  });
  const vault = new FakeVault();
  const service = new capture.KnowledgeCaptureService(vault, "Knowledge", "TreeTalk");
  await service.capture({ scope: "tree", conversation }, now);
  const rootPath = vault.paths().find((filePath) => filePath.includes("TCP 为什么可靠"));
  assert.ok(rootPath);
  const rootNote = await vault.read(rootPath);
  assert.match(rootNote, /- 网络层负责寻址\n- 传输层负责端到端通信\n\n\[\[TreeTalk\/[^|]+\|三次握手\]\]/u);
});

void test("source-note formula selections place their links after the whole formula block", async () => {
  const now = "2026-07-30T01:02:03.000Z";
  const body = "$$\na^2+b^2=c^2\n$$\n\n后文";
  const conversation = validConversation();
  const child = conversation.nodes.child;
  const start = body.indexOf("b^2");
  child.messages.push({
    id: "question", role: "user", content: "公式是什么？", status: "complete", createdAt: now, updatedAt: now,
    selectionContexts: [{
      sourceType: "note", filePath: "Notes/math.md", fileName: "math.md", basis: "note-source-v1",
      startOffset: start, endOffset: start + 3, quote: "b^2", prefix: "a^2+", suffix: "=c^2", contentHash: "fixture"
    }]
  });
  const vault = new FakeVault({ "Notes/math.md": body });
  const service = new capture.KnowledgeCaptureService(vault, "Knowledge", "TreeTalk");
  await service.capture({ scope: "tree", conversation }, now);
  const updated = await vault.read("Notes/math.md");
  assert.match(updated, /^\$\$\na\^2\+b\^2=c\^2\n\$\$\n\n\[\[TreeTalk\/[^|]+\|三次握手\]\]\n\n后文$/u);
});

void test("capturing a note-selection branch preserves YAML and adds only a plain WikiLink", async () => {
  const now = "2026-07-30T01:02:03.000Z";
  const body = "网络层负责寻址和路由选择。";
  const original = `---\ntags: [network]\n---\n\n${body}`;
  const conversation = validConversation();
  conversation.nodes.child.messages.push({
    id: "question", role: "user", content: "网络层是什么？", status: "complete",
    createdAt: now, updatedAt: now,
    selectionContexts: [await noteSelections.createNoteSelectionContext({
      filePath: "Notes/network.md", fileName: "network.md", basis: "note-source-v1",
      visibleText: body, startOffset: 0, endOffset: 3
    })]
  });
  const vault = new FakeVault({ "Notes/network.md": original });
  const service = new capture.KnowledgeCaptureService(vault, "Knowledge", "TreeTalk");
  await service.capture({ scope: "tree", conversation }, now);
  const updated = await vault.read("Notes/network.md");
  assert.match(updated, /^---\ntags: \[network\]\n---\n\n/u);
  assert.match(updated, /网络层 \[\[TreeTalk\/[^|]+\|三次握手\]\]/u);
  assert.doesNotMatch(updated, /treetalk_note_id|treetalk-|TREETALK_ARCHIVE/u);
});

void test("knowledge capture no longer ships archive repair or restoration modules", () => {
  const removed = [
    "src/knowledge/archive-repair.ts",
    "src/knowledge/archive-restore.ts",
    "src/knowledge/tree-archive-index.ts",
    "src/knowledge/nodeized-tree-archive.ts"
  ];
  for (const relative of removed) assert.equal(fs.existsSync(path.join(root, relative)), false);
});
