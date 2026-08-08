import {
  compressAssistantMarkdown
} from "./balanced-markdown-compressor";
import type { CharacterRange } from "./balanced-markdown-compressor";
import {
  estimateNoteTextTokens,
  renderNoteSnapshot
} from "./note-snapshot";
import type {
  BalancedFreezeArtifact,
  BalancedFreezeTier,
  NoteSnapshot
} from "./types";

export const BALANCED_V3_PROTOCOL = "balanced:v3" as const;
export const BALANCED_V3_ASSISTANT_OMISSION =
  "[TreeTalk 已省略部分较早的回答内容]";

export interface BuildAssistantFreezeArtifactInput {
  sourceIdentity: string;
  sourceContentHash: string;
  content: string;
  protectedRanges: readonly CharacterRange[];
  tier: BalancedFreezeTier;
}

export interface BuildNoteFreezeArtifactInput {
  sourceIdentity: string;
  sourceContentHash: string;
  snapshot: NoteSnapshot;
  tier: BalancedFreezeTier;
}

export interface BuildRecoveryPatchArtifactInput {
  sourceIdentity: string;
  sourceContentHash: string;
  sourceLabel: string;
  sourceContent: string;
  startOffset: number;
  endOffset: number;
  quote: string;
}

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

export function balancedV3TextHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function canonicalRanges(ranges: readonly CharacterRange[]): CharacterRange[] {
  const sorted = ranges
    .filter((range) => Number.isInteger(range.start) && Number.isInteger(range.end))
    .map((range) => ({
      start: Math.max(0, range.start),
      end: Math.max(0, range.end)
    }))
    .filter((range) => range.end > range.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: CharacterRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous !== undefined && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

export function protectionHashForRanges(
  ranges: readonly CharacterRange[]
): string {
  const canonical = canonicalRanges(ranges);
  return canonical.length === 0
    ? "none"
    : balancedV3TextHash(canonical.map((range) => `${range.start}:${range.end}`).join("|"));
}

function artifactKey(parts: readonly string[]): string {
  return `balanced-v3-${balancedV3TextHash(parts.join("\u0001"))}`;
}

export function assistantRetentionRatio(
  originalEstimatedTokens: number,
  tier: BalancedFreezeTier
): number {
  if (tier === "compact") return 0.25;
  if (originalEstimatedTokens < 160) return 1;
  if (originalEstimatedTokens < 800) return 0.6;
  if (originalEstimatedTokens < 2000) return 0.5;
  return 0.4;
}

export function noteRetentionRatio(
  originalEstimatedTokens: number,
  tier: BalancedFreezeTier
): number {
  if (tier === "compact") return 0.35;
  if (originalEstimatedTokens < 300) return 1;
  if (originalEstimatedTokens < 1500) return 0.6;
  return 0.5;
}

function deletionRatio(original: number, sent: number): number {
  return original <= 0 ? 0 : Math.max(0, Math.min(1, 1 - sent / original));
}

export function buildAssistantFreezeArtifact(
  input: BuildAssistantFreezeArtifactInput
): BalancedFreezeArtifact | undefined {
  const originalEstimatedTokens = estimateTokens(input.content);
  const retention = assistantRetentionRatio(originalEstimatedTokens, input.tier);
  if (retention >= 1) return undefined;
  const protectedRanges = canonicalRanges(input.protectedRanges);
  const result = compressAssistantMarkdown(input.content, {
    protectedRanges,
    targetRatio: retention,
    maxTokens: Math.max(
      input.tier === "compact" ? 64 : 96,
      Math.floor(originalEstimatedTokens * retention)
    ),
    minTokens: input.tier === "compact" ? 64 : 96,
    omissionMarker: BALANCED_V3_ASSISTANT_OMISSION
  });
  if (!result.compressed || result.content === input.content) return undefined;
  const protectionHash = protectionHashForRanges(protectedRanges);
  const key = artifactKey([
    BALANCED_V3_PROTOCOL,
    "assistant-message",
    input.sourceIdentity,
    input.sourceContentHash,
    protectionHash,
    input.tier
  ]);
  return {
    protocol: BALANCED_V3_PROTOCOL,
    key,
    sourceType: "assistant-message",
    sourceIdentity: input.sourceIdentity,
    sourceContentHash: input.sourceContentHash,
    protectionHash,
    tier: input.tier,
    content: result.content,
    originalEstimatedTokens: result.originalEstimatedTokens,
    sentEstimatedTokens: result.sentEstimatedTokens,
    deletionRatio: deletionRatio(
      result.originalEstimatedTokens,
      result.sentEstimatedTokens
    )
  };
}

export function buildNoteFreezeArtifact(
  input: BuildNoteFreezeArtifactInput
): BalancedFreezeArtifact | undefined {
  const originalEstimatedTokens = estimateNoteTextTokens(input.snapshot.content);
  const retention = noteRetentionRatio(originalEstimatedTokens, input.tier);
  if (retention >= 1) return undefined;
  const result = renderNoteSnapshot(
    input.snapshot,
    Math.max(1, Math.floor(originalEstimatedTokens * retention))
  );
  if (!result.trimmed || result.content === input.snapshot.content) return undefined;
  const protectionHash = balancedV3TextHash(
    `${input.snapshot.selectionStartOffset}:${input.snapshot.selectionEndOffset}`
  );
  const key = artifactKey([
    BALANCED_V3_PROTOCOL,
    "note-snapshot",
    input.sourceIdentity,
    input.sourceContentHash,
    protectionHash,
    input.tier
  ]);
  return {
    protocol: BALANCED_V3_PROTOCOL,
    key,
    sourceType: "note-snapshot",
    sourceIdentity: input.sourceIdentity,
    sourceContentHash: input.sourceContentHash,
    protectionHash,
    tier: input.tier,
    content: result.content,
    originalEstimatedTokens: result.originalEstimatedTokens,
    sentEstimatedTokens: result.sentEstimatedTokens,
    deletionRatio: deletionRatio(
      result.originalEstimatedTokens,
      result.sentEstimatedTokens
    )
  };
}

interface TextRange {
  start: number;
  end: number;
}

function paragraphRanges(content: string): TextRange[] {
  const ranges: TextRange[] = [];
  const pattern = /(?:^|\n\s*\n)([\s\S]*?)(?=\n\s*\n|$)/gu;
  for (const match of content.matchAll(pattern)) {
    const raw = match[1] ?? "";
    const matchStart = (match.index ?? 0) + (match[0]?.indexOf(raw) ?? 0);
    if (raw.trim().length > 0) {
      ranges.push({ start: matchStart, end: matchStart + raw.length });
    }
  }
  return ranges;
}

function containingFence(content: string, start: number): TextRange | undefined {
  const lines = content.split("\n");
  let offset = 0;
  let open: { start: number; marker: string } | undefined;
  for (const line of lines) {
    const lineStart = offset;
    const lineEnd = lineStart + line.length;
    const fence = line.match(/^\s*(`{3,}|~{3,})/u)?.[1];
    if (open === undefined && fence !== undefined) {
      open = { start: lineStart, marker: fence[0] ?? "`" };
    } else if (
      open !== undefined &&
      new RegExp(`^\\s*${open.marker}{3,}\\s*$`, "u").test(line)
    ) {
      const range = { start: open.start, end: lineEnd };
      if (start >= range.start && start <= range.end) return range;
      open = undefined;
    }
    offset = lineEnd + 1;
  }
  return undefined;
}

function nearestHeading(content: string, start: number): string | undefined {
  const prefix = content.slice(0, Math.max(0, start));
  return [...prefix.matchAll(/^#{1,6}[ \t]+.*$/gmu)].at(-1)?.[0];
}

function localContext(
  content: string,
  startOffset: number,
  endOffset: number,
  quote: string
): string {
  let start = Math.max(0, Math.min(content.length, startOffset));
  let end = Math.max(start, Math.min(content.length, endOffset));
  if (content.slice(start, end) !== quote) {
    const exact = content.indexOf(quote);
    if (exact >= 0) {
      start = exact;
      end = exact + quote.length;
    }
  }
  const fence = containingFence(content, start);
  if (fence !== undefined) return content.slice(fence.start, fence.end).trim();
  const paragraphs = paragraphRanges(content);
  const selectedIndex = paragraphs.findIndex(
    (range) => start < range.end && end > range.start
  );
  const pieces: string[] = [];
  const heading = nearestHeading(content, start);
  if (heading !== undefined) pieces.push(heading);
  if (selectedIndex >= 0) {
    for (const index of [selectedIndex - 1, selectedIndex, selectedIndex + 1]) {
      const range = paragraphs[index];
      if (range !== undefined) pieces.push(content.slice(range.start, range.end).trim());
    }
  }
  const unique = [...new Set(pieces.filter((piece) => piece.length > 0))];
  while (unique.length > 1 && estimateTokens(unique.join("\n\n")) > 512) {
    unique.shift();
  }
  let joined = unique.join("\n\n");
  if (estimateTokens(joined) > 512) {
    const left = 0;
    let right = joined.length;
    while (left < right && estimateTokens(joined.slice(0, right)) > 512) {
      right = Math.max(1, Math.floor(right * 0.9));
    }
    joined = joined.slice(0, right).trim();
  }
  return joined;
}

export function buildRecoveryPatchArtifact(
  input: BuildRecoveryPatchArtifactInput
): BalancedFreezeArtifact {
  const context = localContext(
    input.sourceContent,
    input.startOffset,
    input.endOffset,
    input.quote
  );
  const content = [
    "[TreeTalk 恢复引用]",
    `来源：${input.sourceLabel}`,
    "用户框选原文：",
    "---",
    input.quote,
    "---",
    ...(context.length === 0
      ? []
      : ["局部辅助上下文：", "---", context, "---"]),
    "[恢复引用结束]"
  ].join("\n");
  const protectionHash = balancedV3TextHash(
    `${input.startOffset}:${input.endOffset}:${balancedV3TextHash(input.quote)}`
  );
  const key = artifactKey([
    BALANCED_V3_PROTOCOL,
    "recovery-patch",
    input.sourceIdentity,
    input.sourceContentHash,
    protectionHash,
    "standard"
  ]);
  const originalEstimatedTokens = estimateTokens(input.sourceContent);
  const sentEstimatedTokens = estimateTokens(content);
  return {
    protocol: BALANCED_V3_PROTOCOL,
    key,
    sourceType: "recovery-patch",
    sourceIdentity: input.sourceIdentity,
    sourceContentHash: input.sourceContentHash,
    protectionHash,
    tier: "standard",
    content,
    originalEstimatedTokens,
    sentEstimatedTokens,
    deletionRatio: deletionRatio(originalEstimatedTokens, sentEstimatedTokens)
  };
}
