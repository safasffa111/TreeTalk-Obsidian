import type { MessageRole, SelectionAnchor } from "../domain/types";

export const TREETALK_EXCERPT_MIME =
  "application/x-treetalk-excerpt+json";

interface TreeTalkExcerptDragPayloadBase {
  conversationId: string;
  conversationTitle: string;
  nodeId: string;
  nodeTitle: string;
  messageId: string;
  sourceRole: MessageRole;
  quote: string;
}

export interface TreeTalkExcerptDragPayloadV1
  extends TreeTalkExcerptDragPayloadBase {
  version: 1;
}

export interface TreeTalkExcerptDragPayloadV2
  extends TreeTalkExcerptDragPayloadBase {
  version: 2;
  anchor: SelectionAnchor;
}

export type TreeTalkExcerptDragPayload =
  | TreeTalkExcerptDragPayloadV1
  | TreeTalkExcerptDragPayloadV2;

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isIntegerOffset(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function validatedAnchor(value: unknown): SelectionAnchor | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const source = value as Record<string, unknown>;
  if (
    !nonEmptyString(source.messageId) ||
    !nonEmptyString(source.sourceNodeId) ||
    (source.sourceRole !== "user" && source.sourceRole !== "assistant") ||
    source.basis !== "rendered-text-v1" ||
    !isIntegerOffset(source.startOffset) ||
    !isIntegerOffset(source.endOffset) ||
    source.startOffset >= source.endOffset ||
    !nonEmptyString(source.quote) ||
    typeof source.prefix !== "string" ||
    typeof source.suffix !== "string" ||
    !nonEmptyString(source.contentHash) ||
    (source.visibleQuote !== undefined &&
      typeof source.visibleQuote !== "string")
  ) {
    return undefined;
  }
  const anchor: SelectionAnchor = {
    messageId: source.messageId,
    sourceNodeId: source.sourceNodeId,
    sourceRole: source.sourceRole,
    basis: "rendered-text-v1",
    startOffset: source.startOffset,
    endOffset: source.endOffset,
    quote: source.quote,
    prefix: source.prefix,
    suffix: source.suffix,
    contentHash: source.contentHash
  };
  if (source.visibleQuote !== undefined) {
    anchor.visibleQuote = source.visibleQuote;
  }
  return anchor;
}

function validatedBase(
  source: Record<string, unknown>
): TreeTalkExcerptDragPayloadBase | undefined {
  if (
    !nonEmptyString(source.conversationId) ||
    !nonEmptyString(source.conversationTitle) ||
    !nonEmptyString(source.nodeId) ||
    !nonEmptyString(source.nodeTitle) ||
    !nonEmptyString(source.messageId) ||
    (source.sourceRole !== "user" && source.sourceRole !== "assistant") ||
    !nonEmptyString(source.quote)
  ) {
    return undefined;
  }
  return {
    conversationId: source.conversationId,
    conversationTitle: source.conversationTitle,
    nodeId: source.nodeId,
    nodeTitle: source.nodeTitle,
    messageId: source.messageId,
    sourceRole: source.sourceRole,
    quote: source.quote
  };
}

function validatedPayload(value: unknown): TreeTalkExcerptDragPayload | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const source = value as Record<string, unknown>;
  const base = validatedBase(source);
  if (base === undefined) return undefined;
  if (source.version === 1) {
    return { version: 1, ...base };
  }
  if (source.version !== 2) return undefined;
  const anchor = validatedAnchor(source.anchor);
  if (
    anchor === undefined ||
    anchor.messageId !== base.messageId ||
    anchor.sourceNodeId !== base.nodeId ||
    anchor.sourceRole !== base.sourceRole
  ) {
    return undefined;
  }
  return { version: 2, ...base, anchor };
}

function bytesToBinary(bytes: Uint8Array): string {
  const chunks: string[] = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(
      String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
    );
  }
  return chunks.join("");
}

function binaryToBytes(binary: string): Uint8Array {
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function encodeSourceAnchor(anchor: SelectionAnchor): string {
  const validated = validatedAnchor(anchor);
  if (validated === undefined) {
    throw new TypeError("TreeTalk selection anchor is invalid");
  }
  const json = JSON.stringify(validated);
  return btoa(bytesToBinary(new TextEncoder().encode(json)))
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/gu, "");
}

export function decodeSourceAnchor(value: string): SelectionAnchor | undefined {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return undefined;
  try {
    const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/");
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      "="
    );
    const json = new TextDecoder().decode(binaryToBytes(atob(padded)));
    return validatedAnchor(JSON.parse(json) as unknown);
  } catch {
    return undefined;
  }
}

export function serializeExcerptPayload(
  payload: TreeTalkExcerptDragPayload
): string {
  const validated = validatedPayload(payload);
  if (validated === undefined) {
    throw new TypeError("TreeTalk excerpt payload is invalid");
  }
  return JSON.stringify(validated);
}

export function parseExcerptPayload(
  value: string
): TreeTalkExcerptDragPayload | undefined {
  try {
    return validatedPayload(JSON.parse(value) as unknown);
  } catch {
    return undefined;
  }
}

export function writeExcerptDragData(
  dataTransfer: DataTransfer,
  payload: TreeTalkExcerptDragPayload
): void {
  dataTransfer.setData(
    TREETALK_EXCERPT_MIME,
    serializeExcerptPayload(payload)
  );
  dataTransfer.setData("text/plain", payload.quote);
}

export function renderExcerptCallout(
  payload: TreeTalkExcerptDragPayload
): string {
  const validated = validatedPayload(payload);
  if (validated === undefined) {
    throw new TypeError("TreeTalk excerpt payload is invalid");
  }
  const parameters = new URLSearchParams({
    conversationId: validated.conversationId,
    nodeId: validated.nodeId,
    messageId: validated.messageId
  });
  if (validated.version === 2) {
    parameters.set("anchor", encodeSourceAnchor(validated.anchor));
  }
  const quoteLines = validated.quote
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => (line.length === 0 ? ">" : `> ${line}`));
  return [
    "> [!quote] TreeTalk 摘录",
    ...quoteLines,
    ">",
    `> [返回 TreeTalk 来源](obsidian://treetalk-open?${parameters.toString()})`
  ].join("\n");
}
