export const OBSIDIAN_MARKDOWN_SYSTEM_PROMPT = [
  "请使用严格兼容 Obsidian Markdown 的格式输出。",
  "行内公式只使用 $...$，块级公式只使用独立行的 $$...$$。",
  "不要使用 \\(...\\) 或 \\[...\\] 作为公式定界符。",
  "代码块必须使用成对的三反引号围栏，并注明语言时放在起始围栏后。",
  "标题、列表、引用、表格和代码块之间保留必要空行。",
  "表格必须包含表头分隔行。",
  "输出结束前检查所有公式定界符、反引号围栏和 Markdown 链接是否闭合。",
  "只输出回答内容，不解释这些格式要求。"
].join("\n");

export interface StreamingMarkdownSplit {
  stableMarkdown: string;
  pendingSource: string;
}

interface FenceRange {
  start: number;
  end: number;
  closed: boolean;
  marker: string;
}

interface LineInfo {
  start: number;
  end: number;
  content: string;
  newline: string;
}

function linesWithOffsets(value: string): LineInfo[] {
  const lines: LineInfo[] = [];
  let start = 0;
  for (let index = 0; index <= value.length; index += 1) {
    if (index !== value.length && value.charAt(index) !== "\n") continue;
    const raw = value.slice(start, index);
    const content = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const newline = index < value.length ? (raw.endsWith("\r") ? "\r\n" : "\n") : "";
    lines.push({ start, end: index < value.length ? index + 1 : index, content, newline });
    start = index + 1;
  }
  return lines;
}

