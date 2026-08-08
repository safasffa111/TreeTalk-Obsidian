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
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z"
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
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z"
  };
}

function conversation(nodes, currentNodeId) {
  return {
    schemaVersion: 1,
    id: "conversation",
    title: "Math",
    status: "active",
    revision: 1,
    checksum: "",
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
    rootNodeId: "green",
    currentNodeId,
    nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
    ui: { expandedNodeIds: [], treeScrollTop: 0, messageScrollTopByNode: {} }
  };
}

function messageSelection() {
  return {
    messageId: "gauss-answer",
    sourceNodeId: "gauss",
    sourceRole: "assistant",
    basis: "rendered-text-v1",
    startOffset: 5,
    endOffset: 17,
    quote: "高斯公式积分形式",
    prefix: "这里讨论",
    suffix: "以及散度定理",
    contentHash: "hash"
  };
}

function noteSelection() {
  return {
    sourceType: "note",
    filePath: "Math/Gauss.md",
    fileName: "Gauss.md",
    basis: "note-source-v1",
    startOffset: 0,
    endOffset: 4,
    quote: "高斯公式",
    prefix: "",
    suffix: "的适用条件",
    contentHash: "note-hash"
  };
}

function piConversationNodes() {
  return [
    {
      id: "green",
      parentId: null,
      title: "格林公式",
      depth: 0,
      root: true,
      current: false,
      messages: [
        { id: "green-q", role: "user", content: "什么是格林公式", status: "complete", selectionQuotes: [] },
        { id: "green-a", role: "assistant", content: "GREEN_PRIVATE", status: "complete", selectionQuotes: [] }
      ]
    },
    {
      id: "gauss",
      parentId: "green",
      title: "高斯公式",
      depth: 1,
      root: false,
      current: true,
      messages: [
        { id: "gauss-q", role: "user", content: "什么是高斯公式", status: "complete", selectionQuotes: [] },
        { id: "gauss-answer", role: "assistant", content: "GAUSS_PARENT_ANSWER", status: "complete", selectionQuotes: [] },
        { id: "current-q", role: "user", content: "它为什么成立", status: "complete", selectionQuotes: [] }
      ]
    }
  ];
}

function graph() {
  return {
    protocol: "note-context-graph:v1",
    rootNodeIds: ["note-1"],
    fullNoteContext: true,
    relatedNotesEnabled: true,
    perNoteBudget: "full",
    maxDepth: 2,
    builtAt: "2026-08-04T00:00:00.000Z",
    nodes: [
      {
        id: "note-1",
        filePath: "Math/Gauss.md",
        fileName: "Gauss.md",
        content: "# 高斯公式\n\nNOTE_LOCAL_CONTEXT\n\n## 证明\nNOTE_FULL_PROOF",
        contentHash: "h1",
        depth: 0,
        root: true,
        primaryChain: ["note-1"],
        parentIds: [],
        outgoingNodeIds: []
      },
      {
        id: "note-2",
        filePath: "Math/Green.md",
        fileName: "Green.md",
        content: "# 格林公式\n\nUNRELATED_GREEN_NOTE ".repeat(60),
        contentHash: "h2",
        depth: 1,
        root: false,
        primaryParentId: "note-1",
        primaryChain: ["note-1", "note-2"],
        parentIds: [],
        outgoingNodeIds: []
      }
    ],
    edges: [],
    unresolvedLinks: []
  };
}

