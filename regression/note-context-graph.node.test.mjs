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

const NOW = "2026-08-03T00:00:00.000Z";

void test("note context settings migrate safely and preserve unlimited depth", () => {
  const { DEFAULT_SETTINGS, parsePluginData } = load("src/tabs/plugin-data.js");
  const legacy = parsePluginData({ settings: { ...DEFAULT_SETTINGS } });
  assert.equal(legacy.settings.fullNoteContext, true);
  assert.equal(legacy.settings.noteContextTokenBudget, "full");
  assert.equal(legacy.settings.lastCompressedNoteTokenBudget, 512);
  assert.equal(legacy.settings.relatedNoteContextEnabled, false);
  assert.equal(legacy.settings.relatedNoteDepth, 1);

  const configured = parsePluginData({
    settings: {
      ...DEFAULT_SETTINGS,
      fullNoteContext: false,
      noteContextTokenBudget: "minimal",
      lastCompressedNoteTokenBudget: "minimal",
      relatedNoteContextEnabled: true,
      relatedNoteDepth: "unlimited"
    }
  });
  assert.equal(configured.settings.fullNoteContext, true);
  assert.equal(configured.settings.noteContextTokenBudget, "full");
  assert.equal(configured.settings.relatedNoteContextEnabled, true);
  assert.equal(configured.settings.relatedNoteDepth, "unlimited");
});

void test("forward-link extraction happens on raw Markdown and ignores external/code links", () => {
  const { extractForwardNoteLinks } = load("src/domain/note-link-graph.js");
  const links = extractForwardNoteLinks([
    "[[B|B 别名]] [[C#章节]] ![[D.md]]",
    "[E 标题](../E.md#小节)",
    "[网页](https://example.com) [同页](#标题)",
    "`[[InlineCode]]`",
    "```md",
    "[[FenceCode]]",
    "```"
  ].join("\n"));
  assert.deepEqual(
    links.map((entry) => ({ target: entry.target, label: entry.label })),
    [
      { target: "B", label: "B 别名" },
      { target: "C", label: "C" },
      { target: "D.md", label: "D.md" },
      { target: "../E.md", label: "E 标题" }
    ]
  );
});

void test("unlimited traversal preserves cycles and converging paths without duplicate nodes", async () => {
  const { buildNoteLinkGraph } = load("src/domain/note-link-graph.js");
  const files = new Map([
    ["A.md", "# A\n\n[[B]] and [[C]]"],
    ["B.md", "# B\n\n缓存 缓存 索引\n\n[[D]]"],
    ["C.md", "# C\n\n上下文 上下文\n\n[[D]]"],
    ["D.md", "# D\n\n最终节点\n\n[[A]]"]
  ]);
  const resolvePath = (target, sourcePath) => {
    const directory = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/") + 1) : "";
    const normalized = target.endsWith(".md") ? target : `${target}.md`;
    const candidate = path.posix.normalize(`${directory}${normalized}`);
    return files.has(candidate) ? { filePath: candidate, fileName: path.posix.basename(candidate) } : undefined;
  };
  const graph = await buildNoteLinkGraph({
    roots: [{ filePath: "A.md", fileName: "A.md", sourceText: files.get("A.md") }],
    relatedNotesEnabled: true,
    fullNoteContext: false,
    perNoteBudget: "minimal",
    maxDepth: "unlimited",
    builtAt: NOW,
    resolver: {
      resolveLink: resolvePath,
      readMarkdown: async (filePath) => ({
        filePath,
        fileName: path.posix.basename(filePath),
        sourceText: files.get(filePath)
      })
    }
  });

  assert.equal(graph.nodes.length, 4);
  assert.equal(graph.edges.length, 5);
  assert.deepEqual(graph.nodes.map((node) => node.filePath), ["A.md", "B.md", "C.md", "D.md"]);
  const d = graph.nodes.find((node) => node.filePath === "D.md");
  assert.ok(d);
  assert.equal(d.depth, 2);
  assert.deepEqual(d.parentIds, ["N1", "N2"]);
  assert.deepEqual(d.primaryChain, ["N0", "N1", "N3"]);
  const a = graph.nodes.find((node) => node.filePath === "A.md");
  assert.ok(a);
  assert.ok(a.parentIds.includes("N3"));
  assert.equal(graph.nodes.filter((node) => node.filePath === "D.md").length, 1);
});

