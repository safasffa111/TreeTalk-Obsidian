import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const root = process.cwd();
function walk(entry) { const stat=fs.statSync(entry); if (stat.isFile()) return [entry]; return fs.readdirSync(entry,{withFileTypes:true}).flatMap((item)=>walk(path.join(entry,item.name))); }
const modules=new Map();
for (const file of walk(path.join(root,"src")).filter((file)=>file.endsWith(".ts")&&!file.endsWith(".d.ts"))) {
  const id=path.relative(root,file).replaceAll(path.sep,"/").replace(/\.ts$/u,".js");
  modules.set(id,ts.transpileModule(fs.readFileSync(file,"utf8"),{fileName:file,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,moduleResolution:ts.ModuleResolutionKind.Node10,verbatimModuleSyntax:false}}).outputText);
}
const cache=new Map();
function normalize(parts){const result=[];for(const part of parts){if(!part||part===".")continue;if(part==="..")result.pop();else result.push(part);}return result.join("/");}
function resolve(parentId,request){const parent=parentId.split("/");parent.pop();const base=normalize([...parent,...request.split("/")]);for(const candidate of request.endsWith(".js")?[base]:[`${base}.js`,`${base}/index.js`,base])if(modules.has(candidate))return candidate;throw new Error(`Module not found: ${request} from ${parentId}`);}
function load(id){if(cache.has(id))return cache.get(id).exports;const code=modules.get(id);if(code===undefined)throw new Error(`Unknown module: ${id}`);const module={exports:{}};cache.set(id,module);const localRequire=(request)=>request.startsWith(".")?load(resolve(id,request)):request==="obsidian"?{}:require(request);new Function("module","exports","require",code)(module,module.exports,localRequire);return module.exports;}

function evidenceBatch({ id, level, estimatedTokens=100, relatedNote=false }) {
  return { id, level, sourceKind: level === 0 ? "selection" : "section", sourceId: id, sourceRevision: "r1", title: id, relationship: "test", content: id, estimatedTokens, truncated: false, hasMoreFromSource: false, relatedNote, notePaths: [], nodeIds: [] };
}
function baseRequest(question, { selection=true, relatedNotes=true }={}) {
  return {
    conversationId:"c",nodeId:"n",assistantMessageId:"a",contextMessages:[],currentQuestion:question,roleId:"direct",webSearchEnabled:false,
    route:{routeId:"r",providerProfile:{id:"d",name:"DeepSeek",kind:"deepseek",apiKey:"secret",baseUrl:""},modelId:"m"},
    piContext:{currentQuestion:question,selectedQuotes:selection?["旋度"]:[],relatedNotesAllowed:relatedNotes,conversationNodes:[],focus:selection?{interactionMode:"child",defaultScope:"selection_only",anchors:[{id:"F1",kind:"note-selection",filePath:"A.md",fileName:"A.md",quote:"旋度",prefix:"",suffix:""}],targets:[{kind:"exact-selection",anchorId:"F1",text:"旋度",source:{type:"note",filePath:"A.md",fileName:"A.md"}}]}:undefined}
  };
}

void test("progressive state rejects duplicate and over-budget evidence", () => {
  const {createProgressiveContextState,recordInitialProgressiveBatch,recordExpandedProgressiveBatch}=load("src/agent/pi/progressive/context-state.js");
  const state=createProgressiveContextState({initialLevel:0,relatedNotesAllowed:true,maximumEvidenceTokens:1000,maximumExpansions:4});
  const batch=evidenceBatch({id:"section:a",level:1,estimatedTokens:600});
  const initial=recordInitialProgressiveBatch(state,batch);
  assert.equal(initial.deliveredTokens,600);
  assert.equal(initial.expansionCount,0);
  assert.throws(()=>recordExpandedProgressiveBatch(initial,batch),/already delivered/u);
  assert.throws(()=>recordExpandedProgressiveBatch(initial,evidenceBatch({id:"section:b",level:2,estimatedTokens:500})),/evidence budget/u);
});

void test("progressive start level stays minimal and respects related-note permission", () => {
  const { resolveProgressiveStartPlan }=load("src/agent/pi/progressive/request-start-level.js");
  assert.equal(resolveProgressiveStartPlan(baseRequest("旋度是什么意思？")).initialLevel,0);
  assert.equal(resolveProgressiveStartPlan(baseRequest("这里为什么这样写？")).initialLevel,1);
  assert.equal(resolveProgressiveStartPlan(baseRequest("结合这篇笔记总结全文")).initialLevel,2);
  assert.equal(resolveProgressiveStartPlan(baseRequest("联系相关笔记比较这些概念",{relatedNotes:true})).initialLevel,3);
  assert.equal(resolveProgressiveStartPlan(baseRequest("联系相关笔记比较这些概念",{relatedNotes:false})).initialLevel,2);
  assert.equal(resolveProgressiveStartPlan(baseRequest("把这段长内容改写得更清楚")).initialLevel,0);
});

