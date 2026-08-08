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

function message(id, role, content, selectionContexts = undefined) {
  return {
    id,
    role,
    content,
    status: "complete",
    ...(selectionContexts === undefined ? {} : { selectionContexts }),
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z"
  };
}

function node(id, parentId, title, messages) {
  return {
    id,
    parentId,
    childIds: [],
    title,
    titleSource: "question",
    messages,
    draft: { text: "", mode: "continue", selectionContexts: [] },
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z"
  };
}

const noteContent = [
  "# 高斯公式",
  "",
  "导言内容",
  "",
  "## 定义",
  "",
  "DEFINITION_ONLY",
  "",
  "## 推导",
  "",
  "推导前文 SELECTED_TERM 推导后文",
  "",
  "PROOF_BODY",
  "",
  "### 推导细节",
  "",
  "DETAIL_BODY",
  "",
  "## 应用",
  "",
  "APPLICATION_ONLY"
].join("\n");
const selectionStart = noteContent.indexOf("SELECTED_TERM");
const selectionEnd = selectionStart + "SELECTED_TERM".length;

function noteSelection() {
  return {
    sourceType: "note",
    filePath: "Math/Gauss.md",
    fileName: "Gauss.md",
    basis: "note-source-v1",
    startOffset: selectionStart,
    endOffset: selectionEnd,
    quote: "SELECTED_TERM",
    prefix: "推导前文 ",
    suffix: " 推导后文",
    contentHash: "note-hash",
    snapshot: {
      version: "note-snapshot-v1",
      content: noteContent,
      contentHash: "note-hash",
      selectionStartOffset: selectionStart,
      selectionEndOffset: selectionEnd
    }
  };
}

function conversation() {
  const parent = node("gauss", null, "高斯公式", [
    message("parent-q", "user", "什么是高斯公式"),
    message("parent-a", "assistant", "PARENT_ROUND")
  ]);
  const child = node("child", "gauss", "追问", [
    message("child-q", "user", "这里为什么成立", [noteSelection()])
  ]);
  parent.childIds = ["child"];
  return {
    schemaVersion: 1,
    id: "conversation",
    title: "Math",
    status: "active",
    revision: 1,
    checksum: "",
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z",
    rootNodeId: "gauss",
    currentNodeId: "child",
    nodes: { gauss: parent, child },
    ui: { expandedNodeIds: [], treeScrollTop: 0, messageScrollTopByNode: {} }
  };
}

function graph() {
  return {
    protocol: "note-context-graph:v1",
    rootNodeIds: ["root-note"],
    fullNoteContext: true,
    relatedNotesEnabled: true,
    perNoteBudget: "full",
    maxDepth: 2,
    builtAt: "2026-08-05T00:00:00.000Z",
    nodes: [
      {
        id: "root-note",
        filePath: "Math/Gauss.md",
        fileName: "Gauss.md",
        content: noteContent,
        contentHash: "note-hash",
        depth: 0,
        root: true,
        primaryChain: ["root-note"],
        parentIds: [],
        outgoingNodeIds: ["related-note"]
      },
      {
        id: "related-note",
        filePath: "Math/Divergence.md",
        fileName: "Divergence.md",
        content: "# 散度定理\n\n## 定义\n\nRELATED_DEFINITION\n\n## 证明\n\nRELATED_PROOF",
        contentHash: "related-hash",
        depth: 1,
        root: false,
        primaryParentId: "root-note",
        primaryChain: ["root-note", "related-note"],
        parentIds: ["root-note"],
        outgoingNodeIds: []
      }
    ],
    edges: [{ sourceNodeId: "root-note", targetNodeId: "related-note", labels: ["散度定理"] }],
    unresolvedLinks: []
  };
}

function piNodes() {
  return [{
    id: "gauss",
    parentId: null,
    title: "高斯公式",
    depth: 0,
    root: true,
    current: true,
    messages: [
      { id: "parent-q", role: "user", content: "什么是高斯公式", status: "complete", selectionQuotes: [] },
      { id: "parent-a", role: "assistant", content: "PARENT_ROUND", status: "complete", selectionQuotes: [] }
    ]
  }];
}

