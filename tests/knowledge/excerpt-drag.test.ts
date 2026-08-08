import { describe, expect, it } from "vitest";
import type { SelectionAnchor } from "../../src/domain/types";
import {
  decodeSourceAnchor,
  encodeSourceAnchor,
  parseExcerptPayload,
  renderExcerptCallout,
  serializeExcerptPayload,
  TREETALK_EXCERPT_MIME,
  type TreeTalkExcerptDragPayload
} from "../../src/knowledge/excerpt-drag";

const anchor: SelectionAnchor = {
  messageId: "message?1",
  sourceNodeId: "node 1",
  sourceRole: "assistant",
  basis: "rendered-text-v1",
  startOffset: 6,
  endOffset: 16,
  quote: "原始 **文本**",
  visibleQuote: "原始 文本",
  prefix: "before ",
  suffix: " after",
  contentHash: "abc123"
};

const legacyPayload: TreeTalkExcerptDragPayload = {
  version: 1,
  conversationId: "conversation/1",
  conversationTitle: "TCP study",
  nodeId: "node 1",
  nodeTitle: "Reliability",
  messageId: "message?1",
  sourceRole: "assistant",
  quote: "first line\nsecond line"
};

const anchoredPayload: TreeTalkExcerptDragPayload = {
  ...legacyPayload,
  version: 2,
  anchor
};

describe("TreeTalk excerpt drag payload", () => {
  it("round-trips version 2 with an exact selection anchor", () => {
    const serialized = serializeExcerptPayload(anchoredPayload);

    expect(parseExcerptPayload(serialized)).toEqual(anchoredPayload);
    expect(serialized).not.toMatch(/api.?key|model/iu);
    expect(TREETALK_EXCERPT_MIME).toBe(
      "application/x-treetalk-excerpt+json"
    );
  });

  it("keeps parsing legacy version 1 excerpts", () => {
    expect(parseExcerptPayload(serializeExcerptPayload(legacyPayload))).toEqual(
      legacyPayload
    );
  });

  it("encodes and decodes unicode anchors for protocol URLs", () => {
    const encoded = encodeSourceAnchor(anchor);

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(decodeSourceAnchor(encoded)).toEqual(anchor);
    expect(decodeSourceAnchor("not-valid-💥")).toBeUndefined();
  });

  it.each([
    ['{"version":3}', "unknown version"],
    ['{"version":1,"conversationId":""}', "empty identifiers"],
    ['{"version":1,"conversationId":"c","conversationTitle":"t","nodeId":"n","nodeTitle":"x","messageId":"m","sourceRole":"system","quote":"q"}', "invalid role"],
    ['{"version":1,"conversationId":"c","conversationTitle":"t","nodeId":"n","nodeTitle":"x","messageId":"m","sourceRole":"user","quote":"   "}', "empty quote"],
    ['{"version":2,"conversationId":"c","conversationTitle":"t","nodeId":"n","nodeTitle":"x","messageId":"m","sourceRole":"user","quote":"q","anchor":{}}', "invalid anchor"],
    ["not json", "malformed JSON"]
  ])("rejects %s (%s)", (serialized) => {
    expect(parseExcerptPayload(serialized)).toBeUndefined();
  });

  it("renders an anchored source URI for version 2", () => {
    const markdown = renderExcerptCallout(anchoredPayload);
    const href = markdown.match(/\((obsidian:\/\/treetalk-open\?[^)]+)\)/u)?.[1];

    expect(href).toBeDefined();
    const parameters = new URL(href as string).searchParams;
    expect(parameters.get("conversationId")).toBe("conversation/1");
    expect(parameters.get("nodeId")).toBe("node 1");
    expect(parameters.get("messageId")).toBe("message?1");
    expect(decodeSourceAnchor(parameters.get("anchor") ?? "")).toEqual(anchor);
    expect(markdown).toContain("> first line\n> second line");
  });

  it("does not add an anchor parameter to legacy excerpts", () => {
    const markdown = renderExcerptCallout(legacyPayload);

    expect(markdown).not.toContain("&anchor=");
  });
});
