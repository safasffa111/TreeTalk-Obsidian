import { describe, expect, it } from "vitest";
import {
  appendDraftContext,
  removeDraftContext,
  selectionContextKey
} from "../../src/domain/draft-contexts";
import type { NoteSelectionContext, SelectionAnchor } from "../../src/domain/types";

function anchor(
  overrides: Partial<SelectionAnchor> = {}
): SelectionAnchor {
  return {
    messageId: "message-1",
    sourceNodeId: "node-1",
    sourceRole: "assistant",
    basis: "rendered-text-v1",
    startOffset: 2,
    endOffset: 8,
    quote: "quoted",
    prefix: "before",
    suffix: "after",
    contentHash: "hash",
    ...overrides
  };
}

function noteContext(
  overrides: Partial<NoteSelectionContext> = {}
): NoteSelectionContext {
  return {
    sourceType: "note",
    filePath: "课程/网络分层.md",
    fileName: "网络分层.md",
    basis: "note-source-v1",
    startOffset: 10,
    endOffset: 14,
    quote: "网络层",
    prefix: "before",
    suffix: "after",
    contentHash: "note-hash",
    ...overrides
  };
}

describe("draft contexts", () => {
  it("deduplicates the same source range while preserving distinct insertion order", () => {
    const first = anchor();
    const second = anchor({
      messageId: "message-2",
      startOffset: 0,
      endOffset: 4,
      quote: "next"
    });

    expect(appendDraftContext([first, second], first)).toEqual([
      first,
      second
    ]);
  });

  it("keeps message and note contexts distinct and deduplicates each source range", () => {
    const message = anchor();
    const note = noteContext();

    expect(appendDraftContext([message, note], note)).toEqual([message, note]);
    expect(selectionContextKey(message)).not.toBe(selectionContextKey(note));
  });

  it("treats changed note snapshots as distinct draft contexts", () => {
    const first = noteContext({
      snapshot: {
        version: "note-snapshot-v1",
        content: "旧内容",
        contentHash: "old-snapshot",
        selectionStartOffset: 0,
        selectionEndOffset: 3
      }
    });
    const second = noteContext({
      snapshot: {
        version: "note-snapshot-v1",
        content: "新内容",
        contentHash: "new-snapshot",
        selectionStartOffset: 0,
        selectionEndOffset: 3
      }
    });

    expect(appendDraftContext([first], second)).toEqual([first, second]);
  });

  it("removes only the context matching the stable key", () => {
    const first = anchor();
    const second = anchor({ messageId: "message-2", quote: "next" });

    expect(
      removeDraftContext([first, second], selectionContextKey(first))
    ).toEqual([second]);
  });
});