void test("finite depth stops recursive reading after the requested level", async () => {
  const { buildNoteLinkGraph } = load("src/domain/note-link-graph.js");
  const files = new Map([
    ["A.md", "[[B]]"],
    ["B.md", "[[C]]"],
    ["C.md", "end"]
  ]);
  const read = [];
  const graph = await buildNoteLinkGraph({
    roots: [{ filePath: "A.md", fileName: "A.md", sourceText: "[[B]]" }],
    relatedNotesEnabled: true,
    fullNoteContext: true,
    perNoteBudget: "full",
    maxDepth: 1,
    builtAt: NOW,
    resolver: {
      resolveLink: (target) => {
        const filePath = target.endsWith(".md") ? target : `${target}.md`;
        return files.has(filePath) ? { filePath, fileName: filePath } : undefined;
      },
      readMarkdown: async (filePath) => {
        read.push(filePath);
        return { filePath, fileName: filePath, sourceText: files.get(filePath) };
      }
    }
  });
  assert.deepEqual(graph.nodes.map((node) => node.filePath), ["A.md", "B.md"]);
  assert.deepEqual(read, ["B.md"]);
});

void test("forward links and backlinks are traversed as equal related-note neighbors", async () => {
  const { buildNoteLinkGraph } = load("src/domain/note-link-graph.js");
  const { providerContentForMessage } = load("src/domain/context-engine.js");
  const files = new Map([
    ["A.md", "# A\n\n[[B]]"],
    ["B.md", "# B\n\n正向关联正文"],
    ["C.md", "# C\n\n反向关联正文\n\n[[A|指向 A]]"]
  ]);
  const graph = await buildNoteLinkGraph({
    roots: [{ filePath: "A.md", fileName: "A.md", sourceText: files.get("A.md") }],
    relatedNotesEnabled: true,
    fullNoteContext: true,
    perNoteBudget: "full",
    maxDepth: 1,
    builtAt: NOW,
    resolver: {
      resolveLink: (target) => {
        const filePath = target.endsWith(".md") ? target : `${target}.md`;
        return files.has(filePath) ? { filePath, fileName: filePath } : undefined;
      },
      findBacklinks: (filePath) => filePath === "A.md"
        ? [{ filePath: "C.md", fileName: "C.md" }]
        : [],
      readMarkdown: async (filePath) => ({
        filePath,
        fileName: filePath,
        sourceText: files.get(filePath)
      })
    }
  });

  assert.deepEqual(
    graph.nodes.map((node) => ({ path: node.filePath, depth: node.depth })),
    [
      { path: "A.md", depth: 0 },
      { path: "B.md", depth: 1 },
      { path: "C.md", depth: 1 }
    ]
  );
  assert.deepEqual(
    graph.edges.map((edge) => ({
      source: graph.nodes.find((node) => node.id === edge.sourceNodeId)?.filePath,
      target: graph.nodes.find((node) => node.id === edge.targetNodeId)?.filePath,
      labels: edge.labels
    })),
    [
      { source: "A.md", target: "B.md", labels: ["B"] },
      { source: "C.md", target: "A.md", labels: ["指向 A"] }
    ]
  );
  const providerContent = providerContentForMessage({
    id: "u-equal-links",
    role: "user",
    content: "结合关联笔记回答",
    status: "complete",
    noteContextGraph: graph,
    createdAt: NOW,
    updatedAt: NOW
  });
  assert.match(providerContent, /正向关联正文/u);
  assert.match(providerContent, /反向关联正文/u);
});

