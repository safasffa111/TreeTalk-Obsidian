import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  parseExcerptPayload,
  renderExcerptCallout,
  TREETALK_EXCERPT_MIME
} from "../knowledge/excerpt-drag";

function insertAtBlockBoundary(
  document: string,
  position: number,
  block: string
): string {
  const before = document.slice(0, position);
  const after = document.slice(position);
  const prefix =
    before.length === 0
      ? ""
      : before.endsWith("\n\n")
        ? ""
        : before.endsWith("\n")
          ? "\n"
          : "\n\n";
  const suffix =
    after.length === 0
      ? ""
      : after.startsWith("\n\n")
        ? ""
        : after.startsWith("\n")
          ? "\n"
          : "\n\n";
  return `${prefix}${block}${suffix}`;
}

export function handleExcerptDrop(
  view: EditorView,
  event: DragEvent
): boolean {
  const serialized = event.dataTransfer?.getData(TREETALK_EXCERPT_MIME);
  if (serialized === undefined || serialized.length === 0) return false;
  const payload = parseExcerptPayload(serialized);
  if (payload === undefined) return false;
  const position = view.posAtCoords({
    x: event.clientX,
    y: event.clientY
  });
  if (position === null) return false;
  const inserted = insertAtBlockBoundary(
    view.state.doc.toString(),
    position,
    renderExcerptCallout(payload)
  );
  view.dispatch({
    changes: { from: position, insert: inserted },
    selection: { anchor: position + inserted.length }
  });
  event.preventDefault();
  return true;
}

export function createExcerptDropExtension(): Extension {
  return EditorView.domEventHandlers({
    drop: (event, view) => handleExcerptDrop(view, event)
  });
}
