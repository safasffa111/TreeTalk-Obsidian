import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

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

void test("balanced:v3 artifact and request state survive schema parsing", () => {
  const { parseConversation } = load("src/domain/schema.js");
  const { validConversation } = load("tests/fixtures.js");
  const conversation = structuredClone(validConversation());
  const artifact = {
    protocol: "balanced:v3",
    key: "artifact-key",
    sourceType: "assistant-message",
    sourceIdentity: "root\u0000a1",
    sourceContentHash: "hash",
    protectionHash: "none",
    tier: "standard",
    content: "frozen",
    originalEstimatedTokens: 1000,
    sentEstimatedTokens: 500,
    deletionRatio: 0.5
  };
  conversation.contextArtifacts = { balancedV3: { "artifact-key": artifact } };
  conversation.nodes.root.messages = [{
    id: "u1", role: "user", content: "question", status: "complete",
    createdAt: conversation.createdAt, updatedAt: conversation.updatedAt
  }];
  conversation.nodes.root.messages[0].balancedContextState = {
    protocol: "balanced:v3",
    artifactKeys: ["artifact-key"],
    compactSourceIdentities: [],
    recoveryPatchKeys: []
  };

  const parsed = parseConversation(conversation);
  assert.deepEqual(parsed.contextArtifacts?.balancedV3?.["artifact-key"], artifact);
  assert.deepEqual(parsed.nodes.root.messages[0].balancedContextState, {
    protocol: "balanced:v3",
    artifactKeys: ["artifact-key"],
    compactSourceIdentities: [],
    recoveryPatchKeys: []
  });
});

function assistantSource(paragraphs, width = 40) {
  return Array.from({ length: paragraphs }, (_, index) =>
    `段落 ${index}\n${"普通说明内容".repeat(width)}`
  ).join("\n\n");
}

void test("balanced:v3 assistant and note artifact ratios are deterministic", () => {
  const {
    buildAssistantFreezeArtifact,
    buildNoteFreezeArtifact,
    assistantRetentionRatio,
    noteRetentionRatio
  } = load("src/domain/balanced-freeze-v3.js");

  assert.equal(assistantRetentionRatio(159, "standard"), 1);
  assert.equal(assistantRetentionRatio(300, "standard"), 0.6);
  assert.equal(assistantRetentionRatio(1000, "standard"), 0.5);
  assert.equal(assistantRetentionRatio(2200, "standard"), 0.4);
  assert.equal(assistantRetentionRatio(2200, "compact"), 0.25);
  assert.equal(noteRetentionRatio(299, "standard"), 1);
  assert.equal(noteRetentionRatio(800, "standard"), 0.6);
  assert.equal(noteRetentionRatio(1800, "standard"), 0.5);
  assert.equal(noteRetentionRatio(1800, "compact"), 0.35);

  const source = assistantSource(36, 18);
  const first = buildAssistantFreezeArtifact({
    sourceIdentity: "root\u0000a1",
    sourceContentHash: "assistant-hash",
    content: source,
    protectedRanges: [],
    tier: "standard"
  });
  const second = buildAssistantFreezeArtifact({
    sourceIdentity: "root\u0000a1",
    sourceContentHash: "assistant-hash",
    content: source,
    protectedRanges: [],
    tier: "standard"
  });
  assert.ok(first);
  assert.deepEqual(first, second);
  assert.match(first.content, /TreeTalk 已省略部分较早的回答内容/u);
  assert.ok(first.deletionRatio >= 0.32 && first.deletionRatio <= 0.68);

  const noteContent = Array.from({ length: 24 }, (_, index) =>
    `## 章节 ${index}\n\n${"笔记背景内容".repeat(30)}`
  ).join("\n\n");
  const selected = noteContent.indexOf("章节 12");
  const snapshot = {
    version: "note-snapshot-v1",
    content: noteContent,
    contentHash: "note-hash",
    selectionStartOffset: selected,
    selectionEndOffset: selected + "章节 12".length
  };
  const note = buildNoteFreezeArtifact({
    sourceIdentity: "notes/test.md\u0000note-hash",
    sourceContentHash: "note-hash",
    snapshot,
    tier: "standard"
  });
  assert.ok(note);
  assert.match(note.content, /章节 12/u);
  assert.match(note.content, /此处省略了距离框选位置较远的笔记内容/u);
  assert.ok(note.deletionRatio >= 0.32 && note.deletionRatio <= 0.58);
});

