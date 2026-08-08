export interface RenderedTextSegment {
  node: Text;
  start: number;
  end: number;
}

export interface RenderedTextMap {
  text: string;
  segments: RenderedTextSegment[];
}

export interface TraceRange {
  start: number;
  end: number;
  targetId: string;
}

const IGNORED_SELECTOR = [
  ".treetalk-control",
  ".MathJax_Assistive_MathML",
  "[aria-hidden='true']",
  "script",
  "style"
].join(",");

const BLOCK_SELECTOR = [
  "p",
  "li",
  "blockquote",
  "pre",
  "table",
  "tr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "div"
].join(",");

const TEXT_NODE = 3;
const SOURCE_TEXT_ATTRIBUTE = "data-treetalk-source-text";
const VISIBLE_TEXT_ATTRIBUTE = "data-treetalk-visible-text";

function isSelectableText(node: Text, root: HTMLElement): boolean {
  const parent = node.parentElement;
  return (
    node.data.length > 0 &&
    parent !== null &&
    root.contains(parent) &&
    parent.closest(IGNORED_SELECTOR) === null
  );
}

export function mapRenderedText(root: HTMLElement): RenderedTextMap {
  const showText =
    root.ownerDocument.defaultView?.NodeFilter.SHOW_TEXT ??
    NodeFilter.SHOW_TEXT;
  const walker = root.ownerDocument.createTreeWalker(root, showText);
  const segments: RenderedTextSegment[] = [];
  const text: string[] = [];
  let offset = 0;
  let previousBlock: Element | null = null;
  let current = walker.nextNode();
  while (current !== null) {
    if (current.nodeType === TEXT_NODE) {
      const textNode = current as Text;
      if (!isSelectableText(textNode, root)) {
        current = walker.nextNode();
        continue;
      }
      const block = textNode.parentElement?.closest(BLOCK_SELECTOR) ?? null;
      if (
        offset > 0 &&
        block !== null &&
        previousBlock !== null &&
        block !== previousBlock
      ) {
        text.push("\n");
        offset += 1;
      }
      const start = offset;
      offset += textNode.data.length;
      segments.push({ node: textNode, start, end: offset });
      text.push(textNode.data);
      previousBlock = block;
    }
    current = walker.nextNode();
  }
  return { text: text.join(""), segments };
}

function offsetForBoundary(
  map: RenderedTextMap,
  container: Node,
  offset: number
): number | undefined {
  if (container.nodeType !== TEXT_NODE) return undefined;
  const textNode = container as Text;
  const segment = map.segments.find((entry) => entry.node === textNode);
  if (
    segment === undefined ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > textNode.data.length
  ) {
    return undefined;
  }
  return segment.start + offset;
}

export function offsetsForDomRange(
  map: RenderedTextMap,
  range: Range
): { start: number; end: number } | undefined {
  if (range.collapsed) return undefined;
  const start = offsetForBoundary(
    map,
    range.startContainer,
    range.startOffset
  );
  const end = offsetForBoundary(map, range.endContainer, range.endOffset);
  if (start === undefined || end === undefined || start === end) {
    return undefined;
  }
  return {
    start: Math.min(start, end),
    end: Math.max(start, end)
  };
}

function intersectsRange(range: Range, node: Node): boolean {
  try {
    return range.intersectsNode(node);
  } catch {
    return false;
  }
}

function selectedTextFromNode(range: Range, node: Text): string {
  if (!intersectsRange(range, node)) return "";
  let start = 0;
  let end = node.data.length;
  if (range.startContainer === node) start = range.startOffset;
  if (range.endContainer === node) end = range.endOffset;
  if (start < 0 || end > node.data.length || start >= end) return "";
  return node.data.slice(start, end);
}

function blockForNode(node: Node): Element | null {
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest(BLOCK_SELECTOR) ?? null;
}

function safeTextContent(node: Node): string {
  return node.textContent ?? "";
}

interface CanonicalSelectionUnit {
  node: Text | HTMLElement;
  start: number;
  end: number;
  visibleText: string;
  sourceText?: string;
}

interface CanonicalRenderedMap {
  text: string;
  units: CanonicalSelectionUnit[];
}

export interface SourceAwareRenderedSelection {
  visibleText: string;
  startOffset: number;
  endOffset: number;
  sourceText: string;
}

export interface InstalledSourceRangeHighlight {
  elements: HTMLElement[];
  cleanup(): void;
}

