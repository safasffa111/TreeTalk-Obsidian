import type { SelectionAnchor } from "./types";

export type StructuredMarkdownBlockKind =
  | "heading"
  | "paragraph"
  | "list"
  | "quote"
  | "table"
  | "code"
  | "math";

export interface CharacterRange {
  start: number;
  end: number;
}

export interface StructuredMarkdownBlock {
  kind: StructuredMarkdownBlockKind;
  startOffset: number;
  endOffset: number;
  content: string;
  headingPath: string[];
  protectedBySelection: boolean;
  priority: number;
  estimatedTokens: number;
}

interface InternalMarkdownBlock extends StructuredMarkdownBlock {
  headingIndexes: number[];
}

export type StructuredMarkdownParseResult =
  | { ok: true; blocks: StructuredMarkdownBlock[] }
  | { ok: false; reason: "unclosed-code-fence" | "unclosed-math-fence" };

interface InternalParseSuccess {
  ok: true;
  blocks: InternalMarkdownBlock[];
}

type InternalParseResult =
  | InternalParseSuccess
  | { ok: false; reason: "unclosed-code-fence" | "unclosed-math-fence" };

export type ResolvedMarkdownSelection = {
  status: "resolved";
  start: number;
  end: number;
};

export type UnresolvedMarkdownSelection = {
  status: "unresolved";
  quote: string;
};

export interface CompressAssistantMarkdownOptions {
  protectedRanges?: readonly CharacterRange[];
  targetRatio?: number;
  maxTokens?: number;
  minTokens?: number;
  omissionMarker?: string;
}

export interface CompressionResult {
  content: string;
  compressed: boolean;
  originalEstimatedTokens: number;
  sentEstimatedTokens: number;
}

interface SourceLine {
  start: number;
  end: number;
  text: string;
}

const HISTORY_OMISSION =
  "> [!note]- TreeTalk 已压缩历史内容\n> 省略了未被后续对话引用的说明。";
const CODE_OMISSION_TEXT = "TreeTalk 已压缩历史内容：省略未引用代码";
const MIN_COMPRESSIBLE_TOKENS = 160;
const MIN_MEANINGFUL_SAVINGS = 12;

function estimateTokens(text: string): number {
  let weighted = 0;
  for (const character of text) {
    if (/\s/u.test(character)) continue;
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Extended_Pictographic}/u.test(character)) {
      weighted += 1;
    } else if (/[^\x00-\x7F]/u.test(character)) {
      weighted += 0.6;
    } else {
      weighted += 0.25;
    }
  }
  return Math.max(1, Math.ceil(weighted));
}

function sourceLines(markdown: string): SourceLine[] {
  if (markdown.length === 0) return [];
  const lines: SourceLine[] = [];
  let start = 0;
  while (start < markdown.length) {
    const newline = markdown.indexOf("\n", start);
    const end = newline < 0 ? markdown.length : newline + 1;
    const raw = markdown.slice(start, end);
    lines.push({
      start,
      end,
      text: raw.replace(/\r?\n$/u, "")
    });
    start = end;
  }
  return lines;
}

function isBlank(line: SourceLine): boolean {
  return line.text.trim().length === 0;
}

function fenceStart(text: string): { character: "`" | "~"; length: number } | undefined {
  const match = text.match(/^\s*(`{3,}|~{3,})/u);
  const marker = match?.[1];
  if (marker === undefined) return undefined;
  const character = marker[0];
  if (character !== "`" && character !== "~") return undefined;
  return { character, length: marker.length };
}

function isFenceEnd(text: string, fence: { character: "`" | "~"; length: number }): boolean {
  const escaped = fence.character === "`" ? "`" : "~";
  return new RegExp(`^\\s*${escaped}{${String(fence.length)},}\\s*$`, "u").test(text);
}

function isMathFence(text: string): boolean {
  return /^\s*\$\$\s*$/u.test(text);
}

function heading(text: string): { level: number; title: string } | undefined {
  const match = text.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/u);
  if (match === null) return undefined;
  return { level: match[1]?.length ?? 1, title: match[2] ?? "" };
}

function isListStart(text: string): boolean {
  return /^\s*(?:[-*+]\s+|\d+[.)]\s+)/u.test(text);
}

