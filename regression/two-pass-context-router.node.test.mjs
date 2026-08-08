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

function noteNode(index, content, depth = 1) {
  return {
    id: `note-${index}`,
    filePath: `Notes/Note-${String(index).padStart(2, "0")}.md`,
    fileName: `Note-${String(index).padStart(2, "0")}.md`,
    content,
    contentHash: `h${index}`,
    depth,
    root: index === 1,
    ...(index === 1 ? {} : { primaryParentId: "note-1" }),
    primaryChain: index === 1 ? ["note-1"] : ["note-1", `note-${index}`],
    parentIds: [],
    outgoingNodeIds: []
  };
}

function graph(nodes) {
  return {
    protocol: "note-context-graph:v1",
    rootNodeIds: [nodes[0]?.id ?? "note-1"],
    fullNoteContext: true,
    relatedNotesEnabled: true,
    perNoteBudget: "full",
    maxDepth: 2,
    builtAt: "2026-08-04T00:00:00.000Z",
    nodes,
    edges: [],
    unresolvedLinks: []
  };
}

function conversationNodes() {
  return [
    {
      id: "node-real-1",
      parentId: null,
      title: "Earlier derivation",
      depth: 0,
      root: true,
      current: false,
      messages: [
        { id: "u1", role: "user", content: "QUESTION_PRIVATE", status: "complete", selectionQuotes: [] },
        { id: "a1", role: "assistant", content: "ANSWER_PRIVATE\n\n## 结论\nEarlier result", status: "complete", selectionQuotes: [] }
      ]
    }
  ];
}

