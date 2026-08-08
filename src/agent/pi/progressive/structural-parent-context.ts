import { estimateTextTokens } from "../../../domain/context-engine";
import type { ExecutionRequest } from "../../../execution/types";
import { sha256Hex } from "../cache-identity";
import type { ProgressiveContextSnapshot } from "./types";

export interface StructuralParentSource {
  nodeId: string;
  messageId: string;
  title: string;
  content: string;
  revision: string;
}

export function resolveStructuralParentSource(
  request: ExecutionRequest,
  snapshot: ProgressiveContextSnapshot
): StructuralParentSource | undefined {
  const anchor = (request.piContext?.focus?.anchors ?? []).find(
    (entry) => entry.kind === "conversation-round"
  );
  const target = (request.piContext?.focus?.targets ?? []).find(
    (entry) => entry.kind === "conversation-round"
  );
  const sourceNodeId = anchor?.kind === "conversation-round"
    ? anchor.sourceNodeId
    : target?.kind === "conversation-round"
      ? target.sourceNodeId
      : undefined;
  if (sourceNodeId === undefined) return undefined;
  const node = snapshot.conversationNodes.find((entry) => entry.id === sourceNodeId);
  if (node === undefined) return undefined;
  const sourceMessageId = anchor?.kind === "conversation-round"
    ? anchor.sourceMessageId
    : target?.kind === "conversation-round"
      ? target.sourceMessageId
      : undefined;
  const isValid = (message: (typeof node.messages)[number] | undefined): message is (typeof node.messages)[number] =>
    message?.role === "assistant" &&
    message.status === "complete" &&
    message.content.trim().length > 0;
  const message = sourceMessageId === undefined
    ? [...node.messages].reverse().find(isValid)
    : node.messages.find((entry) => entry.id === sourceMessageId && isValid(entry));
  if (message === undefined) return undefined;
  return {
    nodeId: node.id,
    messageId: message.id,
    title: node.title,
    content: message.content,
    revision: sha256Hex(`${node.id}\n${message.id}\n${message.content}`)
  };
}

export interface ReverseTokenWindow {
  content: string;
  startOffset: number;
  endOffset: number;
  hasEarlierContent: boolean;
}

function findWindowStart(content: string, endOffset: number, maximumTokens: number): number {
  let low = 0;
  let high = endOffset;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (estimateTextTokens(content.slice(middle, endOffset)) <= maximumTokens) high = middle;
    else low = middle + 1;
  }
  let start = low;
  if (start > 0) {
    const span = endOffset - start;
    const boundaryLimit = Math.min(endOffset, start + Math.max(1, Math.floor(span * 0.25)));
    for (let index = start; index < boundaryLimit; index += 1) {
      const current = content[index] ?? "";
      const next = content[index + 1] ?? "";
      if (/\n/u.test(current) || /[。！？；.!?;]/u.test(current) || (/\s/u.test(current) && /\S/u.test(next))) {
        start = index + 1;
        break;
      }
    }
  }
  return start;
}

export function createReverseTokenWindows(
  content: string,
  firstMaximumTokens = 500,
  laterMaximumTokens = 1_800
): ReverseTokenWindow[] {
  const windows: ReverseTokenWindow[] = [];
  let endOffset = content.length;
  let maximumTokens = Math.max(1, Math.trunc(firstMaximumTokens));
  while (endOffset > 0) {
    let startOffset = findWindowStart(content, endOffset, maximumTokens);
    if (startOffset >= endOffset) startOffset = Math.max(0, endOffset - 1);
    const text = content.slice(startOffset, endOffset).trim();
    if (text.length > 0) {
      windows.push({
        content: text,
        startOffset,
        endOffset,
        hasEarlierContent: startOffset > 0
      });
    }
    if (startOffset === 0) break;
    endOffset = startOffset;
    maximumTokens = Math.max(1, Math.trunc(laterMaximumTokens));
  }
  return windows;
}

const DIGEST_HEAD_MAX_TOKENS = 260;
const DIGEST_TAIL_MAX_TOKENS = 240;

function clipPrefixToTokens(
  content: string,
  maximumTokens: number
): { text: string; consumed: number } {
  if (estimateTextTokens(content) <= maximumTokens) {
    return { text: content, consumed: content.length };
  }
  let low = 0;
  let high = content.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTextTokens(content.slice(0, middle)) <= maximumTokens) low = middle;
    else high = middle - 1;
  }
  let consumed = Math.max(1, low);
  const minimumBoundary = Math.max(1, Math.floor(consumed * 0.7));
  for (let index = consumed - 1; index >= minimumBoundary; index -= 1) {
    if (/[。！？；.!?;\n\s]/u.test(content[index] ?? "")) {
      consumed = index + 1;
      break;
    }
  }
  return { text: content.slice(0, consumed).trim(), consumed };
}

function clipSuffixToTokens(
  content: string,
  maximumTokens: number
): { text: string; start: number } {
  if (estimateTextTokens(content) <= maximumTokens) {
    return { text: content, start: 0 };
  }
  let low = 0;
  let high = content.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (estimateTextTokens(content.slice(middle)) <= maximumTokens) high = middle;
    else low = middle + 1;
  }
  let start = Math.min(low, content.length - 1);
  const boundaryLimit = Math.min(
    content.length,
    start + Math.max(1, Math.floor((content.length - start) * 0.3))
  );
  for (let index = start; index < boundaryLimit; index += 1) {
    if (/\n/u.test(content[index] ?? "") || /[。！？；.!?;]/u.test(content[index] ?? "")) {
      start = index + 1;
      break;
    }
  }
  return { text: content.slice(start).trim(), start };
}

export interface StructuralParentDigest {
  content: string;
  truncated: boolean;
}

/**
 * Builds a compact digest of the parent answer for follow-up turns: the
 * opening conclusion (answers are prompted to lead with the conclusion) plus
 * the tail where the previous answer left off. The middle stays available via
 * request_context, so continuation keeps its anchor without paying full-text
 * tokens on every turn.
 */
export function createStructuralParentDigest(
  content: string
): StructuralParentDigest {
  const trimmed = content.trim();
  if (
    estimateTextTokens(trimmed) <= DIGEST_HEAD_MAX_TOKENS + DIGEST_TAIL_MAX_TOKENS
  ) {
    return { content: trimmed, truncated: false };
  }
  const head = clipPrefixToTokens(trimmed, DIGEST_HEAD_MAX_TOKENS);
  const tail = clipSuffixToTokens(trimmed, DIGEST_TAIL_MAX_TOKENS);
  if (tail.start <= head.consumed) {
    return { content: trimmed, truncated: false };
  }
  return {
    content: `${head.text}\n\n……（中略，可通过 request_context 获取更早内容）……\n\n${tail.text}`,
    truncated: true
  };
}
