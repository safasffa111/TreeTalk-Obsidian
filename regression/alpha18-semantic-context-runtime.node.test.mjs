import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require=createRequire(import.meta.url);const ts=require("typescript");const root=process.cwd();
function walk(entry){const stat=fs.statSync(entry);if(stat.isFile())return[entry];return fs.readdirSync(entry,{withFileTypes:true}).flatMap((item)=>walk(path.join(entry,item.name)));}
const modules=new Map();for(const file of walk(path.join(root,"src")).filter((file)=>file.endsWith(".ts")&&!file.endsWith(".d.ts"))){const id=path.relative(root,file).replaceAll(path.sep,"/").replace(/\.ts$/u,".js");modules.set(id,ts.transpileModule(fs.readFileSync(file,"utf8"),{fileName:file,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,moduleResolution:ts.ModuleResolutionKind.Node10,verbatimModuleSyntax:false}}).outputText);}
const cache=new Map();function normalize(parts){const result=[];for(const part of parts){if(!part||part===".")continue;if(part==="..")result.pop();else result.push(part);}return result.join("/");}function resolve(parentId,request){const parent=parentId.split("/");parent.pop();const base=normalize([...parent,...request.split("/")]);for(const candidate of request.endsWith(".js")?[base]:[`${base}.js`,`${base}/index.js`,base])if(modules.has(candidate))return candidate;throw new Error(`Module not found: ${request} from ${parentId}`);}function load(id){if(cache.has(id))return cache.get(id).exports;const code=modules.get(id);if(code===undefined)throw new Error(`Unknown module: ${id}`);const module={exports:{}};cache.set(id,module);const localRequire=(request)=>request.startsWith(".")?load(resolve(id,request)):request==="obsidian"?{}:require(request);new Function("module","exports","require",code)(module,module.exports,localRequire);return module.exports;}

function batch(relationship="structural-parent-tail"){return {id:"b",level:2,sourceKind:"conversation-node",sourceId:"n",sourceRevision:"r",title:"父回答 · 末尾",relationship,content:"父文本末尾",estimatedTokens:20,truncated:false,hasMoreFromSource:true,relatedNote:false,notePaths:[],nodeIds:["n"]};}

