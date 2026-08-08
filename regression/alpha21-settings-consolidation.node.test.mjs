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
  modules.set(id, ts.transpileModule(fs.readFileSync(file, "utf8"), {
    fileName: file,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      verbatimModuleSyntax: false
    }
  }).outputText);
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
  const localRequire = (request) => request.startsWith(".")
    ? load(resolve(id, request))
    : request === "obsidian" ? {} : require(request);
  new Function("module", "exports", "require", code)(module, module.exports, localRequire);
  return module.exports;
}

void test("old settings normalize to the alpha.21 DeepSeek Pi full-context contract", () => {
  const { parsePluginData } = load("src/tabs/plugin-data.js");
  const parsed = parsePluginData({
    settings: {
      executionMode: "legacy",
      provider: "openai",
      model: "gpt-5-mini",
      baseUrl: "https://gateway.example/v1",
      answerThinkingMode: "auto",
      contextOptimizationEnabled: true,
      contextMode: "balanced",
      fullNoteContext: false,
      noteContextTokenBudget: 256,
      lastCompressedNoteTokenBudget: 256,
      relatedNoteContextEnabled: true,
      contextDivergenceEnabled: true
    }
  });
  assert.equal(parsed.settings.executionMode, "pi");
  assert.equal(parsed.settings.provider, "deepseek");
  assert.equal(parsed.settings.model, "deepseek-v4-flash");
  assert.equal(parsed.settings.baseUrl, "https://gateway.example/v1");
  assert.equal(parsed.settings.answerThinkingMode, "disabled");
  assert.equal(parsed.settings.contextOptimizationEnabled, false);
  assert.equal(parsed.settings.contextMode, "full");
  assert.equal(parsed.settings.fullNoteContext, true);
  assert.equal(parsed.settings.noteContextTokenBudget, "full");
  assert.equal(parsed.settings.relatedNoteContextEnabled, true);
  assert.equal(parsed.settings.contextDivergenceEnabled, true);
});

void test("explicit enabled thinking survives normalization while auto becomes disabled", () => {
  const { DEFAULT_SETTINGS, normalizeTreeTalkSettings } = load("src/tabs/plugin-data.js");
  assert.equal(normalizeTreeTalkSettings({ ...DEFAULT_SETTINGS, answerThinkingMode: "enabled" }).answerThinkingMode, "enabled");
  assert.equal(normalizeTreeTalkSettings({ ...DEFAULT_SETTINGS, answerThinkingMode: "auto" }).answerThinkingMode, "disabled");
});

void test("settings expose only DeepSeek API and binary thinking", () => {
  const settings = fs.readFileSync(path.join(root, "src/settings-tab.ts"), "utf8");
  assert.match(settings, /heading: "DeepSeek API"/u);
  assert.doesNotMatch(settings, /\.setName\("执行引擎"\)/u);
  assert.doesNotMatch(settings, /\.setName\("服务类型"\)/u);
  assert.doesNotMatch(settings, /\.setName\("平衡模式"\)/u);
  assert.doesNotMatch(settings, /\.setName\("完整笔记上下文"\)/u);
  assert.doesNotMatch(settings, /\.setName\("单篇笔记上下文上限"\)/u);
  assert.match(settings, /name: "回答思考模式"[\s\S]*?type: "toggle"/u);
  assert.doesNotMatch(settings, /auto:\s*"自动"/u);
});

void test("composer removes engine switching and toggles thinking only on or off", () => {
  const view = fs.readFileSync(path.join(root, "src/views/conversation-view.ts"), "utf8");
  assert.doesNotMatch(view, /ExecutionModeControlPort/u);
  assert.doesNotMatch(view, /treetalk-execution-mode-toggle/u);
  assert.doesNotMatch(view, /executionMode:\s*HTMLButtonElement/u);
  assert.match(view, /answerThinkingMode\s*===\s*"enabled"\s*\?\s*"disabled"\s*:\s*"enabled"/u);
  assert.doesNotMatch(view, /思考模式：自动/u);
});

void test("normal send path is fixed to Pi and DeepSeek full note bodies", () => {
  const main = fs.readFileSync(path.join(root, "src/main.ts"), "utf8");
  assert.match(main, /kind:\s*"deepseek"/u);
  assert.match(main, /const executionMode\s*=\s*"pi"/u);
  assert.match(main, /fullNoteContext:\s*true/u);
  assert.match(main, /perNoteBudget:\s*"full"/u);
  assert.match(main, /const contextMode\s*=\s*"full"/u);
});
