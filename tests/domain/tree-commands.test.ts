import { describe, expect, it } from "vitest";
import {
  addSelectionToDraft,
  continueNode,
  prepareChildDraft,
  prepareSelectionChildDraft,
  removeSelectionFromDraft,
  revertTreeCommand,
  submitChildDraft,
  toggleBranchDraft
} from "../../src/domain/tree-commands";
import { selectionContextKey } from "../../src/domain/draft-contexts";
import { createConversation } from "../../src/domain/conversation-factory";
import type { NoteSelectionContext, SelectionAnchor } from "../../src/domain/types";
import { NOW, requireNode, validConversation } from "../fixtures";

const selection: SelectionAnchor = {
  messageId: "assistant-1",
  sourceNodeId: "child",
  sourceRole: "assistant",
  basis: "rendered-text-v1",
  startOffset: 0,
  endOffset: 4,
  quote: "选区内容",
  prefix: "",
  suffix: "",
  contentHash: "hash"
};

describe("tree commands", () => {
  it("names a new conversation and its root from the first question", () => {
    const before = createConversation();

    const result = continueNode(before, {
      nodeId: before.rootNodeId,
      text: "  第一行标题\n第二行不进入标题  ",
      messageId: "first-message",
      now: NOW
    });

    expect(result.state.title).toBe("第一行标题");
    const root = requireNode(result.state, result.state.rootNodeId);
    expect(root.title).toBe("第一行标题");
    expect(root.titleSource).toBe("question");
  });

  it("limits the first-question title to 80 characters", () => {
    const before = createConversation();
    const question = "问".repeat(100);

    const result = continueNode(before, {
      nodeId: before.rootNodeId,
      text: question,
      messageId: "first-message",
      now: NOW
    });

    expect(result.state.title).toBe("问".repeat(80));
  });

  it("does not rename a conversation after its first question", () => {
    const before = createConversation();
    const first = continueNode(before, {
      nodeId: before.rootNodeId,
      text: "最初的问题",
      messageId: "first-message",
      now: NOW
    });

    const second = continueNode(first.state, {
      nodeId: first.state.rootNodeId,
      text: "后续问题不能改名",
      messageId: "second-message",
      now: NOW
    });

    expect(second.state.title).toBe("最初的问题");
    expect(requireNode(second.state, second.state.rootNodeId).title).toBe(
      "最初的问题"
    );
  });

  it("names an empty conversation when its first question creates a child", () => {
    const before = createConversation();
    const prepared = prepareChildDraft(before, {
      nodeId: before.rootNodeId,
      now: NOW
    });

    const submitted = submitChildDraft(prepared, {
      text: "第一个分支问题",
      childId: "first-child",
      messageId: "first-message",
      now: NOW
    });

    expect(submitted.state.title).toBe("第一个分支问题");
    expect(
      requireNode(submitted.state, submitted.state.rootNodeId).title
    ).toBe("第一个分支问题");
    expect(requireNode(submitted.state, "first-child").titleSource).toBe(
      "question"
    );
  });

  it("restores the temporary title when the first root question is reverted", () => {
    const before = createConversation();
    const submitted = continueNode(before, {
      nodeId: before.rootNodeId,
      text: "会被撤销的问题",
      messageId: "first-message",
      now: NOW
    });

    const reverted = revertTreeCommand(submitted.state, submitted.operation);

    expect(reverted.title).toBe("新对话");
    expect(requireNode(reverted, reverted.rootNodeId).title).toBe("新对话");
  });

  it("restores the temporary title when the first child question is reverted", () => {
    const before = createConversation();
    const prepared = prepareChildDraft(before, {
      nodeId: before.rootNodeId,
      now: NOW
    });
    const submitted = submitChildDraft(prepared, {
      text: "会被撤销的分支",
      childId: "first-child",
      messageId: "first-message",
      now: NOW
    });

    const reverted = revertTreeCommand(submitted.state, submitted.operation);

    expect(reverted.title).toBe("新对话");
    expect(requireNode(reverted, reverted.rootNodeId).title).toBe("新对话");
  });

  it("continues the current node without creating a child", () => {
    const before = validConversation();

    const result = continueNode(before, {
      nodeId: "child",
      text: "继续",
      messageId: "message-1",
      now: NOW
    });

    expect(Object.keys(result.state.nodes)).toHaveLength(2);
    expect(requireNode(result.state, "child").messages.at(-1)?.content).toBe("继续");
    expect(result.state.currentNodeId).toBe("child");
  });

  it("prepares a child draft without creating a node", () => {
    const selected = addSelectionToDraft(
      validConversation(),
      "child",
      selection,
      NOW
    );
    const prepared = prepareChildDraft(selected, {
      nodeId: "child",
      now: NOW
    });

    expect(Object.keys(prepared.nodes)).toHaveLength(2);
    expect(requireNode(prepared, "child").draft).toMatchObject({
      mode: "child",
      selectionContexts: [selection]
    });
  });

  it("adds distinct contexts without forcing child mode or creating nodes", () => {
    const second = {
      ...selection,
      messageId: "assistant-2",
      quote: "second"
    };
    const once = addSelectionToDraft(
      validConversation(),
      "child",
      selection,
      NOW
    );
    const twice = addSelectionToDraft(once, "child", second, NOW);
    const duplicate = addSelectionToDraft(twice, "child", selection, NOW);

    expect(Object.keys(duplicate.nodes)).toHaveLength(2);
    expect(requireNode(duplicate, "child").draft).toMatchObject({
      mode: "continue",
      selectionContexts: [selection, second]
    });
  });

  it("removes only the selected draft context", () => {
    const second = {
      ...selection,
      messageId: "assistant-2",
      quote: "second"
    };
    const once = addSelectionToDraft(
      validConversation(),
      "child",
      selection,
      NOW
    );
    const twice = addSelectionToDraft(once, "child", second, NOW);
    const removed = removeSelectionFromDraft(
      twice,
      "child",
      selectionContextKey(selection),
      NOW
    );

    expect(requireNode(removed, "child").draft.selectionContexts).toEqual([
      second
    ]);
  });

  it("restores continue mode after the final message selection is removed", () => {
    const selected = addSelectionToDraft(
      validConversation(),
      "child",
      selection,
      NOW
    );
    const prepared = prepareSelectionChildDraft(selected, {
      nodeId: "child",
      now: NOW
    });

    expect(requireNode(prepared, "child").draft).toMatchObject({
      mode: "child",
      selectionModeBeforeCapture: "continue"
    });

    const removed = removeSelectionFromDraft(
      prepared,
      "child",
      selectionContextKey(selection),
      NOW
    );

    expect(requireNode(removed, "child").draft.mode).toBe("continue");
    expect(
      requireNode(removed, "child").draft.selectionModeBeforeCapture
    ).toBeUndefined();
  });

  it("restores an existing child mode after the final message selection is removed", () => {
    const manuallyPrepared = prepareChildDraft(validConversation(), {
      nodeId: "child",
      now: NOW
    });
    const selected = addSelectionToDraft(
      manuallyPrepared,
      "child",
      selection,
      NOW
    );
    const prepared = prepareSelectionChildDraft(selected, {
      nodeId: "child",
      now: NOW
    });

    expect(
      requireNode(prepared, "child").draft.selectionModeBeforeCapture
    ).toBe("child");

    const removed = removeSelectionFromDraft(
      prepared,
      "child",
      selectionContextKey(selection),
      NOW
    );

    expect(requireNode(removed, "child").draft.mode).toBe("child");
  });

  it("manual branch toggling takes ownership away from selection restoration", () => {
    const selected = addSelectionToDraft(
      validConversation(),
      "child",
      selection,
      NOW
    );
    const prepared = prepareSelectionChildDraft(selected, {
      nodeId: "child",
      now: NOW
    });
    const manuallyToggled = toggleBranchDraft(prepared, "child", NOW);

    expect(requireNode(manuallyToggled, "child").draft.mode).toBe("continue");
    expect(
      requireNode(manuallyToggled, "child").draft.selectionModeBeforeCapture
    ).toBeUndefined();

    const removed = removeSelectionFromDraft(
      manuallyToggled,
      "child",
      selectionContextKey(selection),
      NOW
    );
    expect(requireNode(removed, "child").draft.mode).toBe("continue");
  });

  it("restores selection-owned mode while preserving note contexts", () => {
    const note: NoteSelectionContext = {
      sourceType: "note",
      filePath: "课程/网络分层.md",
      fileName: "网络分层.md",
      basis: "note-source-v1",
      startOffset: 4,
      endOffset: 7,
      quote: "网络层",
      prefix: "第一段",
      suffix: "负责寻址",
      contentHash: "note-hash"
    };
    const withNote = addSelectionToDraft(
      validConversation(),
      "child",
      note,
      NOW
    );
    const withMessage = addSelectionToDraft(
      withNote,
      "child",
      selection,
      NOW
    );
    const prepared = prepareSelectionChildDraft(withMessage, {
      nodeId: "child",
      now: NOW
    });

    const removed = removeSelectionFromDraft(
      prepared,
      "child",
      selectionContextKey(selection),
      NOW
    );

    expect(requireNode(removed, "child").draft.mode).toBe("continue");
    expect(requireNode(removed, "child").draft.selectionContexts).toEqual([
      note
    ]);
  });

  it("creates a child only when a non-empty child draft is submitted", () => {
    const selected = addSelectionToDraft(
      validConversation(),
      "child",
      selection,
      NOW
    );
    const prepared = prepareChildDraft(selected, {
      nodeId: "child",
      now: NOW
    });

    const submitted = submitChildDraft(prepared, {
      text: "子问题",
      childId: "grandchild",
      messageId: "message-1",
      now: NOW
    });

    expect(requireNode(submitted.state, "grandchild").parentId).toBe("child");
    expect(
      requireNode(submitted.state, "grandchild").messages[0]?.selectionContexts
    ).toEqual([selection]);
    expect(
      requireNode(submitted.state, "child").draft.selectionContexts
    ).toEqual([]);
    expect(requireNode(submitted.state, "child").childIds).toEqual(["grandchild"]);
    expect(submitted.state.currentNodeId).toBe("grandchild");
    expect(() =>
      submitChildDraft(prepared, {
        text: "  ",
        childId: "empty",
        messageId: "message-2",
        now: NOW
      })
    ).toThrow(/empty/i);
  });

  it("stores every draft context on a continued user message and clears the draft", () => {
    const second = {
      ...selection,
      messageId: "assistant-2",
      quote: "second"
    };
    const once = addSelectionToDraft(
      validConversation(),
      "child",
      selection,
      NOW
    );
    const twice = addSelectionToDraft(once, "child", second, NOW);

    const result = continueNode(twice, {
      nodeId: "child",
      text: "question",
      messageId: "question-1",
      now: NOW
    });

    expect(
      requireNode(result.state, "child").messages.at(-1)?.selectionContexts
    ).toEqual([selection, second]);
    expect(requireNode(result.state, "child").draft.selectionContexts).toEqual(
      []
    );
  });

  it("stores a note context on the submitted message and starts a fresh next-turn array", () => {
    const note: NoteSelectionContext = {
      sourceType: "note",
      filePath: "课程/网络分层.md",
      fileName: "网络分层.md",
      basis: "note-source-v1",
      startOffset: 4,
      endOffset: 7,
      quote: "网络层",
      prefix: "第一段",
      suffix: "负责寻址",
      contentHash: "note-hash"
    };
    const selected = addSelectionToDraft(
      validConversation(),
      "child",
      note,
      NOW
    );

    const result = continueNode(selected, {
      nodeId: "child",
      text: "解释这一段",
      messageId: "note-question",
      now: NOW
    });

    expect(
      requireNode(result.state, "child").messages.at(-1)?.selectionContexts
    ).toEqual([note]);
    expect(requireNode(result.state, "child").draft.selectionContexts).toEqual([]);
  });

  it("reverts a newly created child when the revision still matches", () => {
    const prepared = prepareChildDraft(validConversation(), {
      nodeId: "child",
      now: NOW
    });
    const submitted = submitChildDraft(prepared, {
      text: "子问题",
      childId: "grandchild",
      messageId: "message-1",
      now: NOW
    });

    const reverted = revertTreeCommand(submitted.state, submitted.operation);

    expect(reverted.nodes.grandchild).toBeUndefined();
    expect(requireNode(reverted, "child").childIds).toEqual([]);
  });
});