test("focus builder assigns stable IDs, per-anchor defaults, and frozen note offsets", () => {
  const { buildPiFocusContext } = load("src/agent/pi/focus-context.js");
  const focus = buildPiFocusContext(conversation(), {
    kind: "create-child",
    childId: "child",
    parentId: "gauss",
    previousDraft: { text: "", mode: "child", selectionContexts: [] },
    previousChildIds: [],
    previousCurrentNodeId: "gauss",
    appliedRevision: 1
  }, "child-q");

  assert.equal(focus.anchors[0].id, "F1");
  assert.equal(focus.anchors[0].defaultScope, "selection_only");
  assert.equal(focus.anchors[0].selectionStartOffset, selectionStart);
  assert.equal(focus.anchors[0].selectionEndOffset, selectionEnd);
  assert.equal(focus.anchors[1].id, "F2");
  assert.equal(focus.anchors[1].defaultScope, "latest_round");
});

test("selector parses independent focus decisions and preserves legacy global scope", () => {
  const { parsePiContextSelection } = load("src/agent/pi/context-selection.js");
  const selected = parsePiContextSelection(JSON.stringify({
    focus: [
      { id: "F1", scope: "containing_section", reason: "needs the selected derivation section" },
      { id: "F2", scope: "latest_round", reason: "keeps the parent target" }
    ],
    notes: [],
    nodes: []
  }), "latest_round");
  assert.deepEqual(selected.focusDecisions, [
    { anchorId: "F1", scope: "containing_section", reason: "needs the selected derivation section" },
    { anchorId: "F2", scope: "latest_round", reason: "keeps the parent target" }
  ]);

  const legacy = parsePiContextSelection(JSON.stringify({
    focus: { scope: "full_source", reason: "legacy response" },
    notes: [],
    nodes: []
  }), "latest_round");
  assert.equal(legacy.focusScope, "full_source");
  assert.deepEqual(legacy.focusDecisions, []);
});

test("focus evidence reads the containing note section while keeping only the parent latest round", () => {
  const { PiContextWorkspace } = load("src/agent/pi/context-workspace.js");
  const { materializePiFocusEvidence } = load("src/agent/pi/focus-evidence.js");
  const { buildPiFocusContext } = load("src/agent/pi/focus-context.js");
  const focus = buildPiFocusContext(conversation(), {
    kind: "create-child",
    childId: "child",
    parentId: "gauss",
    previousDraft: { text: "", mode: "child", selectionContexts: [] },
    previousChildIds: [],
    previousCurrentNodeId: "gauss",
    appliedRevision: 1
  }, "child-q");
  const workspace = new PiContextWorkspace(graph(), piNodes());
  const evidence = materializePiFocusEvidence(workspace, focus, [
    { anchorId: "F1", scope: "containing_section", reason: "needs local derivation" },
    { anchorId: "F2", scope: "latest_round", reason: "keeps parent context" }
  ], { tokenBudget: 2_000 });

  assert.match(evidence.markdown, /> SELECTED_TERM/u);
  assert.match(evidence.markdown, /PROOF_BODY|DETAIL_BODY/u);
  assert.match(evidence.markdown, /PARENT_ROUND/u);
  assert.doesNotMatch(evidence.markdown, /DEFINITION_ONLY/u);
  assert.doesNotMatch(evidence.markdown, /APPLICATION_ONLY/u);
  assert.ok(evidence.materializedKeys.some((key) => key.includes(":section:推导")));
});

