import {
  Component,
  MarkdownRenderer,
  type App
} from "obsidian";

const SOURCE_TEXT_ATTRIBUTE = "data-treetalk-source-text";
const VISIBLE_TEXT_ATTRIBUTE = "data-treetalk-visible-text";

interface SourceTokenRange {
  raw: string;
  start: number;
  end: number;
}

function tokenRanges(markdown: string, pattern: RegExp): SourceTokenRange[] {
  return [...markdown.matchAll(pattern)].map((match) => {
    const raw = match[0];
    const start = match.index;
    return { raw, start, end: start + raw.length };
  });
}

function maskRanges(markdown: string, ranges: SourceTokenRange[]): string {
  const characters = new Array<string>(markdown.length);
  for (let index = 0; index < markdown.length; index += 1) {
    characters[index] = markdown.charAt(index);
  }
  for (const range of ranges) {
    for (let index = range.start; index < range.end; index += 1) {
      characters[index] = " ";
    }
  }
  return characters.join("");
}

function sourceTokens(markdown: string): {
  blockMath: string[];
  inlineMath: string[];
  fencedCode: string[];
  inlineCode: string[];
  links: string[];
  strong: string[];
  emphasis: string[];
  deleted: string[];
} {
  const blockMath = tokenRanges(markdown, /\$\$[\s\S]*?\$\$/gu);
  const fencedCode = tokenRanges(
    markdown,
    /```[^\n]*\n[\s\S]*?```|~~~[^\n]*\n[\s\S]*?~~~/gu
  );
  const withoutBlocks = maskRanges(markdown, [...blockMath, ...fencedCode]);
  const inlineCode = tokenRanges(withoutBlocks, /(`+)[^`\n]+?\1/gu);
  const withoutCode = maskRanges(withoutBlocks, inlineCode);
  const inlineMath = tokenRanges(
    withoutCode,
    /(?<!\\)\$(?!\$)(?:\\.|[^$\n\\])+(?<!\\)\$/gu
  );
  return {
    blockMath: blockMath.map((entry) => entry.raw),
    inlineMath: inlineMath.map((entry) => markdown.slice(entry.start, entry.end)),
    fencedCode: fencedCode.map((entry) => entry.raw),
    inlineCode: inlineCode.map((entry) => markdown.slice(entry.start, entry.end)),
    links: tokenRanges(
      withoutCode,
      /(?<!!)\[[^\]]+\]\([^)]+\)|\[\[[^\]]+\]\]/gu
    ).map((entry) => markdown.slice(entry.start, entry.end)),
    strong: tokenRanges(
      withoutCode,
      /\*\*(?=\S)[\s\S]*?\S\*\*|__(?=\S)[\s\S]*?\S__/gu
    ).map((entry) => markdown.slice(entry.start, entry.end)),
    emphasis: tokenRanges(
      withoutCode,
      /(?<!\*)\*(?!\*)(?=\S)[^*\n]*?\S\*(?!\*)|(?<!_)_(?!_)(?=\S)[^_\n]*?\S_(?!_)/gu
    ).map((entry) => markdown.slice(entry.start, entry.end)),
    deleted: tokenRanges(
      withoutCode,
      /~~(?=\S)[\s\S]*?\S~~/gu
    ).map((entry) => markdown.slice(entry.start, entry.end))
  };
}

function outermostElements(
  container: HTMLElement,
  selector: string
): HTMLElement[] {
  const elements = [...container.querySelectorAll<HTMLElement>(selector)];
  return elements.filter(
    (candidate) =>
      !elements.some(
        (other) => other !== candidate && other.contains(candidate)
      )
  );
}

function sourceVisibleText(
  rendered: HTMLElement,
  rawSource: string
): string {
  const candidates = [
    rendered.getAttribute(VISIBLE_TEXT_ATTRIBUTE),
    rendered.textContent,
    rendered.getAttribute("aria-label"),
    rendered.querySelector<HTMLElement>("[aria-label]")?.getAttribute("aria-label")
  ];
  for (const candidate of candidates) {
    const normalized = candidate?.trim();
    if (normalized !== undefined && normalized.length > 0) return normalized;
  }
  return rawSource;
}

