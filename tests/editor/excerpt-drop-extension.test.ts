// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleExcerptDrop
} from "../../src/editor/excerpt-drop-extension";
import {
  serializeExcerptPayload,
  TREETALK_EXCERPT_MIME,
  type TreeTalkExcerptDragPayload
} from "../../src/knowledge/excerpt-drag";

const payload: TreeTalkExcerptDragPayload = {
  version: 1,
  conversationId: "conversation-1",
  conversationTitle: "TCP",
  nodeId: "node-1",
  nodeTitle: "ACK",
  messageId: "message-1",
  sourceRole: "assistant",
  quote: "ACK confirms delivery."
};

const views: EditorView[] = [];

function dropEvent(serialized?: string): {
  event: DragEvent;
  preventDefault: ReturnType<typeof vi.fn>;
} {
  const preventDefault = vi.fn();
  return {
    event: {
      clientX: 10,
      clientY: 10,
      preventDefault,
      dataTransfer: {
        getData: (type: string) =>
          type === TREETALK_EXCERPT_MIME ? serialized ?? "" : ""
      }
    } as unknown as DragEvent,
    preventDefault
  };
}

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
});

describe("excerpt editor drop", () => {
  it("inserts the callout at the exact drop position and moves the cursor after it", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      state: EditorState.create({ doc: "beforeafter" }),
      parent
    });
    views.push(view);
    vi.spyOn(view, "posAtCoords").mockReturnValue(6);
    const { event, preventDefault } = dropEvent(
      serializeExcerptPayload(payload)
    );

    expect(handleExcerptDrop(view, event)).toBe(true);

    const expectedStart = "before\n\n> [!quote] TreeTalk 摘录";
    expect(view.state.doc.toString()).toContain(expectedStart);
    expect(view.state.doc.toString()).toContain(
      "[返回 TreeTalk 来源](obsidian://treetalk-open?"
    );
    expect(view.state.doc.toString()).toMatch(/\n\nafter$/u);
    expect(view.state.selection.main.head).toBe(
      view.state.doc.length - "after".length
    );
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it("leaves non-TreeTalk and malformed drops to the editor", () => {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      state: EditorState.create({ doc: "unchanged" }),
      parent
    });
    views.push(view);
    vi.spyOn(view, "posAtCoords").mockReturnValue(3);
    const absent = dropEvent();
    const malformed = dropEvent("{bad");

    expect(handleExcerptDrop(view, absent.event)).toBe(false);
    expect(handleExcerptDrop(view, malformed.event)).toBe(false);
    expect(view.state.doc.toString()).toBe("unchanged");
    expect(absent.preventDefault).not.toHaveBeenCalled();
    expect(malformed.preventDefault).not.toHaveBeenCalled();
  });
});
