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

const domainTypes = loadModule("src/domain/types.ts");
const radial = loadModule("src/relationship-graph/radial-layout.ts");
const workerCore = loadModule("src/relationship-graph/worker-core.ts", { "./radial-layout": radial });
const state = loadModule("src/relationship-graph/state.ts");
const model = loadModule("src/relationship-graph/model.ts", { "./state": state, "../domain/types": domainTypes });

const conversationNode = (id, parentId, childIds, title, messages = []) => ({
  id,
  parentId,
  childIds,
  title,
  messages,
  draft: { text: "", mode: "new", selectionContexts: [] },
  createdAt: "2026-08-04T00:00:00.000Z",
  updatedAt: "2026-08-04T00:00:00.000Z"
});

void test("radial planner allocates deterministic non-overlapping subtree sectors", () => {
  const c = (id, parentId, order, rootNode = false) => ({ id, kind: "conversation", parentId, order, root: rootNode });
  const nodes = [
    c("root", undefined, 0, true),
    c("large", "root", 0),
    c("large-1", "large", 0),
    c("large-2", "large", 1),
    c("large-3", "large", 2),
    c("small", "root", 1)
  ];
  const first = radial.planRelationshipGraphRadialLayout(nodes, { width: 1000, height: 800 });
  const second = radial.planRelationshipGraphRadialLayout(nodes, { width: 1000, height: 800 });
  assert.deepEqual([...first.targets.entries()], [...second.targets.entries()]);
  const rootTarget = first.targets.get("root");
  const large = first.targets.get("large");
  const small = first.targets.get("small");
  assert.deepEqual({ x: rootTarget.x, y: rootTarget.y, radius: rootTarget.radius }, { x: 500, y: 400, radius: 0 });
  assert.ok(large.sectorEnd <= small.sectorStart);
  assert.ok(large.sectorEnd - large.sectorStart > small.sectorEnd - small.sectorStart);
  for (const id of ["large", "large-1", "large-2", "large-3"]) {
    const target = first.targets.get(id);
    assert.equal(radial.angleWithinSector(target.angle, large.sectorStart, large.sectorEnd), true);
  }
});

void test("force core settles into center-out rings and returns a dragged node", () => {
  const core = new workerCore.RelationshipGraphForceCore();
  core.setViewport(1000, 800);
  core.reconcile(1, [
    { id: "root", kind: "conversation", root: true, order: 0, x: 20, y: 20 },
    { id: "a", kind: "conversation", parentId: "root", order: 0, x: 30, y: 30 },
    { id: "a1", kind: "conversation", parentId: "a", order: 0, x: 40, y: 40 },
    { id: "b", kind: "conversation", parentId: "root", order: 1, x: 50, y: 50 },
    { id: "b1", kind: "conversation", parentId: "b", order: 0, x: 60, y: 60 },
    { id: "note", kind: "note", hostId: "a1", noteRelation: "source-note", order: 0, orbitIndex: 0, orbitCount: 1, x: 70, y: 70 }
  ], [
    { id: "r-a", sourceId: "root", targetId: "a", kind: "parent-child" },
    { id: "a-a1", sourceId: "a", targetId: "a1", kind: "parent-child" },
    { id: "r-b", sourceId: "root", targetId: "b", kind: "parent-child" },
    { id: "b-b1", sourceId: "b", targetId: "b1", kind: "parent-child" },
    { id: "a1-note", sourceId: "a1", targetId: "note", kind: "source-note" }
  ]);
  for (let index = 0; index < 650; index += 1) core.tick();
  const get = (id) => {
    const node = core.node(id);
    assert.ok(node);
    return node;
  };
  const radius = (id) => Math.hypot(get(id).x - 500, get(id).y - 400);
  assert.ok(radius("root") < 8);
  assert.ok(radius("a1") - radius("a") > 70);
  assert.ok(radius("b1") - radius("b") > 70);
  assert.ok(radius("note") > radius("a1"));
  const aAngle = Math.atan2(get("a").y - 400, get("a").x - 500);
  const bAngle = Math.atan2(get("b").y - 400, get("b").x - 500);
  const branchDelta = Math.abs(Math.atan2(Math.sin(aAngle - bAngle), Math.cos(aAngle - bAngle)));
  assert.ok(branchDelta > 1.8);
  core.beginDrag("a1", 720, 280);
  core.tick(5);
  assert.deepEqual({ x: get("a1").x, y: get("a1").y }, { x: 720, y: 280 });
  core.endDrag("a1");
  for (let index = 0; index < 450; index += 1) core.tick();
  assert.ok(Math.hypot(get("a1").x - get("a1").target.x, get("a1").y - get("a1").target.y) < 70);
  assert.equal(core.isActive(), false);
});