function annotateElements(elements: HTMLElement[], tokens: string[]): void {
  for (const [index, element] of elements.entries()) {
    const token = tokens[index];
    if (token === undefined) break;
    element.setAttribute(SOURCE_TEXT_ATTRIBUTE, token);
    element.setAttribute(VISIBLE_TEXT_ATTRIBUTE, sourceVisibleText(element, token));
    element.classList.add("treetalk-source-atomic");
  }
}

function installFormulaSelectionSource(
  rendered: HTMLElement,
  rawSource: string
): void {
  if (rendered.closest(".treetalk-formula-block") !== null) return;
  const parent = rendered.parentNode;
  if (parent === null) return;
  const wrapper = rendered.ownerDocument.createElement("div");
  wrapper.className = "treetalk-formula-block treetalk-source-atomic";
  wrapper.setAttribute(SOURCE_TEXT_ATTRIBUTE, rawSource);
  wrapper.setAttribute(
    VISIBLE_TEXT_ATTRIBUTE,
    sourceVisibleText(rendered, rawSource)
  );
  parent.replaceChild(wrapper, rendered);
  rendered.removeAttribute(SOURCE_TEXT_ATTRIBUTE);
  rendered.removeAttribute(VISIBLE_TEXT_ATTRIBUTE);
  rendered.classList.remove("treetalk-source-atomic");
  rendered.classList.add("treetalk-formula-rendered");
  rendered.hidden = false;
  rendered.setAttribute("aria-hidden", "false");

  const source = rendered.ownerDocument.createElement("pre");
  source.className = "treetalk-formula-source";
  source.textContent = rawSource;
  source.hidden = true;
  source.setAttribute("aria-hidden", "true");

  wrapper.append(source, rendered);
}

function syncFormulaPresentation(wrapper: HTMLElement): void {
  const rendered = wrapper.querySelector<HTMLElement>(
    ".treetalk-formula-rendered"
  );
  const source = wrapper.querySelector<HTMLElement>(
    ".treetalk-formula-source"
  );
  if (rendered === null || source === null) return;
  const selectionSourceMode = wrapper.classList.contains(
    "is-selection-source"
  );
  rendered.hidden = false;
  rendered.setAttribute("aria-hidden", "false");
  source.hidden = !selectionSourceMode;
  source.setAttribute("aria-hidden", String(!selectionSourceMode));
}

function rangeIntersectsNode(range: Range, node: Node): boolean {
  try {
    return range.intersectsNode(node);
  } catch {
    return false;
  }
}

/**
 * Mirrors Obsidian live preview while selecting Markdown: formulas stay
 * rendered normally, but any formula crossed by the active DOM selection also
 * exposes its original LaTeX in place. The preview remains visible underneath,
 * matching Obsidian's editor selection behavior.
 */
export function installObsidianFormulaSelection(
  root: HTMLElement
): () => void {
  const document = root.ownerDocument;
  let adjustingSelection = false;
  const blocks = (): HTMLElement[] => [
    ...root.querySelectorAll<HTMLElement>(".treetalk-formula-block")
  ];

  const clearSelectionSources = (): void => {
    for (const block of blocks()) {
      block.classList.remove("is-selection-source");
      syncFormulaPresentation(block);
    }
  };

  const syncSelectionSources = (): void => {
    if (adjustingSelection) return;
    const selection = document.defaultView?.getSelection();
    if (
      selection === null ||
      selection === undefined ||
      selection.rangeCount === 0 ||
      selection.isCollapsed
    ) {
      clearSelectionSources();
      return;
    }
    const ranges = Array.from(
      { length: selection.rangeCount },
      (_, index) => selection.getRangeAt(index)
    ).filter(
      (range) =>
        root.contains(range.startContainer) &&
        root.contains(range.endContainer)
    );
    let adjusted = false;
    for (const block of blocks()) {
      const selected = ranges.some((range) => rangeIntersectsNode(range, block));
      block.classList.toggle("is-selection-source", selected);
      syncFormulaPresentation(block);
      if (!selected) continue;
      const source = block.querySelector<HTMLElement>(
        ".treetalk-formula-source"
      );
      if (source === null) continue;
      const sourceText = source.firstChild;
      if (!(sourceText instanceof Text)) continue;
      for (const range of ranges) {
        if (
          block.contains(range.startContainer) &&
          !source.contains(range.startContainer)
        ) {
          range.setStart(sourceText, 0);
          adjusted = true;
        }
        if (
          block.contains(range.endContainer) &&
          !source.contains(range.endContainer)
        ) {
          range.setEnd(sourceText, sourceText.data.length);
          adjusted = true;
        }
      }
    }
    if (adjusted) {
      adjustingSelection = true;
      try {
        selection.removeAllRanges();
        for (const range of ranges) selection.addRange(range);
      } finally {
        adjustingSelection = false;
      }
    }
  };

  const onPointerDown = (event: Event): void => {
    const target = event.target;
    const element = target instanceof Element ? target : null;
    const block = element?.closest<HTMLElement>(".treetalk-formula-block");
    if (block === null || block === undefined || !root.contains(block)) return;
    block.classList.add("is-selection-source");
    syncFormulaPresentation(block);
  };

  document.addEventListener("selectionchange", syncSelectionSources);
  root.addEventListener("pointerdown", onPointerDown);
  return () => {
    document.removeEventListener("selectionchange", syncSelectionSources);
    root.removeEventListener("pointerdown", onPointerDown);
    clearSelectionSources();
  };
}