function isQuoteStart(text: string): boolean {
  return /^\s*>/u.test(text);
}

function isTableSeparator(text: string): boolean {
  if (!text.includes("|")) return false;
  const cells = text.trim().replace(/^\|/u, "").replace(/\|$/u, "").split("|");
  return cells.length > 0 && cells.every((cell) => /^\s*:?-{3,}:?\s*$/u.test(cell));
}

function isTableStart(lines: SourceLine[], index: number): boolean {
  const current = lines[index];
  const next = lines[index + 1];
  return current !== undefined && next !== undefined && current.text.includes("|") && isTableSeparator(next.text);
}

function priorityFor(kind: StructuredMarkdownBlockKind, content: string, isFirst: boolean): number {
  let priority = 20;
  if (kind === "heading") priority = 72;
  else if (kind === "table") priority = 64;
  else if (kind === "math") priority = 62;
  else if (kind === "code") priority = 48;
  else if (kind === "list") priority = 44;
  else if (kind === "quote") priority = 42;
  if (/定义|结论|总结|原因|限制|前提|注意|警告|错误|关键|步骤|接口|参数|返回值|必须|禁止|不要|因此|所以/iu.test(content)) {
    priority += 28;
  }
  if (isFirst && kind !== "heading") priority += 18;
  return priority;
}

function intersects(left: CharacterRange, right: CharacterRange): boolean {
  return left.start < right.end && right.start < left.end;
}

