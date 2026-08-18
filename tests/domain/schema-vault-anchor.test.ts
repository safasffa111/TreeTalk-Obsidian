import { describe, expect, it } from "vitest";
import { parseConversation } from "../../src/domain/schema";
import { classifyAnchor } from "../../src/domain/anchor-status";
import type { ConversationFile } from "../../src/domain/types";
import { validConversation } from "../fixtures";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function baseConversation(): ConversationFile {
  return clone(validConversation());
}

describe("schema vault anchor fields", () => {
  it("accepts a verified triple (vaultId + filePath + fileCtime)", () => {
    const conversation = baseConversation();
    const parsed = parseConversation({
      ...conversation,
      anchorVaultId: "11111111-2222-3333-4444-555555555555",
      anchorFilePath: "Notes/design.md",
      anchorFileCtime: 1700000000000
    });
    expect(parsed.anchorVaultId).toBe("11111111-2222-3333-4444-555555555555");
    expect(parsed.anchorFilePath).toBe("Notes/design.md");
    expect(parsed.anchorFileCtime).toBe(1700000000000);
  });

  it("still reads a legacy path-only anchor without the new fields", () => {
    const conversation = baseConversation();
    const parsed = parseConversation({
      ...conversation,
      anchorFilePath: "Legacy/note.md"
    });
    expect(parsed.anchorFilePath).toBe("Legacy/note.md");
    expect(parsed.anchorVaultId).toBeUndefined();
    expect(parsed.anchorFileCtime).toBeUndefined();
  });

  it("reads a complete PDF triple as schema-compatible but never classifies it verified", () => {
    const conversation = baseConversation();
    const parsed = parseConversation({
      ...conversation,
      anchorVaultId: "11111111-2222-3333-4444-555555555555",
      anchorFilePath: "attachments/scan.pdf",
      anchorFileCtime: 1700000000000
    });
    expect(parsed.anchorFilePath).toBe("attachments/scan.pdf");
    expect(
      classifyAnchor({
        conversation: parsed,
        currentVaultId: "11111111-2222-3333-4444-555555555555"
      })
    ).toEqual({ kind: "missing" });
  });

  it("rejects a verified anchor whose vaultId is not a UUID string", () => {
    const conversation = baseConversation();
    expect(() =>
      parseConversation({
        ...conversation,
        anchorVaultId: "not-a-uuid",
        anchorFilePath: "Notes/design.md",
        anchorFileCtime: 1700000000000
      })
    ).toThrow(/anchorVaultId/);
  });

  it("rejects a verified anchor whose fileCtime is negative", () => {
    const conversation = baseConversation();
    expect(() =>
      parseConversation({
        ...conversation,
        anchorVaultId: "11111111-2222-3333-4444-555555555555",
        anchorFilePath: "Notes/design.md",
        anchorFileCtime: -1
      })
    ).toThrow(/anchorFileCtime/);
  });

  it("rejects a verified anchor whose fileCtime is not an integer", () => {
    const conversation = baseConversation();
    expect(() =>
      parseConversation({
        ...conversation,
        anchorVaultId: "11111111-2222-3333-4444-555555555555",
        anchorFilePath: "Notes/design.md",
        anchorFileCtime: 1.5
      })
    ).toThrow(/anchorFileCtime/);
  });
});
