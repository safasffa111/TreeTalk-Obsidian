import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import ts from "typescript";

const root = process.cwd();
const require = createRequire(import.meta.url);

function transpile(file) {
  return ts.transpileModule(fs.readFileSync(file, "utf8"), {
    fileName: file,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      verbatimModuleSyntax: false
    }
  }).outputText;
}

function loadStandalone(relativePath) {
  const file = path.join(root, relativePath);
  const module = { exports: {} };
  new Function("module", "exports", "require", transpile(file))(
    module,
    module.exports,
    require
  );
  return module.exports;
}

test("transient response status records are isolated by assistant message", () => {
  const { TransientResponseStatusStore } = loadStandalone(
    "src/providers/transient-response-status-store.ts"
  );
  const store = new TransientResponseStatusStore();
  let notifications = 0;
  store.subscribe(() => notifications += 1);

  store.set("assistant-a", "thinking");
  store.set("assistant-b", "searching-web");
  assert.equal(store.get("assistant-a")?.status, "thinking");
  assert.equal(store.get("assistant-b")?.status, "searching-web");
  assert.equal(notifications, 2);

  store.delete("assistant-a");
  assert.equal(store.get("assistant-a"), undefined);
  assert.equal(store.get("assistant-b")?.status, "searching-web");
  assert.equal(notifications, 3);

  store.clear();
  assert.equal(store.get("assistant-b"), undefined);
  assert.equal(notifications, 4);
});

test("conversation view exposes localized inline status behavior", () => {
  const source = fs.readFileSync(path.join(root, "src/views/conversation-view.ts"), "utf8");
  assert.match(source, /responseProgressLabel/u);
  assert.match(source, /正在准备对话上下文…/u);
  assert.match(source, /正在筛选父节点与笔记上下文…/u);
  assert.match(source, /正在判断是否需要联网…/u);
  assert.match(source, /正在搜索网页…/u);
  assert.match(source, /正在整理搜索结果…/u);
  assert.match(source, /treetalk-response-progress/u);
  assert.match(source, /message\.content\.length === 0/u);
  assert.match(source, /message\.status === "streaming"/u);
});

test("request lifecycle updates inline status and does not emit progress notices", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.ts"), "utf8");
  const engineSource = fs.readFileSync(
    path.join(root, "src/execution/legacy-execution-engine.ts"),
    "utf8"
  );
  const source = `${mainSource}\n${engineSource}`;
  assert.match(mainSource, /transientResponseStatus/u);
  assert.match(source, /"deciding-web-search"/u);
  assert.match(source, /"preparing-context"/u);
  assert.match(source, /"searching-web"/u);
  assert.match(source, /"organizing-web-results"/u);
  assert.match(source, /this\.transientResponseStatus\.delete\(messageId\)[\s\S]*this\.responseRouter\.delta/u);
  assert.doesNotMatch(source, /new Notice\("正在判断是否需要联网…"\)/u);
  assert.doesNotMatch(source, /new Notice\([\s\S]{0,120}"正在搜索网页…"/u);
  assert.doesNotMatch(source, /new Notice\([\s\S]{0,120}"正在整理搜索结果…"/u);
});

test("token details render permanent referenced note names including none", () => {
  const source = fs.readFileSync(path.join(root, "src/views/conversation-view.ts"), "utf8");
  assert.match(source, /候选上下文笔记/u);
  assert.match(source, /referencedNoteNames/u);
  assert.match(source, /join\("、"\)/u);
  assert.match(source, /"无"/u);
});