void test("balanced:v3 recovery patch preserves the exact quote and stable local context", () => {
  const { buildRecoveryPatchArtifact } = load("src/domain/balanced-freeze-v3.js");
  const source = [
    "# 标题",
    "",
    "前一段说明。",
    "",
    "需要恢复的精确原文。",
    "",
    "后一段说明。"
  ].join("\n");
  const start = source.indexOf("需要恢复");
  const input = {
    sourceIdentity: "root\u0000a1",
    sourceContentHash: "full-hash",
    sourceLabel: "节点 root / a1",
    sourceContent: source,
    startOffset: start,
    endOffset: start + "需要恢复的精确原文。".length,
    quote: "需要恢复的精确原文。"
  };
  const first = buildRecoveryPatchArtifact(input);
  const second = buildRecoveryPatchArtifact(input);
  assert.deepEqual(first, second);
  assert.match(first.content, /需要恢复的精确原文。/u);
  assert.match(first.content, /前一段说明/u);
  assert.match(first.content, /后一段说明/u);
});

void test("balanced:v3 planner keeps only the latest completed round full and persists immutable artifacts", () => {
  const { compileContextPlan } = load("src/domain/context-engine.js");
  const { applyContextPlanPersistencePatch } = load("src/domain/context-persistence.js");
  const { validConversation } = load("tests/fixtures.js");
  const conversation = structuredClone(validConversation());
  const now = conversation.createdAt;
  const oldOne = assistantSource(28, 16);
  const oldTwo = assistantSource(30, 18);
  const latest = assistantSource(8, 5);
  conversation.nodes.root.messages = [
    { id: "u1", role: "user", content: "问题一", status: "complete", createdAt: now, updatedAt: now },
    { id: "a1", role: "assistant", content: oldOne, status: "complete", createdAt: now, updatedAt: now },
    { id: "u2", role: "user", content: "问题二", status: "complete", createdAt: now, updatedAt: now },
    { id: "a2", role: "assistant", content: oldTwo, status: "complete", createdAt: now, updatedAt: now }
  ];
  conversation.nodes.child.messages = [
    { id: "u3", role: "user", content: "最近问题", status: "complete", createdAt: now, updatedAt: now },
    { id: "a3", role: "assistant", content: latest, status: "complete", createdAt: now, updatedAt: now },
    { id: "u4", role: "user", content: "当前问题", status: "complete", createdAt: now, updatedAt: now }
  ];
  const options = { mode: "balanced", systemPrompt: "规则", maxInputTokens: 30000 };
  const first = compileContextPlan(conversation, "child", options);
  assert.ok(first.persistencePatch);
  const contents = first.messages.map((message) => message.content);
  assert.equal(contents.includes(oldOne), false);
  assert.equal(contents.includes(oldTwo), false);
  assert.equal(contents.includes(latest), true);
  assert.equal(contents.includes("问题一"), true);
  assert.equal(contents.includes("问题二"), true);
  assert.equal(contents.includes("最近问题"), true);
  assert.equal(contents.at(-1), "当前问题");
  assert.ok(first.persistencePatch.artifacts.length >= 2);
  assert.equal(first.persistencePatch.currentUserMessageId, "u4");

  const persisted = applyContextPlanPersistencePatch(
    conversation,
    first.persistencePatch,
    "2026-08-01T00:00:01.000Z"
  );
  const reloaded = load("src/domain/schema.js").parseConversation(
    JSON.parse(JSON.stringify(persisted))
  );
  const second = compileContextPlan(reloaded, "child", options);
  assert.deepEqual(second.messages, first.messages);
  assert.equal(second.stablePrefixHash, first.stablePrefixHash);
  assert.equal(second.persistencePatch, undefined);
  assert.ok(reloaded.nodes.child.messages.find((message) => message.id === "u4")?.balancedContextState);
});

