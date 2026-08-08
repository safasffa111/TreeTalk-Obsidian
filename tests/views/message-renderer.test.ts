// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  render: vi.fn(() => Promise.resolve())
}));

vi.mock("obsidian", () => {
  class Component {
    readonly children: Component[] = [];
    addChild(child: Component): Component {
      this.children.push(child);
      return child;
    }
    removeChild(child: Component): void {
      const index = this.children.indexOf(child);
      if (index >= 0) this.children.splice(index, 1);
    }
  }
  return {
    Component,
    MarkdownRenderer: { render: runtime.render }
  };
});

import { Component } from "obsidian";
import {
  ObsidianMessageRendererFactory,
  enhanceRenderedMarkdown,
  installObsidianFormulaSelection
} from "../../src/views/message-renderer";
import { selectionForDomRange } from "../../src/views/rendered-selection";

describe("ObsidianMessageRendererFactory", () => {
  beforeEach(() => runtime.render.mockClear());

  it("renders through Obsidian and disposes its child lifecycle", async () => {
    const owner = new Component();
    const factory = new ObsidianMessageRendererFactory(
      { name: "app" } as never,
      owner,
      "TreeTalk/source.md"
    );
    const renderer = factory.create();
    const container = document.createElement("div");

    await renderer.render("**native**", container);

    expect(runtime.render).toHaveBeenCalledWith(
      { name: "app" },
      "**native**",
      container,
      "TreeTalk/source.md",
      expect.any(Component)
    );
    const children = (owner as unknown as { children: Component[] }).children;
    expect(children).toHaveLength(1);

    renderer.dispose();

    expect(children).toHaveLength(0);
  });
});


