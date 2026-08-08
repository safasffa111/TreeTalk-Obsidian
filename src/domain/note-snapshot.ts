import type { NoteSnapshot } from "./types";

export const NOTE_SNAPSHOT_VERSION = "note-snapshot-v1" as const;
export const NOTE_OMISSION_MARKER =
  "[此处省略了距离框选位置较远的笔记内容]";

export interface StrippedFrontmatter {
  content: string;
  removedPrefixLength: number;
}

export interface CreateNoteSnapshotInput {
  sourceText: string;
  quote: string;
  basis: "note-source-v1" | "note-rendered-text-v1";
  sourceStartOffset: number;
  sourceEndOffset: number;
}

export interface RenderedNoteSnapshot {
  content: string;
  originalEstimatedTokens: number;
  sentEstimatedTokens: number;
  trimmed: boolean;
}

export async function sha256Hex(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export function stripYamlFrontmatter(source: string): StrippedFrontmatter {
  const bomLength = source.startsWith("\uFEFF") ? 1 : 0;
  const body = source.slice(bomLength);
  const firstBreak = body.indexOf("\n");
  const firstLine = (firstBreak < 0 ? body : body.slice(0, firstBreak)).replace(/\r$/u, "");
  if (firstLine.trim() !== "---") {
    return { content: body, removedPrefixLength: bomLength };
  }
  const linePattern = /^(?:---|\.\.\.)\s*\r?$/gmu;
  linePattern.lastIndex = firstBreak < 0 ? body.length : firstBreak + 1;
  const closing = linePattern.exec(body);
  if (closing === null) {
    return { content: body, removedPrefixLength: bomLength };
  }
  let contentStart = closing.index + closing[0].length;
  if (body.startsWith("\r\n", contentStart)) contentStart += 2;
  else if (body.startsWith("\n", contentStart)) contentStart += 1;
  return {
    content: body.slice(contentStart),
    removedPrefixLength: bomLength + contentStart
  };
}

function comparableProjection(value: string): {
  text: string;
  sourceOffsets: number[];
} {
  const characters: string[] = [];
  const sourceOffsets: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    if (/\s/u.test(character) || /[`*_~#>\[\]()!-]/u.test(character)) {
      continue;
    }
    characters.push(character.toLocaleLowerCase());
    sourceOffsets.push(index);
  }
  return { text: characters.join(""), sourceOffsets };
}

function resolveQuoteRange(content: string, quote: string): {
  start: number;
  end: number;
} | undefined {
  const exact = content.indexOf(quote);
  if (exact >= 0) return { start: exact, end: exact + quote.length };
  const source = comparableProjection(content);
  const target = comparableProjection(quote).text;
  if (target.length === 0) return undefined;
  const projectedStart = source.text.indexOf(target);
  if (projectedStart < 0) return undefined;
  const first = source.sourceOffsets[projectedStart];
  const last = source.sourceOffsets[projectedStart + target.length - 1];
  if (first === undefined || last === undefined) return undefined;
  return { start: first, end: last + 1 };
}

export async function createNoteSnapshot(
  input: CreateNoteSnapshotInput
): Promise<NoteSnapshot> {
  const stripped = stripYamlFrontmatter(input.sourceText);
  let selectionStartOffset = input.sourceStartOffset - stripped.removedPrefixLength;
  let selectionEndOffset = input.sourceEndOffset - stripped.removedPrefixLength;
  const exactSourceRange =
    input.basis === "note-source-v1" &&
    selectionStartOffset >= 0 &&
    selectionEndOffset <= stripped.content.length &&
    stripped.content.slice(selectionStartOffset, selectionEndOffset) === input.quote;
  if (!exactSourceRange) {
    const resolved = resolveQuoteRange(stripped.content, input.quote);
    if (resolved !== undefined) {
      selectionStartOffset = resolved.start;
      selectionEndOffset = resolved.end;
    } else {
      selectionStartOffset = Math.max(
        0,
        Math.min(stripped.content.length, selectionStartOffset)
      );
      selectionEndOffset = Math.max(
        selectionStartOffset,
        Math.min(stripped.content.length, selectionEndOffset)
      );
    }
  }
  return {
    version: NOTE_SNAPSHOT_VERSION,
    content: stripped.content,
    contentHash: await sha256Hex(stripped.content),
    selectionStartOffset,
    selectionEndOffset
  };
}

export function estimateNoteTextTokens(text: string): number {
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

interface HeadingSection {
  start: number;
  end: number;
  level: number;
}

function headingSections(content: string): HeadingSection[] {
  const matches = [...content.matchAll(/^(#{1,6})[ \t]+.*$/gmu)];
  if (matches.length === 0) {
    return [{ start: 0, end: content.length, level: 1 }];
  }
  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const level = (match[1] ?? "#").length;
    let end = content.length;
    for (let next = index + 1; next < matches.length; next += 1) {
      const candidate = matches[next];
      if (candidate === undefined) continue;
      const candidateLevel = (candidate[1] ?? "#").length;
      if (candidateLevel <= level) {
        end = candidate.index ?? content.length;
        break;
      }
    }
    return { start, end, level };
  });
}

function selectedSectionIndex(
  sections: HeadingSection[],
  selectionStartOffset: number
): number {
  let selected = 0;
  for (const [index, section] of sections.entries()) {
    if (section.start > selectionStartOffset) break;
    if (selectionStartOffset < section.end) selected = index;
  }
  return selected;
}

function withOmissionMarkers(
  content: string,
  start: number,
  end: number
): string {
  const parts: string[] = [];
  if (start > 0) parts.push(NOTE_OMISSION_MARKER);
  parts.push(content.slice(start, end).trim());
  if (end < content.length) parts.push(NOTE_OMISSION_MARKER);
  return parts.filter((entry) => entry.length > 0).join("\n\n");
}

function centeredWindow(
  content: string,
  selectionStartOffset: number,
  selectionEndOffset: number,
  maxTokens: number,
  preferredStart: number,
  preferredEnd: number
): string {
  let left = Math.max(preferredStart, selectionStartOffset - 64);
  let right = Math.min(preferredEnd, Math.max(selectionEndOffset + 64, left + 1));
  let step = Math.max(128, Math.floor((preferredEnd - preferredStart) / 4));
  while (step >= 1) {
    let expanded = false;
    const nextLeft = Math.max(preferredStart, left - step);
    const leftCandidate = withOmissionMarkers(content, nextLeft, right);
    if (estimateNoteTextTokens(leftCandidate) <= maxTokens) {
      left = nextLeft;
      expanded = true;
    }
    const nextRight = Math.min(preferredEnd, right + step);
    const rightCandidate = withOmissionMarkers(content, left, nextRight);
    if (estimateNoteTextTokens(rightCandidate) <= maxTokens) {
      right = nextRight;
      expanded = true;
    }
    if (!expanded) step = Math.floor(step / 2);
    if (left === preferredStart && right === preferredEnd) break;
  }
  return withOmissionMarkers(content, left, right);
}

export function trimNoteSnapshotContent(
  snapshot: NoteSnapshot,
  maxTokens: number
): string {
  const content = snapshot.content;
  if (estimateNoteTextTokens(content) <= maxTokens) return content;
  const sections = headingSections(content);
  const selectedFirstIndex = selectedSectionIndex(
    sections,
    snapshot.selectionStartOffset
  );
  const selectedLastIndex = selectedSectionIndex(
    sections,
    Math.max(snapshot.selectionStartOffset, snapshot.selectionEndOffset - 1)
  );
  const selectedFirst = sections[selectedFirstIndex] ?? {
    start: 0,
    end: content.length,
    level: 1
  };
  const selectedLast = sections[selectedLastIndex] ?? selectedFirst;
  const selectedCandidate = withOmissionMarkers(
    content,
    selectedFirst.start,
    selectedLast.end
  );
  if (estimateNoteTextTokens(selectedCandidate) > maxTokens) {
    return centeredWindow(
      content,
      snapshot.selectionStartOffset,
      snapshot.selectionEndOffset,
      maxTokens,
      selectedFirst.start,
      selectedLast.end
    );
  }

  let first = selectedFirstIndex;
  let last = selectedLastIndex;
  let distance = 1;
  while (true) {
    let changed = false;
    const previous = selectedFirstIndex - distance;
    if (previous >= 0) {
      const start = sections[previous]?.start ?? 0;
      const end = sections[last]?.end ?? selectedLast.end;
      const candidate = withOmissionMarkers(content, start, end);
      if (estimateNoteTextTokens(candidate) <= maxTokens) {
        first = previous;
        changed = true;
      }
    }
    const next = selectedLastIndex + distance;
    if (next < sections.length) {
      const start = sections[first]?.start ?? selectedFirst.start;
      const end = sections[next]?.end ?? content.length;
      const candidate = withOmissionMarkers(content, start, end);
      if (estimateNoteTextTokens(candidate) <= maxTokens) {
        last = next;
        changed = true;
      }
    }
    if (previous < 0 && next >= sections.length) break;
    distance += 1;
    if (!changed && distance > sections.length) break;
  }
  return withOmissionMarkers(
    content,
    sections[first]?.start ?? selectedFirst.start,
    sections[last]?.end ?? selectedLast.end
  );
}

export function renderNoteSnapshot(
  snapshot: NoteSnapshot,
  maxTokens: number
): RenderedNoteSnapshot {
  const originalEstimatedTokens = estimateNoteTextTokens(snapshot.content);
  const content = trimNoteSnapshotContent(snapshot, maxTokens);
  const sentEstimatedTokens = estimateNoteTextTokens(content);
  return {
    content,
    originalEstimatedTokens,
    sentEstimatedTokens,
    trimmed: content !== snapshot.content
  };
}

const NOTE_KEYWORD_STOPWORDS = new Set([
  "一个",
  "一些",
  "这个",
  "这些",
  "可以",
  "就是",
  "进行",
  "以及",
  "如果",
  "然后",
  "相关",
  "当前",
  "内容",
  "笔记",
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this"
]);

export function extractDeterministicNoteKeywords(
  content: string,
  limit = 2
): string[] {
  if (!Number.isInteger(limit) || limit <= 0) return [];
  const cleaned = content
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/gu, " ")
    .replace(/!?\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|[^\]]*)?\]\]/gu, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]+\)/gu, "$1")
    .replace(/<[^>]+>/gu, " ")
    .replace(/[#>*_~`|{}()[\]]/gu, " ");
  const entries = new Map<string, { count: number; first: number }>();
  const pattern = /[\p{Script=Han}]{2,8}|[A-Za-z][A-Za-z0-9_-]{2,}/gu;
  let order = 0;
  for (const match of cleaned.matchAll(pattern)) {
    const raw = match[0] ?? "";
    const keyword = /[A-Za-z]/u.test(raw) ? raw.toLocaleLowerCase() : raw;
    if (NOTE_KEYWORD_STOPWORDS.has(keyword)) continue;
    const existing = entries.get(keyword);
    if (existing === undefined) {
      entries.set(keyword, { count: 1, first: order });
    } else {
      existing.count += 1;
    }
    order += 1;
  }
  const ranked = [...entries.entries()].sort((left, right) => {
    const count = right[1].count - left[1].count;
    if (count !== 0) return count;
    const repeated = Number(right[1].count > 1) - Number(left[1].count > 1);
    if (repeated !== 0) return repeated;
    const first = left[1].first - right[1].first;
    return first !== 0 ? first : left[0].localeCompare(right[0]);
  });
  const repeated = ranked.filter((entry) => entry[1].count > 1);
  const source = repeated.length > 0 ? repeated : ranked;
  return source.slice(0, limit).map(([keyword]) => keyword);
}

function relevanceScore(block: string, terms: readonly string[]): number {
  let score = /^#{1,6}\s/u.test(block) ? 80 : 20;
  const lower = block.toLocaleLowerCase();
  for (const term of terms) {
    const normalized = term.trim().toLocaleLowerCase();
    if (normalized.length > 1 && lower.includes(normalized)) score += 45;
  }
  if (/定义|结论|原因|关键|注意|总结|缓存|上下文|关系/iu.test(block)) {
    score += 12;
  }
  return score;
}

export function compressRelatedNoteContent(
  content: string,
  maxTokens: number,
  relevanceTerms: readonly string[] = []
): string {
  if (estimateNoteTextTokens(content) <= maxTokens) return content;
  const blocks = content
    .replace(/\r\n?/gu, "\n")
    .split(/\n{2,}/u)
    .map((block, index) => ({
      block: block.trim(),
      index,
      score: relevanceScore(block, relevanceTerms)
    }))
    .filter((entry) => entry.block.length > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index);
  const selected: Array<{ block: string; index: number }> = [];
  let used = estimateNoteTextTokens(NOTE_OMISSION_MARKER);
  for (const entry of blocks) {
    const tokens = estimateNoteTextTokens(entry.block);
    if (selected.length === 0 || used + tokens <= maxTokens) {
      selected.push(entry);
      used += tokens;
    }
  }
  selected.sort((left, right) => left.index - right.index);
  const body = selected.map((entry) => entry.block).join("\n\n");
  if (body.length === 0) {
    const keywords = extractDeterministicNoteKeywords(content, 2);
    return keywords.length === 0 ? NOTE_OMISSION_MARKER : `关键词：${keywords.join("、")}`;
  }
  return `${body}\n\n${NOTE_OMISSION_MARKER}`;
}
