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

function loadSharedMemory() {
  const module = { exports: {} };
  new Function("module", "exports", "require", transpile("src/relationship-graph/shared-memory.ts"))(
    module,
    module.exports,
    require
  );
  return module.exports;
}

void test("shared graph memory publishes stable triple-buffer pages and drag state", () => {
  const {
    createRelationshipGraphSharedMemory,
    relationshipGraphSharedPositionPages,
    RelationshipGraphSharedMemoryReader,
    RelationshipGraphSharedMemoryWriter,
    RelationshipGraphSharedDragReader,
    RelationshipGraphSharedDragWriter
  } = loadSharedMemory();
  const descriptor = createRelationshipGraphSharedMemory(4, 7);
  assert.equal(descriptor.pageCount, 3);
  assert.equal(relationshipGraphSharedPositionPages(descriptor).length, 3);
  const writer = new RelationshipGraphSharedMemoryWriter(descriptor);
  const reader = new RelationshipGraphSharedMemoryReader(descriptor);
  const control = new Int32Array(descriptor.controlBuffer);
  Atomics.store(control, 8, 1);
  assert.equal(reader.acquire(), undefined);
  Atomics.store(control, 8, 2);
  const first = writer.beginWrite();
  assert.ok(first);
  first.values.set([10, 20, 0, 1]);
  assert.equal(writer.publish(first, true), 1);
  const held = reader.acquire();
  assert.ok(held);
  assert.equal(held.values[0], 10);
  assert.equal(held.active, true);
  const second = writer.beginWrite();
  assert.ok(second);
  assert.notEqual(second.pageIndex, held.pageIndex);
  second.values.set([30, 40, 0, 1]);
  writer.publish(second, false);
  held.release();
  const latest = reader.acquire();
  assert.ok(latest);
  assert.equal(latest.values[0], 30);
  assert.equal(latest.active, false);
  latest.release();

  const dragWriter = new RelationshipGraphSharedDragWriter(descriptor);
  const dragReader = new RelationshipGraphSharedDragReader(descriptor);
  const interaction = new Int32Array(descriptor.interactionBuffer);
  Atomics.store(interaction, 0, 1);
  Atomics.store(interaction, 3, 1);
  assert.equal(dragReader.consume(), undefined);
  Atomics.store(interaction, 0, 0);
  Atomics.store(interaction, 3, 2);
  dragWriter.start(2, 88, 99);
  assert.deepEqual(dragReader.consume(), { sequence: 1, active: true, nodeIndex: 2, x: 88, y: 99 });
  dragWriter.end(2);
  assert.deepEqual(dragReader.consume(), { sequence: 2, active: false, nodeIndex: 2, x: 88, y: 99 });
});

void test("node and edge mesh data reference shared texture coordinates", () => {
  const shared = loadSharedMemory();
  const module = { exports: {} };
  const localRequire = (request) => {
    if (request === "./shared-memory") return shared;
    throw new Error(`unexpected module ${request}`);
  };
  new Function("module", "exports", "require", transpile("src/relationship-graph/pixi-shared-geometry.ts"))(
    module,
    module.exports,
    localRequire
  );
  const { buildRelationshipGraphNodeMeshData, buildRelationshipGraphEdgeMeshData } = module.exports;
  const theme = { accent: 0xff0000, node: 0x808080, edge: 0x404040, text: "#fff" };
  const nodes = [
    { id: "a", x: 0, y: 0, radius: 8, note: false, highlighted: false, dimmed: false, excluded: false, active: false, focused: false },
    { id: "b", x: 0, y: 0, radius: 8, note: false, highlighted: false, dimmed: false, excluded: false, active: false, focused: false }
  ];
  const edges = [{ id: "a-b", sourceX: 0, sourceY: 0, targetX: 0, targetY: 0, highlighted: false, dimmed: false, excluded: false }];
  const nodeData = buildRelationshipGraphNodeMeshData(nodes, new Map([["a", 0], ["b", 1]]), 2, 1, theme);
  const edgeData = buildRelationshipGraphEdgeMeshData(edges, [{ id: "a-b", sourceIndex: 0, targetIndex: 1 }], 2, 1, theme);
  assert.deepEqual([...nodeData.positionUvs.slice(0, 2)], [0.25, 0.5]);
  assert.deepEqual([...nodeData.positionUvs.slice(8, 10)], [0.75, 0.5]);
  assert.deepEqual([...edgeData.sourceUvs.slice(0, 2)], [0.25, 0.5]);
  assert.deepEqual([...edgeData.targetUvs.slice(0, 2)], [0.75, 0.5]);
});

