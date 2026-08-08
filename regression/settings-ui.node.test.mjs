import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const root = process.cwd();
const srcRoot = path.join(root, "src");

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const modules = new Map();
for (const file of walk(srcRoot).filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"))) {
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

void test("legacy optimization settings normalize to full mode", () => {
  const { DEFAULT_SETTINGS, parsePluginData } = load("src/tabs/plugin-data.js");
  const parsed = parsePluginData({
    settings: {
      ...DEFAULT_SETTINGS,
      contextOptimizationEnabled: true,
      contextMode: "balanced"
    }
  });
  assert.equal(parsed.settings.contextOptimizationEnabled, false);
  assert.equal(parsed.settings.contextMode, "full");
});

void test("settings no longer expose balanced or note compression controls", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.ts"), "utf8");
  const settingsSource = fs.readFileSync(path.join(root, "src/settings-tab.ts"), "utf8");
  assert.doesNotMatch(mainSource, /\.setName\("平衡模式"\)/u);
  assert.doesNotMatch(mainSource, /\.setName\("完整笔记上下文"\)/u);
  assert.doesNotMatch(mainSource, /\.setName\("单篇笔记上下文上限"\)/u);
  assert.match(settingsSource, /name: "关联笔记"/u);
});

void test("user message bubble stays close to the rendered text size", () => {
  const styles = fs.readFileSync(path.join(root, "styles.css"), "utf8");
  const rule = styles.match(/\.treetalk-message\.is-user\s*\{([\s\S]*?)\}/u)?.[1] ?? "";

  assert.match(rule, /padding:\s*4px 10px;/u);
  assert.match(rule, /line-height:\s*1\.4;/u);
  assert.match(rule, /border-radius:\s*18px;/u);
});


test("settings and composer expose one synchronized web-search state", () => {
  const mainSource = fs.readFileSync(path.join(root, "src/main.ts"), "utf8");
  const settingsSource = fs.readFileSync(path.join(root, "src/settings-tab.ts"), "utf8");
  const viewSource = fs.readFileSync(path.join(root, "src/views/conversation-view.ts"), "utf8");
  assert.match(settingsSource, /name: "联网模式"/u);
  assert.match(settingsSource, /开启后，DeepSeek 会根据问题自动判断是否需要搜索网页。当前仅支持 DeepSeek。/u);
  assert.match(viewSource, /treetalk-web-search-toggle/u);
  assert.match(viewSource, /aria-pressed/u);
  assert.match(viewSource, /subscribe/u);
  assert.match(mainSource, /subscribeWebSearch\(listener/u);
  assert.match(settingsSource, /unsubscribeWebSearch/u);
  assert.match(settingsSource, /provider !== "deepseek"/u);
});