void test("section locator ignores fenced headings and resolves duplicate quote context", () => {
  const { locateMarkdownContainingSection, locateQuoteOffset, extractLocalMarkdownWindow }=load("src/agent/pi/progressive/section-locator.js");
  const markdown="## Real\nfirst\n```md\n# Fake\n```\nselected\n## Next\nend";
  const section=locateMarkdownContainingSection(markdown,markdown.indexOf("selected"));
  assert.equal(section.heading,"Real");
  assert.match(section.content,/selected/u);
  assert.doesNotMatch(section.content,/## Next/u);
  const duplicate="alpha target omega\n\nbeta target gamma";
  assert.equal(locateQuoteOffset(duplicate,{quote:"target",prefix:"beta ",suffix:" gamma"}),duplicate.lastIndexOf("target"));
  assert.match(extractLocalMarkdownWindow("one\n\ntwo target here\n\nthree",5,{quote:"target",prefix:"two ",suffix:" here"}),/two target here/u);
});

void test("workspace progressive snapshot stays frozen and deterministic", () => {
  const { PiContextWorkspace }=load("src/agent/pi/context-workspace.js");
  const workspace=new PiContextWorkspace({protocol:"note-context-graph:v1",rootNodeIds:["n0"],fullNoteContext:true,relatedNotesEnabled:true,perNoteBudget:"full",maxDepth:2,builtAt:"x",nodes:[
    {id:"n1",filePath:"Related.md",fileName:"Related.md",content:"# Related",contentHash:"h1",depth:1,root:false,primaryParentId:"n0",primaryChain:["n0","n1"],parentIds:[],outgoingNodeIds:[]},
    {id:"n0",filePath:"Root.md",fileName:"Root.md",content:"# Root",contentHash:"h0",depth:0,root:true,primaryChain:["n0"],parentIds:[],outgoingNodeIds:[]}
  ],edges:[],unresolvedLinks:[]},[
    {id:"current",parentId:"parent",title:"Current",depth:2,root:false,current:true,messages:[]},
    {id:"root",parentId:null,title:"Root",depth:0,root:true,current:false,messages:[]},
    {id:"parent",parentId:"root",title:"Parent",depth:1,root:false,current:false,messages:[]}
  ]);
  const snapshot=workspace.progressiveSnapshot();
  assert.deepEqual(snapshot.notes.map((note)=>note.filePath),["Root.md","Related.md"]);
  assert.deepEqual(snapshot.conversationNodes.map((node)=>node.id),["root","parent","current"]);
  assert.equal(snapshot.notes.every((note)=>!note.filePath.startsWith("/")),true);
});

void test("batch planner begins at exact target and expands sections before whole sources", () => {
  const { PiContextWorkspace }=load("src/agent/pi/context-workspace.js");
  const { ProgressiveContextBatchPlanner }=load("src/agent/pi/progressive/context-batch-planner.js");
  const { createProgressiveContextState,recordInitialProgressiveBatch,recordExpandedProgressiveBatch }=load("src/agent/pi/progressive/context-state.js");
  const req=baseRequest("旋度是什么意思？");
  req.piContext.noteContextGraph={protocol:"note-context-graph:v1",rootNodeIds:["n0"],fullNoteContext:true,relatedNotesEnabled:true,perNoteBudget:"full",maxDepth:2,builtAt:"x",nodes:[{id:"n0",filePath:"A.md",fileName:"A.md",content:"# 向量\n\n## 定义\n散度定义。\n\n## 旋度\n旋度描述局部旋转。\n\n## 结论\n最后总结。",contentHash:"h0",depth:0,root:true,primaryChain:["n0"],parentIds:[],outgoingNodeIds:[]}],edges:[],unresolvedLinks:[]};
  req.piContext.focus.anchors[0].selectionStartOffset=req.piContext.noteContextGraph.nodes[0].content.indexOf("旋度描述");
  req.piContext.focus.anchors[0].selectionEndOffset=req.piContext.focus.anchors[0].selectionStartOffset+2;
  const workspace=new PiContextWorkspace(req.piContext.noteContextGraph,[]);
  const planner=new ProgressiveContextBatchPlanner(req,workspace);
  let state=createProgressiveContextState({initialLevel:0,relatedNotesAllowed:true,maximumEvidenceTokens:8000,maximumExpansions:4});
  const l0=planner.buildInitialEvidence(state);
  assert.equal(l0.level,0);
  assert.match(l0.content,/旋度/u);
  assert.doesNotMatch(l0.content,/散度定义/u);
  state=recordInitialProgressiveBatch(state,l0);
  const l1=planner.nextBatch(state);
  assert.equal(l1.level,1);
  assert.match(l1.content,/旋度描述局部旋转/u);
  state=recordExpandedProgressiveBatch(state,l1);
  const l2=planner.nextBatch(state);
  assert.equal(l2.level,2);
  assert.notEqual(l2.id,l1.id);
});

void test("external ranker excludes related notes when permission is off", () => {
  const { rankExternalEvidenceCandidates }=load("src/agent/pi/progressive/external-evidence-ranker.js");
  const snapshot={notes:[{id:"r",filePath:"Related.md",fileName:"Related.md",depth:1,root:false,primaryParentId:"root",content:"## 散度\n散度与源强有关",revision:"hr"}],edges:[],conversationNodes:[
    {id:"parent",parentId:null,title:"Parent",depth:0,root:true,current:false,messages:[{id:"m",role:"assistant",content:"## 散度\n父节点解释散度",status:"complete",selectionQuotes:[]}]},
    {id:"current",parentId:"parent",title:"Current",depth:1,root:false,current:true,messages:[]}
  ]};
  const ranked=rankExternalEvidenceCandidates({question:"散度与源强有什么关系",targetText:"散度",relatedNotesAllowed:false,snapshot});
  assert.equal(ranked.some((entry)=>entry.relatedNote),false);
  assert.equal(ranked[0].relationship,"ancestor-distance-1");
});

void test("progressive prompt exposes only compact semantic context interfaces and no selector protocol", () => {
  const { buildRequestContextTool, parseRequestContextArguments, buildCompactContextToolResult }=load("src/agent/pi/progressive/semantic-context.js");
  const { buildProgressiveSystemPrompt, buildProgressiveInitialUserMessage }=load("src/agent/pi/progressive/progressive-prompts.js");
  const tool=buildRequestContextTool([{target:"current_section",nextLevel:1}],false);
  assert.equal(tool.name,"request_context");
  assert.deepEqual(tool.parameters.required,["target","reason"]);
  assert.deepEqual(parseRequestContextArguments({target:"current_section",reason:"缺少局部定义"},["current_section"]),{target:"current_section",reason:"缺少局部定义"});
  assert.throws(()=>parseRequestContextArguments({target:"current_section",reason:""},["current_section"]),/reason/u);
  const system=buildProgressiveSystemPrompt();
  assert.match(system,/信息足够.*必须直接回答/u);
  assert.doesNotMatch(system,/TT_MODE|read_context_note|search_context_notes|Selector|expand_context/u);
  const initial=buildProgressiveInitialUserMessage({question:"旋度是什么意思？",exactTargetText:"旋度",initialEvidence:evidenceBatch({id:"l0",level:0}),contextDivergenceEnabled:false});
  assert.match(initial,/旋度是什么意思/u);
  assert.match(initial,/回答对象/u);
  const result=buildCompactContextToolResult({status:"expanded",state:{currentLevel:1,initialLevel:0,batchIndexByLevel:{},exhaustedLevels:[],deliveredEvidenceIds:["x"],deliveredTokens:10,expansionCount:1,maximumEvidenceTokens:100,maximumExpansions:4,relatedNotesAllowed:true,expansionDisabled:false},batch:{...evidenceBatch({id:"x",level:1}),title:"当前章节",sourceKind:"section",hasMoreFromSource:false},message:"ok"});
  assert.deepEqual(Object.keys(result).sort(),["content","remaining","scope","source"]);
  assert.equal(result.content,"x");
});

void test("progressive benchmark contains fifty labeled cases across every required category", () => {
  const cases = JSON.parse(fs.readFileSync(path.join(root, "benchmarks/pi-progressive-cases.json"), "utf8"));
  assert.equal(cases.length >= 50, true);
  assert.equal(new Set(cases.map((entry) => entry.id)).size, cases.length);
  assert.deepEqual(
    new Set(cases.map((entry) => entry.category)),
    new Set([
      "term-definition",
      "formula-symbol",
      "local-reference",
      "whole-note",
      "parent-followup",
      "ancestor-chain",
      "related-note-comparison",
      "irrelevant-note-noise",
      "long-source",
      "insufficient-evidence"
    ])
  );
  for (const entry of cases) {
    assert.equal(typeof entry.question, "string");
    assert.equal(typeof entry.selection, "string");
    assert.equal([0, 1, 2, 3, 4].includes(entry.expectedStartLevel), true);
    assert.equal(typeof entry.relatedNotesAllowed, "boolean");
    assert.equal(typeof entry.qualityRubric, "string");
  }
});

void test("L2 continues the undisclosed remainder of a long L1 section without repeating its delivered prefix", () => {
  const { PiContextWorkspace }=load("src/agent/pi/context-workspace.js");
  const { ProgressiveContextBatchPlanner }=load("src/agent/pi/progressive/context-batch-planner.js");
  const { createProgressiveContextState,recordInitialProgressiveBatch,recordExpandedProgressiveBatch }=load("src/agent/pi/progressive/context-state.js");
  const req=baseRequest("解释旋度并在必要时继续查看本节。");
  const repeated = Array.from({length:900},(_,index)=>`局部旋转说明${String(index)}`).join("，");
  const tail = "本节末尾唯一结论：旋度方向遵循右手定则。";
  const content = `## 旋度\n开头唯一内容。${repeated}。${tail}`;
  req.piContext.noteContextGraph={protocol:"note-context-graph:v1",rootNodeIds:["n0"],fullNoteContext:true,relatedNotesEnabled:false,perNoteBudget:"full",maxDepth:0,builtAt:"x",nodes:[{id:"n0",filePath:"A.md",fileName:"A.md",content,contentHash:"h0",depth:0,root:true,primaryChain:["n0"],parentIds:[],outgoingNodeIds:[]}],edges:[],unresolvedLinks:[]};
  req.piContext.focus.anchors[0].selectionStartOffset=content.indexOf("旋度");
  req.piContext.focus.anchors[0].selectionEndOffset=req.piContext.focus.anchors[0].selectionStartOffset+2;
  const planner=new ProgressiveContextBatchPlanner(req,new PiContextWorkspace(req.piContext.noteContextGraph,[]));
  let state=createProgressiveContextState({initialLevel:0,relatedNotesAllowed:false,maximumEvidenceTokens:20000,maximumExpansions:20});
  state=recordInitialProgressiveBatch(state,planner.buildInitialEvidence(state));
  const l1=planner.nextBatch(state);
  assert.equal(l1.level,1);
  assert.equal(l1.truncated,true);
  state=recordExpandedProgressiveBatch(state,l1);
  const l2=planner.nextBatch(state);
  assert.equal(l2.level,2);
  assert.doesNotMatch(l2.content,/开头唯一内容/u);
  const allL2=[l2];
  let nextState=recordExpandedProgressiveBatch(state,l2);
  while (true) {
    let next;
    try { next=planner.nextBatch(nextState); } catch { break; }
    if (next.level!==2) break;
    allL2.push(next);
    nextState=recordExpandedProgressiveBatch(nextState,next);
  }
  assert.match(allL2.map((batch)=>batch.content).join("\n"),/本节末尾唯一结论/u);
});

void test("external ranker considers only the current node's true ancestor chain", () => {
  const { rankExternalEvidenceCandidates }=load("src/agent/pi/progressive/external-evidence-ranker.js");
  const snapshot={notes:[],edges:[],conversationNodes:[
    {id:"root",parentId:null,title:"Root",depth:0,root:true,current:false,messages:[]},
    {id:"parent",parentId:"root",title:"Parent",depth:1,root:false,current:false,messages:[{id:"p",role:"assistant",content:"## 旋度\n真正的祖先说明",status:"complete",selectionQuotes:[]}]},
    {id:"sibling",parentId:"root",title:"Sibling",depth:1,root:false,current:false,messages:[{id:"s",role:"assistant",content:"## 旋度\n不在当前分支上的高匹配内容",status:"complete",selectionQuotes:[]}]},
    {id:"current",parentId:"parent",title:"Current",depth:2,root:false,current:true,messages:[]}
  ]};
  const ranked=rankExternalEvidenceCandidates({question:"旋度是什么",targetText:"旋度",relatedNotesAllowed:false,snapshot});
  assert.equal(ranked.some((entry)=>entry.sourceId==="parent"),true);
  assert.equal(ranked.some((entry)=>entry.sourceId==="root"),true);
  assert.equal(ranked.some((entry)=>entry.sourceId==="sibling"),false);
});

void test("external ranker prefers dense short sections over long keyword-heavy sections", () => {
  const { rankExternalEvidenceCandidates }=load("src/agent/pi/progressive/external-evidence-ranker.js");
  const snapshot={notes:[],edges:[],conversationNodes:[
    {id:"parent",parentId:null,title:"Parent",depth:0,root:true,current:false,messages:[{id:"p",role:"assistant",content:`## 散度\n散度与源强有关。${"无关。".repeat(200)}\n\n## 散度\n散度与源强有关。`,status:"complete",selectionQuotes:[]}]},
    {id:"current",parentId:"parent",title:"Current",depth:1,root:false,current:true,messages:[]}
  ]};
  const ranked=rankExternalEvidenceCandidates({question:"散度与源强有什么关系",targetText:"散度",relatedNotesAllowed:false,snapshot});
  const top=ranked[0];
  assert.equal(top.relationship,"ancestor-distance-1");
  assert.match(top.content,/散度与源强有关。$/u);
  assert.doesNotMatch(top.content,/无关/u);
  assert.ok(top.scoreBreakdown.bodyKeywordMatch > 50);
});



void test("related-note permission defaults to off even when a graph snapshot exists", () => {
  const { PiContextWorkspace }=load("src/agent/pi/context-workspace.js");
  const { ProgressiveContextBatchPlanner }=load("src/agent/pi/progressive/context-batch-planner.js");
  const { createProgressiveContextState,recordInitialProgressiveBatch }=load("src/agent/pi/progressive/context-state.js");
  const req=baseRequest("联系相关笔记解释旋度",{relatedNotes:false});
  delete req.piContext.relatedNotesAllowed;
  req.piContext.noteContextGraph={protocol:"note-context-graph:v1",rootNodeIds:["root"],fullNoteContext:true,relatedNotesEnabled:true,perNoteBudget:"full",maxDepth:1,builtAt:"x",nodes:[
    {id:"root",filePath:"A.md",fileName:"A.md",content:"## 旋度\n当前笔记",contentHash:"h0",depth:0,root:true,primaryChain:["root"],parentIds:[],outgoingNodeIds:["related"]},
    {id:"related",filePath:"Related.md",fileName:"Related.md",content:"## 旋度\n关联笔记唯一内容",contentHash:"h1",depth:1,root:false,primaryParentId:"root",primaryChain:["root","related"],parentIds:["root"],outgoingNodeIds:[]}
  ],edges:[{sourceNodeId:"root",targetNodeId:"related",labels:["Related"]}],unresolvedLinks:[]};
  const planner=new ProgressiveContextBatchPlanner(req,new PiContextWorkspace(req.piContext.noteContextGraph,[]));
  const state=createProgressiveContextState({initialLevel:3,relatedNotesAllowed:false,maximumEvidenceTokens:8000,maximumExpansions:4});
  const initial=planner.buildInitialEvidence(state);
  assert.equal(initial.level,0);
  assert.equal(initial.relatedNote,false);
  assert.throws(()=>planner.nextBatch(state),/exhausted/u);
});

void test("runtime expansion records exhausted lower levels before advancing", () => {
  const { PiContextWorkspace }=load("src/agent/pi/context-workspace.js");
  const { ProgressiveContextBatchPlanner }=load("src/agent/pi/progressive/context-batch-planner.js");
  const { createProgressiveContextState,recordInitialProgressiveBatch }=load("src/agent/pi/progressive/context-state.js");
  const req=baseRequest("旋度是什么意思？",{relatedNotes:false});
  req.piContext.noteContextGraph={protocol:"note-context-graph:v1",rootNodeIds:["n0"],fullNoteContext:true,relatedNotesEnabled:false,perNoteBudget:"full",maxDepth:0,builtAt:"x",nodes:[{id:"n0",filePath:"A.md",fileName:"A.md",content:"## 旋度\n旋度描述局部旋转。",contentHash:"h0",depth:0,root:true,primaryChain:["n0"],parentIds:[],outgoingNodeIds:[]}],edges:[],unresolvedLinks:[]};
  req.piContext.focus.anchors[0].selectionStartOffset=req.piContext.noteContextGraph.nodes[0].content.indexOf("旋度描述");
  req.piContext.focus.anchors[0].selectionEndOffset=req.piContext.focus.anchors[0].selectionStartOffset+2;
  const planner=new ProgressiveContextBatchPlanner(req,new PiContextWorkspace(req.piContext.noteContextGraph,[]));
  let state=createProgressiveContextState({initialLevel:0,relatedNotesAllowed:false,maximumEvidenceTokens:8000,maximumExpansions:4});
  state=recordInitialProgressiveBatch(state,planner.buildInitialEvidence(state));
  const first=planner.expand(state,"need section");
  assert.equal(first.status,"expanded");
  const second=planner.expand(first.state,"need source");
  assert.equal(second.status,"exhausted");
  assert.equal(second.state.expansionDisabled,true);
  assert.deepEqual(second.state.exhaustedLevels,[0,1,2,3,4]);
});