function isTopLevelSourceElement(
  element: HTMLElement,
  root: HTMLElement
): boolean {
  if (!element.hasAttribute(SOURCE_TEXT_ATTRIBUTE)) return false;
  const parentSource = element.parentElement?.closest<HTMLElement>(
    `[${SOURCE_TEXT_ATTRIBUTE}]`
  );
  return (
    parentSource === null ||
    parentSource === undefined ||
    !root.contains(parentSource)
  );
}

function canonicalRenderedMap(root: HTMLElement): CanonicalRenderedMap {
  const chunks: string[] = [];
  const units: CanonicalSelectionUnit[] = [];
  let offset = 0;
  let previousBlock: Element | null = null;

  const append = (
    node: Text | HTMLElement,
    visibleText: string,
    sourceText?: string
  ): void => {
    if (visibleText.length === 0) return;
    const block = blockForNode(node);
    if (
      offset > 0 &&
      block !== null &&
      previousBlock !== null &&
      block !== previousBlock
    ) {
      chunks.push("\n");
      offset += 1;
    }
    const start = offset;
    chunks.push(visibleText);
    offset += visibleText.length;
    units.push({
      node,
      start,
      end: offset,
      visibleText,
      ...(sourceText === undefined ? {} : { sourceText })
    });
    previousBlock = block;
  };

  const visit = (node: Node): void => {
    if (node instanceof HTMLElement && isTopLevelSourceElement(node, root)) {
      append(
        node,
        node.getAttribute(VISIBLE_TEXT_ATTRIBUTE) ?? safeTextContent(node),
        node.getAttribute(SOURCE_TEXT_ATTRIBUTE) ?? ""
      );
      return;
    }
    if (node instanceof Element && node.matches(IGNORED_SELECTOR)) return;
    if (node.nodeType === TEXT_NODE) {
      const textNode = node as Text;
      if (isSelectableText(textNode, root)) append(textNode, textNode.data);
      return;
    }
    for (const child of node.childNodes) visit(child);
  };

  for (const child of root.childNodes) visit(child);
  return { text: chunks.join(""), units };
}

export function canonicalRenderedText(root: HTMLElement): string {
  return canonicalRenderedMap(root).text;
}

export function installSourceRangeHighlight(
  root: HTMLElement,
  start: number,
  end: number
): InstalledSourceRangeHighlight {
  const map = canonicalRenderedMap(root);
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end > map.text.length ||
    start >= end
  ) {
    return { elements: [], cleanup: () => undefined };
  }

  const elements: HTMLElement[] = [];
  const cleanups: Array<() => void> = [];
  for (const unit of map.units) {
    const intersectionStart = Math.max(start, unit.start);
    const intersectionEnd = Math.min(end, unit.end);
    if (intersectionStart >= intersectionEnd) continue;

    if (unit.node instanceof HTMLElement) {
      const element = unit.node;
      element.classList.add("treetalk-source-range-flash");
      elements.push(element);
      cleanups.push(() =>
        element.classList.remove("treetalk-source-range-flash")
      );
      continue;
    }

    const localStart = intersectionStart - unit.start;
    const localEnd = intersectionEnd - unit.start;
    const before = unit.node.data.slice(0, localStart);
    const selected = unit.node.data.slice(localStart, localEnd);
    const after = unit.node.data.slice(localEnd);
    const mark = root.ownerDocument.createElement("mark");
    mark.className = "treetalk-source-range-flash";
    mark.textContent = selected;
    const replacement: Node[] = [];
    if (before.length > 0) {
      replacement.push(root.ownerDocument.createTextNode(before));
    }
    replacement.push(mark);
    if (after.length > 0) {
      replacement.push(root.ownerDocument.createTextNode(after));
    }
    unit.node.replaceWith(...replacement);
    elements.push(mark);
    cleanups.push(() => {
      const parent = mark.parentNode;
      if (parent === null) return;
      mark.replaceWith(root.ownerDocument.createTextNode(safeTextContent(mark)));
      parent.normalize();
    });
  }

  let cleaned = false;
  return {
    elements,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      for (const cleanup of [...cleanups].reverse()) cleanup();
    }
  };
}

/**
 * Returns both the canonical visible-text anchor and the model-facing source
 * quote for a rendered selection. Source-annotated elements are atomic: a
 * selection touching one contributes its complete Markdown/LaTeX token and is
 * anchored against the element's rendered visible text, even while a formula
 * is showing its raw source view.
 */
