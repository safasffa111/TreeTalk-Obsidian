// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  installSourceRangeHighlight,
  installSourceAwareTraceRanges,
  installTraceSegments,
  mapRenderedText,
  offsetsForDomRange,
  selectionForDomRange,
  sourceTextForDomRange
} from "../../src/views/rendered-selection";

describe("rendered selection mapping", () => {
  it("maps selectable text across nested Markdown elements and ignores controls", () => {
    const root = document.createElement("div");
    root.innerHTML =
      'hello <strong>world</strong><button class="treetalk-control">ignore</button> !';

    const map = mapRenderedText(root);

    expect(map.text).toBe("hello world !");
    expect(map.segments).toHaveLength(3);
  });

  it("preserves a canonical newline between rendered Markdown blocks", () => {
    const root = document.createElement("div");
    root.innerHTML = "<p>first paragraph</p><p>second paragraph</p>";

    const map = mapRenderedText(root);

    expect(map.text).toBe("first paragraph\nsecond paragraph");
    expect(map.segments[1]?.start).toBe(16);
  });

  it("converts a DOM range crossing inline formatting into canonical offsets", () => {
    const root = document.createElement("div");
    root.innerHTML = "hello <strong>world</strong> !";
    const first = root.firstChild;
    const strong = root.querySelector("strong")?.firstChild;
    if (first === null || strong === null || strong === undefined) {
      throw new Error("Fixture text nodes are missing");
    }
    const range = document.createRange();
    range.setStart(first, 3);
    range.setEnd(strong, 3);

    expect(offsetsForDomRange(mapRenderedText(root), range)).toEqual({
      start: 3,
      end: 9
    });
  });

  it("returns original Markdown for selected source-annotated rendered elements", () => {
    const root = document.createElement("div");
    root.innerHTML =
      'before <span data-treetalk-source-text="$x^2$">x²</span> after';
    const formulaText = root.querySelector("span")?.firstChild;
    if (formulaText === null || formulaText === undefined) {
      throw new Error("Formula text is missing");
    }
    const range = document.createRange();
    range.setStart(formulaText, 0);
    range.setEnd(formulaText, 2);

    expect(sourceTextForDomRange(root, range)).toBe("$x^2$");
  });

  it("anchors a raw formula selection against its canonical rendered text", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<p>before</p><div data-treetalk-source-text="$$x^2$$" data-treetalk-visible-text="x²"><span aria-hidden="true">x²</span><pre>$$x^2$$</pre></div><p>after</p>';
    const raw = root.querySelector("pre")?.firstChild;
    if (raw === null || raw === undefined) {
      throw new Error("Raw formula source is missing");
    }
    const range = document.createRange();
    range.setStart(raw, 0);
    range.setEnd(raw, raw.textContent?.length ?? 0);

    expect(selectionForDomRange(root, range)).toEqual({
      visibleText: "before\nx²\nafter",
      startOffset: 7,
      endOffset: 9,
      sourceText: "$$x^2$$"
    });
  });

  it("combines normal selected text with complete source atoms in DOM order", () => {
    const root = document.createElement("div");
    root.innerHTML =
      'A <strong data-treetalk-source-text="**bold**">bold</strong> formula <span data-treetalk-source-text="$x$">x</span> end';
    const start = root.firstChild;
    const end = root.lastChild;
    if (start === null || end === null) throw new Error("Text boundaries missing");
    const range = document.createRange();
    range.setStart(start, 0);
    range.setEnd(end, 4);

    expect(sourceTextForDomRange(root, range)).toBe(
      "A **bold** formula $x$ end"
    );
  });

  it("wraps every intersecting text segment with one navigation action", () => {
    const root = document.createElement("div");
    root.innerHTML = "hello <strong>world</strong> !";
    const activate = vi.fn();

    const segments = installTraceSegments(
      root,
      mapRenderedText(root),
      3,
      9,
      activate
    );

    expect(segments).toHaveLength(2);
    expect(root.textContent).toBe("hello world !");
    expect(
      [...root.querySelectorAll(".treetalk-selection-trace")].map(
        (element) => element.textContent
      )
    ).toEqual(["lo ", "wor"]);
    segments[1]?.click();
    expect(activate).toHaveBeenCalledOnce();
  });

  it("rejects collapsed ranges and ranges outside the mapped root", () => {
    const root = document.createElement("div");
    root.textContent = "inside";
    const outside = document.createTextNode("outside");
    const collapsed = document.createRange();
    collapsed.setStart(root.firstChild ?? root, 0);
    collapsed.collapse(true);
    const external = document.createRange();
    external.setStart(outside, 0);
    external.setEnd(outside, 3);

    const map = mapRenderedText(root);
    expect(offsetsForDomRange(map, collapsed)).toBeUndefined();
    expect(offsetsForDomRange(map, external)).toBeUndefined();
  });
  it("highlights a complete rendered formula atom for a stored selection trace", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<p>before</p><div class="treetalk-formula-block" data-treetalk-source-text="$$x^2$$" data-treetalk-visible-text="x²"><div class="treetalk-formula-rendered">x²</div></div><p>after</p>';
    const activate = vi.fn();

    const traces = installSourceAwareTraceRanges(
      root,
      [{ start: 7, end: 9, targetId: "child" }],
      activate
    );

    const formula = root.querySelector<HTMLElement>(".treetalk-formula-block");
    expect(traces).toContain(formula);
    expect(formula?.classList.contains("treetalk-selection-trace-atomic")).toBe(true);
    formula?.click();
    expect(activate).toHaveBeenCalledWith(["child"], formula);
  });

  it("temporarily highlights canonical text and complete rendered formula atoms", () => {
    const root = document.createElement("div");
    root.innerHTML =
      'before <strong>bold</strong> <span data-treetalk-source-text="$x^2$" data-treetalk-visible-text="x²">x²</span> after';

    const highlight = installSourceRangeHighlight(root, 7, 14);

    expect(highlight.elements).toHaveLength(3);
    expect(
      root.querySelector("strong .treetalk-source-range-flash")?.textContent
    ).toBe("bold");
    expect(
      root.querySelector("[data-treetalk-source-text]")?.classList.contains(
        "treetalk-source-range-flash"
      )
    ).toBe(true);
    highlight.cleanup();
    expect(root.querySelector(".treetalk-source-range-flash")).toBeNull();
    expect(root.textContent).toBe("before bold x² after");
  });

});
