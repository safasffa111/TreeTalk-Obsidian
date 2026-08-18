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
  const policy = fs.readFileSync(path.join(root, "src/providers/provider-network-policy.ts"), "utf8");
  const settings = fs.readFileSync(path.join(root, "src/settings-tab.ts"), "utf8");
  const types = fs.readFileSync(path.join(root, "src/execution/types.ts"), "utf8");
  assert.match(settings, /name: "流式输出"/u);
  // The MiniMax CORS workaround is documented next to the toggle so the
  // user is not surprised when MiniMax answers stop streaming. The notice
  // is concatenated across string literals, so we check the disjoint parts.
  assert.match(
    settings,
    /MiniMax 官方 Anthropic 端点（api\.minimaxi\.com\/anthropic）/u
  );
  assert.match(
    settings,
    /因 Obsidian CORS 限制会自动改用非流式 buffered 模式回答/u
  );
  // The execution request no longer forwards the raw toggle; it resolves
  // the effective value through the network policy so the MiniMax official
  // Anthropic endpoint falls back to buffered transport automatically.
  assert.match(
    main,
    /resolveExecutionRequestStreaming\(\s*this\.pluginSettings\.streamingOutputEnabled/u
  );
  assert.match(main, /resolveExecutionRequestStreaming/u);
  assert.match(policy, /MINIMAX_OFFICIAL_HOST\s*=\s*"api\.minimaxi\.com"/u);
  assert.match(policy, /\/anthropic/u);
  assert.match(types, /streamingOutputEnabled\?:\s*boolean/u);
});
