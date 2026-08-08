import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const root = process.cwd();
function walk(entry){const stat=fs.statSync(entry);if(stat.isFile())return[entry];return fs.readdirSync(entry,{withFileTypes:true}).flatMap((item)=>walk(path.join(entry,item.name)));}
const modules=new Map();
for(const file of walk(path.join(root,"src")).filter((file)=>file.endsWith(".ts")&&!file.endsWith(".d.ts"))){const id=path.relative(root,file).replaceAll(path.sep,"/").replace(/\.ts$/u,".js");modules.set(id,ts.transpileModule(fs.readFileSync(file,"utf8"),{fileName:file,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,moduleResolution:ts.ModuleResolutionKind.Node10,verbatimModuleSyntax:false}}).outputText);}
const cache=new Map();
function normalize(parts){const result=[];for(const part of parts){if(!part||part===".")continue;if(part==="..")result.pop();else result.push(part);}return result.join("/");}
function resolve(parentId,request){const parent=parentId.split("/");parent.pop();const base=normalize([...parent,...request.split("/")]);for(const candidate of request.endsWith(".js")?[base]:[`${base}.js`,`${base}/index.js`,base])if(modules.has(candidate))return candidate;throw new Error(`Module not found: ${request} from ${parentId}`);}
function load(id){if(cache.has(id))return cache.get(id).exports;const code=modules.get(id);if(code===undefined)throw new Error(`Unknown module: ${id}`);const module={exports:{}};cache.set(id,module);const localRequire=(request)=>request.startsWith(".")?load(resolve(id,request)):request==="obsidian"?{}:require(request);new Function("module","exports","require",code)(module,module.exports,localRequire);return module.exports;}

function request(sourceMessageId="a2"){
  return {
    conversationId:"c",nodeId:"current",assistantMessageId:"out",contextMessages:[],currentQuestion:"继续",
    piContext:{currentQuestion:"继续",selectedQuotes:[],relatedNotesAllowed:false,conversationNodes:[],focus:{interactionMode:"continue",defaultScope:"latest_round",anchors:[{id:"F1",kind:"conversation-round",sourceNodeId:"parent",sourceMessageId,reason:"previous-turn"}],targets:[{kind:"conversation-round",anchorId:"F1",sourceNodeId:"parent",sourceMessageId,reason:"previous-turn"}]}},
    roleId:"direct",route:{routeId:"r",providerProfile:{id:"d",name:"D",kind:"deepseek",apiKey:"x",baseUrl:"https://api.deepseek.com"},modelId:"m"},webSearchEnabled:false
  };
}
function snapshot(){return {notes:[],edges:[],conversationNodes:[{id:"parent",parentId:null,title:"父节点",depth:0,root:true,current:false,messages:[{id:"u",role:"user",content:"用户文字",status:"complete",selectionQuotes:[]},{id:"a1",role:"assistant",content:"旧回答",status:"complete",selectionQuotes:[]},{id:"a2",role:"assistant",content:"目标父回答 END_MARKER",status:"complete",selectionQuotes:[]},{id:"a3",role:"assistant",content:"流式内容",status:"streaming",selectionQuotes:[]}]},{id:"current",parentId:"parent",title:"当前",depth:1,root:false,current:true,messages:[]}]};}

void test("resolves the anchored completed assistant message only",()=>{
  const {resolveStructuralParentSource}=load("src/agent/pi/progressive/structural-parent-context.js");
  const source=resolveStructuralParentSource(request(),snapshot());
  assert.equal(source.messageId,"a2");
  assert.equal(source.content,"目标父回答 END_MARKER");
  assert.doesNotMatch(source.content,/用户文字|旧回答|流式内容|父节点/u);
});

void test("falls back to the latest completed assistant in the structural node",()=>{
  const {resolveStructuralParentSource}=load("src/agent/pi/progressive/structural-parent-context.js");
  const req=request(undefined);delete req.piContext.focus.anchors[0].sourceMessageId;delete req.piContext.focus.targets[0].sourceMessageId;
  const source=resolveStructuralParentSource(req,snapshot());
  assert.equal(source.messageId,"a2");
});

void test("reverse token windows start at the parent tail and page backward without overlap",()=>{
  const {createReverseTokenWindows}=load("src/agent/pi/progressive/structural-parent-context.js");
  const {estimateTextTokens}=load("src/domain/context-engine.js");
  const content=`BEGIN_MARKER。${Array.from({length:2500},(_,i)=>`段落${i}内容`).join("，")}。MIDDLE_MARKER。${Array.from({length:2500},(_,i)=>`后段${i}内容`).join("，")}。END_MARKER`;
  const windows=createReverseTokenWindows(content,500,1800);
  assert.ok(windows.length>=2);
  assert.match(windows[0].content,/END_MARKER/u);
  assert.ok(estimateTextTokens(windows[0].content)<=500);
  assert.equal(windows[0].hasEarlierContent,true);
  for(let i=1;i<windows.length;i+=1){assert.ok(windows[i].endOffset<=windows[i-1].startOffset);}
  assert.equal(new Set(windows.map((w)=>`${w.startOffset}:${w.endOffset}`)).size,windows.length);
  assert.equal(windows.at(-1).startOffset,0);
});

function plannerRequest(nodes=snapshot().conversationNodes){
  const req=request();
  req.piContext.conversationNodes=nodes;
  return req;
}

