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

void test("composer is a flat theme-aware panel", () => {
  const composer = rule(".treetalk-composer");
  assert.match(composer, /margin:\s*8px 10px 10px/u);
  assert.match(
    composer,
    /border:\s*1px solid var\(--background-modifier-border\)/u
  );
  assert.match(composer, /border-radius:\s*8px/u);
  assert.match(composer, /background:\s*var\(--background-primary-alt\)/u);
  assert.match(composer, /box-shadow:\s*none/u);

  const focused = rule(".treetalk-composer:focus-within");
  assert.match(focused, /color-mix\([^;]*var\(--interactive-accent\)/u);
  assert.match(focused, /box-shadow:\s*none/u);

  const child = rule(".treetalk-composer.is-child");
  assert.match(child, /background:[^;]*color-mix\([^;]*--interactive-accent/u);
  assert.doesNotMatch(child, /0 0 0 1px var\(--interactive-accent\)/u);
});

void test("selection chips are flat strips with accessible removal targets", () => {
  const chip = rule(".treetalk-selection-chip");
  assert.match(chip, /margin:\s*0 0 5px/u);
  assert.match(chip, /border-radius:\s*6px/u);
  assert.match(chip, /background:[^;]*color-mix\([^;]*--interactive-accent/u);
  assert.match(chip, /box-shadow:\s*none/u);

  const remove = rule("button.treetalk-selection-chip-remove");
  assert.match(remove, /width:\s*24px/u);
  assert.match(remove, /height:\s*24px/u);
  assert.match(remove, /border-radius:\s*6px/u);
  assert.match(
    rule("button.treetalk-selection-chip-remove:focus-visible"),
    /box-shadow:\s*0 0 0 2px[^;]*--interactive-accent/u
  );
});

void test("composer actions form one stable right-aligned group", () => {
  assert.match(rule(".treetalk-input-row"), /flex-direction:\s*column/u);
  assert.match(rule(".treetalk-input-actions"), /display:\s*flex/u);
  const actionGroup = rule(".treetalk-composer-actions");
  assert.match(actionGroup, /margin-left:\s*auto/u);
  assert.match(actionGroup, /justify-content:\s*flex-end/u);
  assert.match(actionGroup, /flex-wrap:\s*nowrap/u);

  const branchMode = rule(".treetalk-branch-mode");
  assert.match(branchMode, /background:\s*transparent/u);
  assert.match(branchMode, /padding:\s*0/u);

  const engine = rule(".treetalk-execution-mode-toggle");
  assert.match(engine, /width:\s*28px/u);
  assert.match(engine, /height:\s*28px/u);
  assert.match(rule(".treetalk-execution-mode-toggle.is-pi"), /interactive-accent/u);

  const related = rule(".treetalk-related-note-toggle");
  assert.match(related, /width:\s*28px/u);
  assert.match(related, /height:\s*28px/u);
  assert.match(rule(".treetalk-related-note-toggle.is-enabled"), /interactive-accent/u);

  const webSearch = rule(".treetalk-web-search-toggle");
  assert.match(webSearch, /width:\s*28px/u);
  assert.match(webSearch, /height:\s*28px/u);
  assert.match(webSearch, /border-radius:\s*6px/u);

  const send = rule(".treetalk-send");
  assert.match(send, /width:\s*28px/u);
  assert.match(send, /height:\s*28px/u);
  assert.match(send, /border-radius:\s*6px/u);
  assert.match(
    rule(".treetalk-send:disabled"),
    /background:\s*var\(--background-modifier-hover\)/u
  );
  assert.match(
    rule(".treetalk-stop"),
    /background:\s*var\(--background-modifier-error\)/u
  );
  assert.match(rule(".treetalk-send svg"), /width:\s*14px/u);
  assert.match(rule(".treetalk-execution-mode-toggle svg"), /width:\s*14px/u);
  assert.match(rule(".treetalk-related-note-toggle svg"), /width:\s*14px/u);
  assert.match(rule(".treetalk-web-search-toggle svg"), /width:\s*14px/u);
});
