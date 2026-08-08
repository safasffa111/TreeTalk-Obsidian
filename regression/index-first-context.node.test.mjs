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

function noteGraph() {
  return {
    protocol: "note-context-graph:v1",
    rootNodeIds: ["note-root"],
    fullNoteContext: true,
    relatedNotesEnabled: true,
    perNoteBudget: "full",
    maxDepth: 2,
    builtAt: "2026-08-04T00:00:00.000Z",
    nodes: [
      {
        id: "note-root",
        filePath: "Math/Gauss.md",
        fileName: "Gauss.md",
        content: "# Gauss\n\nPRIVATE_GAUSS_BODY_" + "A".repeat(6000) + "\n\n## 结论\n高斯公式把内部散度与边界通量联系起来。\n\n## 推导\nPRIVATE_DERIVATION_" + "D".repeat(2000),
        contentHash: "h0",
        depth: 0,
        root: true,
        primaryChain: ["note-root"],
        parentIds: ["note-back"],
        outgoingNodeIds: []
      },
      {
        id: "note-back",
        filePath: "Physics/Field.md",
        fileName: "Field.md",
        content: "# Field\n\nPRIVATE_FIELD_BODY_WITHOUT_CONCLUSION_" + "F".repeat(4000),
        contentHash: "h1",
        depth: 1,
        root: false,
        primaryParentId: "note-root",
        primaryChain: ["note-root", "note-back"],
        parentIds: [],
        outgoingNodeIds: ["note-root"]
      }
    ],
    edges: [{ sourceNodeId: "note-back", targetNodeId: "note-root", labels: ["backlink"] }],
    unresolvedLinks: []
  };
}

function conversation() {
  const now = "2026-08-04T00:00:00.000Z";
  return {
    schemaVersion: 1,
    id: "conversation",
    title: "Math",
    status: "active",
    revision: 1,
    checksum: "checksum",
    createdAt: now,
    updatedAt: now,
    rootNodeId: "root",
    currentNodeId: "child",
    nodes: {
      root: {
        id: "root",
        parentId: null,
        childIds: ["child", "sibling"],
        title: "散度基础",
        messages: [
          { id: "u0", role: "user", content: "什么是散度？", status: "complete", createdAt: now, updatedAt: now },
          { id: "a0", role: "assistant", content: "PRIVATE_ROOT_ANSWER\n\n## 结论\n散度衡量局部净流出。", status: "complete", createdAt: now, updatedAt: now }
        ],
        draft: { text: "", mode: "continue", selectionContexts: [] },
        createdAt: now,
        updatedAt: now
      },
      child: {
        id: "child",
        parentId: "root",
        childIds: [],
        title: "高斯关系",
        messages: [
          { id: "u1", role: "user", content: "高斯公式是什么？", status: "complete", createdAt: now, updatedAt: now }
        ],
        draft: { text: "", mode: "continue", selectionContexts: [] },
        createdAt: now,
        updatedAt: now
      },
      sibling: {
        id: "sibling",
        parentId: "root",
        childIds: [],
        title: "不相关分支",
        messages: [
          { id: "u2", role: "user", content: "PRIVATE_SIBLING", status: "complete", createdAt: now, updatedAt: now }
        ],
        draft: { text: "", mode: "continue", selectionContexts: [] },
        createdAt: now,
        updatedAt: now
      }
    },
    ui: { expandedNodeIds: [], treeScrollTop: 0, messageScrollTopByNode: {} }
  };
}

test("explicit Markdown conclusion sections are extracted without adjacent body", () => {
  const { extractMarkdownConclusion, extractMarkdownSection } = load("src/agent/pi/context-index.js");
  const markdown = "# Note\nPRIVATE_INTRO\n\n## 核心结论\n结论正文\n\n### 子项\n仍属结论\n\n## 证据\nPRIVATE_EVIDENCE";
  const conclusion = extractMarkdownConclusion(markdown);
  assert.equal(conclusion.heading, "核心结论");
  assert.match(conclusion.content, /结论正文/u);
  assert.match(conclusion.content, /仍属结论/u);
  assert.doesNotMatch(conclusion.content, /PRIVATE_INTRO|PRIVATE_EVIDENCE/u);
  assert.equal(extractMarkdownSection(markdown, "证据").content, "PRIVATE_EVIDENCE");
  assert.equal(extractMarkdownConclusion("# Note\nNo conclusion"), undefined);
});

