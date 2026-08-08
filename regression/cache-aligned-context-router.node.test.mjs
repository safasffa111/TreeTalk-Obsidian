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

function note(id, filePath, content, depth = 1, rootNode = false) {
  return {
    id,
    filePath,
    fileName: path.basename(filePath),
    content,
    contentHash: `hash-${id}`,
    depth,
    root: rootNode,
    ...(rootNode ? {} : { primaryParentId: "a" }),
    primaryChain: rootNode ? [id] : ["a", id],
    parentIds: [],
    outgoingNodeIds: []
  };
}

function graph(nodes, edges = []) {
  return {
    protocol: "note-context-graph:v1",
    rootNodeIds: nodes.filter((node) => node.root).map((node) => node.id),
    fullNoteContext: true,
    relatedNotesEnabled: true,
    perNoteBudget: "full",
    maxDepth: 3,
    builtAt: "2026-08-04T00:00:00.000Z",
    nodes,
    edges,
    unresolvedLinks: []
  };
}

const conversationNodes = [
  {
    id: "node-real-root",
    parentId: null,
    title: "Root",
    depth: 0,
    root: true,
    current: false,
    messages: [
      { id: "u", role: "user", content: "Earlier question", status: "complete", selectionQuotes: [] },
      { id: "a", role: "assistant", content: "PRIVATE ANSWER\n\n## 结论\nStable node conclusion", status: "complete", selectionQuotes: [] }
    ]
  }
];

