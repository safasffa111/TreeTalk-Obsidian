import { describe, expect, it } from "vitest";
import {
  applyAnchorPathRemap,
  classifyAnchor,
  remapAnchorPath,
  type AnchorStatus
} from "../../src/domain/anchor-status";

const VAULT_ID = "11111111-2222-3333-4444-555555555555";
const OTHER_VAULT = "22222222-3333-4444-5555-666666666666";
const CTIME = 1700000000000;

describe("classifyAnchor", () => {
  it("returns none when anchor has no fields at all", () => {
    expect(classifyAnchor({ conversation: {}, currentVaultId: VAULT_ID })).toEqual<AnchorStatus>({
      kind: "none"
    });
  });

  it("returns verified when triple matches current Vault", () => {
    const status = classifyAnchor({
      conversation: {
        anchorVaultId: VAULT_ID,
        anchorFilePath: "Notes/a.md",
        anchorFileCtime: CTIME
      },
      currentVaultId: VAULT_ID
    });
    expect(status).toEqual<AnchorStatus>({
      kind: "verified",
      vaultId: VAULT_ID,
      filePath: "Notes/a.md",
      fileCtime: CTIME
    });
  });

  it("returns foreign-vault when the triple belongs to another Vault", () => {
    const status = classifyAnchor({
      conversation: {
        anchorVaultId: OTHER_VAULT,
        anchorFilePath: "Notes/a.md",
        anchorFileCtime: CTIME
      },
      currentVaultId: VAULT_ID
    });
    expect(status).toEqual<AnchorStatus>({ kind: "foreign-vault" });
  });

  it("returns legacy-unverified when only anchorFilePath is present", () => {
    expect(
      classifyAnchor({
        conversation: { anchorFilePath: "Legacy/note.md" },
        currentVaultId: VAULT_ID
      })
    ).toEqual<AnchorStatus>({ kind: "legacy-unverified" });
  });

  it("keeps a legacy path-only PDF readable but legacy-unverified", () => {
    expect(
      classifyAnchor({
        conversation: { anchorFilePath: "Legacy/scan.pdf" },
        currentVaultId: VAULT_ID
      })
    ).toEqual<AnchorStatus>({ kind: "legacy-unverified" });
  });

  it.each(["attachments/scan.pdf", "/Notes/a.md", "../Notes/a.md"])(
    "never verifies an invalid stored triple path: %s",
    (anchorFilePath) => {
      expect(
        classifyAnchor({
          conversation: { anchorVaultId: VAULT_ID, anchorFilePath, anchorFileCtime: CTIME },
          currentVaultId: VAULT_ID,
          resolveCurrentPath: () => anchorFilePath,
          resolveCtime: () => CTIME,
          findCandidatesByCtime: () => [anchorFilePath]
        })
      ).toEqual<AnchorStatus>({ kind: "missing" });
    }
  );

  it("treats partial triple (vaultId + path, missing ctime) as missing", () => {
    expect(
      classifyAnchor({
        conversation: {
          anchorVaultId: VAULT_ID,
          anchorFilePath: "Notes/a.md"
        },
        currentVaultId: VAULT_ID
      })
    ).toEqual<AnchorStatus>({ kind: "missing" });
  });

  it("treats verified anchor whose current path cannot be resolved as missing", () => {
    expect(
      classifyAnchor({
        conversation: {
          anchorVaultId: VAULT_ID,
          anchorFilePath: "Notes/a.md",
          anchorFileCtime: CTIME
        },
        currentVaultId: VAULT_ID,
        resolveCurrentPath: () => undefined
      })
    ).toEqual<AnchorStatus>({ kind: "missing" });
  });

  it("reports verified when path resolves and ctime matches", () => {
    const status = classifyAnchor({
      conversation: {
        anchorVaultId: VAULT_ID,
        anchorFilePath: "Notes/a.md",
        anchorFileCtime: CTIME
      },
      currentVaultId: VAULT_ID,
      resolveCurrentPath: () => "Notes/a.md",
      resolveCtime: () => CTIME
    });
    expect(status).toEqual<AnchorStatus>({
      kind: "verified",
      vaultId: VAULT_ID,
      filePath: "Notes/a.md",
      fileCtime: CTIME
    });
  });

  it("reports verified when resolved path differs (file was renamed) but ctime still matches", () => {
    const status = classifyAnchor({
      conversation: {
        anchorVaultId: VAULT_ID,
        anchorFilePath: "Notes/a.md",
        anchorFileCtime: CTIME
      },
      currentVaultId: VAULT_ID,
      resolveCurrentPath: () => "Notes/b.md",
      resolveCtime: () => CTIME
    });
    expect(status).toEqual<AnchorStatus>({
      kind: "verified",
      vaultId: VAULT_ID,
      filePath: "Notes/b.md",
      fileCtime: CTIME
    });
  });

  it("reports ambiguous when multiple candidates match by ctime", () => {
    expect(
      classifyAnchor({
        conversation: {
          anchorVaultId: VAULT_ID,
          anchorFilePath: "Notes/a.md",
          anchorFileCtime: CTIME
        },
        currentVaultId: VAULT_ID,
        resolveCurrentPath: () => undefined,
        findCandidatesByCtime: () => ["Notes/b.md", "Notes/c.md"]
      })
    ).toEqual<AnchorStatus>({ kind: "ambiguous" });
  });

  it("reports missing when no candidate matches by ctime", () => {
    expect(
      classifyAnchor({
        conversation: {
          anchorVaultId: VAULT_ID,
          anchorFilePath: "Notes/a.md",
          anchorFileCtime: CTIME
        },
        currentVaultId: VAULT_ID,
        resolveCurrentPath: () => undefined,
        findCandidatesByCtime: () => []
      })
    ).toEqual<AnchorStatus>({ kind: "missing" });
  });

  it("prefers resolved path when exactly one candidate matches", () => {
    const status = classifyAnchor({
      conversation: {
        anchorVaultId: VAULT_ID,
        anchorFilePath: "Notes/a.md",
        anchorFileCtime: CTIME
      },
      currentVaultId: VAULT_ID,
      resolveCurrentPath: () => undefined,
      findCandidatesByCtime: () => ["Notes/only.md"]
    });
    expect(status).toEqual<AnchorStatus>({
      kind: "verified",
      vaultId: VAULT_ID,
      filePath: "Notes/only.md",
      fileCtime: CTIME
    });
  });
});