function executionRequest(noteContextGraph, nodes = conversationNodes()) {
  return {
    conversationId: "c",
    nodeId: "n",
    assistantMessageId: "a",
    contextMessages: [{ role: "system", content: "TREE_SYSTEM" }],
    piContext: {
      currentQuestion: "CURRENT_QUESTION",
      selectedQuotes: ["EXACT_QUOTE"],
      conversationNodes: nodes,
      noteContextGraph
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

test("selection parser accepts unlimited source counts and merges duplicates", () => {
  const { parsePiContextSelection, mergePiContextSelections } = load("src/agent/pi/context-selection.js");
  const notes = Array.from({ length: 24 }, (_, index) => ({
    id: `P${index + 1}`,
    priority: index === 0 ? "essential" : "supporting",
    sections: ["结论"],
    reason: `reason-${index + 1}`
  }));
  const parsed = parsePiContextSelection(JSON.stringify({ notes, nodes: [] }));
  assert.equal(parsed.notes.length, 24);
  const merged = mergePiContextSelections(parsed, {
    notes: [{ id: "P1", priority: "supporting", sections: ["证明"], reason: "extra" }],
    nodes: []
  });
  assert.deepEqual(merged.notes[0].sections, ["结论", "证明"]);
  assert.equal(merged.notes[0].priority, "essential");
  assert.throws(() => parsePiContextSelection("not json"), /valid JSON|JSON object/u);
});

test("workspace renders compact source IDs instead of repeating long identifiers", () => {
  const { PiContextWorkspace } = load("src/agent/pi/context-workspace.js");
  const workspace = new PiContextWorkspace(
    graph([
      noteNode(1, "# Root\n\n## 结论\nRoot conclusion", 0),
      noteNode(2, "# Linked\n\n## 结论\nLinked conclusion")
    ]),
    conversationNodes()
  );
  const index = workspace.catalogText();
  const nodeId = workspace.compactConversationNodeId("node-real-1");
  const rootNoteId = workspace.compactNoteId("note-1");
  const linkedNoteId = workspace.compactNoteId("note-2");
  assert.match(nodeId, /^N-[0-9a-f]{10}$/u);
  assert.match(rootNoteId, /^P-[0-9a-f]{10}$/u);
  assert.match(linkedNoteId, /^P-[0-9a-f]{10}$/u);
  assert.match(index, new RegExp(`## ${nodeId} · Earlier derivation`, "u"));
  assert.match(index, new RegExp(`## ${rootNoteId} · Note-01\\.md`, "u"));
  assert.match(index, new RegExp(`## ${linkedNoteId} · Note-02\\.md`, "u"));
  assert.doesNotMatch(index, /node-real-1|### note: Notes\/Note-01\.md/u);
  assert.equal(workspace.resolveNoteId("P2").filePath, "Notes/Note-02.md");
  assert.equal(workspace.resolveConversationNodeId("N1").id, "node-real-1");
});

test("evidence materializer has no hard item cap and clips by total token budget", () => {
  const { PiContextWorkspace } = load("src/agent/pi/context-workspace.js");
  const { materializePiEvidence } = load("src/agent/pi/evidence-materializer.js");
  const nodes = Array.from({ length: 20 }, (_, index) =>
    noteNode(index + 1, `# N${index + 1}\n\n## 结论\nshort evidence ${index + 1}`, index === 0 ? 0 : 1)
  );
  const workspace = new PiContextWorkspace(graph(nodes));
  const selection = {
    notes: nodes.map((_, index) => ({ id: `P${index + 1}`, priority: "supporting", sections: ["结论"], reason: "relevant" })),
    nodes: []
  };
  const result = materializePiEvidence(workspace, selection, { tokenBudget: 4000 });
  assert.equal(result.materializedNotePaths.length, 20);
  assert.equal(result.omitted.length, 0);

  const hugeWorkspace = new PiContextWorkspace(graph([
    noteNode(1, "# Huge\n\n" + "LONG_PRIVATE ".repeat(5000), 0)
  ]));
  const clipped = materializePiEvidence(hugeWorkspace, {
    notes: [{ id: "P1", priority: "essential", sections: [], reason: "whole source needed" }],
    nodes: []
  }, { tokenBudget: 120 });
  assert.equal(clipped.materializedNotePaths.length, 1);
  assert.equal(clipped.truncated, true);
  assert.ok(clipped.estimatedTokens <= 130);
});

test("Pi engine uses selector then a clean evidence-only answer request", async () => {
  const { PiExecutionEngine } = load("src/agent/pi/pi-execution-engine.js");
  const requests = [];
  const replies = [
    {
      status: 200,
      json: {
        choices: [{ message: { content: JSON.stringify({ notes: [{ id: "P2", priority: "essential", sections: ["证据"], reason: "needed" }], nodes: [{ id: "N1", priority: "supporting", parts: ["answer"], reason: "prior result" }] }) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 20 }
      }
    },
    {
      status: 200,
      json: {
        choices: [{ message: { content: "FINAL_ANSWER" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 200, completion_tokens: 30 }
      }
    }
  ];
  const evidenceGraph = graph([
    noteNode(1, "# Root\nROOT_PRIVATE\n\n## 结论\nRoot conclusion", 0),
    noteNode(2, "# Selected\nUNSELECTED_INTRO\n\n## 结论\nSelected conclusion\n\n## 证据\nSELECTED_PRIVATE_EVIDENCE")
  ]);
  const engine = new PiExecutionEngine({
    strategy: "two-pass",
    bufferedRequest: async (request) => {
      requests.push(request);
      return replies.shift();
    },
    now: () => "2026-08-04T00:00:00.000Z"
  });
  const events = [];
  for await (const event of engine.execute(executionRequest(evidenceGraph), new AbortController().signal)) events.push(event);

  assert.equal(requests.length, 2);
  assert.equal("tools" in requests[0].body, false);
  assert.equal("tools" in requests[1].body, false);
  const selectorPayload = JSON.stringify(requests[0].body);
  assert.match(selectorPayload, /TreeTalk Context Index|CURRENT_QUESTION|Selected conclusion/u);
  assert.doesNotMatch(selectorPayload, /SELECTED_PRIVATE_EVIDENCE|ANSWER_PRIVATE/u);
  const answerPayload = JSON.stringify(requests[1].body);
  assert.match(answerPayload, /SELECTED_PRIVATE_EVIDENCE|Earlier result|CURRENT_QUESTION|EXACT_QUOTE/u);
  assert.doesNotMatch(answerPayload, /TreeTalk Context Index|Root conclusion|UNSELECTED_INTRO|reason.*needed/u);
  assert.deepEqual(events.filter((event) => event.type === "text-delta").map((event) => event.text), ["FINAL_ANSWER"]);
  const routing = events.find((event) => event.type === "context-routing");
  assert.equal(routing.selectedNoteCount, 1);
  assert.equal(routing.selectedNodeCount, 1);
  const usage = events.filter((event) => event.type === "usage").at(-1).usage;
  assert.equal(usage.promptTokens, 300);
  assert.equal(usage.completionTokens, 50);
});

test("Pi engine allows one supplementary selector cycle without leaking the index into answer passes", async () => {
  const { PiExecutionEngine } = load("src/agent/pi/pi-execution-engine.js");
  const requests = [];
  const replies = [
    {
      status: 200,
      json: { choices: [{ message: { content: JSON.stringify({ notes: [{ id: "P1", priority: "supporting", sections: ["结论"], reason: "start" }], nodes: [] }) }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } }
    },
    {
      status: 200,
      json: { choices: [{ message: { content: JSON.stringify({ status: "need_more_context", missing: "the formal proof" }) }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 3 } }
    },
    {
      status: 200,
      json: { choices: [{ message: { content: JSON.stringify({ notes: [{ id: "P2", priority: "essential", sections: ["证明"], reason: "contains missing proof" }], nodes: [] }) }, finish_reason: "stop" }], usage: { prompt_tokens: 15, completion_tokens: 3 } }
    },
    {
      status: 200,
      json: { choices: [{ message: { content: "FINAL_AFTER_SUPPLEMENT" }, finish_reason: "stop" }], usage: { prompt_tokens: 30, completion_tokens: 4 } }
    }
  ];
  const evidenceGraph = graph([
    noteNode(1, "# One\n\n## 结论\nFIRST_EVIDENCE", 0),
    noteNode(2, "# Two\n\n## 证明\nSUPPLEMENT_EVIDENCE")
  ]);
  const engine = new PiExecutionEngine({
    strategy: "two-pass",
    bufferedRequest: async (request) => { requests.push(request); return replies.shift(); },
    now: () => "2026-08-04T00:00:00.000Z"
  });
  const events = [];
  for await (const event of engine.execute(executionRequest(evidenceGraph, []), new AbortController().signal)) events.push(event);
  assert.equal(requests.length, 4);
  assert.doesNotMatch(JSON.stringify(requests[1].body), /TreeTalk Context Index|SUPPLEMENT_EVIDENCE/u);
  assert.match(JSON.stringify(requests[2].body), /TreeTalk Context Index|the formal proof/u);
  assert.doesNotMatch(JSON.stringify(requests[2].body), /SUPPLEMENT_EVIDENCE/u);
  assert.match(JSON.stringify(requests[3].body), /FIRST_EVIDENCE|SUPPLEMENT_EVIDENCE/u);
  assert.doesNotMatch(JSON.stringify(requests[3].body), /TreeTalk Context Index/u);
  assert.deepEqual(events.filter((event) => event.type === "text-delta").map((event) => event.text), ["FINAL_AFTER_SUPPLEMENT"]);
  const routing = events.filter((event) => event.type === "context-routing").at(-1);
  assert.equal(routing.supplementaryUsed, true);
  assert.deepEqual(events.filter((event) => event.type === "stage-start").map((event) => event.stageId), [
    "pi-context-selector",
    "pi-evidence-answer",
    "pi-supplementary-selector",
    "pi-supplementary-answer"
  ]);
});

test("provider transport omits tool protocol fields when tools are empty", () => {
  const { buildPiProviderRequest } = load("src/agent/pi/pi-provider-transport.js");
  const common = {
    modelId: "model",
    systemPrompt: "system",
    messages: [{ role: "user", content: "question" }],
    tools: [],
    maxOutputTokens: 2048
  };
  for (const profile of [
    { id: "o", name: "OpenAI", kind: "openai", apiKey: "secret", baseUrl: "" },
    { id: "a", name: "Anthropic", kind: "anthropic", apiKey: "secret", baseUrl: "" },
    { id: "g", name: "Gemini", kind: "gemini", apiKey: "secret", baseUrl: "" }
  ]) {
    const request = buildPiProviderRequest({ ...common, profile });
    assert.equal("tools" in request.body, false);
    assert.equal("tool_choice" in request.body, false);
    assert.equal("toolConfig" in request.body, false);
  }
});
