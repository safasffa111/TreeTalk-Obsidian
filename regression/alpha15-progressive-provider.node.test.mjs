import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require=createRequire(import.meta.url);const ts=require("typescript");const root=process.cwd();
function walk(entry){const stat=fs.statSync(entry);if(stat.isFile())return[entry];return fs.readdirSync(entry,{withFileTypes:true}).flatMap((item)=>walk(path.join(entry,item.name)));}
const modules=new Map();for(const file of walk(path.join(root,"src")).filter((file)=>file.endsWith(".ts")&&!file.endsWith(".d.ts"))){const id=path.relative(root,file).replaceAll(path.sep,"/").replace(/\.ts$/u,".js");modules.set(id,ts.transpileModule(fs.readFileSync(file,"utf8"),{fileName:file,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,moduleResolution:ts.ModuleResolutionKind.Node10,verbatimModuleSyntax:false}}).outputText);}
const cache=new Map();function normalize(parts){const out=[];for(const p of parts){if(!p||p===".")continue;if(p==="..")out.pop();else out.push(p);}return out.join("/");}function resolve(parent,req){const pieces=parent.split("/");pieces.pop();const base=normalize([...pieces,...req.split("/")]);for(const c of req.endsWith(".js")?[base]:[`${base}.js`,`${base}/index.js`,base])if(modules.has(c))return c;throw new Error(`Module not found: ${req} from ${parent}`);}function load(id){if(cache.has(id))return cache.get(id).exports;const code=modules.get(id);if(code===undefined)throw new Error(`Unknown module: ${id}`);const module={exports:{}};cache.set(id,module);new Function("module","exports","require",code)(module,module.exports,(req)=>req.startsWith(".")?load(resolve(id,req)):req==="obsidian"?{}:require(req));return module.exports;}

const profile={id:"d",name:"DeepSeek",kind:"deepseek",apiKey:"secret",baseUrl:"https://api.deepseek.com"};
const common={profile,modelId:"m",systemPrompt:"system",tools:[{name:"expand_context",description:"expand",parameters:{type:"object",properties:{reason:{type:"string"}},required:["reason"]}}],maxOutputTokens:16384};

void test("DeepSeek serializes assistant reasoning with its tool call",()=>{
  const {buildPiProviderRequest}=load("src/agent/pi/pi-provider-transport.js");
  const request=buildPiProviderRequest({...common,messages:[{role:"assistant",content:"",reasoningContent:"需要读取所在章节",toolCalls:[{id:"call-1",name:"expand_context",arguments:{reason:"缺少局部定义"}}]},{role:"toolResult",toolCallId:"call-1",toolName:"expand_context",content:"{}",isError:false}],stream:false,thinkingEnabled:true});
  const assistant=request.body.messages.find((message)=>message.role==="assistant");
  assert.equal(assistant.reasoning_content,"需要读取所在章节");
  assert.equal(assistant.tool_calls[0].function.name,"expand_context");
});

void test("OpenAI-compatible stream emits incremental tool-call fragments",()=>{
  const {decodeOpenAiEvent}=load("src/providers/stream-parser.js");
  const first=decodeOpenAiEvent({event:"",data:JSON.stringify({choices:[{delta:{reasoning_content:"分析",tool_calls:[{index:0,id:"call-1",function:{name:"expand_",arguments:"{\"rea"}}]}}]})});
  const second=decodeOpenAiEvent({event:"",data:JSON.stringify({choices:[{delta:{tool_calls:[{index:0,function:{name:"context",arguments:"son\":\"缺少定义\"}"}}]},finish_reason:"tool_calls"}]})});
  assert.equal(first.some((event)=>event.type==="thinking-delta"),true);
  assert.deepEqual(first.find((event)=>event.type==="tool-call-delta"),{type:"tool-call-delta",index:0,id:"call-1",name:"expand_",argumentsText:"{\"rea"});
  assert.deepEqual(second.filter((event)=>event.type==="tool-call-delta")[0],{type:"tool-call-delta",index:0,name:"context",argumentsText:"son\":\"缺少定义\"}"});
  assert.deepEqual(second.at(-1),{type:"finish",reason:"tool_calls"});
});

function executionRequest(streamingOutputEnabled=true){return {conversationId:"c",nodeId:"n",assistantMessageId:"a",contextMessages:[],currentQuestion:"问题",answerThinkingMode:"enabled",streamingOutputEnabled,roleId:"direct",route:{routeId:"r",providerProfile:profile,modelId:"m"},webSearchEnabled:false};}
async function collectWithReturn(generator){const events=[];while(true){const next=await generator.next();if(next.done)return {events,result:next.value};events.push(next.value);}}

void test("provider turn hides tool text and returns one assembled expansion call",async()=>{
  const {runProgressiveProviderTurn}=load("src/agent/pi/progressive/provider-turn-runner.js");
  const streamRequest=async function*(){
    yield {type:"thinking-delta",text:"需要更多上下文"};
    yield {type:"tool-call-delta",index:0,id:"call-1",name:"expand_",argumentsText:"{\"rea"};
    yield {type:"tool-call-delta",index:0,name:"context",argumentsText:"son\":\"缺少定义\"}"};
    yield {type:"finish",reason:"tool_calls"};yield {type:"done"};
  };
  const output=await collectWithReturn(runProgressiveProviderTurn({dependencies:{bufferedRequest:async()=>{throw new Error("unused")},streamRequest},request:executionRequest(true),signal:new AbortController().signal,systemPrompt:"system",messages:[{role:"user",content:"q"}],tools:common.tools,maxOutputTokens:16384,thinkingEnabled:true}));
  assert.deepEqual(output.events.filter((event)=>event.type==="text-delta"),[]);
  assert.equal(output.events.some((event)=>event.type==="thinking-delta"),true);
  assert.equal(output.result.mode,"tool");
  assert.deepEqual(output.result.toolCalls,[{id:"call-1",name:"expand_context",arguments:{reason:"缺少定义"}}]);
  assert.equal(output.result.thinking,"需要更多上下文");
});

void test("provider turn streams final text and rejects later tool calls",async()=>{
  const {runProgressiveProviderTurn}=load("src/agent/pi/progressive/provider-turn-runner.js");
  const good=async function*(){yield {type:"delta",text:"最终"};yield {type:"delta",text:"回答"};yield {type:"finish",reason:"stop"};yield {type:"done"};};
  const output=await collectWithReturn(runProgressiveProviderTurn({dependencies:{bufferedRequest:async()=>{throw new Error("unused")},streamRequest:good},request:executionRequest(true),signal:new AbortController().signal,systemPrompt:"s",messages:[{role:"user",content:"q"}],tools:common.tools,maxOutputTokens:16384,thinkingEnabled:false}));
  assert.equal(output.result.mode,"final");assert.equal(output.result.text,"最终回答");
  assert.equal(output.events.filter((event)=>event.type==="text-delta").map((event)=>event.text).join(""),"最终回答");
  const bad=async function*(){yield {type:"delta",text:"oops"};yield {type:"tool-call-delta",index:0,id:"c",name:"expand_context",argumentsText:"{}"};};
  await assert.rejects(()=>collectWithReturn(runProgressiveProviderTurn({dependencies:{bufferedRequest:async()=>{throw new Error("unused")},streamRequest:bad},request:executionRequest(true),signal:new AbortController().signal,systemPrompt:"s",messages:[{role:"user",content:"q"}],tools:common.tools,maxOutputTokens:100,thinkingEnabled:false})),/also emitted a tool call/u);
});
