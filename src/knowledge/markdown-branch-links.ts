import { parseStructuredMarkdown } from "../domain/balanced-markdown-compressor";
import type {
  SelectionAnchor,
  SelectionContext
} from "../domain/types";
import { resolveSelectionAnchor } from "../domain/selection-anchor";

export interface MarkdownAnchor {
  start: number;
  end: number;
}

export interface MarkdownLink {
  path: string;
  title: string;
}

export interface MarkdownLinkInsertion {
  anchor: MarkdownAnchor;
  links: MarkdownLink[];
}

interface MarkdownLinkPlacement {
  offset: number;
  standalone: boolean;
  scopeStart: number;
  scopeEnd: number;
}

interface GroupedPlacement extends MarkdownLinkPlacement {
  links: MarkdownLink[];
}

const STRUCTURAL_BLOCKS = new Set([
  "heading",
  "list",
  "quote",
  "table",
  "code",
  "math"
]);

function exactMatches(content: string, quote: string): number[] {
  if (quote.length === 0) return [];
  const matches: number[] = [];
  let from = 0;
  while (from <= content.length - quote.length) {
    const index = content.indexOf(quote, from);
    if (index < 0) break;
    matches.push(index);
    from = index + Math.max(1, quote.length);
  }
  return matches;
}

function asSelectionAnchor(context: SelectionContext): SelectionAnchor {
  if (!("sourceType" in context)) return context;
  return {
    messageId: `note:${context.filePath}`,
    sourceNodeId: `note:${context.filePath}`,
    sourceRole: "user",
    basis: "rendered-text-v1",
    startOffset: context.startOffset,
    endOffset: context.endOffset,
    quote: context.quote,
    prefix: context.prefix,
    suffix: context.suffix,
    contentHash: context.contentHash
  };
}

export function resolveMarkdownAnchor(
  content: string,
  context: SelectionContext
): MarkdownAnchor | undefined {
  const rawMatches = exactMatches(content, context.quote);
  if (rawMatches.length === 1) {
    const start = rawMatches[0];
    return start === undefined
      ? undefined
      : { start, end: start + context.quote.length };
  }

  const anchor = asSelectionAnchor(context);
  if (rawMatches.length > 1) {
    const resolved = resolveSelectionAnchor(content, anchor);
    return resolved.status === "resolved"
      ? { start: resolved.start, end: resolved.end }
      : undefined;
  }

  const visibleQuote = "visibleQuote" in context
    ? context.visibleQuote ?? context.quote
    : context.quote;
  const visibleMatches = exactMatches(content, visibleQuote);
  if (visibleMatches.length === 1) {
    const start = visibleMatches[0];
    return start === undefined
      ? undefined
      : { start, end: start + visibleQuote.length };
  }

  const resolved = resolveSelectionAnchor(content, anchor);
  return resolved.status === "resolved"
    ? { start: resolved.start, end: resolved.end }
    : undefined;
}

function notePathWithoutExtension(path: string): string {
  return path.replace(/\\/gu, "/").replace(/\.md$/iu, "");
}

export function markdownWikiLink(path: string, title: string): string {
  const target = notePathWithoutExtension(path).replace(/\|/gu, "-");
  const alias = title.replace(/\|/gu, "-").replace(/[\r\n]+/gu, " ").trim();
  return `[[${target}|${alias.length > 0 ? alias : "未命名"}]]`;
}

function uniqueLinks(links: MarkdownLink[]): MarkdownLink[] {
  const seen = new Set<string>();
  const result: MarkdownLink[] = [];
  for (const link of links) {
    const rendered = markdownWikiLink(link.path, link.title);
    if (seen.has(rendered)) continue;
    seen.add(rendered);
    result.push(link);
  }
  return result;
}

function lineBounds(
  content: string,
  anchor: MarkdownAnchor
): { start: number; end: number } {
  const start = content.lastIndexOf("\n", Math.max(0, anchor.start - 1)) + 1;
  const endIndex = content.indexOf("\n", anchor.end);
  return { start, end: endIndex < 0 ? content.length : endIndex };
}

function isEscaped(value: string, index: number): boolean {
  let slashes = 0;
  for (
    let cursor = index - 1;
    cursor >= 0 && value.charAt(cursor) === "\\";
    cursor -= 1
  ) {
    slashes += 1;
  }
  return slashes % 2 === 1;
}

function insideBacktickSpan(
  content: string,
  anchor: MarkdownAnchor,
  start: number,
  end: number
): boolean {
  let cursor = start;
  while (cursor < end) {
    if (content.charAt(cursor) !== "`" || isEscaped(content, cursor)) {
      cursor += 1;
      continue;
    }
    let markerEnd = cursor + 1;
    while (markerEnd < end && content.charAt(markerEnd) === "`") {
      markerEnd += 1;
    }
    const marker = content.slice(cursor, markerEnd);
    const close = content.indexOf(marker, markerEnd);
    if (close < 0 || close >= end) return false;
    if (anchor.start >= markerEnd && anchor.end <= close) return true;
    cursor = close + marker.length;
  }
  return false;
}