void test("backlinks recurse with the same depth rules and do not duplicate directed edges", async () => {
  const { buildNoteLinkGraph } = load("src/domain/note-link-graph.js");
  const files = new Map([
    ["A.md", "# A"],
    ["C.md", "# C\n\n[[A]]"],
    ["D.md", "# D\n\n[[C]]"]
  ]);
  const backlinks = new Map([
    ["A.md", [{ filePath: "C.md", fileName: "C.md" }]],
    ["C.md", [{ filePath: "D.md", fileName: "D.md" }]]
  ]);
  const graph = await buildNoteLinkGraph({
    roots: [{ filePath: "A.md", fileName: "A.md", sourceText: files.get("A.md") }],
    relatedNotesEnabled: true,
    fullNoteContext: false,
    perNoteBudget: "minimal",
    maxDepth: "unlimited",
    builtAt: NOW,
    resolver: {
      resolveLink: (target) => {
        const filePath = target.endsWith(".md") ? target : `${target}.md`;
        return files.has(filePath) ? { filePath, fileName: filePath } : undefined;
      },
      findBacklinks: (filePath) => backlinks.get(filePath) ?? [],
      readMarkdown: async (filePath) => ({
        filePath,
        fileName: filePath,
        sourceText: files.get(filePath)
      })
    }
  });

  assert.deepEqual(
    graph.nodes.map((node) => ({ path: node.filePath, depth: node.depth })),
    [
      { path: "A.md", depth: 0 },
      { path: "C.md", depth: 1 },
      { path: "D.md", depth: 2 }
    ]
  );
  assert.equal(graph.edges.filter((edge) => {
    const source = graph.nodes.find((node) => node.id === edge.sourceNodeId)?.filePath;
    const target = graph.nodes.find((node) => node.id === edge.targetNodeId)?.filePath;
    return source === "C.md" && target === "A.md";
  }).length, 1);
  assert.equal(graph.edges.filter((edge) => {
    const source = graph.nodes.find((node) => node.id === edge.sourceNodeId)?.filePath;
    const target = graph.nodes.find((node) => node.id === edge.targetNodeId)?.filePath;
    return source === "D.md" && target === "C.md";
  }).length, 1);
});

void test("graph snapshots survive schema parsing", async () => {
  const { buildNoteLinkGraph } = load("src/domain/note-link-graph.js");
  const { parseConversation } = load("src/domain/schema.js");
  const { validConversation } = load("tests/fixtures.js");
  const graph = await buildNoteLinkGraph({
    roots: [{ filePath: "A.md", fileName: "A.md", sourceText: "# A" }],
    relatedNotesEnabled: false,
    fullNoteContext: false,
    perNoteBudget: "minimal",
    maxDepth: "unlimited",
    builtAt: NOW,
    resolver: {
      resolveLink: () => undefined,
      readMarkdown: async () => { throw new Error("not called"); }
    }
  });
  const conversation = validConversation();
  conversation.nodes.root.messages = [{
    id: "u1",
    role: "user",
    content: "问题",
    status: "complete",
    noteContextGraph: graph,
    createdAt: NOW,
    updatedAt: NOW
  }];
  const parsed = parseConversation(conversation);
  assert.deepEqual(parsed.nodes.root.messages[0].noteContextGraph, graph);
});