void test("progressive prompts distinguish exact targets from structural tasks and hide L-numbers",()=>{
  const {buildProgressiveInitialUserMessage,buildProgressiveSystemPrompt}=load("src/agent/pi/progressive/progressive-prompts.js");
  const exact=buildProgressiveInitialUserMessage({question:"解释",exactTargetText:"旋度",initialEvidence:{...batch(),level:0,sourceKind:"selection",content:"目标证据",relationship:"primary-target"},contextDivergenceEnabled:false});
  assert.match(exact,/# 回答对象\n旋度/u);assert.match(exact,/# 当前任务\n解释/u);assert.doesNotMatch(exact,/L[0-4]/u);
  const structural=buildProgressiveInitialUserMessage({question:"继续",initialEvidence:batch(),contextDivergenceEnabled:false});
  assert.match(structural,/# 当前任务\n继续/u);assert.match(structural,/# 结构语境\n已提供当前结构父文本的末尾内容。/u);assert.doesNotMatch(structural,/# 回答目标|始终回答“继续”|L2/u);
  assert.match(buildProgressiveSystemPrompt(true),/当前允许更宽松地探索上下文/u);
  assert.doesNotMatch(buildProgressiveSystemPrompt(false),/当前允许更宽松地探索上下文/u);
  assert.doesNotMatch(buildProgressiveSystemPrompt(false),/expand_context/u);
  assert.match(buildProgressiveSystemPrompt(false),/request_context/u);
});

void test("progressive system prompt carries answer-quality clauses in both modes",()=>{
  const {buildProgressiveSystemPrompt}=load("src/agent/pi/progressive/progressive-prompts.js");
  for (const system of [buildProgressiveSystemPrompt(false),buildProgressiveSystemPrompt(false,true)]) {
    assert.match(system,/先直接给出结论/u);
    assert.match(system,/冲突/u);
    assert.match(system,/不要编造/u);
    assert.match(system,/说明其来源/u);
    assert.doesNotMatch(system,/TT_MODE|Selector|expand_context/u);
  }
});

void test("initial message appends a compact context inventory without breaking the structural prefix",()=>{
  const {buildProgressiveInitialUserMessage,buildProgressiveContextInventory}=load("src/agent/pi/progressive/progressive-prompts.js");
  const inventory=buildProgressiveContextInventory({
    notes:[{id:"n1",filePath:"A.md",fileName:"A.md",depth:0,root:true,content:"## 三次握手\n内容。\n## 四次挥手\n内容。",revision:"r"}],
    edges:[],
    conversationNodes:[
      {id:"root",parentId:null,title:"根",depth:0,root:true,current:false,messages:[]},
      {id:"cur",parentId:"root",title:"TCP 学习",depth:1,root:false,current:true,messages:[{id:"u",role:"user",content:"TCP 为什么可靠？",status:"complete",selectionQuotes:[]}]}
    ]
  });
  assert.match(inventory,/A\.md（三次握手、四次挥手）/u);
  assert.match(inventory,/TCP 学习（当前）：TCP 为什么可靠？/u);
  assert.doesNotMatch(inventory,/L[0-4]|TT_MODE|Selector/u);
  const withInventory=buildProgressiveInitialUserMessage({question:"继续",initialEvidence:batch(),contextDivergenceEnabled:false,contextInventory:inventory});
  assert.match(withInventory,/# 结构语境\n已提供当前结构父文本的末尾内容。/u);
  assert.match(withInventory,/# 可用上下文清单\n笔记：\n- A\.md（三次握手、四次挥手）/u);
  assert.match(withInventory,/清单仅用于选择 request_context 的目标，不是证据正文。/u);
  const without=buildProgressiveInitialUserMessage({question:"继续",initialEvidence:batch(),contextDivergenceEnabled:false});
  assert.doesNotMatch(without,/可用上下文清单/u);
});

void test("divergence mode adds proactive context retrieval guidance",()=>{
  const {buildProgressiveSystemPrompt}=load("src/agent/pi/progressive/progressive-prompts.js");
  for (const system of [buildProgressiveSystemPrompt(true),buildProgressiveSystemPrompt(true,true)]) {
    assert.match(system,/优先调用 request_context 获取相关证据/u);
    assert.doesNotMatch(system,/TT_MODE|Selector|expand_context/u);
  }
  assert.doesNotMatch(buildProgressiveSystemPrompt(false),/优先调用 request_context 获取相关证据/u);
  assert.doesNotMatch(buildProgressiveSystemPrompt(false,true),/优先调用 request_context 获取相关证据/u);
});

function profile(){return {id:"d",name:"DeepSeek",kind:"deepseek",apiKey:"secret",baseUrl:"https://api.deepseek.com"};}
function unselectedRequest(divergence=false){return {conversationId:"c",nodeId:"current",assistantMessageId:"out",contextMessages:[],currentQuestion:"继续处理",answerThinkingMode:"disabled",streamingOutputEnabled:false,contextDivergenceEnabled:divergence,piContext:{currentQuestion:"继续处理",selectedQuotes:[],relatedNotesAllowed:false,conversationNodes:[{id:"ancestor",parentId:null,title:"祖先",depth:0,root:true,current:false,messages:[{id:"aa",role:"assistant",content:"## 背景\n祖先相关章节。",status:"complete",selectionQuotes:[]}]},{id:"parent",parentId:"ancestor",title:"父节点",depth:1,root:false,current:false,messages:[{id:"p",role:"assistant",content:`开头。${"父文本内容。".repeat(1000)}末尾标记 END_MARKER`,status:"complete",selectionQuotes:[]}]},{id:"current",parentId:"parent",title:"当前",depth:2,root:false,current:true,messages:[]}],focus:{interactionMode:"continue",defaultScope:"latest_round",anchors:[{id:"F1",kind:"conversation-round",sourceNodeId:"parent",sourceMessageId:"p",reason:"previous-turn"}],targets:[{kind:"conversation-round",anchorId:"F1",sourceNodeId:"parent",sourceMessageId:"p",reason:"previous-turn"}]}},roleId:"direct",route:{routeId:"r",providerProfile:profile(),modelId:"m"},webSearchEnabled:false};}
function exactRequest(){return {conversationId:"c",nodeId:"current",assistantMessageId:"out",contextMessages:[],currentQuestion:"解释",answerThinkingMode:"disabled",streamingOutputEnabled:false,contextDivergenceEnabled:false,piContext:{currentQuestion:"解释",selectedQuotes:["旋度"],relatedNotesAllowed:false,conversationNodes:[],noteContextGraph:{protocol:"note-context-graph:v1",rootNodeIds:["n"],fullNoteContext:true,relatedNotesEnabled:false,perNoteBudget:"full",maxDepth:0,builtAt:"x",nodes:[{id:"n",filePath:"A.md",fileName:"A.md",content:"## 旋度\n旋度描述局部旋转。\n\n## 其他\n更多正文",contentHash:"h",depth:0,root:true,primaryChain:["n"],parentIds:[],outgoingNodeIds:[]}],edges:[],unresolvedLinks:[]},focus:{interactionMode:"child",defaultScope:"selection_only",anchors:[{id:"F1",kind:"note-selection",filePath:"A.md",fileName:"A.md",quote:"旋度",prefix:"",suffix:"",selectionStartOffset:3,selectionEndOffset:5}],targets:[{kind:"exact-selection",anchorId:"F1",text:"旋度",source:{type:"note",filePath:"A.md",fileName:"A.md"}}]}},roleId:"direct",route:{routeId:"r",providerProfile:profile(),modelId:"m"},webSearchEnabled:false};}
function response(text){return {status:200,json:{choices:[{message:{content:text},finish_reason:"stop"}],usage:{prompt_tokens:10,completion_tokens:4}}};}
function toolResponse(target,reason="需要上下文",id="call-1"){return {status:200,json:{choices:[{message:{content:null,tool_calls:[{id,type:"function",function:{name:"request_context",arguments:JSON.stringify({target,reason})}}]},finish_reason:"tool_calls"}],usage:{prompt_tokens:10,completion_tokens:4}}};}
async function collect(iterable){const events=[];for await(const event of iterable)events.push(event);return events;}

void test("unselected progressive requests receive parent-tail evidence and convergent semantic tools",async()=>{
  const {PiExecutionEngine}=load("src/agent/pi/pi-execution-engine.js");const requests=[];const engine=new PiExecutionEngine({strategy:"progressive",async bufferedRequest(req){requests.push(req);return response("完成");}});
  const events=await collect(engine.execute(unselectedRequest(false),new AbortController().signal));
  assert.equal(requests.length,1);const body=requests[0].body;assert.match(JSON.stringify(body.messages),/END_MARKER/u);assert.doesNotMatch(JSON.stringify(body.messages),/# 回答目标|L2/u);
  assert.equal(body.tools[0].function.name,"request_context");assert.deepEqual(body.tools[0].function.parameters.properties.target.enum,["current_section","current_source","related_sections","related_full_source"]);assert.match(body.messages.at(-1).content,/本轮可用接口：current_source、related_sections/u);assert.equal(events.some((e)=>e.type==="finish"&&e.reason==="stop"),true);
  assert.match(JSON.stringify(body.messages),/这是对上一轮回答的延续/u);
  assert.doesNotMatch(JSON.stringify(body.messages),/# 上一轮回答依据/u);
});

void test("exact L0 convergent mode exposes only current_section",async()=>{
  const {PiExecutionEngine}=load("src/agent/pi/pi-execution-engine.js");const requests=[];const engine=new PiExecutionEngine({strategy:"progressive",async bufferedRequest(req){requests.push(req);return response("完成");}});
  await collect(engine.execute(exactRequest(),new AbortController().signal));
  assert.deepEqual(requests[0].body.tools[0].function.parameters.properties.target.enum,["current_section","current_source","related_sections","related_full_source"]);
  assert.match(requests[0].body.messages.at(-1).content,/本轮可用接口：current_section/u);
});

void test("divergent mode exposes all real upward semantic targets",async()=>{
  const {PiExecutionEngine}=load("src/agent/pi/pi-execution-engine.js");const requests=[];const engine=new PiExecutionEngine({strategy:"progressive",async bufferedRequest(req){requests.push(req);return response("完成");}});
  await collect(engine.execute(unselectedRequest(true),new AbortController().signal));
  assert.deepEqual(requests[0].body.tools[0].function.parameters.properties.target.enum,["current_section","current_source","related_sections","related_full_source"]);
  assert.match(requests[0].body.messages.at(-1).content,/本轮可用接口：current_source、related_sections、related_full_source/u);
});

void test("request_context appends a compact result to the same answer conversation",async()=>{
  const {PiExecutionEngine}=load("src/agent/pi/pi-execution-engine.js");const requests=[];const engine=new PiExecutionEngine({strategy:"progressive",async bufferedRequest(req){requests.push(req);return requests.length===1?toolResponse("current_source"):response("完成");}});
  const events=await collect(engine.execute(unselectedRequest(false),new AbortController().signal));
  assert.equal(requests.length,2);const tool=requests[1].body.messages.find((m)=>m.role==="tool");const payload=JSON.parse(tool.content);assert.deepEqual(Object.keys(payload).sort(),["content","remaining","scope","source"]);assert.equal(payload.scope,"partial-source");assert.equal(events.some((e)=>e.type==="tool-start"&&e.toolName==="request_context"),true);
});

void test("semantic context diagnostics persist optional mode and requested targets without evidence text",()=>{
  const {createAgentRunRecord,applyAgentRunEvent}=load("src/domain/agent-run.js");
  const {agentExecutionViewModel}=load("src/agent/ui/execution-view-model.js");
  let record=createAgentRunRecord({executionMode:"pi",roleId:"direct",routeId:"r",providerId:"deepseek",modelId:"m",startedAt:"2026-08-06T00:00:00.000Z"});
  record=applyAgentRunEvent(record,{type:"progressive-context-start",initialLevel:2,reason:"结构父文本",maximumEvidenceTokens:30000,maximumExpansions:50,relatedNotesAllowed:true,contextMode:"divergent",initialContextKind:"structural-parent-tail"});
  record=applyAgentRunEvent(record,{type:"progressive-context-batch",level:2,evidenceId:"tail",sourceKind:"conversation-node",sourceId:"parent",title:"父回答 · 末尾",relationship:"structural-parent-tail",estimatedTokens:500,notePaths:[],nodeIds:["parent"],relatedNote:false,expansionReason:"initial",exhausted:false,crossedLevel:false});
  record=applyAgentRunEvent(record,{type:"progressive-context-batch",level:4,evidenceId:"full",sourceKind:"note",sourceId:"note",title:"关联笔记",relationship:"related-note-depth-1",estimatedTokens:1200,notePaths:["A.md"],nodeIds:[],relatedNote:true,expansionReason:"需要完整来源",exhausted:false,requestedTarget:"related_full_source",crossedLevel:true});
  assert.equal(record.progressiveContext.contextMode,"divergent");
  assert.equal(record.progressiveContext.initialContextKind,"structural-parent-tail");
  assert.equal(record.progressiveContext.batches[1].requestedTarget,"related_full_source");
  assert.equal(record.progressiveContext.batches[1].crossedLevel,true);
  const serialized=JSON.stringify(record);
  assert.doesNotMatch(serialized,/工具正文绝不能保存|reasoningContent|父文本内容。父文本内容/u);
  const view=agentExecutionViewModel(record);
  assert.deepEqual(view.rows.find(([label])=>label==="上下文模式"),["上下文模式","发散"]);
  assert.deepEqual(view.rows.find(([label])=>label==="初始语境"),["初始语境","父文本尾部"]);
  assert.deepEqual(view.rows.find(([label])=>label==="请求接口"),["请求接口","related_full_source（跨级）"]);
  assert.deepEqual(view.rows.find(([label])=>label==="新增证据 Token"),["新增证据 Token","1,700 / 30,000"]);
});

function invalidToolResponse(target,id){return {status:200,json:{choices:[{message:{content:null,tool_calls:[{id,type:"function",function:{name:"request_context",arguments:JSON.stringify({target,reason:"无效跨级"})}}]},finish_reason:"tool_calls"}],usage:{prompt_tokens:10,completion_tokens:4}}};}

void test("one unavailable semantic request returns one compact error and a corrected request may continue",async()=>{
  const {PiExecutionEngine}=load("src/agent/pi/pi-execution-engine.js");const requests=[];
  const engine=new PiExecutionEngine({strategy:"progressive",async bufferedRequest(req){requests.push(req);if(requests.length===1)return invalidToolResponse("related_full_source","bad-1");if(requests.length===2)return toolResponse("current_section","需要章节","good-1");return response("完成");}});
  const events=await collect(engine.execute(exactRequest(),new AbortController().signal));
  assert.equal(requests.length,3);
  const firstError=JSON.parse(requests[1].body.messages.find((m)=>m.role==="tool").content);
  assert.deepEqual(Object.keys(firstError).sort(),["content","remaining","scope","source"]);
  assert.equal(firstError.remaining,true);
  assert.equal(events.filter((e)=>e.type==="tool-end"&&e.isError).length,1);
  assert.equal(events.filter((e)=>e.type==="progressive-context-batch"&&e.expansionReason!=="initial").length,1);
});

void test("two invalid semantic requests disable tools and force a final answer",async()=>{
  const {PiExecutionEngine}=load("src/agent/pi/pi-execution-engine.js");const requests=[];
  const engine=new PiExecutionEngine({strategy:"progressive",async bufferedRequest(req){requests.push(req);if(requests.length<=2)return invalidToolResponse("related_full_source",`bad-${requests.length}`);return response("基于已有信息回答");}});
  const events=await collect(engine.execute(exactRequest(),new AbortController().signal));
  assert.equal(requests.length,3);
  assert.equal(Array.isArray(requests[2].body.tools),true);
  assert.equal(Object.hasOwn(requests[2].body,"tool_choice"),false);
  assert.match(JSON.stringify(requests[2].body.messages),/上下文扩展已结束或达到限制/u);
  assert.equal(events.filter((e)=>e.type==="tool-end"&&e.isError).length,2);
  assert.equal(events.filter((e)=>e.type==="text-delta").map((e)=>e.text).join(""),"基于已有信息回答");
});

function conversationWithProgressiveBatch(batchOverrides={}){const now="2026-08-06T00:00:00.000Z";return {schemaVersion:1,id:"c",title:"C",status:"active",revision:1,checksum:"x",createdAt:now,updatedAt:now,rootNodeId:"root",currentNodeId:"root",nodes:{root:{id:"root",parentId:null,childIds:[],title:"Root",messages:[{id:"a",role:"assistant",content:"answer",status:"complete",createdAt:now,updatedAt:now,agentRun:{protocol:"pi-agent-run:v1",executionMode:"pi",status:"completed",roleId:"direct",routeId:"r",providerId:"deepseek",modelId:"m",stages:[],toolExecutions:[],progressiveContext:{initialLevel:2,finalLevel:2,startReason:"结构父文本",maximumEvidenceTokens:30000,maximumExpansions:50,deliveredEvidenceTokens:500,expansionCount:0,relatedNotesAllowed:false,relatedNotesUsed:false,batches:[{level:2,evidenceId:"tail",sourceKind:"conversation-node",sourceId:"parent",title:"父回答",relationship:"structural-parent-tail",estimatedTokens:500,notePaths:[],nodeIds:["parent"],expansionReason:"initial",...batchOverrides}]},sources:[],startedAt:now,finishedAt:now}}],draft:{text:"",mode:"continue",selectionContexts:[]},createdAt:now,updatedAt:now}},ui:{expandedNodeIds:[],treeScrollTop:0,messageScrollTopByNode:{}}};}

void test("old progressive records remain valid and optional semantic target values are validated",()=>{
  const {parseConversation}=load("src/domain/schema.js");
  const old=parseConversation(conversationWithProgressiveBatch());
  assert.equal(old.nodes.root.messages[0].agentRun.progressiveContext.contextMode,undefined);
  assert.throws(()=>parseConversation(conversationWithProgressiveBatch({requestedTarget:"unknown_target"})),/requestedTarget.*invalid/u);
});
