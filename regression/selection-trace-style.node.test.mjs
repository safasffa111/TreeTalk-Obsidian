import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const css = fs.readFileSync(path.join(process.cwd(), "styles.css"), "utf8");

function rule(selector) {
  const escaped = selector
    .trim()
    .split(/\s+/u)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("\\s+");
  const match = css.match(
    new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, "su")
  );
  assert.ok(match, `Missing CSS rule: ${selector}`);
  return match[1];
}

void test("selection traces define stronger shared Obsidian accent backgrounds", () => {
  const conversation = rule(".treetalk-conversation");
  assert.match(
    conversation,
    /--treetalk-selection-trace-bg:\s*color-mix\(\s*in srgb,\s*var\(--interactive-accent\) 32%,\s*transparent\s*\)/u
  );
  assert.match(
    conversation,
    /--treetalk-selection-trace-hover-bg:\s*color-mix\(\s*in srgb,\s*var\(--interactive-accent\) 42%,\s*transparent\s*\)/u
  );
  assert.match(
    conversation,
    /--treetalk-selection-source-bg:\s*color-mix\(\s*in srgb,\s*var\(--interactive-accent\) 28%,\s*transparent\s*\)/u
  );
  const body = rule(".treetalk-selection-trace");
  assert.match(body, /background:\s*var\(--treetalk-selection-trace-bg\)/u);
  assert.doesNotMatch(body, /box-shadow/u);
  assert.match(body, /border-radius:\s*(?:3px|4px|var\()/u);
  assert.match(
    rule(".treetalk-selection-trace:hover"),
    /background:\s*var\(--treetalk-selection-trace-hover-bg\)/u
  );
});

void test("atomic formula traces highlight the rendered formula rather than the scroll container", () => {
  assert.match(
    css,
    /\.treetalk-formula-block\.treetalk-selection-trace-atomic\s+\.treetalk-formula-rendered\s*\{/u
  );
  const atomic = rule(".treetalk-selection-trace-atomic");
  assert.match(atomic, /background:\s*var\(--treetalk-selection-trace-bg\)/u);
  assert.doesNotMatch(atomic, /box-shadow/u);
  assert.match(
    rule(".treetalk-formula-block.treetalk-selection-trace-atomic .treetalk-formula-rendered"),
    /background:\s*var\(--treetalk-selection-trace-bg\)/u
  );
});

void test("formula source preview uses a soft accent background", () => {
  const body = rule(".treetalk-formula-block.is-selection-source .treetalk-formula-source");
  assert.match(body, /background:\s*var\(--treetalk-selection-source-bg\)/u);
  assert.match(body, /border-radius/u);
});