function parseInternal(markdown: string, protectedRanges: readonly CharacterRange[]): InternalParseResult {
  const lines = sourceLines(markdown);
  const blocks: InternalMarkdownBlock[] = [];
  const headingTitles: string[] = [];
  const headingIndexes: number[] = [];
  let index = 0;
  let firstSubstantiveSeen = false;

  const addBlock = (
    kind: StructuredMarkdownBlockKind,
    startLine: number,
    endLineExclusive: number,
    headingPath: string[],
    blockHeadingIndexes: number[]
  ): void => {
    const first = lines[startLine];
    const last = lines[endLineExclusive - 1];
    if (first === undefined || last === undefined) return;
    const startOffset = first.start;
    const rawLastLine = markdown.slice(last.start, last.end);
    const trailingNewlineLength = rawLastLine.endsWith("\r\n")
      ? 2
      : rawLastLine.endsWith("\n")
        ? 1
        : 0;
    const endOffset = last.end - trailingNewlineLength;
    const content = markdown.slice(startOffset, endOffset);
    const range = { start: startOffset, end: endOffset };
    const protectedBySelection = protectedRanges.some((item) => intersects(range, item));
    const isFirst = !firstSubstantiveSeen && kind !== "heading";
    if (kind !== "heading") firstSubstantiveSeen = true;
    blocks.push({
      kind,
      startOffset,
      endOffset,
      content,
      headingPath: [...headingPath],
      headingIndexes: [...blockHeadingIndexes],
      protectedBySelection,
      priority: priorityFor(kind, content, isFirst),
      estimatedTokens: estimateTokens(content)
    });
  };

  while (index < lines.length) {
    const current = lines[index];
    if (current === undefined) break;
    if (isBlank(current)) {
      index += 1;
      continue;
    }

    const fence = fenceStart(current.text);
    if (fence !== undefined) {
      let end = index + 1;
      while (end < lines.length && !isFenceEnd(lines[end]?.text ?? "", fence)) end += 1;
      if (end >= lines.length) return { ok: false, reason: "unclosed-code-fence" };
      addBlock("code", index, end + 1, headingTitles, headingIndexes);
      index = end + 1;
      continue;
    }

    if (isMathFence(current.text)) {
      let end = index + 1;
      while (end < lines.length && !isMathFence(lines[end]?.text ?? "")) end += 1;
      if (end >= lines.length) return { ok: false, reason: "unclosed-math-fence" };
      addBlock("math", index, end + 1, headingTitles, headingIndexes);
      index = end + 1;
      continue;
    }

    const currentHeading = heading(current.text);
    if (currentHeading !== undefined) {
      headingTitles.length = currentHeading.level - 1;
      headingIndexes.length = currentHeading.level - 1;
      headingTitles[currentHeading.level - 1] = currentHeading.title;
      const blockIndex = blocks.length;
      headingIndexes[currentHeading.level - 1] = blockIndex;
      addBlock("heading", index, index + 1, headingTitles, headingIndexes.slice(0, -1));
      index += 1;
      continue;
    }

    if (isQuoteStart(current.text)) {
      let end = index + 1;
      while (end < lines.length && isQuoteStart(lines[end]?.text ?? "")) end += 1;
      addBlock("quote", index, end, headingTitles, headingIndexes);
      index = end;
      continue;
    }

    if (isTableStart(lines, index)) {
      let end = index + 2;
      while (end < lines.length && !isBlank(lines[end] ?? { start: 0, end: 0, text: "" }) && (lines[end]?.text.includes("|") ?? false)) {
        end += 1;
      }
      addBlock("table", index, end, headingTitles, headingIndexes);
      index = end;
      continue;
    }

    if (isListStart(current.text)) {
      let end = index + 1;
      while (end < lines.length) {
        const line = lines[end];
        if (line === undefined || isBlank(line)) break;
        if (heading(line.text) !== undefined || fenceStart(line.text) !== undefined || isMathFence(line.text) || isQuoteStart(line.text) || isTableStart(lines, end)) break;
        if (!isListStart(line.text) && !/^\s{2,}\S/u.test(line.text)) break;
        end += 1;
      }
      addBlock("list", index, end, headingTitles, headingIndexes);
      index = end;
      continue;
    }

    let end = index + 1;
    while (end < lines.length) {
      const line = lines[end];
      if (line === undefined || isBlank(line)) break;
      if (heading(line.text) !== undefined || fenceStart(line.text) !== undefined || isMathFence(line.text) || isQuoteStart(line.text) || isTableStart(lines, end) || isListStart(line.text)) break;
      end += 1;
    }
    addBlock("paragraph", index, end, headingTitles, headingIndexes);
    index = end;
  }

  return { ok: true, blocks };
}

export function parseStructuredMarkdown(markdown: string): StructuredMarkdownParseResult {
  const result = parseInternal(markdown, []);
  if (!result.ok) return result;
  return {
    ok: true,
    blocks: result.blocks.map(({ headingIndexes: _headingIndexes, ...block }) => block)
  };
}

function commonSuffixLength(left: string, right: string): number {
  const maximum = Math.min(left.length, right.length);
  let matched = 0;
  while (matched < maximum && left[left.length - 1 - matched] === right[right.length - 1 - matched]) matched += 1;
  return matched;
}

function commonPrefixLength(left: string, right: string): number {
  const maximum = Math.min(left.length, right.length);
  let matched = 0;
  while (matched < maximum && left[matched] === right[matched]) matched += 1;
  return matched;
}

interface SelectionCandidate {
  start: number;
  end: number;
  contextScore: number;
  distance: number;
}