void test("minimal graph context sends structure once and preserves the exact root quote", async () => {
  const { buildNoteLinkGraph } = load("src/domain/note-link-graph.js");
  const { providerContentForMessage } = load("src/domain/context-engine.js");
  const rootText = "# A\n\n前文\n\n精确框选原文\n\n[[B]]";
  const start = rootText.indexOf("精确框选原文");
  const graph = await buildNoteLinkGraph({
    roots: [{ filePath: "A.md", fileName: "A.md", sourceText: rootText }],
    relatedNotesEnabled: true,
    fullNoteContext: false,
    perNoteBudget: "minimal",
    maxDepth: "unlimited",
    builtAt: NOW,
    resolver: {
      resolveLink: (target) => target === "B" ? { filePath: "B.md", fileName: "B.md" } : undefined,
      readMarkdown: async () => ({
        filePath: "B.md",
        fileName: "B.md",
        sourceText: "# B\n\n缓存 缓存 缓存 索引\n\n秘密正文不应在最小限度出现"
      })
    }
  });
  const content = providerContentForMessage({
    id: "u1",
    role: "user",
    content: "解释它",
    status: "complete",
    noteContextGraph: graph,
    selectionContexts: [{
      sourceType: "note",
      filePath: "A.md",
      fileName: "A.md",
      basis: "note-source-v1",
      startOffset: start,
      endOffset: start + "精确框选原文".length,
      quote: "精确框选原文",
      prefix: "",
      suffix: "",
      contentHash: "root-visible-hash",
      snapshot: {
        version: "note-snapshot-v1",
        content: rootText,
        contentHash: graph.nodes[0].contentHash,
        selectionStartOffset: start,
        selectionEndOffset: start + "精确框选原文".length
      }
    }],
    createdAt: NOW,
    updatedAt: NOW
  });
  assert.match(content, /\[TreeTalk 关联笔记图\]/u);
  assert.match(content, /N0 → N1/u);
  assert.equal((content.match(/\[关联笔记节点 N1\]/gu) ?? []).length, 1);
  assert.match(content, /精确框选原文/u);
  assert.match(content, /关键词：缓存/u);
  assert.doesNotMatch(content, /秘密正文不应在最小限度出现/u);
});

void test("Obsidian resolver accepts only Markdown files and reads cached source", async () => {
  const { ObsidianNoteLinkResolver } = load("src/storage/obsidian-note-link-resolver.js");
  const markdownFile = { path: "notes/B.md", name: "B.md", extension: "md" };
  const imageFile = { path: "assets/x.png", name: "x.png", extension: "png" };
  const cache = {
    getFirstLinkpathDest: (target) => target === "B" ? markdownFile : target === "x" ? imageFile : null,
    resolvedLinks: {
      "A.md": { "notes/B.md": 1 },
      "notes/C.md": { "notes/B.md": 2 },
      "assets/x.png": { "notes/B.md": 1 }
    }
  };
  const backlinkFile = { path: "notes/C.md", name: "C.md", extension: "md" };
  const vault = {
    getAbstractFileByPath: (filePath) => filePath === markdownFile.path
      ? markdownFile
      : filePath === backlinkFile.path
        ? backlinkFile
        : null,
    cachedRead: async (file) => file === markdownFile ? "# B\n\n正文" : ""
  };
  const resolver = new ObsidianNoteLinkResolver(vault, cache);
  assert.deepEqual(resolver.resolveLink("B", "A.md"), {
    filePath: "notes/B.md",
    fileName: "B.md"
  });
  assert.equal(resolver.resolveLink("x", "A.md"), undefined);
  assert.deepEqual(resolver.findBacklinks("notes/B.md"), [
    { filePath: "notes/C.md", fileName: "C.md" }
  ]);
  assert.deepEqual(await resolver.readMarkdown("notes/B.md"), {
    filePath: "notes/B.md",
    fileName: "B.md",
    sourceText: "# B\n\n正文"
  });
});

