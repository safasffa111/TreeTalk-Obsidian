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
      esModuleInterop: true,
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

function note(id, index, depth, rootNote = false) {
  const headings = Array.from({ length: 9 }, (_, headingIndex) =>
    `${headingIndex < 7 ? "##" : "###"} H${index}-${headingIndex + 1}\n\nBODY-${index}-${headingIndex + 1}`
  ).join("\n\n");
  return {
    id,
    filePath: `Notes/Note-${index}.md`,
    fileName: `Note-${index}.md`,
    content: `# Note ${index}\n\n${headings}\n\n## 结论\n\nSECRET_CONCLUSION_${index}_${"X".repeat(900)}`,
    contentHash: `hash-${id}`,
    depth,
    root: rootNote,
    ...(rootNote ? {} : { primaryParentId: depth === 1 ? "root" : `n${index - 1}` }),
    primaryChain: rootNote ? [id] : ["root", id],
    parentIds: [],
    outgoingNodeIds: []
  };
}

function graph(count = 19) {
  const nodes = [note("root", 0, 0, true)];
  for (let index = 1; index < count; index += 1) nodes.push(note(`n${index}`, index, index === 1 ? 1 : 2));
  const edges = nodes.slice(1).map((node, index) => ({
    sourceNodeId: index === 0 ? "root" : `n${index}`,
    targetNodeId: node.id,
    labels: [`REL-${index + 1}`]
  }));
  return {
    protocol: "note-context-graph:v1",
    rootNodeIds: ["root"],
    fullNoteContext: true,
    relatedNotesEnabled: true,
    perNoteBudget: "full",
    maxDepth: 3,
    builtAt: "2026-08-05T00:00:00.000Z",
    nodes,
    edges,
    unresolvedLinks: []
  };
}

const conversationNodes = [
  {
    id: "node-root",
    parentId: null,
    title: "Root node",
    depth: 0,
    root: true,
    current: false,
    messages: [
      { id: "q1", role: "user", content: "Earlier question", status: "complete", selectionQuotes: [] },
      { id: "a1", role: "assistant", content: `## 结论\n\nPRIVATE_NODE_CONCLUSION_${"Y".repeat(900)}`, status: "complete", selectionQuotes: [] }
    ]
  },
  {
    id: "node-current",
    parentId: "node-root",
    title: "Current node",
    depth: 1,
    root: false,
    current: true,
    messages: [
      { id: "q2", role: "user", content: "CURRENT QUESTION", status: "complete", selectionQuotes: [] }
    ]
  }
];

function request() {
  return {
    conversationId: "c",
    nodeId: "node-current",
    assistantMessageId: "assistant",
    contextMessages: [{ role: "system", content: "TREE SYSTEM" }],
    piContext: {
      currentQuestion: "请解释 H0-1，并判断是否需要其他笔记。",
      selectedQuotes: ["H0-1"],
      conversationNodes,
      noteContextGraph: graph(),
      focus: {
        interactionMode: "child",
        defaultScope: "selection_only",
        anchors: [{
          id: "F1",
          kind: "note-selection",
          filePath: "Notes/Note-0.md",
          fileName: "Note-0.md",
          quote: "H0-1",
          prefix: "",
          suffix: "",
          defaultScope: "selection_only"
        }],
        targets: [{
          kind: "exact-selection",
          anchorId: "F1",
          text: "H0-1",
          source: { type: "note", filePath: "Notes/Note-0.md", fileName: "Note-0.md" }
        }]
      }
    },
    roleId: "direct",
    route: {
      routeId: "default",
      providerProfile: { id: "deepseek", name: "DeepSeek", kind: "deepseek", apiKey: "secret", baseUrl: "" },
      modelId: "deepseek-test"
    },
    webSearchEnabled: false
  };
}

