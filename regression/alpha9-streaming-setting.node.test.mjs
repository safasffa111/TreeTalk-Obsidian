import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const root = process.cwd();
const moduleCache = new Map();
function load(relativePath) {
  if (moduleCache.has(relativePath)) return moduleCache.get(relativePath);
  const file = path.join(root, relativePath);
  const output = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    fileName: file,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.Node10, verbatimModuleSyntax: false }
  }).outputText;
  const module = { exports: {} };
  moduleCache.set(relativePath, module.exports);
  const localRequire = (request) => {
    if (!request.startsWith(".")) return {};
    const base = path.join(path.dirname(file), request);
    const resolved = path.extname(base) === ".js" ? base : `${base}.ts`;
    return load(path.relative(root, resolved).replaceAll(path.sep, "/"));
  };
  new Function("module", "exports", "require", output)(
    module,
    module.exports,
    localRequire
  );
  return module.exports;
}

test("streaming output defaults on and explicit false survives parsing", () => {
  const { DEFAULT_SETTINGS, parsePluginData } = load("src/tabs/plugin-data.ts");
  assert.equal(DEFAULT_SETTINGS.streamingOutputEnabled, true);
  assert.equal(parsePluginData({ settings: {} }).settings.streamingOutputEnabled, true);
  assert.equal(parsePluginData({ settings: { streamingOutputEnabled: false } }).settings.streamingOutputEnabled, false);
});

test("settings UI and execution request expose the streaming switch", () => {
  const main = fs.readFileSync(path.join(root, "src/main.ts"), "utf8");
  const types = fs.readFileSync(path.join(root, "src/execution/types.ts"), "utf8");
  assert.match(main, /\.setName\("流式输出"\)/u);
  assert.match(main, /开启后回答会边生成边显示；关闭后等待完整回答后一次性显示。/u);
  assert.match(main, /streamingOutputEnabled:\s*this\.pluginSettings\.streamingOutputEnabled/u);
  assert.match(types, /streamingOutputEnabled\?:\s*boolean/u);
});
