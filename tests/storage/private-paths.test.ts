import { describe, expect, it } from "vitest";
import {
  conversationFolder,
  privateConversationRoots
} from "../../src/storage/private-paths";

describe("privateConversationRoots", () => {
  it("places TreeTalk data under the Obsidian configuration directory", () => {
    expect(privateConversationRoots(".obsidian")).toEqual({
      root: ".obsidian/treetalk-data",
      active: ".obsidian/treetalk-data/active",
      history: ".obsidian/treetalk-data/history"
    });
  });

  it("normalizes trailing separators", () => {
    expect(privateConversationRoots(".settings/")).toEqual({
      root: ".settings/treetalk-data",
      active: ".settings/treetalk-data/active",
      history: ".settings/treetalk-data/history"
    });
  });
});

describe("conversationFolder", () => {
  it("uses the stable conversation id as the folder name", () => {
    expect(conversationFolder(".obsidian/treetalk-data/active", "conversation-123")).toBe(
      ".obsidian/treetalk-data/active/conversation-123"
    );
  });

  it.each(["", ".", "..", "../outside", "folder/id", "folder\\id"])(
    "rejects an unsafe conversation id: %s",
    (id) => {
      expect(() => conversationFolder(".obsidian/treetalk-data/active", id)).toThrow(
        "Invalid conversation id"
      );
    }
  );
});
