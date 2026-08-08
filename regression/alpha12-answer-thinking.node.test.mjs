import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

void test("settings use binary thinking while legacy draft overrides stay parseable", () => {
  const pluginData = read("src/tabs/plugin-data.ts");
  const domainTypes = read("src/domain/types.ts");
  const schema = read("src/domain/schema.ts");
  assert.match(pluginData, /answerThinkingMode:\s*AnswerThinkingMode/u);
  assert.match(pluginData, /answerThinkingMode:\s*"disabled"/u);
  assert.match(pluginData, /settings\.answerThinkingMode === "enabled" \? "enabled" : "disabled"/u);
  assert.match(domainTypes, /answerThinkingModeOverride\?:\s*AnswerThinkingMode/u);
  assert.match(schema, /answerThinkingModeOverride/u);
  const main = read("src/main.ts");
  const view = read("src/views/conversation-view.ts");
  assert.doesNotMatch(main, /draft\.answerThinkingModeOverride/u);
  assert.doesNotMatch(view, /draft\.answerThinkingModeOverride/u);
});

void test("composer exposes one binary thinking control", () => {
  const view = read("src/views/conversation-view.ts");
  assert.match(view, /AnswerThinkingControlPort/u);
  assert.match(view, /treetalk-answer-thinking-toggle/u);
  assert.match(view, /思考模式：\$\{thinkingModeLabel\}/u);
  assert.doesNotMatch(view, /思考模式：自动/u);
  assert.match(view, /answerThinkingMode === "enabled" \? "disabled" : "enabled"/u);
  assert.doesNotMatch(view, /executionMode\s*===\s*"pi"[\s\S]{0,200}answerThinking/u);
});

void test("main resolves and forwards thinking for every answer request", () => {
  const main = read("src/main.ts");
  const executionTypes = read("src/execution/types.ts");
  assert.match(main, /answerThinkingMode:\s*requestedAnswerThinkingMode/u);
  assert.match(main, /currentQuestion:\s*text/u);
  assert.match(executionTypes, /answerThinkingMode\?:\s*AnswerThinkingMode/u);
  assert.match(executionTypes, /currentQuestion\?:\s*string/u);
});

void test("legacy and Pi apply shared thinking while selectors stay disabled", () => {
  const legacy = read("src/execution/legacy-execution-engine.ts");
  const twoPass = read("src/agent/pi/two-pass-execution-engine.ts");
  const progressive = read("src/agent/pi/progressive/progressive-execution-engine.ts");
  const turnRunner = read("src/agent/pi/progressive/provider-turn-runner.ts");
  assert.match(legacy, /thinkingEnabled:\s*answerThinking\.enabled/u);
  assert.match(twoPass, /thinkingEnabled:\s*answerThinking\.enabled/u);
  assert.match(twoPass, /thinkingEnabled:\s*false/u);
  assert.match(progressive, /thinkingEnabled:\s*answerThinking\.enabled/u);
  assert.match(
    turnRunner,
    /runBufferedOnceWithTransientRetry\(\s*false,\s*"thinking-disabled-recovery"\s*\)/u
  );
});
