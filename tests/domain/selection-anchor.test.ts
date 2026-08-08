import { describe, expect, it } from "vitest";
import {
  createSelectionAnchor,
  resolveSelectionAnchor
} from "../../src/domain/selection-anchor";

describe("selection anchors", () => {
  it.each([
    ["中文上下文", 2, 5],
    ["A😀B", 1, 3],
    ["first\nsecond", 3, 9]
  ])("round-trips UTF-16 offsets in %s", async (content, start, end) => {
    const anchor = await createSelectionAnchor({
      messageId: "message-1",
      sourceNodeId: "node-1",
      sourceRole: "assistant",
      visibleText: content,
      startOffset: start,
      endOffset: end
    });

    expect(resolveSelectionAnchor(content, anchor)).toMatchObject({
      status: "resolved",
      start,
      end
    });
    expect(anchor).toMatchObject({
      sourceNodeId: "node-1",
      sourceRole: "assistant",
      basis: "rendered-text-v1"
    });
  });

  it("relocates an unchanged quote after prefix insertion", async () => {
    const anchor = await createSelectionAnchor({
      messageId: "message-1",
      sourceNodeId: "node-1",
      sourceRole: "assistant",
      visibleText: "alpha target omega",
      startOffset: 6,
      endOffset: 12
    });

    expect(resolveSelectionAnchor("new alpha target omega", anchor)).toMatchObject({
      status: "resolved",
      start: 10,
      end: 16
    });
  });

  it("returns unresolved when repeated text has no unique contextual match", async () => {
    const anchor = await createSelectionAnchor({
      messageId: "message-1",
      sourceNodeId: "node-1",
      sourceRole: "assistant",
      visibleText: "x target x",
      startOffset: 2,
      endOffset: 8
    });
    const changed = "target..........target";

    expect(resolveSelectionAnchor(changed, {
      ...anchor,
      prefix: "",
      suffix: "",
      startOffset: 8
    })).toEqual({
      status: "unresolved",
      quote: "target"
    });
  });

  it("stores source Markdown while resolving against the visible quote", async () => {
    const anchor = await createSelectionAnchor({
      messageId: "message-1",
      sourceNodeId: "node-1",
      sourceRole: "assistant",
      visibleText: "Euler identity is eⁱπ + 1 = 0",
      startOffset: 18,
      endOffset: 29,
      quoteOverride: "$e^{i\\pi} + 1 = 0$"
    });

    expect(anchor.quote).toBe("$e^{i\\pi} + 1 = 0$");
    expect(anchor.visibleQuote).toBe("eⁱπ + 1 = 0");
    expect(resolveSelectionAnchor("Euler identity is eⁱπ + 1 = 0", anchor)).toMatchObject({
      status: "resolved",
      start: 18,
      end: 29
    });
  });

  it("rejects invalid or empty ranges", async () => {
    const create = (startOffset: number, endOffset: number) =>
      createSelectionAnchor({
        messageId: "message-1",
        sourceNodeId: "node-1",
        sourceRole: "assistant",
        visibleText: "abc",
        startOffset,
        endOffset
      });
    await expect(create(2, 2)).rejects.toThrow(/range/i);
    await expect(create(-1, 2)).rejects.toThrow(/range/i);
    await expect(create(0, 4)).rejects.toThrow(/range/i);
  });
});