function request() {
  return {
    conversationId: "c",
    nodeId: "n",
    assistantMessageId: "a",
    contextMessages: [{ role: "system", content: "TREE_SYSTEM" }],
    piContext: {
      currentQuestion: "DYNAMIC_QUESTION",
      selectedQuotes: ["DYNAMIC_SELECTION"],
      conversationNodes,
      noteContextGraph: graph([
        note("a", "Notes/A.md", "# A\n\n## 结论\nA conclusion", 0, true),
        note("c", "Notes/C.md", "# C\n\n## 结论\nC conclusion")
      ])
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

test("note and node compact IDs are stable across insertion and ordering changes", () => {
  const { stableNoteSourceId, stableNodeSourceId } = load("src/agent/pi/cache-identity.js");
  assert.match(stableNoteSourceId("Notes/A.md"), /^P-[0-9a-f]{10}$/u);
  assert.equal(stableNoteSourceId("./Notes\\A.md"), stableNoteSourceId("Notes/A.md"));
  assert.match(stableNodeSourceId("node-real-root"), /^N-[0-9a-f]{10}$/u);

  const { PiContextWorkspace } = load("src/agent/pi/context-workspace.js");
  const before = new PiContextWorkspace(graph([
    note("a", "Notes/A.md", "# A\n\n## 结论\nA", 0, true),
    note("c", "Notes/C.md", "# C\n\n## 结论\nC")
  ]), conversationNodes);
  const after = new PiContextWorkspace(graph([
    note("c", "Notes/C.md", "# C\n\n## 结论\nC"),
    note("b", "Notes/B.md", "# B\n\n## 结论\nB"),
    note("a", "Notes/A.md", "# A\n\n## 结论\nA", 0, true)
  ]), [...conversationNodes].reverse());
  assert.equal(before.compactNoteId("a"), after.compactNoteId("a"));
  assert.equal(before.compactNoteId("c"), after.compactNoteId("c"));
  assert.equal(before.compactConversationNodeId("node-real-root"), after.compactConversationNodeId("node-real-root"));
});

test("catalog snapshot separates a stable note prefix from the dynamic branch", () => {
  const { PiContextWorkspace } = load("src/agent/pi/context-workspace.js");
  const workspace = new PiContextWorkspace(request().piContext.noteContextGraph, conversationNodes);
  const snapshot = workspace.catalogSnapshot();
  assert.match(snapshot.stableMarkdown, /^# Stable Note Catalog/mu);
  assert.match(snapshot.stableMarkdown, /- 与焦点关系：用户框选源笔记/u);
  assert.doesNotMatch(snapshot.stableMarkdown, /Stable Note Relationships|A conclusion|C conclusion/u);
  assert.doesNotMatch(snapshot.stableMarkdown, /Dynamic Conversation Branch|Earlier question|DYNAMIC_QUESTION/u);
  assert.match(snapshot.dynamicMarkdown, /^# Dynamic Conversation Branch/mu);
  assert.match(snapshot.dynamicMarkdown, /Earlier question/u);
  assert.doesNotMatch(snapshot.dynamicMarkdown, /Stable node conclusion|PRIVATE ANSWER/u);
  assert.match(snapshot.stableHash, /^[0-9a-f]{64}$/u);
  assert.equal(snapshot.markdown, `${snapshot.stableMarkdown}\n\n${snapshot.dynamicMarkdown}`);
});

test("selector and answer prompts put stable content before dynamic questions and keep system prompts fixed", () => {
  const { PiContextWorkspace } = load("src/agent/pi/context-workspace.js");
  const {
    buildPiSelectorPrompt,
    buildPiSupplementarySelectorPrompt,
    buildPiAnswerPrompt
  } = load("src/agent/pi/two-pass-prompts.js");
  const workspace = new PiContextWorkspace(request().piContext.noteContextGraph, conversationNodes);
  const snapshot = workspace.catalogSnapshot();
  const initial = buildPiSelectorPrompt(request(), snapshot);
  assert.ok(initial.userPrompt.indexOf("# Stable Note Catalog") < initial.userPrompt.indexOf("# Dynamic Conversation Branch"));
  assert.ok(initial.userPrompt.indexOf("# Dynamic Conversation Branch") < initial.userPrompt.indexOf("# Current Request"));
  assert.ok(initial.userPrompt.indexOf("# Current Request") < initial.userPrompt.indexOf("DYNAMIC_QUESTION") + 1);
  const supplementary = buildPiSupplementarySelectorPrompt(request(), snapshot, { notes: [], nodes: [] }, "missing proof");
  assert.equal(supplementary.systemPrompt, initial.systemPrompt);
  assert.ok(supplementary.userPrompt.indexOf(snapshot.stableMarkdown) === 0);

  const firstAnswer = buildPiAnswerPrompt(request(), "# Selected Evidence\n\nEVIDENCE", true);
  const finalAnswer = buildPiAnswerPrompt(request(), "# Selected Evidence\n\nEVIDENCE\n\nMORE", false);
  assert.equal(firstAnswer.systemPrompt, finalAnswer.systemPrompt);
  assert.ok(firstAnswer.userPrompt.indexOf("EVIDENCE") < firstAnswer.userPrompt.indexOf("DYNAMIC_QUESTION"));
  assert.match(firstAnswer.stablePrefixHash, /^[0-9a-f]{64}$/u);
  assert.ok(firstAnswer.stablePrefixEstimatedTokens > 0);
  assert.ok(firstAnswer.dynamicTailEstimatedTokens > 0);
});

test("evidence materialization is canonical regardless of selector array order", () => {
  const { PiContextWorkspace } = load("src/agent/pi/context-workspace.js");
  const { materializePiEvidence } = load("src/agent/pi/evidence-materializer.js");
  const workspace = new PiContextWorkspace(graph([
    note("a", "Notes/A.md", "# A\n\n## 结论\nA conclusion", 0, true),
    note("c", "Notes/C.md", "# C\n\n## 结论\nC conclusion")
  ]), conversationNodes);
  const a = workspace.compactNoteId("a");
  const c = workspace.compactNoteId("c");
  const n = workspace.compactConversationNodeId("node-real-root");
  const first = materializePiEvidence(workspace, {
    notes: [
      { id: c, priority: "supporting", sections: ["结论"], reason: "c" },
      { id: a, priority: "essential", sections: ["结论"], reason: "a" }
    ],
    nodes: [{ id: n, priority: "supporting", parts: ["answer"], reason: "n" }]
  }, { tokenBudget: 2000 });
  const second = materializePiEvidence(workspace, {
    notes: [
      { id: a, priority: "essential", sections: ["结论"], reason: "a" },
      { id: c, priority: "supporting", sections: ["结论"], reason: "c" }
    ],
    nodes: [{ id: n, priority: "supporting", parts: ["answer"], reason: "n" }]
  }, { tokenBudget: 2000 });
  assert.equal(first.markdown, second.markdown);
  assert.equal(first.evidenceHash, second.evidenceHash);
  assert.match(first.evidenceHash, /^[0-9a-f]{64}$/u);
});

test("agent run records stage-level cache diagnostics without changing cumulative usage", () => {
  const { createAgentRunRecord, applyAgentRunEvent } = load("src/domain/agent-run.js");
  let record = createAgentRunRecord({
    executionMode: "pi",
    roleId: "direct",
    routeId: "default",
    providerId: "deepseek",
    modelId: "deepseek-chat",
    startedAt: "2026-08-04T00:00:00.000Z"
  });
  record = applyAgentRunEvent(record, {
    type: "stage-start",
    stageId: "pi-context-selector",
    roleId: "direct",
    routeId: "default",
    startedAt: "2026-08-04T00:00:00.000Z"
  });
  record = applyAgentRunEvent(record, {
    type: "stage-usage",
    stageId: "pi-context-selector",
    usage: { promptTokens: 1000, completionTokens: 20, cacheHitTokens: 800, cacheMissTokens: 200, providerReported: true },
    stablePrefixHash: "a".repeat(64),
    stablePrefixEstimatedTokens: 850,
    dynamicTailEstimatedTokens: 150
  });
  assert.equal(record.stages[0].usage.cacheHitTokens, 800);
  assert.equal(record.stages[0].stablePrefixEstimatedTokens, 850);
  assert.equal(record.usage, undefined);
  const { agentExecutionViewModel } = load("src/agent/ui/execution-view-model.js");
  const rows = new Map(agentExecutionViewModel(record).rows);
  assert.match(rows.get("缓存 · 上下文选择"), /命中 800.*未命中 200/u);
});

test("Pi engine emits per-stage cache diagnostics and cache keys from stable prefixes", async () => {
  const { PiContextWorkspace } = load("src/agent/pi/context-workspace.js");
  const { PiExecutionEngine } = load("src/agent/pi/pi-execution-engine.js");
  const input = request();
  const workspace = new PiContextWorkspace(
    input.piContext.noteContextGraph,
    input.piContext.conversationNodes
  );
  const selectedId = workspace.compactNoteId("a");
  const requests = [];
  const replies = [
    {
      status: 200,
      json: {
        choices: [{
          message: { content: JSON.stringify({ notes: [{ id: selectedId, priority: "essential", sections: ["结论"], reason: "needed" }], nodes: [] }) },
          finish_reason: "stop"
        }],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 700 }
        }
      }
    },
    {
      status: 200,
      json: {
        choices: [{ message: { content: "FINAL" }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 600,
          completion_tokens: 40,
          prompt_tokens_details: { cached_tokens: 400 }
        }
      }
    }
  ];
  const engine = new PiExecutionEngine({
    strategy: "two-pass",
    bufferedRequest: async (providerRequest) => {
      requests.push(providerRequest);
      return replies.shift();
    },
    now: () => "2026-08-04T00:00:00.000Z"
  });
  const events = [];
  for await (const event of engine.execute(input, new AbortController().signal)) {
    events.push(event);
  }
  const stageUsage = events.filter((event) => event.type === "stage-usage");
  assert.equal(stageUsage.length, 2);
  assert.equal(stageUsage[0].stageId, "pi-context-selector");
  assert.equal(stageUsage[0].usage.cacheHitTokens, 700);
  assert.equal(stageUsage[0].usage.cacheMissTokens, 300);
  assert.match(stageUsage[0].stablePrefixHash, /^[0-9a-f]{64}$/u);
  assert.equal(stageUsage[1].stageId, "pi-evidence-answer");
  assert.equal(stageUsage[1].usage.cacheHitTokens, 400);
  assert.match(requests[0].body.prompt_cache_key, /^treetalk-selector-v1:/u);
  assert.match(requests[1].body.prompt_cache_key, /^treetalk-answer-v1:/u);
  const firstUser = requests[0].body.messages.at(-1).content;
  assert.ok(firstUser.indexOf("# Stable Note Catalog") < firstUser.indexOf("DYNAMIC_QUESTION"));
  const secondUser = requests[1].body.messages.at(-1).content;
  assert.ok(secondUser.indexOf("# Selected Evidence") < secondUser.indexOf("DYNAMIC_QUESTION"));
});