test("conversation snapshots include only the current branch", () => {
  const { buildPiConversationNodeSnapshots } = load("src/agent/pi/context-index.js");
  const snapshots = buildPiConversationNodeSnapshots(conversation(), "child");
  assert.deepEqual(snapshots.map((node) => node.id), ["root", "child"]);
  assert.equal(snapshots[0].messages[1].content.includes("PRIVATE_ROOT_ANSWER"), true);
  assert.equal(JSON.stringify(snapshots).includes("PRIVATE_SIBLING"), false);
});

test("Markdown selector index exposes stable identities and headings but no conclusion or body text", () => {
  const { buildPiConversationNodeSnapshots } = load("src/agent/pi/context-index.js");
  const { PiContextWorkspace } = load("src/agent/pi/context-workspace.js");
  const workspace = new PiContextWorkspace(
    noteGraph(),
    buildPiConversationNodeSnapshots(conversation(), "child")
  );
  const index = workspace.catalogText();
  assert.match(index, /^# Stable Note Catalog/mu);
  assert.match(index, /# Dynamic Conversation Branch/u);
  assert.match(index, /## N-[0-9a-f]{10} · 散度基础/u);
  assert.match(index, /- 深度：0/u);
  assert.match(index, /- 与焦点关系：用户框选源笔记/u);
  assert.match(index, /# Stable Note Catalog/u);
  assert.match(index, /## P-[0-9a-f]{10} · Gauss\.md/u);
  assert.match(index, /- 一级\/二级标题：Gauss；结论；推导/u);
  assert.match(index, /## P-[0-9a-f]{10} · Field\.md/u);
  assert.doesNotMatch(index, /散度衡量局部净流出|高斯公式把内部散度与边界通量联系起来|PRIVATE_GAUSS_BODY|PRIVATE_DERIVATION|PRIVATE_FIELD_BODY|PRIVATE_ROOT_ANSWER/u);
});

test("Pi reads hidden note sections and node transcripts only through frozen tools", async () => {
  const { buildPiConversationNodeSnapshots } = load("src/agent/pi/context-index.js");
  const { PiContextWorkspace } = load("src/agent/pi/context-workspace.js");
  const workspace = new PiContextWorkspace(
    noteGraph(),
    buildPiConversationNodeSnapshots(conversation(), "child")
  );
  const section = JSON.parse((await workspace.execute("read_context_note_section", {
    path: "Math/Gauss.md",
    heading: "推导"
  })).content);
  assert.match(section.content, /PRIVATE_DERIVATION/u);

  const nodeResult = await workspace.execute("read_context_node", { nodeId: "root" });
  const node = JSON.parse(nodeResult.content);
  assert.match(node.content, /PRIVATE_ROOT_ANSWER/u);
  assert.deepEqual(nodeResult.details.nodeIds, ["root"]);

  await assert.rejects(
    () => workspace.execute("read_context_node", { nodeId: "sibling" }),
    /outside the frozen TreeTalk context/u
  );
});

test("Pi selector sees only the index and the clean answer pass receives chosen node evidence", async () => {
  const { buildPiConversationNodeSnapshots } = load("src/agent/pi/context-index.js");
  const { PiExecutionEngine } = load("src/agent/pi/pi-execution-engine.js");
  const requests = [];
  const replies = [
    {
      status: 200,
      json: {
        choices: [{
          message: {
            content: JSON.stringify({
              notes: [],
              nodes: [{ id: "N1", priority: "essential", parts: ["answer"], reason: "contains the previous conclusion" }]
            })
          },
          finish_reason: "stop"
        }],
        usage: { prompt_tokens: 10, completion_tokens: 2 }
      }
    },
    {
      status: 200,
      json: {
        choices: [{ message: { content: "最终答案" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 4 }
      }
    }
  ];
  const engine = new PiExecutionEngine({
    strategy: "two-pass",
    bufferedRequest: async (request) => {
      requests.push(request);
      return replies.shift();
    },
    now: () => "2026-08-04T00:00:00.000Z"
  });
  const events = [];
  for await (const event of engine.execute({
    conversationId: "conversation",
    nodeId: "child",
    assistantMessageId: "assistant",
    contextMessages: [
      { role: "system", content: "TREE_SYSTEM" },
      { role: "user", content: "PRIVATE_HISTORICAL_USER" },
      { role: "assistant", content: "PRIVATE_HISTORICAL_ASSISTANT" },
      { role: "user", content: "PRIVATE_COMPILED_CURRENT_CONTEXT" }
    ],
    piContext: {
      currentQuestion: "CURRENT_QUESTION",
      selectedQuotes: ["EXACT_QUOTE"],
      conversationNodes: buildPiConversationNodeSnapshots(conversation(), "child"),
      noteContextGraph: noteGraph()
    },
    roleId: "direct",
    route: {
      routeId: "default",
      providerProfile: {
        id: "default",
        name: "Default",
        kind: "openai",
        apiKey: "secret",
        baseUrl: ""
      },
      modelId: "gpt-test"
    },
    webSearchEnabled: false
  }, new AbortController().signal)) events.push(event);

  const firstPayload = JSON.stringify(requests[0].body);
  assert.match(firstPayload, /CURRENT_QUESTION|EXACT_QUOTE|Stable Note Catalog/u);
  assert.match(firstPayload, /- 与焦点关系：|- 一级\/二级标题：/u);
  assert.doesNotMatch(firstPayload, /散度衡量局部净流出|高斯公式把内部散度/u);
  assert.doesNotMatch(firstPayload, /PRIVATE_HISTORICAL_USER|PRIVATE_HISTORICAL_ASSISTANT|PRIVATE_COMPILED_CURRENT_CONTEXT/u);
  assert.doesNotMatch(firstPayload, /PRIVATE_ROOT_ANSWER|PRIVATE_GAUSS_BODY|PRIVATE_DERIVATION|PRIVATE_FIELD_BODY/u);

  const secondPayload = JSON.stringify(requests[1].body);
  assert.match(secondPayload, /PRIVATE_ROOT_ANSWER/u);
  assert.doesNotMatch(secondPayload, /Stable Note Catalog|PRIVATE_GAUSS_BODY|PRIVATE_FIELD_BODY/u);
  const routing = events.find((event) => event.type === "context-routing");
  assert.deepEqual(routing.materializedNodeIds, ["root"]);
  assert.equal(events.some((event) => event.type === "tool-end"), false);
});

test("Pi index context plan bypasses full conversation compilation", () => {
  const { buildPiIndexContextPlan } = load("src/agent/pi/index-context-plan.js");
  const built = buildPiIndexContextPlan({
    conversation: conversation(),
    currentNodeId: "child",
    currentQuestion: "CURRENT_QUESTION",
    selectedQuotes: ["EXACT_QUOTE"],
    noteContextGraph: noteGraph(),
    systemPrompt: "TREE_SYSTEM",
    mode: "balanced"
  });
  assert.deepEqual(built.contextPlan.messages, [{ role: "system", content: "TREE_SYSTEM" }]);
  assert.equal(built.conversationNodes.length, 2);
  assert.ok(built.contextPlan.fullEstimatedTokens > built.contextPlan.sentEstimatedTokens);
  assert.doesNotMatch(JSON.stringify(built.contextPlan.messages), /PRIVATE_ROOT_ANSWER|PRIVATE_GAUSS_BODY/u);
  assert.match(built.indexText, /Stable Note Catalog/u);
});