describe("applyAnchorPathRemap", () => {
  it("remaps verified anchors to their resolved current path", () => {
    const next = applyAnchorPathRemap({
      anchorFilePath: "Notes/a.md",
      anchorVaultId: VAULT_ID,
      anchorFileCtime: CTIME,
      resolvedPath: "Notes/b.md"
    });
    expect(next?.anchorFilePath).toBe("Notes/b.md");
    expect(next?.anchorVaultId).toBe(VAULT_ID);
    expect(next?.anchorFileCtime).toBe(CTIME);
  });

  it("does not mutate state when resolved path equals stored path", () => {
    const original = {
      anchorFilePath: "Notes/a.md",
      anchorVaultId: VAULT_ID,
      anchorFileCtime: CTIME
    };
    const next = applyAnchorPathRemap({
      ...original,
      resolvedPath: "Notes/a.md"
    });
    expect(next).toEqual(original);
  });

  it("returns null when the anchor has no path", () => {
    expect(
      applyAnchorPathRemap({
        anchorVaultId: VAULT_ID,
        anchorFileCtime: CTIME,
        resolvedPath: "Notes/a.md"
      })
    ).toBeNull();
  });

  it("returns null when no resolved path is provided", () => {
    expect(
      applyAnchorPathRemap({
        anchorFilePath: "Notes/a.md",
        anchorVaultId: VAULT_ID,
        anchorFileCtime: CTIME
      })
    ).toBeNull();
  });
});

describe("remapAnchorPath", () => {
  it("rewrites prefix paths in pending and stored anchors", () => {
    const updated = remapAnchorPath(
      {
        pending: { filePath: "A/old/note.md" },
        stored: { filePath: "A/old/note.md", vaultId: VAULT_ID, ctime: CTIME }
      },
      { oldPrefix: "A/old", newPrefix: "A/new" }
    );
    expect(updated.pending?.filePath).toBe("A/new/note.md");
    expect(updated.stored?.filePath).toBe("A/new/note.md");
    expect(updated.stored?.vaultId).toBe(VAULT_ID);
    expect(updated.stored?.ctime).toBe(CTIME);
  });

  it("rewrites exact folder moves when source is a folder prefix only", () => {
    const updated = remapAnchorPath(
      { pending: { filePath: "A/note.md" }, stored: { filePath: "A/note.md", vaultId: VAULT_ID, ctime: CTIME } },
      { oldPrefix: "A", newPrefix: "B" }
    );
    expect(updated.pending?.filePath).toBe("B/note.md");
    expect(updated.stored?.filePath).toBe("B/note.md");
  });

  it("returns undefined for both when no remap applies", () => {
    const updated = remapAnchorPath(
      {
        pending: { filePath: "C/note.md" },
        stored: { filePath: "C/note.md", vaultId: VAULT_ID, ctime: CTIME }
      },
      { oldPrefix: "A", newPrefix: "B" }
    );
    expect(updated.pending).toBeUndefined();
    expect(updated.stored).toBeUndefined();
  });

  it("handles paths with backslashes by normalizing before remap", () => {
    const updated = remapAnchorPath(
      {
        stored: { filePath: "A\\old\\note.md", vaultId: VAULT_ID, ctime: CTIME }
      },
      { oldPrefix: "A/old", newPrefix: "A/new" }
    );
    expect(updated.stored?.filePath).toBe("A/new/note.md");
  });
});
