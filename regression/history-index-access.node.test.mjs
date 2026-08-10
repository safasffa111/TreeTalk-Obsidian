import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../src/main.ts", import.meta.url),
  "utf8"
);

function privateMethodBody(name) {
  const start = source.indexOf(`  private async ${name}(`);
  assert.notEqual(start, -1, `${name} is missing`);
  const end = source.indexOf("\n  private ", start + 1);
  assert.notEqual(end, -1, `${name} has no following method boundary`);
  return source.slice(start, end);
}

for (const name of ["openHistoryManager", "openHistorySource"]) {
  test(`${name} uses incremental history refresh`, () => {
    const body = privateMethodBody(name);
    assert.match(body, /index\.ensureFresh\(\)/u);
    assert.doesNotMatch(body, /\.rebuild\(\)/u);
    assert.doesNotMatch(body, /lifecycleReconciler\?\.reconcile\(\)/u);
  });
}
