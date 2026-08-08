import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const css = fs.readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const conversationView = fs.readFileSync(
  new URL("../src/views/conversation-view.ts", import.meta.url),
  "utf8"
);

test("user bubble margin reset targets the actual nested markdown wrapper", () => {
  assert.match(
    conversationView,
    /renderedMount\.className\s*=\s*["']treetalk-streaming-rendered["']/
  );
  assert.match(
    css,
    /\.treetalk-message\.is-user \.treetalk-streaming-rendered > :first-child\s*\{[^}]*margin-block-start:\s*0\s*!important;/s
  );
  assert.match(
    css,
    /\.treetalk-message\.is-user \.treetalk-streaming-rendered > :last-child\s*\{[^}]*margin-block-end:\s*0\s*!important;/s
  );
  assert.match(
    css,
    /\.treetalk-message\.is-user \.treetalk-streaming-rendered > p:only-child\s*\{[^}]*margin:\s*0\s*!important;/s
  );
});