void test("shared graph source keeps one RAF authority and GPU-expanded edges", () => {
  const windowSource = fs.readFileSync(path.join(root, "src/relationship-graph/window.ts"), "utf8");
  const runtimeSource = fs.readFileSync(path.join(root, "src/relationship-graph/worker-runtime.ts"), "utf8");
  const workerClientSource = fs.readFileSync(path.join(root, "src/relationship-graph/worker-client.ts"), "utf8");
  const geometrySource = fs.readFileSync(path.join(root, "src/relationship-graph/pixi-shared-geometry.ts"), "utf8");
  assert.match(windowSource, /private ensureAnimationFrame\(\): void/u);
  assert.match(windowSource, /this\.view\.renderShared/u);
  assert.doesNotMatch(windowSource, /timestamp\s*-\s*1000\s*\/\s*30/u);
  assert.match(runtimeSource, /publishSharedFrame/u);
  assert.match(runtimeSource, /if \(this\.sharedWriter !== undefined\)/u);
  const sharedDragStart = workerClientSource.indexOf("this.sharedDragWriter.start(index, x, y);");
  const sharedWake = workerClientSource.indexOf(
    'this.post({ type: "drag-start", sessionId: this.options.sessionId, nodeId, x, y });',
    sharedDragStart
  );
  const sharedReturn = workerClientSource.indexOf("return;", sharedDragStart);
  assert.ok(sharedDragStart >= 0 && sharedWake > sharedDragStart && sharedWake < sharedReturn);
  assert.match(runtimeSource, /case "drag-start":\s*if \(this\.sharedMode\) this\.consumeSharedDrag\(\);/u);
  assert.match(runtimeSource, /type: "shared-activity"/u);
  assert.match(workerClientSource, /source\.type === "shared-activity"/u);
  assert.match(windowSource, /onSharedActivity: \(\) => this\.scheduleRender\("positions"\)/u);
  assert.match(geometrySource, /texture2D\(uPositionTexture, aSourceUv\)/u);
  assert.match(geometrySource, /texture2D\(uPositionTexture, aTargetUv\)/u);
  assert.match(geometrySource, /gl\.drawElements\(gl\.TRIANGLES/gu);
  assert.match(geometrySource, /class RelationshipGraphGpuGeometry/gu);
});

void test("shared geometry uploads a position page only when its sequence changes", () => {
  const shared = loadSharedMemory();
  let textureUploads = 0;
  let objectId = 0;
  const gl = {
    MAX_VERTEX_TEXTURE_IMAGE_UNITS: 0x8b4c,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    TEXTURE_2D: 0x0de1,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    NEAREST: 0x2600,
    CLAMP_TO_EDGE: 0x812f,
    RGBA: 0x1908,
    FLOAT: 0x1406,
    ARRAY_BUFFER: 0x8892,
    ELEMENT_ARRAY_BUFFER: 0x8893,
    STATIC_DRAW: 0x88e4,
    UNSIGNED_INT: 0x1405,
    UNSIGNED_SHORT: 0x1403,
    TEXTURE0: 0x84c0,
    BLEND: 0x0be2,
    ONE: 1,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    DEPTH_TEST: 0x0b71,
    TRIANGLES: 0x0004,
    getParameter() { return 8; },
    getExtension(name) { return name === "OES_texture_float" ? {} : null; },
    createShader() { return { id: ++objectId }; },
    shaderSource() {},
    compileShader() {},
    getShaderParameter() { return true; },
    getShaderInfoLog() { return ""; },
    createProgram() { return { id: ++objectId }; },
    attachShader() {},
    linkProgram() {},
    getProgramParameter() { return true; },
    getProgramInfoLog() { return ""; },
    deleteShader() {},
    getAttribLocation(_program, name) { return name.length; },
    getUniformLocation() { return { id: ++objectId }; },
    createTexture() { return { id: ++objectId }; },
    bindTexture() {},
    texParameteri() {},
    texImage2D() {},
    texSubImage2D() { textureUploads += 1; },
    createBuffer() { return { id: ++objectId }; },
    bindBuffer() {},
    bufferData() {},
    deleteBuffer() {},
    deleteTexture() {},
    deleteProgram() {},
    activeTexture() {},
    enable() {},
    blendFunc() {},
    disable() {},
    useProgram() {},
    uniform2f() {},
    uniform3f() {},
    uniform1i() {},
    enableVertexAttribArray() {},
    vertexAttribPointer() {},
    drawElements() {}
  };
  const module = { exports: {} };
  const localRequire = (request) => {
    if (request === "./shared-memory") return shared;
    throw new Error(`unexpected module ${request}`);
  };
  new Function("module", "exports", "require", transpile("src/relationship-graph/pixi-shared-geometry.ts"))(
    module,
    module.exports,
    localRequire
  );
  const descriptor = shared.createRelationshipGraphSharedMemory(1, 1);
  const geometry = new module.exports.RelationshipGraphSharedGeometry(
    gl,
    descriptor,
    { accent: 0xff0000, node: 0x808080, edge: 0x404040, text: "#fff" }
  );
  geometry.update({
    camera: { scale: 1, panX: 0, panY: 0 },
    nodes: [{ id: "a", x: 0, y: 0, radius: 8, note: false, highlighted: false, dimmed: false, excluded: false, active: false, focused: false }],
    edges: [],
    labels: []
  }, ["a"], []);
  const camera = { scale: 1, panX: 0, panY: 0 };
  geometry.render(1, 7, camera, { width: 800, height: 600 });
  geometry.render(1, 7, camera, { width: 800, height: 600 });
  assert.equal(textureUploads, 1);
  geometry.render(1, 8, camera, { width: 800, height: 600 });
  assert.equal(textureUploads, 2);
});
