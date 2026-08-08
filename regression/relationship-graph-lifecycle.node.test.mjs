import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const root = process.cwd();

function transpile(file) {
  return ts.transpileModule(fs.readFileSync(path.join(root, file), "utf8"), {
    fileName: file,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      verbatimModuleSyntax: false
    }
  }).outputText;
}

function loadModule(file, dependencies = {}) {
  const module = { exports: {} };
  const localRequire = (request) => {
    if (Object.hasOwn(dependencies, request)) return dependencies[request];
    throw new Error(`unexpected module ${request} while loading ${file}`);
  };
  new Function("module", "exports", "require", transpile(file))(module, module.exports, localRequire);
  return module.exports;
}

void test("reopened relationship graph retains one window controller instead of discarding its session UI state", () => {
  const source = fs.readFileSync(path.join(root, "src/main.ts"), "utf8");
  const openMethod = source.slice(source.indexOf("private openDepositGraph"), source.indexOf("private async captureTree"));
  assert.doesNotMatch(openMethod, /onClose:\s*\(\)\s*=>\s*\{\s*this\.relationshipGraphWindow\s*=\s*undefined/u);
});

void test("the minimize control toggles between minimized and restored states", () => {
  const source = fs.readFileSync(path.join(root, "src/relationship-graph/window.ts"), "utf8");
  const minimizeMethod = source.slice(source.indexOf("private minimize"), source.indexOf("private toggleMaximize"));
  assert.match(minimizeMethod, /minimized:\s*!state\.minimized/u);
});

void test("fully restored graph coordinates remain stable through initial reopen and viewport synchronization", () => {
  const radial = loadModule("src/relationship-graph/radial-layout.ts");
  const workerCore = loadModule("src/relationship-graph/worker-core.ts", { "./radial-layout": radial });
  const core = new workerCore.RelationshipGraphForceCore();
  const original = {
    root: { x: 420, y: 310 },
    child: { x: 610, y: 355 }
  };
  core.reconcile(1, [
    { id: "root", kind: "conversation", root: true, order: 0, x: original.root.x, y: original.root.y, restored: true },
    { id: "child", kind: "conversation", parentId: "root", order: 0, x: original.child.x, y: original.child.y, restored: true }
  ], [
    { id: "root-child", sourceId: "root", targetId: "child", kind: "parent-child" }
  ]);
  core.setViewport(880, 550);
  for (let index = 0; index < 120; index += 1) core.tick();
  const rootNode = core.node("root");
  const childNode = core.node("child");
  assert.ok(rootNode && childNode);
  assert.deepEqual({ x: rootNode.x, y: rootNode.y }, original.root);
  assert.deepEqual({ x: childNode.x, y: childNode.y }, original.child);
  assert.equal(core.isActive(), false);

  core.setViewport(960, 620);
  assert.equal(core.isActive(), true);
});

void test("persisted graph positions are marked as restored in the Worker topology", () => {
  const domainTypes = loadModule("src/domain/types.ts");
  const state = loadModule("src/relationship-graph/state.ts");
  const model = loadModule("src/relationship-graph/model.ts", {
    "./state": state,
    "../domain/types": domainTypes
  });
  const conversation = {
    schemaVersion: 1, id: "space", title: "Space", status: "active", revision: 1, checksum: "x",
    createdAt: "2026-08-04T00:00:00.000Z", updatedAt: "2026-08-04T00:00:00.000Z",
    rootNodeId: "root", currentNodeId: "root",
    nodes: { root: { id: "root", parentId: null, childIds: [], title: "Root", messages: [] } },
    ui: { expandedNodeIds: [], treeScrollTop: 0, messageScrollTopByNode: {} },
    depositGraphState: {
      protocol: "deposit-graph:v1", nodeStates: {}, edgeOverrides: {},
      nodePositions: { "conversation:root": { x: 420, y: 310, fixed: false } }
    }
  };
  const snapshot = new model.RelationshipGraphModelAdapter().snapshot("space", conversation);
  const topology = model.relationshipGraphWorkerTopology(snapshot);
  assert.equal(topology.nodes[0]?.restored, true);
});