/**
 * Adds source metadata to Obsidian-rendered Markdown without replacing its
 * native renderer. The metadata lets TreeTalk preserve Markdown/LaTeX when a
 * user selects visual output, and complete block formulas gain an Obsidian-like
 * temporary source preview during native text selection.
 */
export function enhanceRenderedMarkdown(
  container: HTMLElement,
  markdown: string
): void {
  const tokens = sourceTokens(markdown);
  const blockMath = outermostElements(
    container,
    ".math-block, mjx-container[display='true'], .MathJax_Display, .katex-display"
  );
  annotateElements(blockMath, tokens.blockMath);

  const inlineMath = outermostElements(
    container,
    ".math-inline, mjx-container:not([display='true']), span.math"
  ).filter(
    (element) => !blockMath.some((block) => block.contains(element))
  );
  annotateElements(inlineMath, tokens.inlineMath);
  annotateElements(outermostElements(container, "pre"), tokens.fencedCode);
  annotateElements(
    outermostElements(container, "code:not(pre code)"),
    tokens.inlineCode
  );
  annotateElements(outermostElements(container, "a"), tokens.links);
  annotateElements(outermostElements(container, "strong"), tokens.strong);
  annotateElements(outermostElements(container, "em"), tokens.emphasis);
  annotateElements(outermostElements(container, "del, s"), tokens.deleted);

  for (const [index, element] of blockMath.entries()) {
    const rawSource = tokens.blockMath[index];
    if (rawSource !== undefined) installFormulaSelectionSource(element, rawSource);
  }
}

export interface MessageRendererPort {
  render(markdown: string, container: HTMLElement): Promise<void>;
  dispose(): void;
}

export interface MessageRendererFactory {
  create(): MessageRendererPort;
}

class ObsidianMessageRenderer implements MessageRendererPort {
  private readonly component = new Component();
  private disposed = false;

  constructor(
    private readonly app: App,
    private readonly owner: Component,
    private readonly sourcePath: string
  ) {
    this.owner.addChild(this.component);
  }

  async render(markdown: string, container: HTMLElement): Promise<void> {
    if (this.disposed) throw new Error("Message renderer is disposed");
    container.replaceChildren();
    await MarkdownRenderer.render(
      this.app,
      markdown,
      container,
      this.sourcePath,
      this.component
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.owner.removeChild(this.component);
  }
}

export class ObsidianMessageRendererFactory
  implements MessageRendererFactory
{
  constructor(
    private readonly app: App,
    private readonly owner: Component,
    private readonly sourcePath = ""
  ) {}

  create(): MessageRendererPort {
    return new ObsidianMessageRenderer(
      this.app,
      this.owner,
      this.sourcePath
    );
  }
}

export const plainTextMessageRendererFactory: MessageRendererFactory = {
  create: () => ({
    render: (markdown, container) => {
      container.textContent = markdown;
      return Promise.resolve();
    },
    dispose: () => undefined
  })
};