void test("balanced:v3 later selection adds a recovery patch without rewriting the frozen assistant", () => {
  const { compileContextPlan } = load("src/domain/context-engine.js");
  const { applyContextPlanPersistencePatch } = load("src/domain/context-persistence.js");
  const { validConversation } = load("tests/fixtures.js");
  const conversation = structuredClone(validConversation());
  const now = conversation.createdAt;
  const old = [
    "# 定义",
    "",
    ...Array.from({ length: 24 }, (_, index) =>
      index === 13
        ? "这是一段后来才框选的精确原文。"
        : `早期段落 ${index}：${"普通说明。".repeat(18)}`
    ),
    "",
    "最终结论。"
  ].join("\n\n");
  conversation.nodes.root.messages = [
    { id: "u1", role: "user", content: "问题一", status: "complete", createdAt: now, updatedAt: now },
    { id: "a1", role: "assistant", content: old, status: "complete", createdAt: now, updatedAt: now },
    { id: "u2", role: "user", content: "问题二", status: "complete", createdAt: now, updatedAt: now },
    { id: "a2", role: "assistant", content: assistantSource(20, 12), status: "complete", createdAt: now, updatedAt: now }
  ];
  conversation.nodes.child.messages = [
    { id: "u3", role: "user", content: "最近问题", status: "complete", createdAt: now, updatedAt: now },
    { id: "a3", role: "assistant", content: "最近回答", status: "complete", createdAt: now, updatedAt: now },
    { id: "u4", role: "user", content: "当前问题", status: "complete", createdAt: now, updatedAt: now }
  ];
  const options = { mode: "balanced", systemPrompt: "规则", maxInputTokens: 30000 };
  const first = compileContextPlan(conversation, "child", options);
  const persisted = applyContextPlanPersistencePatch(conversation, first.persistencePatch, "2026-08-01T00:00:01.000Z");
  const frozen = Object.values(persisted.contextArtifacts.balancedV3).find(
    (artifact) => artifact.sourceType === "assistant-message" && artifact.sourceIdentity === "root\u0000a1" && artifact.tier === "standard"
  );
  assert.ok(frozen);

  const next = structuredClone(persisted);
  next.nodes.child.messages.push(
    { id: "a4", role: "assistant", content: "当前回答", status: "complete", createdAt: now, updatedAt: now },
    {
      id: "u5",
      role: "user",
      content: "针对旧内容继续问",
      status: "complete",
      selectionContexts: [{
        messageId: "a1",
        sourceNodeId: "root",
        sourceRole: "assistant",
        basis: "rendered-text-v1",
        startOffset: old.indexOf("这是一段后来"),
        endOffset: old.indexOf("这是一段后来") + "这是一段后来才框选的精确原文。".length,
        quote: "这是一段后来才框选的精确原文。",
        prefix: "",
        suffix: "",
        contentHash: "anchor-hash"
      }],
      createdAt: now,
      updatedAt: now
    }
  );
  const second = compileContextPlan(next, "child", options);
  const sameFrozen = second.persistencePatch?.artifacts.find((artifact) => artifact.sourceIdentity === "root\u0000a1" && artifact.sourceType === "assistant-message");
  assert.equal(sameFrozen, undefined);
  const recovery = second.persistencePatch?.artifacts.find((artifact) => artifact.sourceType === "recovery-patch");
  assert.ok(recovery);
  assert.match(recovery.content, /这是一段后来才框选的精确原文。/u);
  const oldArtifactStillStored = next.contextArtifacts.balancedV3[frozen.key];
  assert.deepEqual(oldArtifactStillStored, frozen);
});