void test("frozen note graph attaches to the submitted user message immutably", async () => {
  const { buildNoteLinkGraph } = load("src/domain/note-link-graph.js");
  const { attachNoteContextGraphToMessage, continueNode } = load("src/domain/tree-commands.js");
  const { validConversation } = load("tests/fixtures.js");
  const before = validConversation();
  const submitted = continueNode(before, {
    nodeId: "root",
    text: "问题",
    messageId: "u-graph",
    now: NOW
  }).state;
  const graph = await buildNoteLinkGraph({
    roots: [{ filePath: "A.md", fileName: "A.md", sourceText: "# A" }],
    relatedNotesEnabled: false,
    fullNoteContext: true,
    perNoteBudget: "full",
    maxDepth: 1,
    builtAt: NOW,
    resolver: {
      resolveLink: () => undefined,
      readMarkdown: async () => { throw new Error("not called"); }
    }
  });
  const frozen = attachNoteContextGraphToMessage(
    submitted,
    "root",
    "u-graph",
    graph,
    "2026-08-03T00:00:01.000Z"
  );
  assert.equal(submitted.nodes.root.messages.at(-1).noteContextGraph, undefined);
  assert.deepEqual(frozen.nodes.root.messages.at(-1).noteContextGraph, graph);
  assert.equal(frozen.revision, submitted.revision + 1);
});

void test("send-time freeze builds from selected note snapshots before provider compilation", async () => {
  const { freezeNoteContextForMessage } = load("src/domain/note-context-freeze.js");
  const { continueNode } = load("src/domain/tree-commands.js");
  const { validConversation } = load("tests/fixtures.js");
  const before = validConversation();
  const selected = "# A\n\n框选内容\n\n[[B]]";
  const start = selected.indexOf("框选内容");
  const submitted = continueNode(before, {
    nodeId: "root",
    text: "问题",
    messageId: "u-freeze",
    now: NOW,
    selectionContexts: [{
      sourceType: "note",
      filePath: "A.md",
      fileName: "A.md",
      basis: "note-source-v1",
      startOffset: start,
      endOffset: start + 4,
      quote: "框选内容",
      prefix: "",
      suffix: "",
      contentHash: "visible",
      snapshot: {
        version: "note-snapshot-v1",
        content: selected,
        contentHash: "snapshot-hash",
        selectionStartOffset: start,
        selectionEndOffset: start + 4
      }
    }]
  }).state;
  const result = await freezeNoteContextForMessage(submitted, {
    nodeId: "root",
    messageId: "u-freeze",
    builtAt: NOW,
    fullNoteContext: false,
    perNoteBudget: 256,
    relatedNotesEnabled: true,
    maxDepth: "unlimited",
    resolver: {
      resolveLink: (target) => target === "B" ? { filePath: "B.md", fileName: "B.md" } : undefined,
      readMarkdown: async () => ({ filePath: "B.md", fileName: "B.md", sourceText: "# B" })
    }
  });
  assert.equal(result.frozen, true);
  assert.deepEqual(
    result.state.nodes.root.messages.at(-1).noteContextGraph.nodes.map((node) => node.filePath),
    ["A.md", "B.md"]
  );
});


