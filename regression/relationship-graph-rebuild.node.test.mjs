import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("the plugin entry uses only the rebuilt relationship graph window", () => {
  const source = read("src/main.ts");
  assert.match(source, /relationship-graph\/window/);
  assert.doesNotMatch(source, /deposit-graph\/window|DepositGraphWindow/);
});

test("the build config bundles only the rebuilt Worker", () => {
  const source = read("esbuild.config.mjs");
  assert.match(source, /relationship-graph-worker-source/);
  assert.doesNotMatch(source, /legacy-deposit-graph|src\/deposit-graph\/force-worker/);
});

test("the visible graph styles are owned by the rebuilt window", () => {
  const styles = read("styles.css");
  assert.match(styles, /\.relationship-graph-window/);
  assert.doesNotMatch(styles, /\.treetalk-deposit-window|\.treetalk-deposit-pixi-mount/);
});

test("the graph uses persistent WebGL batches and a camera-only frame path", () => {
  const view = read("src/relationship-graph/pixi-view.ts");
  const geometry = read("src/relationship-graph/pixi-shared-geometry.ts");
  const window = read("src/relationship-graph/window.ts");
  assert.match(view, /RelationshipGraphGpuGeometry/);
  assert.match(geometry, /gl\.drawElements/);
  assert.match(geometry, /uPositionTexture/);
  assert.doesNotMatch(view, /graphics\.clear\(/);
  assert.match(view, /renderCamera\(camera\)/);
  assert.match(window, /frameInterpolator/);
  assert.match(window, /renderCamera/);
});