export function selectionForDomRange(
  root: HTMLElement,
  range: Range
): SourceAwareRenderedSelection | undefined {
  if (
    range.collapsed ||
    !root.contains(range.startContainer) ||
    !root.contains(range.endContainer)
  ) {
    return undefined;
  }

  const map = canonicalRenderedMap(root);
  const selected: Array<{
    start: number;
    end: number;
    sourceText: string;
  }> = [];
  for (const unit of map.units) {
    if (unit.node instanceof Text) {
      const text = selectedTextFromNode(range, unit.node);
      if (text.length === 0) continue;
      const localStart =
        range.startContainer === unit.node ? range.startOffset : 0;
      selected.push({
        start: unit.start + localStart,
        end: unit.start + localStart + text.length,
        sourceText: text
      });
      continue;
    }
    if (intersectsRange(range, unit.node)) {
      selected.push({
        start: unit.start,
        end: unit.end,
        sourceText: unit.sourceText ?? unit.visibleText
      });
    }
  }
  if (selected.length === 0) return undefined;

  selected.sort((left, right) => left.start - right.start || left.end - right.end);
  const first = selected[0];
  const last = selected.at(-1);
  if (first === undefined || last === undefined) return undefined;
  const sourceChunks: string[] = [];
  let previousEnd: number | undefined;
  for (const fragment of selected) {
    if (previousEnd !== undefined && fragment.start > previousEnd) {
      sourceChunks.push(map.text.slice(previousEnd, fragment.start));
    }
    sourceChunks.push(fragment.sourceText);
    previousEnd = fragment.end;
  }
  return {
    visibleText: map.text,
    startOffset: first.start,
    endOffset: last.end,
    sourceText: sourceChunks.join("")
  };
}

/**
 * Builds the model-facing quote for a rendered DOM selection. Normal text is
 * copied character-for-character. Rendered elements annotated with
 * `data-treetalk-source-text` contribute their complete original Markdown or
 * LaTeX token instead of the visual text produced by Obsidian.
 */
export function sourceTextForDomRange(
  root: HTMLElement,
  range: Range
): string | undefined {
  return selectionForDomRange(root, range)?.sourceText;
}

function traceElement(
  document: Document,
  text: string,
  activate: () => void
): HTMLElement {
  const trace = document.createElement("span");
  trace.className = "treetalk-selection-trace";
  trace.tabIndex = 0;
  trace.setAttribute("role", "button");
  trace.textContent = text;
  trace.addEventListener("click", activate);
  trace.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    activate();
  });
  return trace;
}

function traceTitle(targetIds: string[]): string {
  return targetIds.length === 1
    ? "打开使用这段原文提问的节点"
    : `选择 ${String(targetIds.length)} 个关联分支`;
}

function targetIdsForRange(
  ranges: TraceRange[],
  start: number,
  end: number
): string[] {
  return [
    ...new Set(
      ranges
        .filter((range) => range.start < end && range.end > start)
        .map((range) => range.targetId)
    )
  ];
}

/**
 * Installs persistent selection traces using the same source-aware canonical
 * map used while capturing a rendered selection. Source-annotated atoms such
 * as MathJax formulas are highlighted as complete rendered elements instead
 * of trying to wrap inaccessible SVG text nodes.
 */
