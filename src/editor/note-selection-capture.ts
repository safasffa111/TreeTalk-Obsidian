import { addSelectionToDraft } from "../domain/tree-commands";
import { createNoteSelectionContext } from "../domain/note-selection-context";
import type { NoteSelectionContext } from "../domain/types";
import type { ConversationStorePort } from "../tabs/active-conversation-store";
import { mapRenderedText, offsetsForDomRange } from "../views/rendered-selection";

export interface EditorPositionLike {
  line: number;
  ch: number;
}

export interface NoteEditorSelectionPort {
  getSelection(): string;
  getCursor(which: "from" | "to"): EditorPositionLike;
  posToOffset(position: EditorPositionLike): number;
  getValue(): string;
}

export interface MarkdownSelectionSource {
  filePath: string;
  fileName: string;
  mode: "source" | "preview";
  contentEl: HTMLElement;
  editor?: NoteEditorSelectionPort;
  loadSourceText?: () => Promise<string>;
}

export async function captureNoteSelection(
  source: MarkdownSelectionSource,
  domSelection: Selection | null =
    source.contentEl.ownerDocument.defaultView?.getSelection() ?? null
): Promise<NoteSelectionContext | undefined> {
  if (source.mode === "source") {
    const editor = source.editor;
    if (editor === undefined || editor.getSelection().trim().length === 0) {
      return undefined;
    }
    const visibleText = editor.getValue();
    const startOffset = editor.posToOffset(editor.getCursor("from"));
    const endOffset = editor.posToOffset(editor.getCursor("to"));
    if (visibleText.slice(startOffset, endOffset).trim().length === 0) {
      return undefined;
    }
    return createNoteSelectionContext({
      filePath: source.filePath,
      fileName: source.fileName,
      basis: "note-source-v1",
      visibleText,
      sourceText: visibleText,
      startOffset,
      endOffset
    });
  }

  if (
    domSelection === null ||
    domSelection.rangeCount === 0 ||
    domSelection.isCollapsed
  ) {
    return undefined;
  }
  const range = domSelection.getRangeAt(0);
  if (
    !source.contentEl.contains(range.startContainer) ||
    !source.contentEl.contains(range.endContainer)
  ) {
    return undefined;
  }
  const map = mapRenderedText(source.contentEl);
  const offsets = offsetsForDomRange(map, range);
  if (
    offsets === undefined ||
    map.text.slice(offsets.start, offsets.end).trim().length === 0
  ) {
    return undefined;
  }
  let sourceText: string | undefined;
  try {
    sourceText = await source.loadSourceText?.();
  } catch {
    // The rendered note text is still a stable fallback if the file changes mid-capture.
  }
  return createNoteSelectionContext({
    filePath: source.filePath,
    fileName: source.fileName,
    basis: "note-rendered-text-v1",
    visibleText: map.text,
    ...(sourceText === undefined ? {} : { sourceText }),
    startOffset: offsets.start,
    endOffset: offsets.end
  });
}

export interface NoteSelectionCaptureOptions {
  document: Document;
  store: ConversationStorePort;
  getActiveSource(): MarkdownSelectionSource | undefined;
  now(): string;
  captureSelection?(
    source: MarkdownSelectionSource
  ): Promise<NoteSelectionContext | undefined>;
}

function eventNode(event: Event): Node | undefined {
  const target = event.target;
  return target !== null && typeof target === "object" && "nodeType" in target
    ? (target as Node)
    : undefined;
}

function eventElement(node: Node): Element | undefined {
  return node.nodeType === Node.ELEMENT_NODE
    ? (node as Element)
    : node.parentElement ?? undefined;
}

function isTreeTalkTarget(node: Node): boolean {
  return (
    eventElement(node)?.closest(
      ".treetalk-root, .treetalk-workspace, .treetalk-view-content"
    ) !== null
  );
}

export function installNoteSelectionCapture(
  options: NoteSelectionCaptureOptions
): () => void {
  let keyboardTimer: ReturnType<typeof setTimeout> | undefined;

  const capture = async (event: Event): Promise<void> => {
    const target = eventNode(event);
    if (target === undefined || isTreeTalkTarget(target)) return;
    const source = options.getActiveSource();
    if (source === undefined || !source.contentEl.contains(target)) return;
    const snapshot = options.store.getSnapshot();
    if (
      snapshot === undefined ||
      snapshot.status !== "active" ||
      !(options.store.canMutate?.() ?? true)
    ) {
      return;
    }
    const conversationId = snapshot.id;
    const nodeId = snapshot.currentNodeId;
    const context = await (
      options.captureSelection?.(source) ?? captureNoteSelection(source)
    );
    if (context === undefined) return;
    try {
      options.store.update((current) => {
        if (
          current.id !== conversationId ||
          current.currentNodeId !== nodeId ||
          current.status !== "active"
        ) {
          return current;
        }
        return addSelectionToDraft(current, nodeId, context, options.now());
      });
    } catch {
      // The active tab can become read-only or close while hashing the selection.
    }
  };

  const onMouseUp = (event: MouseEvent): void => {
    void capture(event);
  };
  const onKeyUp = (event: KeyboardEvent): void => {
    if (!event.shiftKey) return;
    if (keyboardTimer !== undefined) clearTimeout(keyboardTimer);
    keyboardTimer = setTimeout(() => {
      keyboardTimer = undefined;
      void capture(event);
    }, 120);
  };

  options.document.addEventListener("mouseup", onMouseUp);
  options.document.addEventListener("keyup", onKeyUp);
  return () => {
    if (keyboardTimer !== undefined) clearTimeout(keyboardTimer);
    options.document.removeEventListener("mouseup", onMouseUp);
    options.document.removeEventListener("keyup", onKeyUp);
  };
}
