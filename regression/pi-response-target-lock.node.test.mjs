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
    item.name === "node_modules" ? [] : walk(path.join(entry, item.name))
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
function conversation() {
  const selection = {
    messageId: "forward-answer",
    sourceNodeId: "forward",
    sourceRole: "assistant",
    basis: "rendered-text-v1",
    startOffset: 7,
    endOffset: 9,
    quote: "旋度",
    prefix: "判断向量场的",
    suffix: "方向需要使用右手定则",
    contentHash: "selection-hash"
  };
  const nodes = [
    node("forward", null, "正向", [
      message("forward-q", "user", "什么是正向"),
      message("forward-answer", "assistant", "正向节点包含大量关于正向的解释，同时提到了旋度。")
    ]),
    node("child", "forward", "这个概念是什么意思", [
      message("child-q", "user", "这个概念是什么意思", [selection])
    ])
  ];
  return {
    schemaVersion: 1,
    id: "conversation",
    title: "向量分析",
    status: "active",
    revision: 1,
    checksum: "",
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z",
    rootNodeId: "forward",
    currentNodeId: "child",
    nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
    ui: { expandedNodeIds: [], treeScrollTop: 0, messageScrollTopByNode: {} }
  };
}
function operation() {
  return {
    kind: "create-child",
    childId: "child",
    parentId: "forward",
    previousDraft: { text: "", mode: "child", selectionContexts: [] },
    previousChildIds: [],
    previousCurrentNodeId: "forward",
    appliedRevision: 1
  };
}
function piNodes() {
  return [{
    id: "forward",
    parentId: null,
    title: "正向",
    depth: 0,
    root: true,
    current: true,
    messages: [
      { id: "forward-q", role: "user", content: "什么是正向", status: "complete", selectionQuotes: [] },
      { id: "forward-answer", role: "assistant", content: "正向".repeat(80) + "旋度", status: "complete", selectionQuotes: [] }
    ]
  }];
}
function request(focus) {
  return {
    conversationId: "c",
    nodeId: "child",
    assistantMessageId: "a",
    contextMessages: [{ role: "system", content: "TREE_SYSTEM" }],
    piContext: {
      currentQuestion: "这个概念是什么意思",
      selectedQuotes: ["旋度"],
      conversationNodes: piNodes(),
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

function builtFocus() {
  const { buildPiFocusContext } = load("src/agent/pi/focus-context.js");
  return buildPiFocusContext(conversation(), operation(), "child-q");
}

test("exact selection becomes an explicit primary response target while the parent remains context", () => {
  const focus = builtFocus();
  assert.deepEqual(focus.targets, [{
    kind: "exact-selection",
    anchorId: "F1",
    text: "旋度",
    source: {
      type: "conversation-message",
      nodeId: "forward",
      messageId: "forward-answer",
      role: "assistant"
    }
  }]);
  assert.equal(focus.anchors.length, 1, "the selected source message already supplies the parent context");
});

test("selector prompt separates the selected concept from its source node title", () => {
  const { buildPiSelectorPrompt } = load("src/agent/pi/two-pass-prompts.js");
  const prompt = buildPiSelectorPrompt(request(builtFocus()), "# Context Catalog\n\nNo additional sources.");
  assert.match(prompt.userPrompt, /# Primary Response Target/u);
  assert.match(prompt.userPrompt, /Target text: “旋度”/u);
  assert.match(prompt.userPrompt, /Source container: conversation node “正向” \(context only\)/u);
  assert.match(prompt.systemPrompt, /scope decisions may change how much context is read, but must not change the primary response target/iu);
});

test("answer prompt repeats a target lock after the current request even when source context is much more prominent", () => {
  const { buildPiAnswerPrompt } = load("src/agent/pi/two-pass-prompts.js");
  const prompt = buildPiAnswerPrompt(
    request(builtFocus()),
    `# Local Focus Evidence\n\n${"正向".repeat(200)}\n\n> 旋度`,
    false,
    [{ anchorId: "F1", scope: "full_source", reason: "test full source" }]
  );
  const requestIndex = prompt.userPrompt.indexOf("# Current Request");
  const targetLockIndex = prompt.userPrompt.indexOf("# Target Lock");
  assert.ok(requestIndex >= 0 && targetLockIndex > requestIndex);
  assert.match(prompt.userPrompt, /Primary target: “旋度”/u);
  assert.match(prompt.userPrompt, /“这个概念”.*refers to the exact selection “旋度”/u);
  assert.match(prompt.userPrompt, /“正向” is only the source container/u);
});

test("protected evidence labels the selection as target evidence rather than using the source title as the focus heading", () => {
  const { PiContextWorkspace } = load("src/agent/pi/context-workspace.js");
  const { materializePiFocusEvidence } = load("src/agent/pi/focus-evidence.js");
  const workspace = new PiContextWorkspace(undefined, piNodes());
  const evidence = materializePiFocusEvidence(
    workspace,
    builtFocus(),
    [{ anchorId: "F1", scope: "full_source", reason: "need source context" }],
    { tokenBudget: 2_000 }
  );
  assert.match(evidence.markdown, /# Primary Target Evidence/u);
  assert.match(evidence.markdown, /## Target F1 · Exact Selection/u);
  assert.match(evidence.markdown, /Target text: 旋度/u);
  assert.match(evidence.markdown, /# Target Context/u);
  assert.match(evidence.markdown, /Source container: 正向/u);
});

test("multiple exact selections remain a primary target set", () => {
  const { buildPiFocusContext } = load("src/agent/pi/focus-context.js");
  const state = conversation();
  const userMessage = state.nodes.child.messages[0];
  userMessage.selectionContexts.push({
    ...userMessage.selectionContexts[0],
    startOffset: 10,
    endOffset: 12,
    quote: "散度",
    prefix: "对比向量场的",
    suffix: "与旋度"
  });
  const focus = buildPiFocusContext(state, operation(), "child-q");
  assert.deepEqual(focus.targets.map((target) => target.text), ["旋度", "散度"]);
});

test("without an exact selection the direct parent round remains the primary target", () => {
  const { buildPiFocusContext } = load("src/agent/pi/focus-context.js");
  const state = conversation();
  delete state.nodes.child.messages[0].selectionContexts;
  const focus = buildPiFocusContext(state, operation(), "child-q");
  assert.deepEqual(focus.targets, [{
    kind: "conversation-round",
    anchorId: "F1",
    sourceNodeId: "forward",
    sourceMessageId: "forward-answer",
    reason: "direct-parent"
  }]);
});
