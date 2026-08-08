import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { createRequire } from "node:module";
const require=createRequire(import.meta.url); const root=process.cwd();
function transpile(file){return ts.transpileModule(fs.readFileSync(path.join(root,file),"utf8"),{fileName:file,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,moduleResolution:ts.ModuleResolutionKind.Node10,verbatimModuleSyntax:false}}).outputText;}
function loadStandalone(file, deps={}){const module={exports:{}};new Function("module","exports","require",transpile(file))(module,module.exports,(request)=>deps[request]??require(request));return module.exports;}

test("label alpha fades smoothly from hidden to normal",()=>{
  const camera=loadStandalone("src/relationship-graph/camera.ts");
  assert.equal(camera.relationshipGraphLabelAlpha(0.7),0);
  assert.ok(camera.relationshipGraphLabelAlpha(0.9)>0 && camera.relationshipGraphLabelAlpha(0.9)<1);
  assert.equal(camera.relationshipGraphLabelAlpha(1.18),1);
});

test("below the zoom threshold hovering reveals only the hovered label",()=>{
  const camera=loadStandalone("src/relationship-graph/camera.ts");
  const render=loadStandalone("src/relationship-graph/render-model.ts",{"./camera":camera});
  const snapshot={nodes:[{id:"a",title:"A",kind:"conversation",degree:1,included:true},{id:"b",title:"B",kind:"conversation",degree:1,included:true}],edges:[{id:"e",sourceId:"a",targetId:"b",kind:"parent-child",included:true}],positions:{a:{x:0,y:0,fixed:false},b:{x:40,y:0,fixed:false}}};
  const frame=render.createRelationshipGraphRenderFrame(snapshot,{scale:0.6,panX:100,panY:100},{hoveredNodeId:"a"},{width:400,height:300});
  assert.deepEqual(frame.labels.map((label)=>label.id),["a"]);
});

test("graph theme prefers Obsidian interactive accent and exposes live refresh",()=>{
  const source=fs.readFileSync(path.join(root,"src/relationship-graph/pixi-view.ts"),"utf8");
  assert.match(source,/get\("--interactive-accent"\).*get\("--color-accent"\)/su);
  assert.match(source,/refreshTheme/u);
  assert.match(source,/MutationObserver/u);
  const geometry=fs.readFileSync(path.join(root,"src/relationship-graph/pixi-shared-geometry.ts"),"utf8");
  assert.match(geometry,/setTheme\(/u);
});

test("graph theme accepts HSL accent values used by Obsidian themes",()=>{
  const geometry={
    relationshipGraphWebGlSupported:()=>false,
    RelationshipGraphGpuGeometry:class {},
    RelationshipGraphSharedGeometry:class {}
  };
  const camera=loadStandalone("src/relationship-graph/camera.ts");
  const render=loadStandalone("src/relationship-graph/render-model.ts",{"./camera":camera});
  const module=loadStandalone("src/relationship-graph/pixi-view.ts",{
    "./pixi-shared-geometry":geometry,
    "./frame-interpolator":{stepRelationshipGraphRadius:(value)=>value},
    "./spatial-index":{RelationshipGraphEdgeSpatialIndex:class {},RelationshipGraphSpatialIndex:class {}},
    "./render-model":render,
    "./camera":camera
  });
  const canvas={ownerDocument:{defaultView:{getComputedStyle:()=>({getPropertyValue:(name)=>name === "--interactive-accent" ? "hsl(120, 100%, 50%)" : ""})}}};
  assert.equal(module.resolveRelationshipGraphThemeColors(canvas).accent,0x00ff00);
});

test("zoom camera frames recompute label opacity before drawing",()=>{
  const viewSource=fs.readFileSync(path.join(root,"src/relationship-graph/pixi-view.ts"),"utf8");
  const windowSource=fs.readFileSync(path.join(root,"src/relationship-graph/window.ts"),"utf8");
  assert.match(viewSource,/renderCamera\(camera:[\s\S]*this\.renderLabels\(camera\)/u);
  assert.match(windowSource,/mode === "labels" \|\| mode === "camera"/u);
});
