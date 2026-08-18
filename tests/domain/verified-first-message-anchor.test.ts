import { describe, expect, it } from "vitest";
import { verifiedFirstMessageAnchor } from "../../src/domain/verified-first-message-anchor";

const VAULT_ID = "11111111-2222-3333-4444-555555555555";

describe("verifiedFirstMessageAnchor", () => {
  it("returns the full verified triple only when Vault identity and ctime are available", () => {
    expect(
      verifiedFirstMessageAnchor({
        filePath: "Notes/design.md",
        vaultId: VAULT_ID,
        fileCtime: 1700000000000
      })
    ).toEqual({
      anchorFilePath: "Notes/design.md",
      anchorVaultId: VAULT_ID,
      anchorFileCtime: 1700000000000
    });
  });

  it("does not create a path-only legacy anchor when ctime or Vault identity is unavailable", () => {
    expect(
      verifiedFirstMessageAnchor({
        filePath: "Notes/design.md",
        vaultId: VAULT_ID,
        fileCtime: undefined
      })
    ).toBeUndefined();
    expect(
      verifiedFirstMessageAnchor({
        filePath: "Notes/design.md",
        vaultId: undefined,
        fileCtime: 1700000000000
      })
    ).toBeUndefined();
  });

  it.each(["attachments/scan.pdf", "/Notes/design.md", "../Notes/design.md"])(
    "rejects a non-Vault-relative Markdown anchor path: %s",
    (filePath) => {
      expect(
        verifiedFirstMessageAnchor({ filePath, vaultId: VAULT_ID, fileCtime: 1700000000000 })
      ).toBeUndefined();
    }
  );
});