export function installSourceAwareTraceRanges(
  root: HTMLElement,
  ranges: TraceRange[],
  activate: (targetIds: string[], element: HTMLElement) => void
): HTMLElement[] {
  const map = canonicalRenderedMap(root);
  const validRanges = ranges.filter(
    (range) =>
      Number.isInteger(range.start) &&
      Number.isInteger(range.end) &&
      range.start >= 0 &&
      range.end <= map.text.length &&
      range.start < range.end &&
      range.targetId.length > 0
  );
  const traces: HTMLElement[] = [];

  for (const unit of map.units) {
    const intersecting = validRanges.filter(
      (range) => range.start < unit.end && range.end > unit.start
    );
    if (intersecting.length === 0) continue;

    if (unit.node instanceof HTMLElement) {
      const targetIds = targetIdsForRange(intersecting, unit.start, unit.end);
      if (targetIds.length === 0) continue;
      const element = unit.node;
      element.classList.add("treetalk-selection-trace-atomic");
      element.tabIndex = 0;
      element.setAttribute("role", "button");
      element.title = traceTitle(targetIds);
      const trigger = (): void => activate(targetIds, element);
      element.addEventListener("click", trigger);
      element.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        trigger();
      });
      traces.push(element);
      continue;
    }

    const boundaries = new Set<number>([unit.start, unit.end]);
    for (const range of intersecting) {
      boundaries.add(Math.max(unit.start, range.start));
      boundaries.add(Math.min(unit.end, range.end));
    }
    const ordered = [...boundaries].sort((left, right) => left - right);
    const replacement: Node[] = [];
    for (let index = 0; index < ordered.length - 1; index += 1) {
      const start = ordered[index];
      const end = ordered[index + 1];
      if (start === undefined || end === undefined || start >= end) continue;
      const text = unit.node.data.slice(start - unit.start, end - unit.start);
      const targetIds = targetIdsForRange(intersecting, start, end);
      if (targetIds.length === 0) {
        replacement.push(root.ownerDocument.createTextNode(text));
        continue;
      }
      const trace = traceElement(root.ownerDocument, text, () =>
        activate(targetIds, trace)
      );
      trace.title = traceTitle(targetIds);
      replacement.push(trace);
      traces.push(trace);
    }
    unit.node.replaceWith(...replacement);
  }
  return traces;
}

export function installTraceRanges(
  root: HTMLElement,
  map: RenderedTextMap,
  ranges: TraceRange[],
  activate: (targetIds: string[], element: HTMLElement) => void
): HTMLElement[] {
  const validRanges = ranges.filter(
    (range) =>
      Number.isInteger(range.start) &&
      Number.isInteger(range.end) &&
      range.start >= 0 &&
      range.end <= map.text.length &&
      range.start < range.end &&
      range.targetId.length > 0
  );
  const traces: HTMLElement[] = [];
  for (const segment of map.segments) {
    const intersecting = validRanges.filter(
      (range) => range.start < segment.end && range.end > segment.start
    );
    if (intersecting.length === 0) continue;
    const boundaries = new Set<number>([segment.start, segment.end]);
    for (const range of intersecting) {
      boundaries.add(Math.max(segment.start, range.start));
      boundaries.add(Math.min(segment.end, range.end));
    }
    const ordered = [...boundaries].sort((left, right) => left - right);
    const replacement: Node[] = [];
    for (let index = 0; index < ordered.length - 1; index += 1) {
      const start = ordered[index];
      const end = ordered[index + 1];
      if (start === undefined || end === undefined || start >= end) continue;
      const text = segment.node.data.slice(
        start - segment.start,
        end - segment.start
      );
      const targetIds = [
        ...new Set(
          intersecting
            .filter((range) => range.start < end && range.end > start)
            .map((range) => range.targetId)
        )
      ];
      if (targetIds.length === 0) {
        replacement.push(root.ownerDocument.createTextNode(text));
        continue;
      }
      const trace = traceElement(root.ownerDocument, text, () =>
        activate(targetIds, trace)
      );
      trace.title =
        targetIds.length === 1
          ? "打开使用这段原文提问的节点"
          : `选择 ${String(targetIds.length)} 个关联分支`;
      replacement.push(trace);
      traces.push(trace);
    }
    segment.node.replaceWith(...replacement);
  }
  return traces;
}

export function installTraceSegments(
  root: HTMLElement,
  map: RenderedTextMap,
  start: number,
  end: number,
  activate: () => void
): HTMLElement[] {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end > map.text.length ||
    start >= end
  ) {
    return [];
  }
  const traces: HTMLElement[] = [];
  for (const segment of map.segments) {
    const intersectionStart = Math.max(start, segment.start);
    const intersectionEnd = Math.min(end, segment.end);
    if (intersectionStart >= intersectionEnd) continue;
    const localStart = intersectionStart - segment.start;
    const localEnd = intersectionEnd - segment.start;
    const before = segment.node.data.slice(0, localStart);
    const selected = segment.node.data.slice(localStart, localEnd);
    const after = segment.node.data.slice(localEnd);
    const trace = traceElement(root.ownerDocument, selected, activate);
    const replacement: Node[] = [];
    if (before.length > 0) {
      replacement.push(root.ownerDocument.createTextNode(before));
    }
    replacement.push(trace);
    if (after.length > 0) {
      replacement.push(root.ownerDocument.createTextNode(after));
    }
    segment.node.replaceWith(...replacement);
    traces.push(trace);
  }
  return traces;
}
