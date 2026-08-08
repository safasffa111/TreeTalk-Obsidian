import type { SelectionAnchor } from "./types";

export interface ResolvedSelection {
  status: "resolved";
  start: number;
  end: number;
}

export interface UnresolvedSelection {
  status: "unresolved";
  quote: string;
}

const CONTEXT_LENGTH = 32;

export interface CreateSelectionAnchorInput {
  messageId: string;
  sourceNodeId: string;
  sourceRole: "user" | "assistant";
  visibleText: string;
  startOffset: number;
  endOffset: number;
  quoteOverride?: string;
}

async function sha256(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export async function createSelectionAnchor(
  input: CreateSelectionAnchorInput
): Promise<SelectionAnchor> {
  const {
    messageId,
    sourceNodeId,
    sourceRole,
    visibleText,
    startOffset,
    endOffset
  } = input;
  const validRange =
    Number.isInteger(startOffset) &&
    Number.isInteger(endOffset) &&
    startOffset >= 0 &&
    endOffset <= visibleText.length &&
    startOffset < endOffset;
  if (!validRange) {
    throw new RangeError("Selection range is invalid");
  }
  const visibleQuote = visibleText.slice(startOffset, endOffset);
  const quote = input.quoteOverride ?? visibleQuote;
  const anchor: SelectionAnchor = {
    messageId,
    sourceNodeId,
    sourceRole,
    basis: "rendered-text-v1",
    startOffset,
    endOffset,
    quote,
    prefix: visibleText.slice(
      Math.max(0, startOffset - CONTEXT_LENGTH),
      startOffset
    ),
    suffix: visibleText.slice(endOffset, endOffset + CONTEXT_LENGTH),
    contentHash: await sha256(visibleText)
  };
  if (quote !== visibleQuote) anchor.visibleQuote = visibleQuote;
  return anchor;
}

function commonSuffixLength(left: string, right: string): number {
  const maximum = Math.min(left.length, right.length);
  let matched = 0;
  while (
    matched < maximum &&
    left[left.length - 1 - matched] === right[right.length - 1 - matched]
  ) {
    matched += 1;
  }
  return matched;
}

function commonPrefixLength(left: string, right: string): number {
  const maximum = Math.min(left.length, right.length);
  let matched = 0;
  while (matched < maximum && left[matched] === right[matched]) {
    matched += 1;
  }
  return matched;
}

interface Candidate {
  start: number;
  end: number;
  contextScore: number;
  distance: number;
}

export function resolveSelectionAnchor(
  content: string,
  anchor: SelectionAnchor
): ResolvedSelection | UnresolvedSelection {
  const visibleQuote = anchor.visibleQuote ?? anchor.quote;
  if (content.slice(anchor.startOffset, anchor.endOffset) === visibleQuote) {
    return {
      status: "resolved",
      start: anchor.startOffset,
      end: anchor.endOffset
    };
  }

  const candidates: Candidate[] = [];
  let searchFrom = 0;
  while (searchFrom <= content.length - visibleQuote.length) {
    const start = content.indexOf(visibleQuote, searchFrom);
    if (start < 0) break;
    const end = start + visibleQuote.length;
    const before = content.slice(Math.max(0, start - anchor.prefix.length), start);
    const after = content.slice(end, end + anchor.suffix.length);
    candidates.push({
      start,
      end,
      contextScore:
        commonSuffixLength(anchor.prefix, before) + commonPrefixLength(anchor.suffix, after),
      distance: Math.abs(start - anchor.startOffset)
    });
    searchFrom = start + Math.max(1, visibleQuote.length);
  }

  candidates.sort(
    (left, right) =>
      right.contextScore - left.contextScore ||
      left.distance - right.distance ||
      left.start - right.start
  );
  const best = candidates[0];
  if (best === undefined) {
    return { status: "unresolved", quote: anchor.quote };
  }
  const second = candidates[1];
  if (
    second !== undefined &&
    second.contextScore === best.contextScore &&
    second.distance === best.distance
  ) {
    return { status: "unresolved", quote: anchor.quote };
  }
  return {
    status: "resolved",
    start: best.start,
    end: best.end
  };
}
