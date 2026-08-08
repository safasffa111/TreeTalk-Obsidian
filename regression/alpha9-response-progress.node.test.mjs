import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const root = process.cwd();
function loadStandalone(relativePath) { const file=path.join(root,relativePath); const output=ts.transpileModule(fs.readFileSync(file,"utf8"),{fileName:file,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,moduleResolution:ts.ModuleResolutionKind.Node10,verbatimModuleSyntax:false}}).outputText; const module={exports:{}}; new Function("module","exports","require",output)(module,module.exports,require); return module.exports; }

test("response progress store keeps structured stage details", () => {
  const { TransientResponseStatusStore } = loadStandalone("src/providers/transient-response-status-store.ts");
  const store = new TransientResponseStatusStore();
  store.set("a", { status:"context-selected", selectedNodeCount:2, selectedNoteCount:1, supplementary:false });
  assert.deepEqual(store.get("a"), { status:"context-selected", selectedNodeCount:2, selectedNoteCount:1, supplementary:false });
});

test("conversation progress labels describe real Pi stages and selected evidence", () => {
  const source = fs.readFileSync(path.join(root,"src/views/conversation-view.ts"),"utf8");
  assert.match(source,/正在围绕框选内容确定回答焦点…/u);
  assert.match(source,/正在筛选父节点与笔记上下文…/u);
  assert.match(source,/const prefix = progress\.supplementary === true \? "已补充" : "已选择"/u);
  assert.match(source,/个节点和/u);
  assert.match(source,/篇笔记/u);
  assert.match(source,/正在读取选中的上下文…/u);
  assert.match(source,/正在组织回答…/u);
  assert.match(source,/正在补充缺失的上下文…/u);
  assert.match(source,/正在生成最终回答…/u);
  assert.doesNotMatch(source,/return "正在思考…"/u);
});