export function resolveSelectionInMarkdown(
  markdown: string,
  anchor: SelectionAnchor
): ResolvedMarkdownSelection | UnresolvedMarkdownSelection {
  const searchTerms = [anchor.quote, anchor.visibleQuote]
    .filter((value): value is string => value !== undefined && value.length > 0)
    .filter((value, index, values) => values.indexOf(value) === index);

  if (
    Number.isInteger(anchor.startOffset) &&
    Number.isInteger(anchor.endOffset) &&
    anchor.startOffset >= 0 &&
    anchor.endOffset > anchor.startOffset &&
    anchor.endOffset <= markdown.length
  ) {
    const exact = markdown.slice(anchor.startOffset, anchor.endOffset);
    const visibleTerm = anchor.visibleQuote ?? anchor.quote;
    if (exact === visibleTerm) {
      return {
        status: "resolved",
        start: anchor.startOffset,
        end: anchor.endOffset
      };
    }
  }

  for (const term of searchTerms) {
    const candidates: SelectionCandidate[] = [];
    let from = 0;
    while (from <= markdown.length - term.length) {
      const start = markdown.indexOf(term, from);
      if (start < 0) break;
      const end = start + term.length;
      const before = markdown.slice(Math.max(0, start - anchor.prefix.length), start);
      const after = markdown.slice(end, end + anchor.suffix.length);
      candidates.push({
        start,
        end,
        contextScore: commonSuffixLength(anchor.prefix, before) + commonPrefixLength(anchor.suffix, after),
        distance: Math.abs(start - anchor.startOffset)
      });
      from = start + Math.max(1, term.length);
    }
    if (candidates.length === 0) continue;
    if (candidates.length === 1) {
      const only = candidates[0];
      if (only !== undefined) return { status: "resolved", start: only.start, end: only.end };
    }
    candidates.sort((left, right) => right.contextScore - left.contextScore || left.distance - right.distance || left.start - right.start);
    const best = candidates[0];
    const second = candidates[1];
    if (best === undefined) continue;
    if (best.contextScore === 0 || (second !== undefined && second.contextScore === best.contextScore)) {
      return { status: "unresolved", quote: anchor.quote };
    }
    return { status: "resolved", start: best.start, end: best.end };
  }
  return { status: "unresolved", quote: anchor.quote };
}

function codeOmissionComment(language: string): string {
  const normalized = language.toLowerCase();
  if (/^(?:py|python|sh|bash|zsh|fish|yaml|yml|toml|r|ruby|perl)$/u.test(normalized)) {
    return `# ${CODE_OMISSION_TEXT}`;
  }
  if (/^(?:html|xml|svg|md|markdown)$/u.test(normalized)) {
    return `<!-- ${CODE_OMISSION_TEXT} -->`;
  }
  return `// ${CODE_OMISSION_TEXT}`;
}