void test("send-time freeze accepts backlinks whose real edge points toward the selected root", async () => {
  const { freezeNoteContextForMessage } = load("src/domain/note-context-freeze.js");
  const { continueNode } = load("src/domain/tree-commands.js");
  const { validConversation } = load("tests/fixtures.js");
  const before = validConversation();
  const selected = "# A\n\n框选内容";
  const start = selected.indexOf("框选内容");
  const submitted = continueNode(before, {
    nodeId: "root",
    text: "问题",
    messageId: "u-backlink-freeze",
    now: NOW,
    selectionContexts: [{
      sourceType: "note",
      filePath: "A.md",
      fileName: "A.md",
      basis: "note-source-v1",
      startOffset: start,
      endOffset: start + 4,
      quote: "框选内容",
      prefix: "",
      suffix: "",
      contentHash: "visible",
      snapshot: {
        version: "note-snapshot-v1",
        content: selected,
        contentHash: "snapshot-hash",
        selectionStartOffset: start,
        selectionEndOffset: start + 4
      }
    }]
  }).state;
  const result = await freezeNoteContextForMessage(submitted, {
    nodeId: "root",
    messageId: "u-backlink-freeze",
    builtAt: NOW,
    fullNoteContext: false,
    perNoteBudget: 256,
    relatedNotesEnabled: true,
    maxDepth: 1,
    resolver: {
      resolveLink: (target, sourcePath) =>
        target === "A" && sourcePath === "C.md"
          ? { filePath: "A.md", fileName: "A.md" }
          : undefined,
      findBacklinks: (filePath) =>
        filePath === "A.md" ? [{ filePath: "C.md", fileName: "C.md" }] : [],
      readMarkdown: async (filePath) => ({
        filePath,
        fileName: filePath,
        sourceText: filePath === "C.md" ? "# C\n\n[[A]]" : selected
      })
    }
  });
  const graph = result.state.nodes.root.messages.at(-1).noteContextGraph;
  assert.equal(result.frozen, true);
  assert.deepEqual(graph.nodes.map((node) => node.filePath), ["A.md", "C.md"]);
  assert.deepEqual(graph.edges.map((edge) => [edge.sourceNodeId, edge.targetNodeId]), [["N1", "N0"]]);
  const { buildRelationshipGraph } = load("src/relationship-graph/model.js");
  const relationship = buildRelationshipGraph(result.state);
  assert.deepEqual(
    relationship.nodes
      .filter((node) => node.kind === "note")
      .map((node) => node.filePath)
      .sort(),
    ["A.md", "C.md"]
  );
});

void test("main persists frozen note graphs before compiling provider context", () => {
  const source = fs.readFileSync(path.join(root, "src/main.ts"), "utf8");
  const freezeIndex = source.indexOf("const frozenNoteContext = await freezeNoteContextForMessage");
  const persistIndex = source.indexOf("await this.persistence.flush", freezeIndex);
  const compileIndex = source.indexOf("contextPlan = compileContextPlan", freezeIndex);
  assert.ok(freezeIndex >= 0);
  assert.ok(persistIndex > freezeIndex);
  assert.ok(compileIndex > persistIndex);
});

void test("settings UI fixes full note bodies and keeps related-note depth controls", () => {
  const source = fs.readFileSync(path.join(root, "src/main.ts"), "utf8");
  assert.doesNotMatch(source, /\.setName\("完整笔记上下文"\)/u);
  assert.doesNotMatch(source, /\.setName\("单篇笔记上下文上限"\)/u);
  assert.match(source, /\.setName\("关联笔记上下文"\)/u);
  assert.match(source, /\.setName\("关联笔记深度"\)/u);
  assert.match(source, /unlimited:\s*"无限"/u);
  assert.match(source, /inputEl\.min\s*=\s*"1"/u);
  assert.match(source, /正向和反向内部链接/u);
});