void test("selecting a historical assistant prepares the child draft on the source node", async () => {
  const { attachSelectionContext } = load("src/views/conversation-view.js");
  const { validConversation } = load("tests/fixtures.js");
  let conversation = structuredClone(validConversation());
  const now = conversation.createdAt;
  conversation.nodes.root.messages = [{
    id: "a1",
    role: "assistant",
    content: "历史回答文本",
    status: "complete",
    createdAt: now,
    updatedAt: now
  }];
  conversation.currentNodeId = "child";
  const store = {
    getSnapshot: () => conversation,
    update: (updater) => { conversation = updater(conversation); }
  };
  await attachSelectionContext(store, "a1", "历史回答文本", 0, 4);
  assert.equal(conversation.currentNodeId, "root");
  assert.equal(conversation.nodes.root.draft.mode, "child");
  assert.equal(conversation.nodes.root.draft.selectionContexts[0].sourceNodeId, "root");
  assert.equal(conversation.nodes.child.draft.selectionContexts.length, 0);
});

void test("balanced:v3 compact choices persist only on the current branch", () => {
  const { compileContextPlan } = load("src/domain/context-engine.js");
  const { applyContextPlanPersistencePatch } = load("src/domain/context-persistence.js");
  const { validConversation } = load("tests/fixtures.js");
  const conversation = structuredClone(validConversation());
  const now = conversation.createdAt;
  conversation.nodes.root.messages = [
    { id: "u1", role: "user", content: "问题一", status: "complete", createdAt: now, updatedAt: now },
    { id: "a1", role: "assistant", content: assistantSource(70, 20), status: "complete", createdAt: now, updatedAt: now },
    { id: "u2", role: "user", content: "问题二", status: "complete", createdAt: now, updatedAt: now },
    { id: "a2", role: "assistant", content: assistantSource(65, 20), status: "complete", createdAt: now, updatedAt: now }
  ];
  conversation.nodes.child.messages = [
    { id: "u3", role: "user", content: "最近问题", status: "complete", createdAt: now, updatedAt: now },
    { id: "a3", role: "assistant", content: "最近回答".repeat(40), status: "complete", createdAt: now, updatedAt: now },
    { id: "u4", role: "user", content: "当前问题", status: "complete", createdAt: now, updatedAt: now }
  ];
  const tight = compileContextPlan(conversation, "child", {
    mode: "balanced",
    systemPrompt: "规则",
    maxInputTokens: 5000
  });
  assert.ok(tight.persistencePatch);
  assert.ok(tight.persistencePatch.requestState.compactSourceIdentities.length >= 1);
  assert.ok(tight.sentEstimatedTokens <= 5000);
  const persisted = applyContextPlanPersistencePatch(conversation, tight.persistencePatch, "2026-08-01T00:00:02.000Z");

  const descendant = structuredClone(persisted);
  descendant.nodes.child.messages.push(
    { id: "a4", role: "assistant", content: "当前回答", status: "complete", createdAt: now, updatedAt: now },
    { id: "u5", role: "user", content: "后代问题", status: "complete", createdAt: now, updatedAt: now }
  );
  const inherited = compileContextPlan(descendant, "child", {
    mode: "balanced",
    systemPrompt: "规则",
    maxInputTokens: 5000
  });
  assert.deepEqual(
    inherited.persistencePatch?.requestState.compactSourceIdentities ??
      descendant.nodes.child.messages.find((message) => message.id === "u5")?.balancedContextState?.compactSourceIdentities,
    tight.persistencePatch.requestState.compactSourceIdentities
  );

  const sibling = structuredClone(persisted);
  sibling.nodes.sibling = {
    id: "sibling",
    parentId: "root",
    childIds: [],
    title: "兄弟",
    messages: [{ id: "su", role: "user", content: "兄弟问题", status: "complete", createdAt: now, updatedAt: now }],
    draft: { text: "", mode: "continue", selectionContexts: [] },
    createdAt: now,
    updatedAt: now
  };
  sibling.nodes.root.childIds.push("sibling");
  sibling.currentNodeId = "sibling";
  const siblingPlan = compileContextPlan(sibling, "sibling", {
    mode: "balanced",
    systemPrompt: "规则",
    maxInputTokens: 30000
  });
  assert.deepEqual(siblingPlan.persistencePatch?.requestState.compactSourceIdentities, []);
});

