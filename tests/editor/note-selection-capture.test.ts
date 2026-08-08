// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { ConversationSessionStore } from "../../src/state/conversation-session-store";
import {
  captureNoteSelection,
  installNoteSelectionCapture,
  type MarkdownSelectionSource
} from "../../src/editor/note-selection-capture";
import { validConversation } from "../fixtures";

function sourceEditorSelection(): MarkdownSelectionSource {
  const contentEl = document.createElement("div");
  const text = "第一段\n网络层负责寻址与路由选择\n最后一段";
  return {
    filePath: "课程/网络分层.md",
    fileName: "网络分层.md",
    mode: "source",
    contentEl,
    editor: {
      getSelection: () => "网络层负责寻址与路由选择",
      getCursor: (which: "from" | "to") =>
        which === "from" ? { line: 1, ch: 0 } : { line: 1, ch: 12 },
      posToOffset: (position: { line: number; ch: number }) =>
        position.line === 1 ? 4 + position.ch : position.ch,
      getValue: () => text
    }
  };
}

describe("note selection capture", () => {
  it("extracts exact source offsets from editing and live-preview editors", async () => {
    const context = await captureNoteSelection(sourceEditorSelection());

    expect(context).toMatchObject({
      sourceType: "note",
      filePath: "课程/网络分层.md",
      basis: "note-source-v1",
      startOffset: 4,
      endOffset: 16,
      quote: "网络层负责寻址与路由选择"
    });
  });

  it("extracts a reading-mode selection only inside the current preview", async () => {
    const contentEl = document.createElement("div");
    contentEl.innerHTML = "<p>第一段</p><p><strong>网络层</strong>负责寻址</p>";
    document.body.append(contentEl);
    const strongText = contentEl.querySelector("strong")?.firstChild;
    const paragraphText = contentEl.querySelectorAll("p")[1]?.lastChild;
    if (strongText === undefined || strongText === null || paragraphText === undefined || paragraphText === null) {
      throw new Error("Preview fixture is missing");
    }
    const range = document.createRange();
    range.setStart(strongText, 0);
    range.setEnd(paragraphText, paragraphText.textContent?.length ?? 0);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const context = await captureNoteSelection({
      filePath: "课程/网络分层.md",
      fileName: "网络分层.md",
      mode: "preview",
      contentEl,
      loadSourceText: async () =>
        "---\ntags: [network]\n---\n第一段\n\n**网络层**负责寻址"
    });

    expect(context).toMatchObject({
      basis: "note-rendered-text-v1",
      quote: "网络层负责寻址"
    });
    expect(context?.snapshot?.content).toBe(
      "第一段\n\n**网络层**负责寻址"
    );
    expect(
      context?.snapshot?.content.slice(
        context.snapshot.selectionStartOffset,
        context.snapshot.selectionEndOffset
      )
    ).toContain("网络层");
    contentEl.remove();
  });

  it("returns no context for collapsed or outside-note selections", async () => {
    const source = sourceEditorSelection();
    if (source.editor === undefined) throw new Error("Editor fixture is missing");
    source.editor.getSelection = () => "";
    expect(await captureNoteSelection(source)).toBeUndefined();

    const contentEl = document.createElement("div");
    contentEl.textContent = "inside";
    const outside = document.createElement("p");
    outside.textContent = "outside";
    document.body.append(contentEl, outside);
    const range = document.createRange();
    range.selectNodeContents(outside);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    expect(
      await captureNoteSelection({
        filePath: "note.md",
        fileName: "note.md",
        mode: "preview",
        contentEl
      })
    ).toBeUndefined();
    contentEl.remove();
    outside.remove();
  });

  it("adds the note selection to the current draft and ignores TreeTalk targets", async () => {
    const store = new ConversationSessionStore(validConversation());
    const note = sourceEditorSelection();
    note.contentEl.className = "markdown-source-view";
    document.body.append(note.contentEl);
    const treetalk = document.createElement("div");
    treetalk.className = "treetalk-root";
    document.body.append(treetalk);
    const getSource = vi.fn(() => note);
    const cleanup = installNoteSelectionCapture({
      document,
      store,
      getActiveSource: getSource,
      now: () => "2026-07-30T00:00:00.000Z"
    });

    note.contentEl.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await vi.waitFor(() =>
      expect(store.getSnapshot().nodes.child?.draft.selectionContexts).toHaveLength(1)
    );
    treetalk.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await Promise.resolve();

    expect(store.getSnapshot().nodes.child?.draft.selectionContexts).toHaveLength(1);
    cleanup();
    note.contentEl.remove();
    treetalk.remove();
  });

  it("does not mutate archived conversations", async () => {
    const conversation = validConversation();
    conversation.status = "archived";
    const store = new ConversationSessionStore(conversation);
    const note = sourceEditorSelection();
    document.body.append(note.contentEl);
    const cleanup = installNoteSelectionCapture({
      document,
      store,
      getActiveSource: () => note,
      now: () => "2026-07-30T00:00:00.000Z"
    });

    note.contentEl.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await Promise.resolve();

    expect(store.getSnapshot().nodes.child?.draft.selectionContexts).toEqual([]);
    cleanup();
    note.contentEl.remove();
  });

  it("does not attach an async selection after the active node changes", async () => {
    const store = new ConversationSessionStore(validConversation());
    const note = sourceEditorSelection();
    document.body.append(note.contentEl);
    let release: (() => void) | undefined;
    const hashReady = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cleanup = installNoteSelectionCapture({
      document,
      store,
      getActiveSource: () => note,
      now: () => "2026-07-30T00:00:00.000Z",
      captureSelection: async (source) => {
        await hashReady;
        return captureNoteSelection(source);
      }
    });

    note.contentEl.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    store.selectNode("root");
    release?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(store.getSnapshot().nodes.child?.draft.selectionContexts).toEqual([]);
    cleanup();
    note.contentEl.remove();
  });
});