void test("full related-note bodies are admitted atomically under the model-wide token limit", async () => {
  const { buildNoteLinkGraph } = load("src/domain/note-link-graph.js");
  const { compileContextPlan } = load("src/domain/context-engine.js");
  const { validConversation } = load("tests/fixtures.js");
  const rootText = "# A\n\n必须完整保留的框选原文\n\n[[B]]\n[[C]]";
  const selectionStart = rootText.indexOf("必须完整保留的框选原文");
  const files = new Map([
    ["B.md", `# B\n\n${"乙节点完整正文".repeat(120)}\n\nB_UNIQUE_TAIL`],
    ["C.md", `# C\n\n${"丙节点完整正文".repeat(120)}\n\nC_UNIQUE_TAIL`]
  ]);
  const graph = await buildNoteLinkGraph({
    roots: [{ filePath: "A.md", fileName: "A.md", sourceText: rootText }],
    relatedNotesEnabled: true,
    fullNoteContext: true,
    perNoteBudget: "full",
    maxDepth: "unlimited",
    builtAt: NOW,
    resolver: {
      resolveLink: (target) => files.has(`${target}.md`)
        ? { filePath: `${target}.md`, fileName: `${target}.md` }
        : undefined,
      readMarkdown: async (filePath) => ({
        filePath,
        fileName: filePath,
        sourceText: files.get(filePath)
      })
    }
  });
  const conversation = validConversation();
  conversation.currentNodeId = "root";
  conversation.nodes.root.childIds = [];
  conversation.nodes.root.messages = [{
    id: "u-budget-full",
    role: "user",
    content: "请结合关联图解释",
    status: "complete",
    noteContextGraph: graph,
    selectionContexts: [{
      sourceType: "note",
      filePath: "A.md",
      fileName: "A.md",
      basis: "note-source-v1",
      startOffset: selectionStart,
      endOffset: selectionStart + "必须完整保留的框选原文".length,
      quote: "必须完整保留的框选原文",
      prefix: "",
      suffix: "",
      contentHash: "visible",
      snapshot: {
        version: "note-snapshot-v1",
        content: rootText,
        contentHash: graph.nodes[0].contentHash,
        selectionStartOffset: selectionStart,
        selectionEndOffset: selectionStart + "必须完整保留的框选原文".length
      }
    }],
    createdAt: NOW,
    updatedAt: NOW
  }];

  const maxInputTokens = 520;
  const plan = compileContextPlan(conversation, "root", {
    mode: "full",
    systemPrompt: "system",
    maxInputTokens
  });
  const output = plan.messages.map((message) => message.content).join("\n");

  assert.ok(plan.sentEstimatedTokens <= maxInputTokens);
  assert.match(output, /必须完整保留的框选原文/u);
  assert.match(output, /N0 → N1/u);
  assert.match(output, /正文因模型总上下文上限未发送/u);
  assert.ok(!output.includes("B_UNIQUE_TAIL") || output.includes(files.get("B.md")));
  assert.ok(!output.includes("C_UNIQUE_TAIL") || output.includes(files.get("C.md")));
  assert.deepEqual(plan.referencedNoteNames.sort(), ["A.md", "B.md", "C.md"]);
});

void test("compressed related notes downgrade distant nodes before exceeding the model-wide token limit", async () => {
  const { buildNoteLinkGraph } = load("src/domain/note-link-graph.js");
  const { compileContextPlan } = load("src/domain/context-engine.js");
  const { validConversation } = load("tests/fixtures.js");
  const rootText = "# A\n\n核心框选\n\n[[B]]";
  const files = new Map([
    ["B.md", `# B\n\n缓存 缓存 ${"B段正文".repeat(150)}\n\n[[C]]\nB_COMPRESSED_TAIL`],
    ["C.md", `# C\n\n索引 索引 ${"C段正文".repeat(150)}\n\n[[D]]\nC_COMPRESSED_TAIL`],
    ["D.md", `# D\n\n关系 关系 ${"D段正文".repeat(150)}\nD_COMPRESSED_TAIL`]
  ]);
  const graph = await buildNoteLinkGraph({
    roots: [{ filePath: "A.md", fileName: "A.md", sourceText: rootText }],
    relatedNotesEnabled: true,
    fullNoteContext: false,
    perNoteBudget: 400,
    maxDepth: "unlimited",
    builtAt: NOW,
    resolver: {
      resolveLink: (target) => files.has(`${target}.md`)
        ? { filePath: `${target}.md`, fileName: `${target}.md` }
        : undefined,
      readMarkdown: async (filePath) => ({ filePath, fileName: filePath, sourceText: files.get(filePath) })
    }
  });
  const conversation = validConversation();
  conversation.currentNodeId = "root";
  conversation.nodes.root.childIds = [];
  conversation.nodes.root.messages = [{
    id: "u-budget-compressed",
    role: "user",
    content: "解释",
    status: "complete",
    noteContextGraph: graph,
    selectionContexts: [{
      sourceType: "note",
      filePath: "A.md",
      fileName: "A.md",
      basis: "note-source-v1",
      startOffset: rootText.indexOf("核心框选"),
      endOffset: rootText.indexOf("核心框选") + 4,
      quote: "核心框选",
      prefix: "",
      suffix: "",
      contentHash: "visible",
      snapshot: {
        version: "note-snapshot-v1",
        content: rootText,
        contentHash: graph.nodes[0].contentHash,
        selectionStartOffset: rootText.indexOf("核心框选"),
        selectionEndOffset: rootText.indexOf("核心框选") + 4
      }
    }],
    createdAt: NOW,
    updatedAt: NOW
  }];

  const maxInputTokens = 440;
  const plan = compileContextPlan(conversation, "root", {
    mode: "full",
    systemPrompt: "",
    maxInputTokens
  });
  const output = plan.messages.map((message) => message.content).join("\n");

  assert.ok(plan.sentEstimatedTokens <= maxInputTokens);
  assert.match(output, /核心框选/u);
  assert.match(output, /N2 → N3/u);
  assert.match(output, /正文因模型总上下文上限未发送|关键词：/u);
  assert.doesNotMatch(output, /D_COMPRESSED_TAIL/u);
});

