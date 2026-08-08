import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const root = process.cwd();
const sourcePath = path.join(root, "src/providers/transient-thinking-store.ts");
const output = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
  fileName: sourcePath,
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    verbatimModuleSyntax: false
  }
}).outputText;
const module = { exports: {} };
new Function("module", "exports", "require", output)(module, module.exports, require);
const { TransientThinkingStore } = module.exports;

function fakeClock() {
  const jobs = [];
  return {
    jobs,
    schedule(callback, delayMs) {
      const job = { callback, delayMs, cancelled: false };
      jobs.push(job);
      return job;
    },
    cancel(job) {
      job.cancelled = true;
    },
    flushNext() {
      const job = jobs.find((entry) => !entry.cancelled);
      assert.ok(job, "expected a scheduled notification");
      job.cancelled = true;
      job.callback();
    }
  };
}

void test("thinking appends coalesce into one 50 ms targeted notification", () => {
  const clock = fakeClock();
  const store = new TransientThinkingStore({
    schedule: (callback, delayMs) => clock.schedule(callback, delayMs),
    cancel: (handle) => clock.cancel(handle),
    throttleMs: 50
  });
  const changes = [];
  store.subscribe((change) => changes.push(change));
  for (let index = 0; index < 500; index += 1) store.append("m1", "x");
  assert.equal(changes.length, 0);
  assert.equal(clock.jobs.length, 1);
  assert.equal(clock.jobs[0].delayMs, 50);
  clock.flushNext();
  assert.deepEqual(changes, [{ messageIds: ["m1"] }]);
  assert.equal(store.get("m1").content.length, 500);
});

void test("delete and clear cancel pending work and notify affected messages immediately", () => {
  const clock = fakeClock();
  const store = new TransientThinkingStore({
    schedule: (callback, delayMs) => clock.schedule(callback, delayMs),
    cancel: (handle) => clock.cancel(handle),
    throttleMs: 50
  });
  const changes = [];
  store.subscribe((change) => changes.push(change));
  store.append("m1", "a");
  store.delete("m1");
  assert.deepEqual(changes, [{ messageIds: ["m1"] }]);
  store.append("m2", "b");
  store.append("m3", "c");
  store.clear();
  assert.deepEqual(changes, [
    { messageIds: ["m1"] },
    { messageIds: ["m2", "m3"] }
  ]);
  assert.equal(store.get("m2"), undefined);
  assert.equal(store.get("m3"), undefined);
});

void test("conversation view updates only changed thinking messages", () => {
  const view = fs.readFileSync(path.join(root, "src/views/conversation-view.ts"), "utf8");
  const subscription = view.match(/const unsubscribeThinking[\s\S]*?const unsubscribeWebSearch/u)?.[0] ?? "";
  assert.match(subscription, /subscribe\(\(change\)/u);
  assert.match(subscription, /for \(const messageId of change\.messageIds\)/u);
  assert.match(subscription, /syncThinkingMessage\(messageId\)/u);
  assert.doesNotMatch(subscription, /\bsync\(\)/u);
});

void test("thinking rendering appends only the suffix and avoids collapsed-panel layout reads", () => {
  const view = fs.readFileSync(path.join(root, "src/views/conversation-view.ts"), "utf8");
  assert.match(view, /renderedThinkingLength/u);
  assert.match(view, /record\.content\.slice\(view\.renderedThinkingLength\)/u);
  assert.match(view, /append\(\s*container\.ownerDocument\.createTextNode\(suffix\)\s*\)/u);
  assert.match(view, /view\.thinkingPanel\.open\s*&&\s*isNearBottom\(view\.thinkingContent\)/u);
  assert.doesNotMatch(view, /thinkingContent\.textContent\s*=\s*record\.content;\s*\n\s*view\.thinkingContent\.scrollTop\s*=\s*view\.thinkingContent\.scrollHeight/u);
});
