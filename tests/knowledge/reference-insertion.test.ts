import { describe, expect, it } from "vitest";
import type { ChatMessage, NoteSelectionContext } from "../../src/domain/types";
import { createNoteSelectionContext } from "../../src/domain/note-selection-context";
import { createSelectionAnchor } from "../../src/domain/selection-anchor";
import {
  findDocumentReference,
  insertDocumentReference
} from "../../src/knowledge/reference-insertion";
import { validConversation, NOW } from "../fixtures";
import { FakeVault } from "../storage/fake-vault";

function message(
  id: string,
  role: ChatMessage["role"],
  content: string,
  selectionContexts?: ChatMessage["selectionContexts"]
): ChatMessage {
  return {
    id,
    role,
    content,
    status: "complete",
    ...(selectionContexts === undefined ? {} : { selectionContexts }),
    createdAt: NOW,
    updatedAt: NOW
  };
}

async function networkNoteContext(): Promise<NoteSelectionContext> {
  return createNoteSelectionContext({
    filePath: "Notes/network.md",
    fileName: "network.md",
    basis: "note-source-v1",
    visibleText: "前文网络层负责寻址。",
    startOffset: 2,
    endOffset: 5
  });
}

describe("answer reference insertion", () => {
  it("uses a note selection from the question that produced the answer", async () => {
    const conversation = validConversation();
    const child = conversation.nodes.child;
    if (child === undefined) throw new Error("Missing child fixture");
    child.messages.push(
      message("question", "user", "解释网络层", [await networkNoteContext()]),
      message("answer", "assistant", "网络层负责寻址。")
    );

    const reference = findDocumentReference(conversation, "child", "answer");
    expect(reference?.note.filePath).toBe("Notes/network.md");
    expect(reference?.nodeId).toBe("child");
    expect(reference?.messageId).toBe("question");

    const vault = new FakeVault({ "Notes/network.md": "前文网络层负责寻址。" });
    if (reference === undefined) throw new Error("Missing reference");
    const status = await insertDocumentReference(vault, reference.note, {
      path: "TreeTalk 知识/三次握手.md",
      title: "三次握手"
    });
    expect(status).toBe("inserted");
    expect(await vault.read("Notes/network.md")).toBe(
      "前文网络层 [[TreeTalk 知识/三次握手|三次握手]] 负责寻址。"
    );
  });

  it("recursively follows parent chat selections to the original note", async () => {
    const conversation = validConversation();
    const root = conversation.nodes.root;
    const child = conversation.nodes.child;
    if (root === undefined || child === undefined) {
      throw new Error("Missing fixture");
    }
    root.messages.push(
      message("root-question", "user", "网络层做什么？", [
        await networkNoteContext()
      ]),
      message("root-answer", "assistant", "网络层负责寻址。")
    );
    const anchor = await createSelectionAnchor({
      messageId: "root-answer",
      sourceNodeId: "root",
      sourceRole: "assistant",
      visibleText: "网络层负责寻址。",
      startOffset: 0,
      endOffset: 3
    });
    child.messages.push(
      message("child-question", "user", "继续解释", [anchor]),
      message("child-answer", "assistant", "寻址意味着选择路径。")
    );

    const reference = findDocumentReference(conversation, "child", "child-answer");
    expect(reference?.note.filePath).toBe("Notes/network.md");
    expect(reference?.nodeId).toBe("root");
    expect(reference?.messageId).toBe("root-question");
  });

  it("follows multiple chat hops before finding a note", async () => {
    const conversation = validConversation();
    const root = conversation.nodes.root;
    const child = conversation.nodes.child;
    if (root === undefined || child === undefined) {
      throw new Error("Missing fixture");
    }
    root.messages.push(
      message("root-question", "user", "网络层做什么？", [
        await networkNoteContext()
      ]),
      message("root-answer", "assistant", "网络层负责寻址。")
    );
    child.messages.push(
      message("child-question", "user", "继续解释", [
        await createSelectionAnchor({
          messageId: "root-answer",
          sourceNodeId: "root",
          sourceRole: "assistant",
          visibleText: "网络层负责寻址。",
          startOffset: 0,
          endOffset: 3
        })
      ]),
      message("child-answer", "assistant", "寻址意味着选择路径。")
    );
    conversation.nodes.grandchild = {
      id: "grandchild",
      parentId: "child",
      childIds: [],
      title: "再进一步",
      messages: [
        message("grandchild-question", "user", "举例", [
          await createSelectionAnchor({
            messageId: "child-answer",
            sourceNodeId: "child",
            sourceRole: "assistant",
            visibleText: "寻址意味着选择路径。",
            startOffset: 0,
            endOffset: 2
          })
        ]),
        message("grandchild-answer", "assistant", "例如路由表。")
      ],
      draft: { text: "", mode: "continue", selectionContexts: [] },
      createdAt: NOW,
      updatedAt: NOW
    };
    child.childIds.push("grandchild");

    const reference = findDocumentReference(
      conversation,
      "grandchild",
      "grandchild-answer"
    );
    expect(reference?.note.filePath).toBe("Notes/network.md");
    expect(reference?.messageId).toBe("root-question");
  });

  it("prefers a direct note selection over a parent chat chain", async () => {
    const conversation = validConversation();
    const root = conversation.nodes.root;
    const child = conversation.nodes.child;
    if (root === undefined || child === undefined) {
      throw new Error("Missing fixture");
    }
    root.messages.push(
      message("root-question", "user", "旧问题", [await networkNoteContext()]),
      message("root-answer", "assistant", "旧回答")
    );
    const parentAnchor = await createSelectionAnchor({
      messageId: "root-answer",
      sourceNodeId: "root",
      sourceRole: "assistant",
      visibleText: "旧回答",
      startOffset: 0,
      endOffset: 1
    });
    const direct = await createNoteSelectionContext({
      filePath: "Notes/direct.md",
      fileName: "direct.md",
      basis: "note-source-v1",
      visibleText: "直接引用的内容",
      startOffset: 0,
      endOffset: 2
    });
    child.messages.push(
      message("child-question", "user", "新问题", [parentAnchor, direct]),
      message("child-answer", "assistant", "新回答")
    );

    const reference = findDocumentReference(conversation, "child", "child-answer");
    expect(reference?.note.filePath).toBe("Notes/direct.md");
    expect(reference?.messageId).toBe("child-question");
  });

  it("returns undefined when no note selection exists in the chain", () => {
    const conversation = validConversation();
    const child = conversation.nodes.child;
    if (child === undefined) throw new Error("Missing child fixture");
    child.messages.push(
      message("question", "user", "没有引用的问题"),
      message("answer", "assistant", "没有引用的回答")
    );

    expect(findDocumentReference(conversation, "child", "answer")).toBeUndefined();
  });

  it("appends a link when the note selection can no longer be resolved", async () => {
    const vault = new FakeVault({ "Notes/changed.md": "完全不同的内容" });
    const reference: NoteSelectionContext = {
      sourceType: "note",
      filePath: "Notes/changed.md",
      fileName: "changed.md",
      basis: "note-source-v1",
      startOffset: 0,
      endOffset: 3,
      quote: "网络层",
      prefix: "",
      suffix: "",
      contentHash: "old"
    };

    const status = await insertDocumentReference(vault, reference, {
      path: "TreeTalk 知识/三次握手.md",
      title: "三次握手"
    });
    expect(status).toBe("appended");
    expect(await vault.read("Notes/changed.md")).toBe(
      "完全不同的内容\n\n## TreeTalk 沉淀\n\n- [[TreeTalk 知识/三次握手|三次握手]]\n"
    );
  });

  it("reports a missing source note without creating anything", async () => {
    const vault = new FakeVault();
    const reference: NoteSelectionContext = {
      sourceType: "note",
      filePath: "Notes/missing.md",
      fileName: "missing.md",
      basis: "note-source-v1",
      startOffset: 0,
      endOffset: 1,
      quote: "a",
      prefix: "",
      suffix: "",
      contentHash: "old"
    };

    await expect(
      insertDocumentReference(vault, reference, {
        path: "TreeTalk 知识/三次握手.md",
        title: "三次握手"
      })
    ).resolves.toBe("missing");
    expect(vault.paths()).toEqual([]);
  });
});
