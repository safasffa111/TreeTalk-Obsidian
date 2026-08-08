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

const selection = {
  messageId: "assistant-1",
  sourceNodeId: "child",
  sourceRole: "assistant",
  basis: "rendered-text-v1",
  startOffset: 0,
  endOffset: 4,
  quote: "选区内容",
  prefix: "",
  suffix: "",
  contentHash: "hash"
};

void test("message selections own child mode until their final chip is removed", () => {
  const commands = load("src/domain/tree-commands.js");
  const { selectionContextKey } = load("src/domain/draft-contexts.js");
  const { validConversation } = load("tests/fixtures.js");
  const selected = commands.addSelectionToDraft(validConversation(), "child", selection, "2026-08-02T00:00:00.000Z");
  const prepared = commands.prepareSelectionChildDraft(selected, {
    nodeId: "child",
    now: "2026-08-02T00:00:01.000Z"
  });
  assert.equal(prepared.nodes.child.draft.mode, "child");
  assert.equal(prepared.nodes.child.draft.selectionModeBeforeCapture, "continue");

  const removed = commands.removeSelectionFromDraft(
    prepared,
    "child",
    selectionContextKey(selection),
    "2026-08-02T00:00:02.000Z"
  );
  assert.equal(removed.nodes.child.draft.mode, "continue");
  assert.equal(removed.nodes.child.draft.selectionModeBeforeCapture, undefined);
});

void test("manual branch toggling clears automatic selection restoration ownership", () => {
  const commands = load("src/domain/tree-commands.js");
  const { selectionContextKey } = load("src/domain/draft-contexts.js");
  const { validConversation } = load("tests/fixtures.js");
  const selected = commands.addSelectionToDraft(validConversation(), "child", selection, "2026-08-02T00:00:00.000Z");
  const prepared = commands.prepareSelectionChildDraft(selected, {
    nodeId: "child",
    now: "2026-08-02T00:00:01.000Z"
  });
  const toggled = commands.toggleBranchDraft(prepared, "child", "2026-08-02T00:00:02.000Z");
  assert.equal(toggled.nodes.child.draft.mode, "continue");
  assert.equal(toggled.nodes.child.draft.selectionModeBeforeCapture, undefined);

  const removed = commands.removeSelectionFromDraft(
    toggled,
    "child",
    selectionContextKey(selection),
    "2026-08-02T00:00:03.000Z"
  );
  assert.equal(removed.nodes.child.draft.mode, "continue");
});

void test("selection branch restoration metadata survives schema parsing", () => {
  const { parseConversation } = load("src/domain/schema.js");
  const { validConversation } = load("tests/fixtures.js");
  const value = validConversation();
  value.nodes.child.draft.mode = "child";
  value.nodes.child.draft.selectionModeBeforeCapture = "continue";
  assert.equal(
    parseConversation(value).nodes.child.draft.selectionModeBeforeCapture,
    "continue"
  );
});

void test("conversation UI uses contextmenu and no longer intercepts Alt+F", () => {
  const source = fs.readFileSync(path.join(root, "src/views/conversation-view.ts"), "utf8");
  assert.match(source, /container\.addEventListener\("contextmenu"/u);
  assert.doesNotMatch(source, /inputRow\.addEventListener\("contextmenu"/u);
  assert.match(source, /toggleBranch/u);
  assert.doesNotMatch(source, /handleBranchShortcut|event\.altKey/u);
});

void test("plugin exports and registers the native branch command", () => {
  const source = fs.readFileSync(path.join(root, "src/main.ts"), "utf8");
  assert.match(source, /toggleBranch:\s*"toggle-current-branch"/u);
  assert.match(source, /name:\s*"创建或关闭当前分支"/u);
  assert.match(source, /toggleActiveBranch/u);
});