function fenceRanges(markdown: string): FenceRange[] {
  const ranges: FenceRange[] = [];
  let open:
    | { start: number; marker: string; character: string; length: number }
    | undefined;
  for (const line of linesWithOffsets(markdown)) {
    const match = line.content.match(/^\s*(`{3,}|~{3,})/u);
    if (match === null) continue;
    const marker = match[1];
    if (marker === undefined) continue;
    const character = marker.charAt(0);
    if (open === undefined) {
      open = { start: line.start, marker, character, length: marker.length };
      continue;
    }
    if (character === open.character && marker.length >= open.length) {
      ranges.push({
        start: open.start,
        end: line.end,
        closed: true,
        marker: open.marker
      });
      open = undefined;
    }
  }
  if (open !== undefined) {
    ranges.push({
      start: open.start,
      end: markdown.length,
      closed: false,
      marker: open.marker
    });
  }
  return ranges;
}

function inRanges(index: number, ranges: FenceRange[]): boolean {
  return ranges.some((range) => index >= range.start && index < range.end);
}

function isEscaped(value: string, index: number): boolean {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value.charAt(cursor) === "\\"; cursor -= 1) {
    slashes += 1;
  }
  return slashes % 2 === 1;
}

function unclosedMathStart(markdown: string, ranges: FenceRange[]): number | undefined {
  let blockStart: number | undefined;
  let inlineStart: number | undefined;
  for (let index = 0; index < markdown.length; index += 1) {
    if (inRanges(index, ranges)) continue;
    if (markdown.charAt(index) !== "$" || isEscaped(markdown, index)) continue;
    if (markdown.charAt(index + 1) === "$") {
      if (inlineStart !== undefined) continue;
      blockStart = blockStart === undefined ? index : undefined;
      index += 1;
      continue;
    }
    if (blockStart !== undefined) continue;
    const previous = markdown.charAt(index - 1);
    const next = markdown.charAt(index + 1);
    if (inlineStart === undefined) {
      if (next.length === 0 || /\s/u.test(next)) continue;
      inlineStart = index;
    } else if (previous.length > 0 && !/\s/u.test(previous)) {
      inlineStart = undefined;
    }
  }
  return blockStart ?? inlineStart;
}

const HTML_BLOCK_TAGS = new Set([
  "article",
  "blockquote",
  "details",
  "div",
  "pre",
  "section",
  "summary",
  "table"
]);

function unclosedHtmlStart(markdown: string, ranges: FenceRange[]): number | undefined {
  const stack: Array<{ tag: string; start: number }> = [];
  const pattern = /<\/?([a-z][a-z0-9-]*)\b[^>]*>/giu;
  for (const match of markdown.matchAll(pattern)) {
    const index = match.index;
    if (inRanges(index, ranges)) continue;
    const raw = match[0];
    const tag = match[1]?.toLowerCase();
    if (tag === undefined || !HTML_BLOCK_TAGS.has(tag) || /\/\s*>$/u.test(raw)) continue;
    if (raw.startsWith("</")) {
      const position = stack.map((entry) => entry.tag).lastIndexOf(tag);
      if (position >= 0) stack.splice(position, 1);
    } else {
      stack.push({ tag, start: index });
    }
  }
  return stack[0]?.start;
}

function tableCellCount(line: string): number {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return 0;
  return trimmed.slice(1, -1).split(/(?<!\\)\|/u).length;
}

function isPipeRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("|") && trimmed.endsWith("|") &&
    (trimmed.match(/(?<!\\)\|/gu)?.length ?? 0) >= 2;
}

function isTableLine(line: string): boolean {
  return tableCellCount(line) >= 2;
}

function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!isTableLine(trimmed)) return false;
  return trimmed
    .slice(1, -1)
    .split(/(?<!\\)\|/u)
    .every((cell) => /^\s*:?-{3,}:?\s*$/u.test(cell));
}

function unfinishedTableStart(markdown: string): number | undefined {
  if (markdown.length === 0 || markdown.endsWith("\n")) return undefined;
  const lines = linesWithOffsets(markdown);
  let cursor = lines.length - 1;
  while (cursor >= 0 && isPipeRow(lines[cursor]?.content ?? "")) cursor -= 1;
  const group = lines.slice(cursor + 1);
  if (group.length === 0) return undefined;
  const headerCells = tableCellCount(group[0]?.content ?? "");
  const lastCells = tableCellCount(group.at(-1)?.content ?? "");
  if (group.length === 1) return group[0]?.start;
  if (!isTableSeparator(group[1]?.content ?? "")) return group[0]?.start;
  if (lastCells !== headerCells) return group[0]?.start;
  return undefined;
}

export function splitStreamingMarkdown(markdown: string): StreamingMarkdownSplit {
  const ranges = fenceRanges(markdown);
  const candidates: number[] = [];
  const unclosedFence = ranges.find((range) => !range.closed);
  if (unclosedFence !== undefined) candidates.push(unclosedFence.start);
  const mathStart = unclosedMathStart(markdown, ranges);
  if (mathStart !== undefined) candidates.push(mathStart);
  const htmlStart = unclosedHtmlStart(markdown, ranges);
  if (htmlStart !== undefined) candidates.push(htmlStart);
  const tableStart = unfinishedTableStart(markdown);
  if (tableStart !== undefined) candidates.push(tableStart);
  const start = candidates.length > 0 ? Math.min(...candidates) : markdown.length;
  return {
    stableMarkdown: markdown.slice(0, start),
    pendingSource: markdown.slice(start)
  };
}

function transformOutsideFences(
  markdown: string,
  transform: (text: string) => string
): { value: string; unclosedFenceMarker?: string } {
  const ranges = fenceRanges(markdown);
  let cursor = 0;
  let value = "";
  let unclosedFenceMarker: string | undefined;
  for (const range of ranges) {
    value += transform(markdown.slice(cursor, range.start));
    value += markdown.slice(range.start, range.end);
    cursor = range.end;
    if (!range.closed) unclosedFenceMarker = range.marker;
  }
  value += transform(markdown.slice(cursor));
  return unclosedFenceMarker === undefined
    ? { value }
    : { value, unclosedFenceMarker };
}

function convertMathDelimiters(text: string): string {
  return text
    .replace(/(?<!\\)\\\[([\s\S]*?)(?<!\\)\\\]/gu, (_match, body: string) => {
      const normalized = body.trim();
      return `$$\n${normalized}\n$$`;
    })
    .replace(/(?<!\\)\\\(([^\n]*?)(?<!\\)\\\)/gu, (_match, body: string) =>
      `$${body.trim()}$`
    );
}

function insertMissingTableSeparators(text: string): string {
  const lines = text.split("\n");
  const output: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!isTableLine(line)) {
      output.push(line);
      index += 1;
      continue;
    }
    const group: string[] = [];
    while (index < lines.length && isTableLine(lines[index] ?? "")) {
      group.push(lines[index] ?? "");
      index += 1;
    }
    const headerCount = tableCellCount(group[0] ?? "");
    const second = group[1];
    output.push(group[0] ?? "");
    if (
      second !== undefined &&
      !isTableSeparator(second) &&
      tableCellCount(second) === headerCount
    ) {
      output.push(`| ${Array.from({ length: headerCount }, () => "---").join(" | ")} |`);
    }
    output.push(...group.slice(1));
  }
  return output.join("\n");
}

function isListLine(line: string): boolean {
  return /^\s*(?:[-+*]|\d+[.)])\s+/u.test(line);
}

function isQuoteLine(line: string): boolean {
  return /^\s*>\s?/u.test(line);
}

function isHeadingLine(line: string): boolean {
  return /^\s*#{1,6}\s+/u.test(line);
}

function addStructuralBlankLines(text: string): string {
  const lines = text.split("\n");
  const output: string[] = [];
  for (const line of lines) {
    const previous = output.at(-1) ?? "";
    const previousNonblank = previous.trim().length > 0;
    const needsSeparation =
      isHeadingLine(line) ||
      (isListLine(line) && !isListLine(previous)) ||
      (isQuoteLine(line) && !isQuoteLine(previous));
    if (previousNonblank && needsSeparation) output.push("");
    output.push(line);
  }
  return output.join("\n");
}

function closeUnmatchedMath(text: string): string {
  const split = splitStreamingMarkdown(text);
  if (split.pendingSource.length === 0) return text;
  if (split.pendingSource.startsWith("$$")) return `${text}\n$$`;
  if (split.pendingSource.startsWith("$")) return `${text}$`;
  return text;
}

export function normalizeObsidianMarkdown(markdown: string): string {
  const transformed = transformOutsideFences(markdown, (text) =>
    addStructuralBlankLines(
      insertMissingTableSeparators(convertMathDelimiters(text))
    )
  );
  let normalized = transformed.value;
  if (transformed.unclosedFenceMarker !== undefined) {
    const separator = normalized.endsWith("\n") ? "" : "\n";
    normalized += `${separator}${transformed.unclosedFenceMarker}`;
    return normalized;
  }
  normalized = closeUnmatchedMath(normalized);
  return normalized;
}