void test("balanced mode preserves the frozen related-note graph and applies the same atomic body budget", async () => {
  const { buildNoteLinkGraph } = load("src/domain/note-link-graph.js");
  const { compileContextPlan } = load("src/domain/context-engine.js");
  const { validConversation } = load("tests/fixtures.js");
  const rootText = "# A\n\n平衡模式框选\n\n[[B]]";
  const start = rootText.indexOf("平衡模式框选");
  const relatedText = `# B\n\n${"平衡模式关联正文".repeat(180)}\nBALANCED_UNIQUE_TAIL`;
  const graph = await buildNoteLinkGraph({
    roots: [{ filePath: "A.md", fileName: "A.md", sourceText: rootText }],
    relatedNotesEnabled: true,
    fullNoteContext: true,
    perNoteBudget: "full",
    maxDepth: "unlimited",
    builtAt: NOW,
    resolver: {
      resolveLink: (target) => target === "B"
        ? { filePath: "B.md", fileName: "B.md" }
        : undefined,
      readMarkdown: async () => ({ filePath: "B.md", fileName: "B.md", sourceText: relatedText })
    }
  });
  const conversation = validConversation();
  conversation.currentNodeId = "root";
  conversation.nodes.root.childIds = [];
  conversation.nodes.root.messages = [{
    id: "u-balanced-graph",
    role: "user",
    content: "回答",
    status: "complete",
    noteContextGraph: graph,
    selectionContexts: [{
      sourceType: "note",
      filePath: "A.md",
      fileName: "A.md",
      basis: "note-source-v1",
      startOffset: start,
      endOffset: start + "平衡模式框选".length,
      quote: "平衡模式框选",
      prefix: "",
      suffix: "",
      contentHash: "visible",
      snapshot: {
        version: "note-snapshot-v1",
        content: rootText,
        contentHash: graph.nodes[0].contentHash,
        selectionStartOffset: start,
        selectionEndOffset: start + "平衡模式框选".length
      }
    }],
    createdAt: NOW,
    updatedAt: NOW
  }];

  const maxInputTokens = 500;
  const plan = compileContextPlan(conversation, "root", {
    mode: "balanced",
    systemPrompt: "",
    maxInputTokens
  });
  const output = plan.messages.map((message) => message.content).join("\n");

  assert.ok(plan.sentEstimatedTokens <= maxInputTokens);
  assert.match(output, /\[TreeTalk 关联笔记图\]/u);
  assert.match(output, /平衡模式框选/u);
  assert.match(output, /正文因模型总上下文上限未发送/u);
  assert.doesNotMatch(output, /BALANCED_UNIQUE_TAIL/u);
});

