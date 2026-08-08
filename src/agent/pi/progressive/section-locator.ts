import { estimateTextTokens } from "../../../domain/context-engine";

export interface LocatedMarkdownSection {
  heading: string;
  level: number;
  lineStart: number;
  contentStart: number;
  endOffset: number;
  content: string;
}

export interface QuoteLocatorInput {
  quote: string;
  prefix?: string;
  suffix?: string;
  selectionStartOffset?: number;
  selectionEndOffset?: number;
}

export interface ScannedHeading {
  heading: string;
  normalized: string;
  level: number;
  lineStart: number;
  contentStart: number;
}

function normalizeHeading(value: string): string {
  return value
    .replace(/[`*_~]/gu, "")
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .toLowerCase();
}

function lineEndOffset(markdown: string, start: number): number {
  const newline = markdown.indexOf("\n", start);
  return newline < 0 ? markdown.length : newline + 1;
}

export function scanMarkdownHeadings(markdown: string): ScannedHeading[] {
  const result: ScannedHeading[] = [];
  let offset = 0;
  let fence: { marker: "`" | "~"; length: number } | undefined;
  while (offset < markdown.length) {
    const end = lineEndOffset(markdown, offset);
    const rawLine = markdown.slice(offset, end).replace(/\r?\n$/u, "");
    const fenceMatch = rawLine.match(/^\s*(`{3,}|~{3,})/u);
    if (fenceMatch !== null) {
      const token = fenceMatch[1] ?? "";
      const marker = token[0] as "`" | "~";
      if (fence === undefined) {
        fence = { marker, length: token.length };
      } else if (fence.marker === marker && token.length >= fence.length) {
        fence = undefined;
      }
      offset = end;
      continue;
    }
    if (fence === undefined) {
      const match = rawLine.match(/^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/u);
      if (match !== null) {
        const marker = match[1] ?? "";
        const heading = (match[2] ?? "").trim();
        result.push({
          heading,
          normalized: normalizeHeading(heading),
          level: marker.length,
          lineStart: offset,
          contentStart: end
        });
      }
    }
    offset = end;
  }
  return result;
}

function sectionAt(
  markdown: string,
  headings: readonly ScannedHeading[],
  index: number
): LocatedMarkdownSection | undefined {
  const current = headings[index];
  if (current === undefined) return undefined;
  const next = headings
    .slice(index + 1)
    .find((candidate) => candidate.level <= current.level);
  const endOffset = next?.lineStart ?? markdown.length;
  const content = markdown.slice(current.lineStart, endOffset).trim();
  if (content.length === 0) return undefined;
  return {
    heading: current.heading,
    level: current.level,
    lineStart: current.lineStart,
    contentStart: current.contentStart,
    endOffset,
    content
  };
}

export function locateMarkdownContainingSection(
  markdown: string,
  selectionStartOffset: number
): LocatedMarkdownSection | undefined {
  if (!Number.isInteger(selectionStartOffset) || selectionStartOffset < 0) {
    return undefined;
  }
  const headings = scanMarkdownHeadings(markdown);
  let selectedIndex = -1;
  for (const [index, heading] of headings.entries()) {
    if (heading.lineStart > selectionStartOffset) break;
    selectedIndex = index;
  }
  if (selectedIndex < 0) return undefined;
  const section = sectionAt(markdown, headings, selectedIndex);
  if (section === undefined || selectionStartOffset >= section.endOffset) {
    return undefined;
  }
  return section;
}

export function locateMarkdownSection(
  markdown: string,
  requestedHeading: string
): LocatedMarkdownSection | undefined {
  const normalized = normalizeHeading(requestedHeading);
  if (normalized.length === 0) return undefined;
  const headings = scanMarkdownHeadings(markdown);
  const index = headings.findIndex((entry) => entry.normalized === normalized);
  return index < 0 ? undefined : sectionAt(markdown, headings, index);
}

export function splitMarkdownIntoLogicalSections(
  markdown: string
): LocatedMarkdownSection[] {
  const headings = scanMarkdownHeadings(markdown);
  const result: LocatedMarkdownSection[] = [];
  const first = headings[0];
  if (first !== undefined && first.lineStart > 0) {
    const preamble = markdown.slice(0, first.lineStart).trim();
    if (preamble.length > 0) {
      result.push({
        heading: "导言",
        level: 0,
        lineStart: 0,
        contentStart: 0,
        endOffset: first.lineStart,
        content: preamble
      });
    }
  }
  for (let index = 0; index < headings.length; index += 1) {
    const section = sectionAt(markdown, headings, index);
    if (section !== undefined) result.push(section);
  }
  if (result.length === 0 && markdown.trim().length > 0) {
    result.push({
      heading: "正文",
      level: 0,
      lineStart: 0,
      contentStart: 0,
      endOffset: markdown.length,
      content: markdown.trim()
    });
  }
  return result;
}

function commonSuffixLength(left: string, right: string): number {
  const maximum = Math.min(left.length, right.length);
  let count = 0;
  while (count < maximum && left[left.length - count - 1] === right[right.length - count - 1]) count += 1;
  return count;
}

function commonPrefixLength(left: string, right: string): number {
  const maximum = Math.min(left.length, right.length);
  let count = 0;
  while (count < maximum && left[count] === right[count]) count += 1;
  return count;
}

export function locateQuoteOffset(
  content: string,
  input: QuoteLocatorInput
): number | undefined {
  const quote = input.quote;
  if (quote.length === 0) return undefined;
  const start = input.selectionStartOffset;
  const end = input.selectionEndOffset;
  if (
    start !== undefined && end !== undefined &&
    Number.isInteger(start) && Number.isInteger(end) &&
    start >= 0 && end >= start && end <= content.length &&
    content.slice(start, end) === quote
  ) return start;

  const occurrences: number[] = [];
  let cursor = 0;
  while (cursor <= content.length - quote.length) {
    const index = content.indexOf(quote, cursor);
    if (index < 0) break;
    occurrences.push(index);
    cursor = index + Math.max(1, quote.length);
  }
  if (occurrences.length === 0) return undefined;
  if (occurrences.length === 1) return occurrences[0];
  const prefix = input.prefix ?? "";
  const suffix = input.suffix ?? "";
  let best = occurrences[0] ?? 0;
  let bestScore = -1;
  for (const index of occurrences) {
    const before = content.slice(Math.max(0, index - prefix.length), index);
    const after = content.slice(index + quote.length, index + quote.length + suffix.length);
    const score = commonSuffixLength(before, prefix) * 2 + commonPrefixLength(after, suffix) * 2;
    if (score > bestScore) {
      bestScore = score;
      best = index;
    }
  }
  return best;
}

export function extractLocalMarkdownWindow(
  markdown: string,
  maximumTokens: number,
  locator: QuoteLocatorInput
): string {
  const offset = locateQuoteOffset(markdown, locator) ?? 0;
  const paragraphs: Array<{ start: number; end: number; content: string }> = [];
  const pattern = /(?:^|\n\s*\n)([\s\S]*?)(?=\n\s*\n|$)/gu;
  for (const match of markdown.matchAll(pattern)) {
    if (match.index === undefined) continue;
    const raw = match[1] ?? "";
    const localStart = match[0].indexOf(raw);
    const start = match.index + Math.max(0, localStart);
    const content = raw.trim();
    if (content.length === 0) continue;
    paragraphs.push({ start, end: start + raw.length, content });
  }
  if (paragraphs.length === 0) return markdown.trim();
  let center = paragraphs.findIndex((paragraph) => offset >= paragraph.start && offset <= paragraph.end);
  if (center < 0) center = 0;
  const selected = new Set<number>([center]);
  let left = center - 1;
  let right = center + 1;
  const render = (): string => [...selected].sort((a,b)=>a-b).map((index)=>paragraphs[index]?.content ?? "").filter(Boolean).join("\n\n");
  while (left >= 0 || right < paragraphs.length) {
    const candidate = left >= 0 ? left-- : right++;
    selected.add(candidate);
    if (estimateTextTokens(render()) > maximumTokens) {
      selected.delete(candidate);
      if (candidate < center && right < paragraphs.length) continue;
      break;
    }
    if (candidate < center && right < paragraphs.length) {
      const rightCandidate = right++;
      selected.add(rightCandidate);
      if (estimateTextTokens(render()) > maximumTokens) selected.delete(rightCandidate);
    }
  }
  return render();
}
