import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../src/main.ts", import.meta.url),
  "utf8"
);

function restoreOpenTabsBody() {
  const start = source.indexOf("  private async restoreOpenTabs(");
  assert.notEqual(start, -1, "restoreOpenTabs is missing");
  const end = source.indexOf("\n  private ", start + 1);
  assert.notEqual(end, -1, "restoreOpenTabs has no following method boundary");
  return source.slice(start, end);
}

test("startup restore uses ordered controlled conversation loading", () => {
  const body = restoreOpenTabsBody();
  assert.match(body, /Promise\.all\(\[/u);
  assert.match(body, /loadStartupConversations\(\{/u);
  assert.doesNotMatch(body, /repository\?\.load\(folder\)/u);
  assert.doesNotMatch(body, /interruptOrphanedResponses\(/u);
});