test("selector prompt exposes root focus identity, per-focus scopes, and optional linked notes", () => {
  const { buildPiSelectorPrompt } = load("src/agent/pi/two-pass-prompts.js");
  const { PiContextWorkspace } = load("src/agent/pi/context-workspace.js");
  const { buildPiFocusContext } = load("src/agent/pi/focus-context.js");
  const focus = buildPiFocusContext(conversation(), {
    kind: "create-child",
    childId: "child",
    parentId: "gauss",
    previousDraft: { text: "", mode: "child", selectionContexts: [] },
    previousChildIds: [],
    previousCurrentNodeId: "gauss",
    appliedRevision: 1
  }, "child-q");
  const request = {
    conversationId: "c",
    nodeId: "child",
    assistantMessageId: "a",
    contextMessages: [{ role: "system", content: "TREE_SYSTEM" }],
    piContext: {
      currentQuestion: "这里为什么成立",
      selectedQuotes: ["SELECTED_TERM"],
      conversationNodes: piNodes(),
      noteContextGraph: graph(),
      focus
    },
    roleId: "direct",
    route: {
      routeId: "default",
      providerProfile: { id: "default", name: "Default", kind: "openai", apiKey: "secret", baseUrl: "" },
      modelId: "gpt-test"
    },
    webSearchEnabled: false
  };
  const catalog = new PiContextWorkspace(graph(), piNodes()).catalogSnapshot();
  const prompt = buildPiSelectorPrompt(request, catalog);

  assert.match(prompt.userPrompt, /Focus ID: F1/u);
  assert.match(prompt.userPrompt, /containing_section/u);
  assert.match(prompt.userPrompt, /用户框选源笔记|root focus note/iu);
  assert.match(prompt.systemPrompt, /linked notes are candidates|do not select a linked note merely because/iu);
  assert.match(prompt.userPrompt, /"focus":\[\{"id":"F1"/u);
});

test("Pi engine can materialize a selected section from the same note as the protected exact selection", async () => {
  const { PiExecutionEngine } = load("src/agent/pi/pi-execution-engine.js");
  const { stableNoteSourceId } = load("src/agent/pi/cache-identity.js");
  const { buildPiFocusContext } = load("src/agent/pi/focus-context.js");
  const focus = buildPiFocusContext(conversation(), {
    kind: "create-child",
    childId: "child",
    parentId: "gauss",
    previousDraft: { text: "", mode: "child", selectionContexts: [] },
    previousChildIds: [],
    previousCurrentNodeId: "gauss",
    appliedRevision: 1
  }, "child-q");
  const providerRequests = [];
  const replies = [
    {
      status: 200,
      json: {
        choices: [{
          message: {
            content: JSON.stringify({
              focus: [
                { id: "F1", scope: "selection_only", reason: "exact target is clear" },
                { id: "F2", scope: "latest_round", reason: "keep direct parent context" }
              ],
              notes: [{
                id: stableNoteSourceId("Math/Gauss.md"),
                priority: "essential",
                sections: ["推导"],
                reason: "the selected term depends on its containing derivation"
              }],
              nodes: []
            })
          },
          finish_reason: "stop"
        }]
      }
    },
    {
      status: 200,
      json: { choices: [{ message: { content: "FINAL_ANSWER" }, finish_reason: "stop" }] }
    }
  ];
  const engine = new PiExecutionEngine({
    strategy: "two-pass",
    bufferedRequest: async (request) => {
      providerRequests.push(request);
      return replies.shift();
    },
    initialEvidenceTokenBudget: 4_000,
    supplementaryEvidenceTokenBudget: 0,
    now: () => "2026-08-05T00:00:00.000Z"
  });
  const request = {
    conversationId: "c",
    nodeId: "child",
    assistantMessageId: "a",
    contextMessages: [{ role: "system", content: "TREE_SYSTEM" }],
    piContext: {
      currentQuestion: "这里为什么成立",
      selectedQuotes: ["SELECTED_TERM"],
      conversationNodes: piNodes(),
      noteContextGraph: graph(),
      focus
    },
    roleId: "direct",
    route: {
      routeId: "default",
      providerProfile: { id: "default", name: "Default", kind: "openai", apiKey: "secret", baseUrl: "" },
      modelId: "gpt-test"
    },
    webSearchEnabled: false
  };
  const events = [];
  for await (const event of engine.execute(request, new AbortController().signal)) {
    events.push(event);
  }

  assert.equal(providerRequests.length, 2);
  const answerPayload = JSON.stringify(providerRequests[1].body);
  assert.match(answerPayload, /> SELECTED_TERM/u);
  assert.match(answerPayload, /PROOF_BODY|DETAIL_BODY/u);
  assert.match(answerPayload, /F1.*chosen scope: selection_only/iu);
  assert.doesNotMatch(answerPayload, /DEFINITION_ONLY/u);
  assert.doesNotMatch(answerPayload, /APPLICATION_ONLY/u);
  assert.deepEqual(events.filter((event) => event.type === "text-delta").map((event) => event.text), ["FINAL_ANSWER"]);
});

test("focus decision normalization applies source-specific scopes and fills missing anchors", () => {
  const { buildPiFocusContext } = load("src/agent/pi/focus-context.js");
  const { resolvePiFocusDecisions } = load("src/agent/pi/focus-evidence.js");
  const focus = buildPiFocusContext(conversation(), {
    kind: "create-child",
    childId: "child",
    parentId: "gauss",
    previousDraft: { text: "", mode: "child", selectionContexts: [] },
    previousChildIds: [],
    previousCurrentNodeId: "gauss",
    appliedRevision: 1
  }, "child-q");

  assert.deepEqual(resolvePiFocusDecisions(focus, [
    { anchorId: "F1", scope: "source_message", reason: "invalid for a note focus" }
  ]), [
    { anchorId: "F1", scope: "selection_only", reason: "invalid for a note focus" },
    { anchorId: "F2", scope: "latest_round", reason: "" }
  ]);
});
