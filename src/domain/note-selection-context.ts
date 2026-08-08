import { createNoteSnapshot, sha256Hex } from "./note-snapshot";
import type { NoteSelectionContext } from "./types";

const CONTEXT_LENGTH = 32;

export interface CreateNoteSelectionContextInput {
  filePath: string;
  fileName: string;
  basis: NoteSelectionContext["basis"];
  visibleText: string;
  sourceText?: string;
  startOffset: number;
  endOffset: number;
}

export async function createNoteSelectionContext(
  input: CreateNoteSelectionContextInput
): Promise<NoteSelectionContext> {
  const { visibleText, startOffset, endOffset } = input;
  const validRange =
    Number.isInteger(startOffset) &&
    Number.isInteger(endOffset) &&
    startOffset >= 0 &&
    endOffset <= visibleText.length &&
    startOffset < endOffset;
  if (!validRange) {
    throw new RangeError("Note selection range is invalid");
  }
  const quote = visibleText.slice(startOffset, endOffset);
  const context: NoteSelectionContext = {
    sourceType: "note",
    filePath: input.filePath,
    fileName: input.fileName,
    basis: input.basis,
    startOffset,
    endOffset,
    quote,
    prefix: visibleText.slice(
      Math.max(0, startOffset - CONTEXT_LENGTH),
      startOffset
    ),
    suffix: visibleText.slice(endOffset, endOffset + CONTEXT_LENGTH),
    contentHash: await sha256Hex(visibleText)
  };
  const sourceText = input.sourceText ?? visibleText;
  context.snapshot = await createNoteSnapshot({
    sourceText,
    quote,
    basis: input.basis,
    sourceStartOffset: startOffset,
    sourceEndOffset: endOffset
  });
  return context;
}