describe("rendered Markdown source enhancement", () => {
  it("annotates semantic rendered elements with their original Markdown", () => {
    const container = document.createElement("div");
    container.innerHTML =
      '<p><strong>bold</strong> <code>value</code> <a href="https://example.com">link</a></p>';

    enhanceRenderedMarkdown(
      container,
      "**bold** `value` [link](https://example.com)"
    );

    expect(container.querySelector("strong")?.dataset.treetalkSourceText).toBe(
      "**bold**"
    );
    expect(container.querySelector("code")?.dataset.treetalkSourceText).toBe(
      "`value`"
    );
    expect(container.querySelector("a")?.dataset.treetalkSourceText).toBe(
      "[link](https://example.com)"
    );
  });

  it("does not install the obsolete manual formula source toggle", () => {
    const container = document.createElement("div");
    const rendered = document.createElement("div");
    rendered.className = "math-block";
    rendered.textContent = "∫x dx";
    container.append(rendered);

    const source = String.raw`$$
\int x\,dx
$$`;
    enhanceRenderedMarkdown(container, source);

    const block = container.querySelector<HTMLElement>(".treetalk-formula-block");
    expect(block?.dataset.treetalkSourceText).toBe(source);
    expect(block?.querySelector(".treetalk-formula-source-toggle")).toBeNull();
    expect(block?.classList.contains("is-source")).toBe(false);
    expect(block?.querySelector(".treetalk-formula-rendered")?.getAttribute("aria-hidden")).toBe("false");
  });

  it("keeps inline math in the extracted quote when native rendering uses an empty SVG", () => {
    const container = document.createElement("div");
    container.innerHTML =
      '<p id="line">before <span class="math-inline"><svg aria-label="omega"></svg></span> after</p>';
    enhanceRenderedMarkdown(container, "before $\\Omega$ after");

    const line = container.querySelector("#line");
    const before = line?.firstChild;
    const after = line?.lastChild;
    if (before === null || before === undefined || after === null || after === undefined) {
      throw new Error("Selection boundary text is missing");
    }
    const range = document.createRange();
    range.setStart(before, 0);
    range.setEnd(after, after.textContent?.length ?? 0);

    expect(selectionForDomRange(container, range)?.sourceText).toContain("$\\Omega$");
  });

  it("keeps a formula in the extracted quote when native rendering has no textContent", () => {
    const container = document.createElement("div");
    container.innerHTML =
      '<p id="before">before</p><div class="math-block"><svg aria-label="x squared"></svg></div><p id="after">after</p>';
    enhanceRenderedMarkdown(container, "before\n\n$$x^2$$\n\nafter");

    const before = container.querySelector("#before")?.firstChild;
    const after = container.querySelector("#after")?.firstChild;
    if (before === null || before === undefined || after === null || after === undefined) {
      throw new Error("Selection boundary text is missing");
    }
    const range = document.createRange();
    range.setStart(before, 0);
    range.setEnd(after, 5);

    expect(selectionForDomRange(container, range)?.sourceText).toContain("$$x^2$$");
  });

  it("reveals raw LaTeX beside the rendered formula while a native selection crosses it", () => {
    const container = document.createElement("div");
    container.innerHTML = '<p id="before">before</p><div class="math-block">x²</div><p id="after">after</p>';
    document.body.append(container);
    enhanceRenderedMarkdown(container, "before\n\n$$x^2$$\n\nafter");
    const cleanup = installObsidianFormulaSelection(container);

    const before = container.querySelector("#before")?.firstChild;
    const after = container.querySelector("#after")?.firstChild;
    const block = container.querySelector<HTMLElement>(".treetalk-formula-block");
    const source = block?.querySelector<HTMLElement>(".treetalk-formula-source");
    const rendered = block?.querySelector<HTMLElement>(".treetalk-formula-rendered");
    if (before === null || before === undefined || after === null || after === undefined) {
      throw new Error("Selection boundary text is missing");
    }

    const range = document.createRange();
    range.setStart(before, 0);
    range.setEnd(after, 5);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));

    expect(block?.classList.contains("is-selection-source")).toBe(true);
    expect(block?.firstElementChild).toBe(source);
    expect(source?.getAttribute("aria-hidden")).toBe("false");
    expect(rendered?.getAttribute("aria-hidden")).toBe("false");

    selection?.removeAllRanges();
    document.dispatchEvent(new Event("selectionchange"));
    expect(block?.classList.contains("is-selection-source")).toBe(false);
    expect(source?.getAttribute("aria-hidden")).toBe("true");

    cleanup();
    container.remove();
  });

  it("moves a selection made on rendered math onto the complete LaTeX source", () => {
    const container = document.createElement("div");
    container.innerHTML = '<div class="math-block">x²</div>';
    document.body.append(container);
    enhanceRenderedMarkdown(container, "$$x^2$$");
    const cleanup = installObsidianFormulaSelection(container);
    const renderedText = container.querySelector(
      ".treetalk-formula-rendered"
    )?.firstChild;
    const sourceText = container.querySelector(
      ".treetalk-formula-source"
    )?.firstChild;
    if (
      renderedText === null ||
      renderedText === undefined ||
      sourceText === null ||
      sourceText === undefined
    ) {
      throw new Error("Formula text nodes are missing");
    }

    const range = document.createRange();
    range.setStart(renderedText, 0);
    range.setEnd(renderedText, renderedText.textContent?.length ?? 0);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));

    const adjusted = selection?.getRangeAt(0);
    expect(adjusted?.startContainer).toBe(sourceText);
    expect(adjusted?.startOffset).toBe(0);
    expect(adjusted?.endContainer).toBe(sourceText);
    expect(adjusted?.endOffset).toBe("$$x^2$$".length);

    cleanup();
    container.remove();
  });

  it("does not enhance an unclosed streaming block formula", () => {
    const container = document.createElement("div");
    const rendered = document.createElement("div");
    rendered.className = "math-block";
    rendered.textContent = "partial";
    container.append(rendered);

    enhanceRenderedMarkdown(container, "$$\npartial");

    expect(container.querySelector(".treetalk-formula-block")).toBeNull();
  });
});