function insideDollarSpan(
  content: string,
  anchor: MarkdownAnchor,
  start: number,
  end: number
): boolean {
  let cursor = start;
  while (cursor < end) {
    if (content.charAt(cursor) !== "$" || isEscaped(content, cursor)) {
      cursor += 1;
      continue;
    }
    const marker = content.charAt(cursor + 1) === "$" ? "$$" : "$";
    const openEnd = cursor + marker.length;
    let close = openEnd;
    while (close < end) {
      close = content.indexOf(marker, close);
      if (close < 0 || close >= end) return false;
      if (!isEscaped(content, close)) break;
      close += marker.length;
    }
    if (close < 0 || close >= end) return false;
    if (anchor.start >= openEnd && anchor.end <= close) return true;
    cursor = close + marker.length;
  }
  return false;
}

function paragraphHasProtectedInlineSyntax(
  content: string,
  anchor: MarkdownAnchor,
  start: number,
  end: number
): boolean {
  return (
    insideBacktickSpan(content, anchor, start, end) ||
    insideDollarSpan(content, anchor, start, end)
  );
}

function followingLineEnd(content: string, offset: number): number {
  let cursor = offset;
  while (cursor < content.length && /\s/u.test(content.charAt(cursor))) {
    cursor += 1;
  }
  if (cursor >= content.length) return content.length;
  const newline = content.indexOf("\n", cursor);
  return newline < 0 ? content.length : newline;
}

function placementFor(
  content: string,
  anchor: MarkdownAnchor
): MarkdownLinkPlacement {
  const parsed = parseStructuredMarkdown(content);
  if (parsed.ok) {
    const block = parsed.blocks.find(
      (candidate) =>
        anchor.start >= candidate.startOffset &&
        anchor.end <= candidate.endOffset
    );
    if (
      block !== undefined &&
      (STRUCTURAL_BLOCKS.has(block.kind) ||
        (block.kind === "paragraph" &&
          paragraphHasProtectedInlineSyntax(
            content,
            anchor,
            block.startOffset,
            block.endOffset
          )))
    ) {
      return {
        offset: block.endOffset,
        standalone: true,
        scopeStart: block.startOffset,
        scopeEnd: followingLineEnd(content, block.endOffset)
      };
    }
  }

  const line = lineBounds(content, anchor);
  return {
    offset: anchor.end,
    standalone: false,
    scopeStart: line.start,
    scopeEnd: line.end
  };
}

function newlineFor(content: string): string {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function insertInline(content: string, offset: number, rendered: string): string {
  const before = content.slice(0, offset);
  const after = content.slice(offset);
  const beforeSpacer = /\s$/u.test(before) ? "" : " ";
  const afterSpacer =
    after.length === 0 || /^(?:\s|[，。！？、；：,.!?;:)])/u.test(after)
      ? ""
      : " ";
  return `${before}${beforeSpacer}${rendered}${afterSpacer}${after}`;
}

function insertStandalone(
  content: string,
  offset: number,
  rendered: string
): string {
  const newline = newlineFor(content);
  const before = content.slice(0, offset);
  const after = content.slice(offset);
  const beforeSeparator = new RegExp(`(?:${newline}){2}$`, "u").test(before)
    ? ""
    : new RegExp(`${newline}$`, "u").test(before)
      ? newline
      : `${newline}${newline}`;
  const afterSeparator = new RegExp(`^(?:${newline}){2}`, "u").test(after)
    ? ""
    : new RegExp(`^${newline}`, "u").test(after)
      ? newline
      : after.length > 0
        ? `${newline}${newline}`
        : "";
  return `${before}${beforeSeparator}${rendered}${afterSeparator}${after}`;
}

function placementKey(placement: MarkdownLinkPlacement): string {
  return [
    String(placement.offset),
    placement.standalone ? "block" : "inline",
    String(placement.scopeStart),
    String(placement.scopeEnd)
  ].join(":");
}

export function insertMarkdownLinks(
  content: string,
  insertions: MarkdownLinkInsertion[]
): string {
  const grouped = new Map<string, GroupedPlacement>();
  for (const insertion of insertions) {
    const placement = placementFor(content, insertion.anchor);
    const key = placementKey(placement);
    const group = grouped.get(key) ?? { ...placement, links: [] };
    group.links.push(...insertion.links);
    grouped.set(key, group);
  }

  const placements = [...grouped.values()]
    .map((placement) => {
      const scope = content.slice(placement.scopeStart, placement.scopeEnd);
      return {
        ...placement,
        links: uniqueLinks(placement.links).filter(
          (link) => !scope.includes(markdownWikiLink(link.path, link.title))
        )
      };
    })
    .filter((placement) => placement.links.length > 0)
    .sort((left, right) => right.offset - left.offset);

  return placements.reduce((current, placement) => {
    const rendered = placement.links
      .map((link) => markdownWikiLink(link.path, link.title))
      .join(" ");
    return placement.standalone
      ? insertStandalone(current, placement.offset, rendered)
      : insertInline(current, placement.offset, rendered);
  }, content);
}