void test("relationship model emits hierarchy and note-orbit metadata", () => {
  const selection = {
    sourceType: "note",
    filePath: "Notes/a.md",
    fileName: "a.md",
    basis: "note-source-v1",
    startOffset: 0,
    endOffset: 1,
    quote: "a",
    prefix: "",
    suffix: "",
    contentHash: "hash"
  };
  const conversation = {
    schemaVersion: 1,
    id: "space",
    title: "Space",
    status: "active",
    revision: 1,
    checksum: "checksum",
    createdAt: "2026-08-04T00:00:00.000Z",
    updatedAt: "2026-08-04T00:00:00.000Z",
    rootNodeId: "root",
    currentNodeId: "root",
    nodes: {
      root: conversationNode("root", null, ["b", "a"], "Root"),
      a: conversationNode("a", "root", [], "A", [{ id: "u", role: "user", content: "q", status: "complete", createdAt: "2026-08-04T00:00:00.000Z", updatedAt: "2026-08-04T00:00:00.000Z", selectionContexts: [selection] }]),
      b: conversationNode("b", "root", [], "B")
    },
    ui: { expandedNodeIds: [], treeScrollTop: 0, messageScrollTopByNode: {} }
  };
  const snapshot = new model.RelationshipGraphModelAdapter().snapshot("session", conversation);
  const find = (id) => snapshot.nodes.find((node) => node.id === id);
  assert.equal(find("conversation:root").layoutRoot, true);
  assert.equal(find("conversation:b").layoutOrder, 0);
  assert.equal(find("conversation:a").layoutOrder, 1);
  const note = find(model.noteRelationshipNodeId("Notes/a.md"));
  assert.equal(note.layoutHostId, "conversation:a");
  assert.equal(note.layoutNoteRelation, "source-note");
  assert.equal(note.layoutOrbitCount, 1);
  const topology = model.relationshipGraphWorkerTopology(snapshot);
  assert.equal(topology.links.find((edge) => edge.id.startsWith("parent-child:"))?.kind, "parent-child");
});


void test("crowded radial branches expand and dense note groups use multiple rings", () => {
  const branchNodes = Array.from({ length: 40 }, (_, index) => ({
    id: `branch-${index}`, kind: "conversation", parentId: "root", order: index
  }));
  const notes = Array.from({ length: 14 }, (_, index) => ({
    id: `note-${index}`, kind: "note", hostId: "branch-0", order: index,
    orbitIndex: index, orbitCount: 14, noteRelation: "source-note"
  }));
  const plan = radial.planRelationshipGraphRadialLayout([
    { id: "root", kind: "conversation", root: true, order: 0 },
    ...branchNodes,
    ...notes
  ], { width: 1000, height: 800 });
  const ordered = branchNodes.map((node) => plan.targets.get(node.id));
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    assert.ok(Math.hypot(current.x - previous.x, current.y - previous.y) >= 52);
  }
  const radii = new Set(notes.map((note) => Math.round(plan.targets.get(note.id).radius)));
  assert.ok(radii.size >= 3);
});

void test("radial layout remains inside the shared GPU architecture", () => {
  const windowSource = fs.readFileSync(path.join(root, "src/relationship-graph/window.ts"), "utf8");
  const coreSource = fs.readFileSync(path.join(root, "src/relationship-graph/worker-core.ts"), "utf8");
  const geometrySource = fs.readFileSync(path.join(root, "src/relationship-graph/pixi-shared-geometry.ts"), "utf8");
  assert.match(windowSource, /relationshipGraphWorkerTopology/u);
  assert.match(windowSource, /planRelationshipGraphRadialLayout/u);
  assert.match(coreSource, /applyLayoutForce/u);
  assert.match(coreSource, /planRelationshipGraphRadialLayout/u);
  assert.match(geometrySource, /edge\.kind === "parent-child"/u);
  assert.match(geometrySource, /uPositionTexture/u);
  assert.doesNotMatch(coreSource, /RELATIONSHIP_GRAPH_CENTER_STRENGTH/u);
});
