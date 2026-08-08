import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

void test("composer exposes related-note, divergence, and binary thinking controls backed by settings", () => {
  const view = read("src/views/conversation-view.ts");
  assert.doesNotMatch(view, /ExecutionModeControlPort/u);
  assert.match(view, /RelatedNoteControlPort/u);
  assert.match(view, /ContextDivergenceControlPort/u);
  assert.match(view, /setMode\(mode:\s*AnswerThinkingMode\)/u);
  assert.doesNotMatch(view, /treetalk-execution-mode-toggle/u);
  assert.match(view, /treetalk-related-note-toggle/u);
  assert.match(view, /treetalk-context-divergence-toggle/u);
  assert.match(view, /treetalk-answer-thinking-toggle/u);
  assert.doesNotMatch(view, /draft\.answerThinkingModeOverride/u);
});

void test("plugin publishes and persists one global composer-control state", () => {
  const main = read("src/main.ts");
  assert.match(main, /composerControlListeners/u);
  assert.match(main, /subscribeComposerControls/u);
  assert.doesNotMatch(main, /setExecutionMode/u);
  assert.match(main, /setRelatedNoteContextEnabled/u);
  assert.match(main, /setContextDivergenceEnabled/u);
  assert.match(main, /setAnswerThinkingMode/u);
  assert.match(
    main,
    /for \(const listener of \[\.\.\.this\.composerControlListeners\]\) listener\(\)/u
  );
  assert.doesNotMatch(main, /executionMode:\s*\(\)/u);
  assert.match(main, /relatedNoteContextEnabled:\s*\(\)\s*=>\s*this\.pluginSettings\.relatedNoteContextEnabled/u);
  assert.match(main, /contextDivergenceEnabled:\s*\(\)\s*=>\s*this\.pluginSettings\.contextDivergenceEnabled/u);
  assert.match(main, /answerThinkingMode:\s*\(\)\s*=>\s*this\.pluginSettings\.answerThinkingMode/u);
});

void test("send snapshots global controls before changing conversation state", () => {
  const main = read("src/main.ts");
  const sendStart = main.indexOf("private async send(text: string)");
  const commandStart = main.indexOf("const command =", sendStart);
  assert.ok(sendStart >= 0 && commandStart > sendStart);
  const prefix = main.slice(sendStart, commandStart);
  assert.match(prefix, /const executionMode = "pi"/u);
  assert.match(prefix, /const requestedAnswerThinkingMode[\s\S]*this\.pluginSettings\.answerThinkingMode/u);
  assert.match(prefix, /const relatedNoteContextEnabled[\s\S]*this\.pluginSettings\.relatedNoteContextEnabled/u);
  assert.match(prefix, /const relatedNoteDepth = this\.pluginSettings\.relatedNoteDepth/u);
  assert.doesNotMatch(main.slice(sendStart), /restoreAnswerThinkingOverride/u);
});

void test("settings page subscribes to composer control changes", () => {
  const settings = read("src/settings-tab.ts");
  assert.match(settings, /unsubscribeComposerControls/u);
  assert.match(settings, /subscribeComposerControls\(/u);
  assert.match(settings, /=> this\.update\(\)/u);
});
