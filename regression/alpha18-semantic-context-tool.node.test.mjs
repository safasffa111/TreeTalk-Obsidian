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

void test("semantic context protocol exposes stable compact target descriptions", () => {
  const {
    CONTEXT_TARGETS,
    CONTEXT_TARGET_DESCRIPTIONS
  } = load("src/agent/pi/progressive/semantic-context.js");
  assert.deepEqual(CONTEXT_TARGETS, [
    "current_section",
    "current_source",
    "related_sections",
    "related_full_source"
  ]);
  assert.equal(
    CONTEXT_TARGET_DESCRIPTIONS.current_source,
    "返回当前笔记、节点或父回答的下一批正文。"
  );
  for (const description of Object.values(CONTEXT_TARGET_DESCRIPTIONS)) {
    assert.doesNotMatch(description, /L[0-4]|成本|适用|权限/u);
  }
});

function state(level){return {currentLevel:level,initialLevel:level,batchIndexByLevel:{},exhaustedLevels:[],deliveredEvidenceIds:[],deliveredTokens:0,expansionCount:0,maximumEvidenceTokens:30000,maximumExpansions:50,relatedNotesAllowed:false,expansionDisabled:false};}

void test("convergent and divergent availability expose only valid semantic targets",()=>{
  const {availableContextTargets}=load("src/agent/pi/progressive/semantic-context.js");
  const all=new Set([1,2,3,4]);
  assert.deepEqual(availableContextTargets({state:state(0),exactSelection:true,divergenceEnabled:false,availableLevels:all}).map((x)=>x.target),["current_section"]);
  assert.deepEqual(availableContextTargets({state:state(1),exactSelection:true,divergenceEnabled:false,availableLevels:all}).map((x)=>x.target),["current_source"]);
  assert.deepEqual(availableContextTargets({state:state(2),exactSelection:false,divergenceEnabled:false,availableLevels:all}).map((x)=>x.target),["current_source","related_sections"]);
  assert.deepEqual(availableContextTargets({state:state(3),exactSelection:true,divergenceEnabled:false,availableLevels:all}).map((x)=>x.target),["related_sections","related_full_source"]);
  assert.deepEqual(availableContextTargets({state:state(2),exactSelection:false,divergenceEnabled:true,availableLevels:all}).map((x)=>x.target),["current_source","related_sections","related_full_source"]);
  assert.deepEqual(availableContextTargets({state:state(2),exactSelection:false,divergenceEnabled:true,availableLevels:new Set([3])}).map((x)=>x.target),["related_sections"]);
  assert.deepEqual(availableContextTargets({state:state(1),exactSelection:true,divergenceEnabled:false,availableLevels:new Set([3])}).map((x)=>x.target),["related_sections"]);
  assert.deepEqual(availableContextTargets({state:state(2),exactSelection:false,divergenceEnabled:false,availableLevels:new Set([4])}).map((x)=>x.target),["related_full_source"]);
});

void test("request_context schema is compact, permission-aware, and availability-stable",()=>{
  const {buildRequestContextTool}=load("src/agent/pi/progressive/semantic-context.js");
  const available=[{target:"current_source",nextLevel:2},{target:"related_sections",nextLevel:3}];
  const tool=buildRequestContextTool(available,false);
  assert.equal(tool.name,"request_context");
  assert.deepEqual(tool.parameters.properties.target.enum,["current_section","current_source","related_sections","related_full_source"]);
  assert.equal(tool.description,"上下文接口：\n- current_section：返回当前框选所在的 Markdown 章节；无标题时返回附近文本。\n- current_source：返回当前笔记、节点或父回答的下一批正文。\n- related_sections：返回祖先节点的相关章节。\n- related_full_source：返回一个祖先节点的完整正文；过长时分批返回。");
  assert.doesNotMatch(tool.description,/L[0-4]|成本|适用|权限|关联笔记/u);
  const withNotes=buildRequestContextTool([{target:"related_full_source",nextLevel:4}],true);
  assert.match(withNotes.description,/祖先节点或关联笔记的完整正文/u);
  assert.deepEqual(withNotes.parameters.properties.target.enum,tool.parameters.properties.target.enum);
});

void test("request_context parser rejects unavailable targets and compact result hides diagnostics",()=>{
  const {parseRequestContextArguments,buildCompactContextToolResult}=load("src/agent/pi/progressive/semantic-context.js");
  assert.deepEqual(parseRequestContextArguments({target:"current_source",reason:"需要前文"},["current_source"]),{target:"current_source",reason:"需要前文"});
  assert.throws(()=>parseRequestContextArguments({target:"related_sections",reason:"x"},["current_source"]),/unavailable/u);
  const result=buildCompactContextToolResult({status:"expanded",message:"x",state:state(2),batch:{id:"b",level:2,sourceKind:"conversation-node",sourceId:"n",sourceRevision:"r",title:"父回答",relationship:"structural-parent-earlier",content:"正文",estimatedTokens:10,truncated:false,hasMoreFromSource:true,relatedNote:false,notePaths:[],nodeIds:["n"],requestedTarget:"current_source"}});
  assert.deepEqual(Object.keys(result).sort(),["content","remaining","scope","source"]);
  assert.deepEqual(result,{source:"父回答",scope:"partial-source",remaining:true,content:"正文"});
});
