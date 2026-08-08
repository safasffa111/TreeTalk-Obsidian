import {
  isNoteSelectionContext,
  type SelectionContext
} from "./types";

export function selectionContextKey(context: SelectionContext): string {
  if (isNoteSelectionContext(context)) {
    return [
      "note",
      context.filePath,
      context.basis,
      context.startOffset,
      context.endOffset,
      context.quote,
      context.snapshot?.contentHash ?? context.contentHash
    ].join(":");
  }
  return [
    "message",
    context.messageId,
    context.startOffset,
    context.endOffset,
    context.quote
  ].join(":");
}

export function appendDraftContext(
  contexts: SelectionContext[],
  context: SelectionContext
): SelectionContext[] {
  const key = selectionContextKey(context);
  if (contexts.some((entry) => selectionContextKey(entry) === key)) {
    return [...contexts];
  }
  return [...contexts, structuredClone(context)];
}

export function removeDraftContext(
  contexts: SelectionContext[],
  key: string
): SelectionContext[] {
  return contexts
    .filter((entry) => selectionContextKey(entry) !== key)
    .map((entry) => structuredClone(entry));
}