function request(focus) {
  return {
    conversationId: "c",
    nodeId: "gauss",
    assistantMessageId: "a",
    contextMessages: [{ role: "system", content: "TREE_SYSTEM" }],
    piContext: {
      currentQuestion: "它为什么成立",
      selectedQuotes: [],
      conversationNodes: piConversationNodes(),
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
}

test("focus builder retains true message-selection and note-selection source identity", () => {
  const { buildPiFocusContext } = load("src/agent/pi/focus-context.js");
  const child = node("child", "gauss", "为什么", [
    message("current-q", "user", "为什么", [messageSelection(), noteSelection()])
  ]);
  const state = conversation([
    node("green", null, "格林公式", []),
    node("gauss", "green", "高斯公式", [message("gauss-answer", "assistant", "高斯公式积分形式")]),
    child
  ], "child");
  const focus = buildPiFocusContext(state, {
    kind: "create-child",
    childId: "child",
    parentId: "gauss",
    previousDraft: { text: "", mode: "child", selectionContexts: [] },
    previousChildIds: [],
    previousCurrentNodeId: "gauss",
    appliedRevision: 1
  }, "current-q");

  assert.equal(focus.interactionMode, "child");
  assert.equal(focus.defaultScope, "source_message");
  assert.deepEqual(focus.anchors[0], {
    id: "F1",
    defaultScope: "source_message",
    kind: "message-selection",
    sourceNodeId: "gauss",
    sourceMessageId: "gauss-answer",
    sourceRole: "assistant",
    quote: "高斯公式积分形式",
    prefix: "这里讨论",
    suffix: "以及散度定理"
  });
  assert.deepEqual(focus.anchors[1], {
    id: "F2",
    defaultScope: "selection_only",
    kind: "note-selection",
    filePath: "Math/Gauss.md",
    fileName: "Gauss.md",
    quote: "高斯公式",
    prefix: "",
    suffix: "的适用条件"
  });
});

test("note selection keeps the direct parent round in the same local focus group", () => {
  const { buildPiFocusContext } = load("src/agent/pi/focus-context.js");
  const childState = conversation([
    node("green", null, "格林公式", []),
    node("gauss", "green", "高斯公式", [
      message("gauss-q", "user", "什么是高斯公式"),
      message("gauss-answer", "assistant", "GAUSS_PARENT_ANSWER")
    ]),
    node("child", "gauss", "笔记里这里呢", [
      message("child-q", "user", "笔记里这里呢", [noteSelection()])
    ])
  ], "child");
  const focus = buildPiFocusContext(childState, {
    kind: "create-child",
    childId: "child",
    parentId: "gauss",
    previousDraft: { text: "", mode: "child", selectionContexts: [] },
    previousChildIds: [],
    previousCurrentNodeId: "gauss",
    appliedRevision: 1
  }, "child-q");
  assert.deepEqual(focus.anchors, [
    {
      id: "F1",
      defaultScope: "selection_only",
      kind: "note-selection",
      filePath: "Math/Gauss.md",
      fileName: "Gauss.md",
      quote: "高斯公式",
      prefix: "",
      suffix: "的适用条件"
    },
    {
      id: "F2",
      defaultScope: "latest_round",
      kind: "conversation-round",
      sourceNodeId: "gauss",
      sourceMessageId: "gauss-answer",
      reason: "direct-parent"
    }
  ]);
});

test("focus builder uses direct parent for child turns and previous assistant for continue turns", () => {
  const { buildPiFocusContext } = load("src/agent/pi/focus-context.js");
  const childState = conversation([
    node("green", null, "格林公式", []),
    node("gauss", "green", "高斯公式", [
      message("gauss-q", "user", "什么是高斯公式"),
      message("gauss-answer", "assistant", "GAUSS_PARENT_ANSWER")
    ]),
    node("child", "gauss", "为什么", [message("child-q", "user", "为什么")])
  ], "child");
  const childFocus = buildPiFocusContext(childState, {
    kind: "create-child",
    childId: "child",
    parentId: "gauss",
    previousDraft: { text: "", mode: "child", selectionContexts: [] },
    previousChildIds: [],
    previousCurrentNodeId: "gauss",
    appliedRevision: 1
  }, "child-q");
  assert.deepEqual(childFocus.anchors, [{
    id: "F1",
    defaultScope: "latest_round",
    kind: "conversation-round",
    sourceNodeId: "gauss",
    sourceMessageId: "gauss-answer",
    reason: "direct-parent"
  }]);

  const continueState = conversation([
    node("green", null, "格林公式", []),
    node("gauss", "green", "高斯公式", [
      message("gauss-q", "user", "什么是高斯公式"),
      message("gauss-answer", "assistant", "GAUSS_PARENT_ANSWER"),
      message("current-q", "user", "为什么")
    ])
  ], "gauss");
  const continueFocus = buildPiFocusContext(continueState, {
    kind: "append-message",
    nodeId: "gauss",
    messageId: "current-q",
    previousDraft: { text: "", mode: "continue", selectionContexts: [] },
    previousCurrentNodeId: "gauss",
    appliedRevision: 1
  }, "current-q");
  assert.deepEqual(continueFocus.anchors, [{
    id: "F1",
    defaultScope: "latest_round",
    kind: "conversation-round",
    sourceNodeId: "gauss",
    sourceMessageId: "gauss-answer",
    reason: "previous-turn"
  }]);
});

test("selector parses focus scope and keeps local focus in the dynamic prompt tail", () => {
  const { parsePiContextSelection } = load("src/agent/pi/context-selection.js");
  const { buildPiSelectorPrompt } = load("src/agent/pi/two-pass-prompts.js");
  const { PiContextWorkspace } = load("src/agent/pi/context-workspace.js");
  assert.equal(parsePiContextSelection(JSON.stringify({
    focus: { scope: "full_source", reason: "needs the whole derivation" },
    notes: [],
    nodes: []
  }), "latest_round").focusScope, "full_source");
  assert.equal(parsePiContextSelection(JSON.stringify({ notes: [], nodes: [] }), "source_message").focusScope, "source_message");

  const focus = {
    interactionMode: "continue",
    defaultScope: "latest_round",
    anchors: [{ kind: "conversation-round", sourceNodeId: "gauss", sourceMessageId: "gauss-answer", reason: "previous-turn" }]
  };
  const catalog = new PiContextWorkspace(graph(), piConversationNodes()).catalogSnapshot();
  const first = buildPiSelectorPrompt(request(focus), catalog);
  const second = buildPiSelectorPrompt(request({
    ...focus,
    anchors: [{ kind: "message-selection", sourceNodeId: "gauss", sourceMessageId: "gauss-answer", sourceRole: "assistant", quote: "DIFFERENT_QUOTE", prefix: "", suffix: "" }]
  }), catalog);
  assert.equal(first.stablePrefixHash, second.stablePrefixHash);
  assert.match(first.userPrompt, /# Local Focus|高斯公式|previous-turn|default response target/u);
  assert.match(first.systemPrompt, /explicitly names another target|must not replace the local focus/u);
  assert.match(first.userPrompt, /selection_only\|containing_section\|source_message\|latest_round\|full_source/u);
});

test("focus materializer extracts the focused round and full note source", () => {
  const { PiContextWorkspace } = load("src/agent/pi/context-workspace.js");
  const { materializePiFocusEvidence } = load("src/agent/pi/focus-evidence.js");
  const workspace = new PiContextWorkspace(graph(), piConversationNodes());
  const round = materializePiFocusEvidence(workspace, {
    interactionMode: "continue",
    defaultScope: "latest_round",
    anchors: [{ kind: "conversation-round", sourceNodeId: "gauss", sourceMessageId: "gauss-answer", reason: "previous-turn" }]
  }, "latest_round", { tokenBudget: 1000 });
  assert.match(round.markdown, /# Local Focus Evidence|什么是高斯公式|GAUSS_PARENT_ANSWER/u);
  assert.doesNotMatch(round.markdown, /GREEN_PRIVATE/u);
  assert.deepEqual(round.materializedNodeIds, ["gauss"]);

  const note = materializePiFocusEvidence(workspace, {
    interactionMode: "child",
    defaultScope: "source_message",
    anchors: [{ kind: "note-selection", filePath: "Math/Gauss.md", fileName: "Gauss.md", quote: "高斯公式", prefix: "", suffix: "的适用条件" }]
  }, "full_source", { tokenBudget: 1000 });
  assert.match(note.markdown, /NOTE_LOCAL_CONTEXT|NOTE_FULL_PROOF/u);
  assert.deepEqual(note.materializedNotePaths, ["Math/Gauss.md"]);
});

test("protected focus reserves exact selection and parent before expanding a full note", () => {
  const { PiContextWorkspace } = load("src/agent/pi/context-workspace.js");
  const { materializePiFocusEvidence } = load("src/agent/pi/focus-evidence.js");
  const workspace = new PiContextWorkspace(graph(), piConversationNodes());
  const result = materializePiFocusEvidence(workspace, {
    interactionMode: "child",
    defaultScope: "source_message",
    anchors: [
      { kind: "note-selection", filePath: "Math/Gauss.md", fileName: "Gauss.md", quote: "高斯公式", prefix: "", suffix: "的适用条件" },
      { kind: "conversation-round", sourceNodeId: "gauss", sourceMessageId: "gauss-answer", reason: "direct-parent" }
    ]
  }, "full_source", { tokenBudget: 110 });
  assert.match(result.markdown, /> 高斯公式/u);
  assert.match(result.markdown, /GAUSS_PARENT_ANSWER/u);
  assert.deepEqual(result.materializedNodeIds, ["gauss"]);
});

test("Pi engine protects local focus before unrelated selected evidence and locks the response target", async () => {
  const { PiExecutionEngine } = load("src/agent/pi/pi-execution-engine.js");
  const { stableNoteSourceId } = load("src/agent/pi/cache-identity.js");
  const requests = [];
  const replies = [
    {
      status: 200,
      json: {
        choices: [{ message: { content: JSON.stringify({
          focus: { scope: "latest_round", reason: "the question continues the current high-Gauss node" },
          notes: [{ id: stableNoteSourceId("Math/Green.md"), priority: "essential", sections: [], reason: "possible comparison" }],
          nodes: []
        }) }, finish_reason: "stop" }]
      }
    },
    {
      status: 200,
      json: { choices: [{ message: { content: "FINAL" }, finish_reason: "stop" }] }
    }
  ];
  const focus = {
    interactionMode: "continue",
    defaultScope: "latest_round",
    anchors: [{ kind: "conversation-round", sourceNodeId: "gauss", sourceMessageId: "gauss-answer", reason: "previous-turn" }]
  };
  const engine = new PiExecutionEngine({
    strategy: "two-pass",
    bufferedRequest: async (providerRequest) => {
      requests.push(providerRequest);
      return replies.shift();
    },
    initialEvidenceTokenBudget: 160,
    supplementaryEvidenceTokenBudget: 0,
    now: () => "2026-08-04T00:00:00.000Z"
  });
  const events = [];
  for await (const event of engine.execute(request(focus), new AbortController().signal)) events.push(event);

  assert.equal(requests.length, 2);
  const answerPayload = JSON.stringify(requests[1].body);
  const focusIndex = answerPayload.indexOf("Local Focus Evidence");
  const selectedIndex = answerPayload.indexOf("Selected Evidence");
  assert.ok(focusIndex >= 0);
  assert.ok(selectedIndex < 0 || focusIndex < selectedIndex);
  assert.match(answerPayload, /GAUSS_PARENT_ANSWER|Response Target|高斯公式|supplementary/u);
  assert.doesNotMatch(answerPayload, /GREEN_PRIVATE/u);
  assert.deepEqual(events.filter((event) => event.type === "text-delta").map((event) => event.text), ["FINAL"]);
  const routing = events.find((event) => event.type === "context-routing");
  assert.deepEqual(routing.materializedNodeIds, ["gauss"]);
});

test("an unavailable selected source does not discard a valid parent focus", () => {
  const { PiContextWorkspace } = load("src/agent/pi/context-workspace.js");
  const { materializePiFocusEvidence } = load("src/agent/pi/focus-evidence.js");
  const workspace = new PiContextWorkspace(graph(), piConversationNodes());
  const result = materializePiFocusEvidence(workspace, {
    interactionMode: "child",
    defaultScope: "latest_round",
    anchors: [
      {
        kind: "note-selection",
        filePath: "Missing/Deleted.md",
        fileName: "Deleted.md",
        quote: "missing",
        prefix: "",
        suffix: ""
      },
      {
        kind: "conversation-round",
        sourceNodeId: "gauss",
        sourceMessageId: "gauss-answer",
        reason: "direct-parent"
      }
    ]
  }, "latest_round", { tokenBudget: 1000 });

  assert.match(result.markdown, /GAUSS_PARENT_ANSWER/u);
  assert.deepEqual(result.materializedNodeIds, ["gauss"]);
  assert.equal(result.omitted.some((entry) => entry.sourceId === "Missing/Deleted.md"), true);
});