void test("unselected requests start at internal L2 with a parent digest",()=>{
  const {resolveProgressiveStartPlan}=load("src/agent/pi/progressive/request-start-level.js");
  const {PiContextWorkspace}=load("src/agent/pi/context-workspace.js");
  const {ProgressiveContextBatchPlanner}=load("src/agent/pi/progressive/context-batch-planner.js");
  const {createProgressiveContextState}=load("src/agent/pi/progressive/context-state.js");
  const req=plannerRequest();
  assert.equal(resolveProgressiveStartPlan(req).initialLevel,2);
  const planner=new ProgressiveContextBatchPlanner(req,new PiContextWorkspace(undefined,req.piContext.conversationNodes));
  const state=createProgressiveContextState({initialLevel:2,relatedNotesAllowed:false,maximumEvidenceTokens:30000,maximumExpansions:50});
  const initial=planner.buildInitialEvidence(state);
  assert.equal(initial.level,2);
  assert.equal(initial.relationship,"structural-parent-digest");
  assert.match(initial.content,/END_MARKER/u);
  assert.doesNotMatch(initial.content,/Primary Response Target|当前问题/u);
});

void test("continue provenance is carried from the parent agentRun batches",()=>{
  const {buildPiConversationNodeSnapshots}=load("src/agent/pi/context-index.js");
  const {PiContextWorkspace}=load("src/agent/pi/context-workspace.js");
  const {ProgressiveContextBatchPlanner}=load("src/agent/pi/progressive/context-batch-planner.js");
  const now="2026-08-08T00:00:00.000Z";
  const conversation={
    schemaVersion:1,id:"c",title:"C",status:"active",revision:1,checksum:"x",createdAt:now,updatedAt:now,
    rootNodeId:"parent",currentNodeId:"current",
    nodes:{
      parent:{id:"parent",parentId:null,childIds:["current"],title:"父节点",messages:[
        {id:"u",role:"user",content:"第一个问题",status:"complete",createdAt:now,updatedAt:now},
        {id:"a2",role:"assistant",content:"父回答",status:"complete",createdAt:now,updatedAt:now,agentRun:{protocol:"pi-agent-run:v1",executionMode:"pi",status:"completed",roleId:"direct",routeId:"r",providerId:"deepseek",modelId:"m",stages:[],toolExecutions:[],sources:[],progressiveContext:{initialLevel:2,finalLevel:2,startReason:"结构父文本",maximumEvidenceTokens:30000,maximumExpansions:50,deliveredEvidenceTokens:500,expansionCount:0,relatedNotesAllowed:false,relatedNotesUsed:false,batches:[{level:2,evidenceId:"e1",sourceKind:"conversation-node",sourceId:"parent",title:"父回答",relationship:"structural-parent-tail",estimatedTokens:500,notePaths:[],nodeIds:["parent"],expansionReason:"initial"}]},startedAt:now,finishedAt:now}},
        {id:"s",role:"assistant",content:"流式",status:"streaming",createdAt:now,updatedAt:now}
      ],draft:{text:"",mode:"continue",selectionContexts:[]},createdAt:now,updatedAt:now},
      current:{id:"current",parentId:"parent",childIds:[],title:"当前",messages:[],draft:{text:"",mode:"continue",selectionContexts:[]},createdAt:now,updatedAt:now}
    },
    ui:{expandedNodeIds:[],treeScrollTop:0,messageScrollTopByNode:{}}
  };
  const nodes=buildPiConversationNodeSnapshots(conversation,"current");
  const req=request();
  req.piContext.conversationNodes=nodes;
  const planner=new ProgressiveContextBatchPlanner(req,new PiContextWorkspace(undefined,nodes));
  assert.equal(planner.isStructuralContinue(),true);
  assert.equal(planner.continueProvenanceText(),"- 父回答（L2）");
});

void test("missing parent text searches upward before using request-only fallback",()=>{
  const {PiContextWorkspace}=load("src/agent/pi/context-workspace.js");
  const {ProgressiveContextBatchPlanner}=load("src/agent/pi/progressive/context-batch-planner.js");
  const {createProgressiveContextState}=load("src/agent/pi/progressive/context-state.js");
  const req=plannerRequest([{id:"ancestor",parentId:null,title:"祖先",depth:0,root:true,current:false,messages:[{id:"aa",role:"assistant",content:"## 背景\n祖先章节材料",status:"complete",selectionQuotes:[]}]},{id:"current",parentId:"ancestor",title:"当前",depth:1,root:false,current:true,messages:[]}]);
  req.piContext.focus.anchors[0].sourceNodeId="missing";req.piContext.focus.targets[0].sourceNodeId="missing";
  const planner=new ProgressiveContextBatchPlanner(req,new PiContextWorkspace(undefined,req.piContext.conversationNodes));
  const state=createProgressiveContextState({initialLevel:2,relatedNotesAllowed:false,maximumEvidenceTokens:30000,maximumExpansions:50});
  assert.equal(planner.buildInitialEvidence(state).level,3);

  const emptyReq=plannerRequest([{id:"current",parentId:null,title:"当前",depth:0,root:true,current:true,messages:[]}]);
  emptyReq.piContext.focus.anchors[0].sourceNodeId="missing";emptyReq.piContext.focus.targets[0].sourceNodeId="missing";
  const emptyPlanner=new ProgressiveContextBatchPlanner(emptyReq,new PiContextWorkspace(undefined,emptyReq.piContext.conversationNodes));
  const fallback=emptyPlanner.buildInitialEvidence(state);
  assert.equal(fallback.level,2);
  assert.equal(fallback.relationship,"request-only");
  assert.equal(fallback.content,"未找到可用的结构父文本或外部上下文。");
});