function looksLikeSignature(line: string): boolean {
  return /^\s*(?:import|export|from|require|#include|using|package|class|interface|type|enum|struct|def|fn|func|function|public|private|protected|static|async|const\s+\w+\s*=\s*\(|let\s+\w+\s*=\s*\().*/u.test(line);
}

function compactCode(content: string, maxTokens: number): string {
  if (estimateTokens(content) <= maxTokens) return content;
  const lines = content.split("\n");
  const opening = lines[0] ?? "```";
  const closing = lines.at(-1) ?? "```";
  const language = opening.replace(/^\s*(`{3,}|~{3,})/u, "").trim();
  const body = lines.slice(1, -1);
  const keep = new Set<number>();
  for (let index = 0; index < Math.min(6, body.length); index += 1) keep.add(index);
  for (let index = Math.max(0, body.length - 4); index < body.length; index += 1) keep.add(index);
  for (const [lineIndex, line] of body.entries()) {
    if (looksLikeSignature(line)) keep.add(lineIndex);
    if (keep.size >= 28) break;
  }
  const selected = [...keep].sort((left, right) => left - right);
  const output = [opening];
  let previous = -1;
  for (const lineIndex of selected) {
    if (previous >= 0 && lineIndex > previous + 1) output.push(codeOmissionComment(language));
    output.push(body[lineIndex] ?? "");
    previous = lineIndex;
  }
  output.push(closing);
  return output.join("\n");
}

function clampRatio(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0.45;
  return Math.min(0.6, Math.max(0.25, value));
}

function addHeadingAncestors(blocks: InternalMarkdownBlock[], selected: Set<number>): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const index of [...selected]) {
      const block = blocks[index];
      if (block === undefined) continue;
      for (const headingIndex of block.headingIndexes) {
        if (!selected.has(headingIndex)) {
          selected.add(headingIndex);
          changed = true;
        }
      }
    }
  }
}

export function compressAssistantMarkdown(
  markdown: string,
  options: CompressAssistantMarkdownOptions = {}
): CompressionResult {
  const originalEstimatedTokens = estimateTokens(markdown);
  const unchanged = (): CompressionResult => ({
    content: markdown,
    compressed: false,
    originalEstimatedTokens,
    sentEstimatedTokens: originalEstimatedTokens
  });
  if (originalEstimatedTokens <= MIN_COMPRESSIBLE_TOKENS) return unchanged();

  const protectedRanges = options.protectedRanges ?? [];
  const parsed = parseInternal(markdown, protectedRanges);
  if (!parsed.ok || parsed.blocks.length < 3) return unchanged();
  const blocks = parsed.blocks;
  const ratio = clampRatio(options.targetRatio);
  const minimumTokens = Math.max(1, Math.floor(options.minTokens ?? 96));
  const ratioTarget = Math.max(
    minimumTokens,
    Math.floor(originalEstimatedTokens * ratio)
  );
  const target = options.maxTokens === undefined
    ? ratioTarget
    : Math.max(
        minimumTokens,
        Math.min(ratioTarget, Math.floor(options.maxTokens))
      );
  const omissionMarker = options.omissionMarker ?? HISTORY_OMISSION;
  const selected = new Set<number>();

  for (const [blockIndex, block] of blocks.entries()) {
    if (block.protectedBySelection) selected.add(blockIndex);
  }
  const substantive = blocks
    .map((block, blockIndex) => ({ block, blockIndex }))
    .filter(({ block }) => block.kind !== "heading");
  const first = substantive[0];
  const last = substantive.at(-1);
  if (first !== undefined) selected.add(first.blockIndex);
  if (last !== undefined) selected.add(last.blockIndex);
  for (const { block, blockIndex } of substantive) {
    if (block.priority >= 70) selected.add(blockIndex);
  }

  for (const protectedIndex of [...selected]) {
    const protectedBlock = blocks[protectedIndex];
    if (protectedBlock?.protectedBySelection !== true) continue;
    for (const neighborIndex of [protectedIndex - 1, protectedIndex + 1]) {
      const neighbor = blocks[neighborIndex];
      if (neighbor !== undefined && neighbor.kind !== "heading" && neighbor.estimatedTokens <= 96) {
        selected.add(neighborIndex);
      }
    }
  }
  addHeadingAncestors(blocks, selected);

  let used = [...selected].reduce((total, blockIndex) => total + (blocks[blockIndex]?.estimatedTokens ?? 0), 0);
  const ranked = blocks
    .map((block, blockIndex) => ({ block, blockIndex }))
    .filter(({ blockIndex }) => !selected.has(blockIndex))
    .sort((left, right) => right.block.priority - left.block.priority || left.blockIndex - right.blockIndex);
  for (const { block, blockIndex } of ranked) {
    if (block.kind === "heading") continue;
    if (used + block.estimatedTokens > target) continue;
    selected.add(blockIndex);
    used += block.estimatedTokens;
  }
  addHeadingAncestors(blocks, selected);

  const pieces: string[] = [];
  let omitted = false;
  for (const [blockIndex, block] of blocks.entries()) {
    if (!selected.has(blockIndex)) {
      omitted = true;
      continue;
    }
    if (omitted && pieces.length > 0) pieces.push(omissionMarker);
    omitted = false;
    let content = block.content;
    if (block.kind === "code" && !block.protectedBySelection) {
      content = compactCode(content, Math.max(96, Math.floor(target * 0.45)));
    }
    pieces.push(content.trim());
  }
  if (omitted && pieces.length > 0) pieces.push(omissionMarker);
  const content = pieces.join("\n\n").trim();
  const sentEstimatedTokens = estimateTokens(content);
  if (content.length === 0 || sentEstimatedTokens >= originalEstimatedTokens - MIN_MEANINGFUL_SAVINGS) {
    return unchanged();
  }
  return {
    content,
    compressed: true,
    originalEstimatedTokens,
    sentEstimatedTokens
  };
}