test("selector note catalog keeps stable ID, title, depth, focus relation, and at most six H1/H2 headings", () => {
  const { PiContextWorkspace } = load("src/agent/pi/context-workspace.js");
  const workspace = new PiContextWorkspace(graph(), conversationNodes);
  const snapshot = workspace.catalogSnapshot({ queryText: "H0-1" });
  const rootId = workspace.compactNoteId("root");
  assert.match(snapshot.stableMarkdown, new RegExp(`## ${rootId} · Note-0\\.md`, "u"));
  assert.match(snapshot.stableMarkdown, /- 深度：0/u);
  assert.match(snapshot.stableMarkdown, /- 与焦点关系：用户框选源笔记/u);
  const rootBlock = snapshot.stableMarkdown.split(`## ${rootId} · Note-0.md`)[1].split(/\n## /u)[0];
  const headingLine = rootBlock.split("\n").find((line) => line.startsWith("- 一级\/二级标题："));
  assert.ok(headingLine);
  assert.equal(headingLine.split("；").length, 6);
  assert.doesNotMatch(headingLine, /H0-7|H0-8|H0-9/u);
  assert.doesNotMatch(snapshot.stableMarkdown, /SECRET_CONCLUSION|Stable Note Relationships/u);
  assert.match(snapshot.stableMarkdown, /- 与焦点关系：.*REL-1/u);
});

test("selector prompt stays within its configured budget for nineteen long candidate notes", () => {
  const { PiContextWorkspace } = load("src/agent/pi/context-workspace.js");
  const { buildPiSelectorPrompt } = load("src/agent/pi/two-pass-prompts.js");
  const workspace = new PiContextWorkspace(graph(), conversationNodes);
  const prompt = buildPiSelectorPrompt(request(), workspace.catalogSnapshot({ queryText: "H0-1" }), { tokenBudget: 2000 });
  assert.ok(prompt.tokenBreakdown);
  assert.ok(prompt.tokenBreakdown.total <= 2000, JSON.stringify(prompt.tokenBreakdown));
  assert.ok(prompt.tokenBreakdown.noteCatalog > 0);
  assert.ok(prompt.tokenBreakdown.localFocus > 0);
  assert.ok(prompt.tokenBreakdown.currentRequest > 0);
  assert.equal(prompt.tokenBreakdown.detailedNoteCount, 8);
  assert.equal(prompt.tokenBreakdown.compactNoteCount, 11);
  assert.equal(prompt.tokenBreakdown.omittedNoteCount, 0);
  assert.doesNotMatch(prompt.userPrompt, /SECRET_CONCLUSION|PRIVATE_NODE_CONCLUSION/u);
  assert.match(prompt.userPrompt, /H0-1/u);
});

test("selector stage diagnostics persist and display the catalog token breakdown", () => {
  const { createAgentRunRecord, applyAgentRunEvent } = load("src/domain/agent-run.js");
  const { agentExecutionViewModel } = load("src/agent/ui/execution-view-model.js");
  let record = createAgentRunRecord({
    executionMode: "pi",
    roleId: "direct",
    routeId: "default",
    providerId: "deepseek",
    modelId: "deepseek-test",
    startedAt: "2026-08-05T00:00:00.000Z"
  });
  record = applyAgentRunEvent(record, {
    type: "stage-start",
    stageId: "pi-context-selector",
    roleId: "direct",
    routeId: "default",
    startedAt: "2026-08-05T00:00:00.000Z"
  });
  record = applyAgentRunEvent(record, {
    type: "stage-usage",
    stageId: "pi-context-selector",
    selectorTokenBreakdown: {
      systemPrompt: 250,
      noteCatalog: 620,
      conversationBranch: 120,
      localFocus: 310,
      currentRequest: 80,
      outputContract: 100,
      total: 1480,
      budget: 2000,
      detailedNoteCount: 8,
      compactNoteCount: 11,
      omittedNoteCount: 0
    }
  });
  const rows = new Map(agentExecutionViewModel(record).rows);
  assert.equal(rows.get("索引 · 上下文选择"), "目录 620 / 分支 120 / 焦点 310 / 问题 80 / 协议 100");
  assert.equal(rows.get("预算 · 上下文选择"), "1,480 / 2,000（详细 8 / 紧凑 11 / 省略 0）");
});