void test("balanced:v3 refuses to trim protected-only context below the hard budget", () => {
  const { compileContextPlan, ProtectedContextTooLongError } = load("src/domain/context-engine.js");
  const { validConversation } = load("tests/fixtures.js");
  const conversation = structuredClone(validConversation());
  const now = conversation.createdAt;
  conversation.nodes.root.messages = [
    { id: "u1", role: "user", content: "用户问题".repeat(1000), status: "complete", createdAt: now, updatedAt: now },
    { id: "a1", role: "assistant", content: "最近回答".repeat(1000), status: "complete", createdAt: now, updatedAt: now },
    { id: "u2", role: "user", content: "当前问题".repeat(1000), status: "complete", createdAt: now, updatedAt: now }
  ];
  conversation.nodes.child.messages = [];
  assert.throws(
    () => compileContextPlan(conversation, "root", {
      mode: "balanced",
      systemPrompt: "规则",
      maxInputTokens: 200
    }),
    (error) => error instanceof ProtectedContextTooLongError && /受保护上下文过长/u.test(error.message)
  );
});

void test("balanced:v3 persistence is flushed before the provider response starts", () => {
  const source = fs.readFileSync(path.join(root, "src/main.ts"), "utf8");
  assert.match(source, /applyContextPlanPersistencePatch/u);
  assert.match(source, /ProtectedContextTooLongError/u);
  const compileIndex = source.indexOf("compileContextPlan(");
  const applyIndex = source.indexOf("applyContextPlanPersistencePatch(");
  const schedulerFlushIndex = source.indexOf("this.persistenceScheduler.flush();", applyIndex);
  const diskFlushIndex = source.indexOf("await this.persistence.flush", applyIndex);
  const responseStartIndex = source.indexOf("this.responseRouter.start(ticket", applyIndex);
  assert.ok(compileIndex >= 0);
  assert.ok(applyIndex > compileIndex);
  assert.ok(schedulerFlushIndex > applyIndex);
  assert.ok(diskFlushIndex > schedulerFlushIndex);
  assert.ok(responseStartIndex > diskFlushIndex);
  assert.match(source, /上下文冻结保存失败/u);
  assert.match(source, /error instanceof ProtectedContextTooLongError/u);
  assert.match(source, /new Notice\(error\.message\)/u);
});

void test("balanced:v3 initial note freeze protects every selection from the first introducing message", () => {
  const { compileContextPlan } = load("src/domain/context-engine.js");
  const { validConversation } = load("tests/fixtures.js");
  const conversation = structuredClone(validConversation());
  const now = conversation.createdAt;
  const sections = Array.from({ length: 80 }, (_, index) =>
    `## 章节 ${String(index)}\n\n锚点-${String(index)} ${"笔记背景内容。".repeat(24)}`
  );
  const content = sections.join("\n\n");
  const firstQuote = "锚点-5";
  const secondQuote = "锚点-70";
  const firstStart = content.indexOf(firstQuote);
  const secondStart = content.indexOf(secondQuote);
  const makeContext = (quote, start) => ({
    sourceType: "note",
    filePath: "课程/多选笔记.md",
    fileName: "多选笔记.md",
    basis: "note-source-v1",
    startOffset: start,
    endOffset: start + quote.length,
    quote,
    prefix: "",
    suffix: "",
    contentHash: "note-v1",
    snapshot: {
      version: "note-snapshot-v1",
      content,
      contentHash: "note-v1",
      selectionStartOffset: start,
      selectionEndOffset: start + quote.length
    }
  });
  conversation.nodes.root.messages = [{
    id: "u1",
    role: "user",
    content: "综合两处内容",
    status: "complete",
    createdAt: now,
    updatedAt: now,
    selectionContexts: [
      makeContext(firstQuote, firstStart),
      makeContext(secondQuote, secondStart)
    ]
  }];
  const plan = compileContextPlan(conversation, "root", {
    mode: "balanced",
    systemPrompt: "规则",
    maxInputTokens: 30000
  });
  const noteArtifact = plan.persistencePatch?.artifacts.find(
    (artifact) => artifact.sourceType === "note-snapshot"
  );
  assert.ok(noteArtifact);
  assert.match(noteArtifact.content, /锚点-5/u);
  assert.match(noteArtifact.content, /锚点-70/u);
});
