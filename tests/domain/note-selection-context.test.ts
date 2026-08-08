import { describe, expect, it } from "vitest";
import { createNoteSelectionContext } from "../../src/domain/note-selection-context";

const NOTE = "第一段\n网络层负责寻址与路由选择\n最后一段";

describe("note selection context", () => {
  it("creates a source anchor with file metadata and surrounding text", async () => {
    const start = NOTE.indexOf("网络层");
    const end = start + "网络层负责寻址与路由选择".length;

    const context = await createNoteSelectionContext({
      filePath: "课程/网络分层.md",
      fileName: "网络分层.md",
      basis: "note-source-v1",
      visibleText: NOTE,
      startOffset: start,
      endOffset: end
    });

    expect(context).toMatchObject({
      sourceType: "note",
      filePath: "课程/网络分层.md",
      fileName: "网络分层.md",
      basis: "note-source-v1",
      quote: "网络层负责寻址与路由选择",
      startOffset: start,
      endOffset: end
    });
    expect(context.prefix).toContain("第一段");
    expect(context.suffix).toContain("最后一段");
    expect(context.contentHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(context.snapshot).toMatchObject({
      version: "note-snapshot-v1",
      content: NOTE,
      selectionStartOffset: start,
      selectionEndOffset: end
    });
  });

  it("removes YAML from the saved snapshot without changing the selected quote", async () => {
    const source = "---\ntags: [network]\n---\n# 标题\n\n网络层负责寻址";
    const start = source.indexOf("网络层");
    const context = await createNoteSelectionContext({
      filePath: "课程/网络分层.md",
      fileName: "网络分层.md",
      basis: "note-source-v1",
      visibleText: source,
      sourceText: source,
      startOffset: start,
      endOffset: source.length
    });

    expect(context.quote).toBe("网络层负责寻址");
    expect(context.snapshot?.content).toBe("# 标题\n\n网络层负责寻址");
    expect(
      context.snapshot?.content.slice(
        context.snapshot.selectionStartOffset,
        context.snapshot.selectionEndOffset
      )
    ).toBe("网络层负责寻址");
  });

  it("rejects empty or out-of-bounds note selections", async () => {
    await expect(
      createNoteSelectionContext({
        filePath: "note.md",
        fileName: "note.md",
        basis: "note-source-v1",
        visibleText: NOTE,
        startOffset: 3,
        endOffset: 3
      })
    ).rejects.toThrow(/range/i);
  });
});
