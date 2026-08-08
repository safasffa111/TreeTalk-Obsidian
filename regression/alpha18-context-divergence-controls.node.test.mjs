import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require=createRequire(import.meta.url);const ts=require("typescript");const root=process.cwd();
function walk(entry){const stat=fs.statSync(entry);if(stat.isFile())return[entry];return fs.readdirSync(entry,{withFileTypes:true}).flatMap((item)=>walk(path.join(entry,item.name)));}
const modules=new Map();for(const file of walk(path.join(root,"src")).filter((file)=>file.endsWith(".ts")&&!file.endsWith(".d.ts"))){const id=path.relative(root,file).replaceAll(path.sep,"/").replace(/\.ts$/u,".js");modules.set(id,ts.transpileModule(fs.readFileSync(file,"utf8"),{fileName:file,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,moduleResolution:ts.ModuleResolutionKind.Node10,verbatimModuleSyntax:false}}).outputText);}
const cache=new Map();function normalize(parts){const result=[];for(const part of parts){if(!part||part===".")continue;if(part==="..")result.pop();else result.push(part);}return result.join("/");}function resolve(parentId,request){const parent=parentId.split("/");parent.pop();const base=normalize([...parent,...request.split("/")]);for(const candidate of request.endsWith(".js")?[base]:[`${base}.js`,`${base}/index.js`,base])if(modules.has(candidate))return candidate;throw new Error(`Module not found: ${request} from ${parentId}`);}function load(id){if(cache.has(id))return cache.get(id).exports;const code=modules.get(id);if(code===undefined)throw new Error(`Unknown module: ${id}`);const module={exports:{}};cache.set(id,module);const localRequire=(request)=>request.startsWith(".")?load(resolve(id,request)):request==="obsidian"?{}:require(request);new Function("module","exports","require",code)(module,module.exports,localRequire);return module.exports;}
const read=(file)=>fs.readFileSync(path.join(root,file),"utf8");

void test("context divergence is a backward-compatible global setting",()=>{
  const {DEFAULT_SETTINGS,parsePluginData}=load("src/tabs/plugin-data.js");
  assert.equal(DEFAULT_SETTINGS.contextDivergenceEnabled,false);
  assert.equal(parsePluginData({settings:{}}).settings.contextDivergenceEnabled,false);
  assert.equal(parsePluginData({settings:{contextDivergenceEnabled:true}}).settings.contextDivergenceEnabled,true);
  assert.equal(parsePluginData({settings:{contextDivergenceEnabled:false}}).settings.contextDivergenceEnabled,false);
  assert.doesNotMatch(read("src/domain/types.ts"),/contextDivergenceEnabled/u);
});

void test("send freezes context divergence before mutating conversation state",()=>{
  const main=read("src/main.ts");const sendStart=main.indexOf("private async send(text: string)");const commandStart=main.indexOf("const command =",sendStart);const prefix=main.slice(sendStart,commandStart);
  assert.match(prefix,/const contextDivergenceEnabled[\s\S]*this\.pluginSettings\.contextDivergenceEnabled/u);
  assert.match(main.slice(commandStart),/contextDivergenceEnabled,/u);
  assert.match(main,/setContextDivergenceEnabled/u);
});

void test("composer and settings expose one synchronized context divergence control",()=>{
  const view=read("src/views/conversation-view.ts");const obsidian=read("src/views/obsidian-views.ts");const main=read("src/main.ts");const css=read("styles.css");
  const settings=read("src/settings-tab.ts");
  assert.match(view,/ContextDivergenceControlPort/u);assert.match(view,/treetalk-context-divergence-toggle/u);assert.match(view,/setIcon\(contextDivergence, "git-fork"\)/u);
  const order=view.indexOf("relatedNotes,\n      contextDivergence,\n      answerThinking,\n      webSearch");assert.ok(order>=0);
  assert.match(obsidian,/ContextDivergenceControlPort/u);assert.match(main,/contextDivergenceEnabled:\s*\(\)\s*=>\s*this\.pluginSettings\.contextDivergenceEnabled/u);
  assert.match(settings,/上下文发散/u);assert.match(settings,/开启后，Pi 可在当前权限范围内跨级请求可用上下文/u);
  assert.match(css,/\.treetalk-context-divergence-toggle/u);
});
