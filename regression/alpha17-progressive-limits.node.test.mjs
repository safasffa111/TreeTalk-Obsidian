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
for (const file of walk(path.join(root, "src")).filter(
  (file) => file.endsWith(".ts") && !file.endsWith(".d.ts")
)) {
  const id = path
    .relative(root, file)
    .replaceAll(path.sep, "/")
    .replace(/\.ts$/u, ".js");
  modules.set(
    id,
    ts.transpileModule(fs.readFileSync(file, "utf8"), {
      fileName: file,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        moduleResolution: ts.ModuleResolutionKind.Node10,
        verbatimModuleSyntax: false
      }
    }).outputText
  );
}

const cache = new Map();
function normalize(parts) {
  const result = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") result.pop();
    else result.push(part);
  }
  return result.join("/");
}
function resolve(parentId, request) {
  const parent = parentId.split("/");
  parent.pop();
  const base = normalize([...parent, ...request.split("/")]);
  for (const candidate of request.endsWith(".js")
    ? [base]
    : [`${base}.js`, `${base}/index.js`, base]) {
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
  const localRequire = (request) =>
    request.startsWith(".")
      ? load(resolve(id, request))
      : request === "obsidian"
        ? {}
        : require(request);
  new Function("module", "exports", "require", code)(
    module,
    module.exports,
    localRequire
  );
  return module.exports;
}

function evidenceBatch(id, estimatedTokens = 500) {
  return {
    id,
    level: 1,
    sourceKind: "section",
    sourceId: id,
    sourceRevision: "r1",
    title: id,
    relationship: "test",
    content: id,
    estimatedTokens,
    truncated: false,
    hasMoreFromSource: true,
    relatedNote: false,
    notePaths: [],
    nodeIds: []
  };
}

function executionRequest(question = "旋度是什么意思？") {
  return {
    conversationId: "c",
    nodeId: "n",
    assistantMessageId: "a",
    contextMessages: [],
    currentQuestion: question,
    answerThinkingMode: "auto",
    streamingOutputEnabled: false,
    piContext: {
      currentQuestion: question,
      selectedQuotes: ["旋度"],
      relatedNotesAllowed: false,
      conversationNodes: [],
      noteContextGraph: {
        protocol: "note-context-graph:v1",
        rootNodeIds: ["N0"],
        fullNoteContext: true,
        relatedNotesEnabled: false,
        perNoteBudget: "full",
        maxDepth: 0,
        builtAt: "2026-08-06T00:00:00.000Z",
        nodes: [
          {
            id: "N0",
            filePath: "Math/Vector.md",
            fileName: "Vector.md",
            content: "# 向量分析\n\n## 旋度\n旋度描述局部旋转趋势。",
            contentHash: "h0",
            depth: 0,
            root: true,
            primaryChain: ["N0"],
            parentIds: [],
            outgoingNodeIds: []
          }
        ],
        edges: [],
        unresolvedLinks: []
      },
      focus: {
        interactionMode: "child",
        defaultScope: "selection_only",
        anchors: [
          {
            id: "F1",
            kind: "note-selection",
            filePath: "Math/Vector.md",
            fileName: "Vector.md",
            quote: "旋度",
            prefix: "",
            suffix: ""
          }
        ],
        targets: [
          {
            kind: "exact-selection",
            anchorId: "F1",
            text: "旋度",
            source: {
              type: "note",
              filePath: "Math/Vector.md",
              fileName: "Vector.md"
            }
          }
        ]
      }
    },
    roleId: "direct",
    route: {
      routeId: "r",
      providerProfile: {
        id: "deepseek",
        name: "DeepSeek",
        kind: "deepseek",
        apiKey: "secret",
        baseUrl: "https://api.deepseek.com"
      },
      modelId: "model"
    },
    webSearchEnabled: false
  };
}

function openAiResponse(text) {
  return {
    status: 200,
    json: {
      choices: [{ message: { content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 4 }
    }
  };
}

async function collect(iterable) {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}

void test("progressive start plans use a 30000-token evidence ceiling", () => {
  const { resolveProgressiveStartPlan } = load(
    "src/agent/pi/progressive/request-start-level.js"
  );
  const normal = resolveProgressiveStartPlan(executionRequest("旋度是什么意思？"));
  const comprehensive = resolveProgressiveStartPlan(
    executionRequest("请全面深入分析旋度。")
  );
  assert.equal(normal.maximumEvidenceTokens, 30_000);
  assert.equal(comprehensive.maximumEvidenceTokens, 30_000);
});

void test("progressive state allows expansion 50 and rejects expansion 51", () => {
  const {
    createProgressiveContextState,
    recordInitialProgressiveBatch,
    recordExpandedProgressiveBatch
  } = load("src/agent/pi/progressive/context-state.js");
  let state = createProgressiveContextState({
    initialLevel: 0,
    relatedNotesAllowed: false,
    maximumEvidenceTokens: 30_000,
    maximumExpansions: 50
  });
  state = recordInitialProgressiveBatch(state, {
    ...evidenceBatch("initial", 100),
    level: 0,
    sourceKind: "selection"
  });
  for (let index = 1; index <= 50; index += 1) {
    state = recordExpandedProgressiveBatch(
      state,
      evidenceBatch(`batch-${String(index)}`, 500)
    );
  }
  assert.equal(state.expansionCount, 50);
  assert.equal(state.expansionDisabled, true);
  assert.throws(
    () =>
      recordExpandedProgressiveBatch(
        state,
        evidenceBatch("batch-51", 1)
      ),
    /expansion limit/u
  );
});

void test("progressive state rejects evidence beyond 30000 tokens", () => {
  const {
    createProgressiveContextState,
    recordInitialProgressiveBatch,
    recordExpandedProgressiveBatch
  } = load("src/agent/pi/progressive/context-state.js");
  let state = createProgressiveContextState({
    initialLevel: 0,
    relatedNotesAllowed: false,
    maximumEvidenceTokens: 30_000,
    maximumExpansions: 50
  });
  state = recordInitialProgressiveBatch(state, {
    ...evidenceBatch("initial-budget", 29_999),
    level: 0,
    sourceKind: "selection"
  });
  state = recordExpandedProgressiveBatch(
    state,
    evidenceBatch("last-token", 1)
  );
  assert.equal(state.deliveredTokens, 30_000);
  assert.equal(state.expansionDisabled, true);

  let overBudgetState = createProgressiveContextState({
    initialLevel: 0,
    relatedNotesAllowed: false,
    maximumEvidenceTokens: 30_000,
    maximumExpansions: 50
  });
  overBudgetState = recordInitialProgressiveBatch(overBudgetState, {
    ...evidenceBatch("initial-over-budget", 29_999),
    level: 0,
    sourceKind: "selection"
  });
  assert.throws(
    () =>
      recordExpandedProgressiveBatch(
        overBudgetState,
        evidenceBatch("two-extra-tokens", 2)
      ),
    /evidence budget/u
  );
  assert.equal(overBudgetState.deliveredTokens, 29_999);
});

void test("progressive runtime advertises 50 expansions and 30000 evidence tokens by default", async () => {
  const { PiExecutionEngine } = load("src/agent/pi/pi-execution-engine.js");
  const engine = new PiExecutionEngine({
    strategy: "progressive",
    async bufferedRequest() {
      return openAiResponse("旋度描述局部旋转趋势。");
    }
  });
  const events = await collect(
    engine.execute(executionRequest(), new AbortController().signal)
  );
  const start = events.find((event) => event.type === "progressive-context-start");
  assert.ok(start, JSON.stringify(events));
  assert.equal(start.maximumExpansions, 50);
  assert.equal(start.maximumEvidenceTokens, 30_000);
});
