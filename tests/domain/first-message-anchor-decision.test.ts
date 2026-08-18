import { describe, expect, it } from "vitest";
import { decideFirstMessageAnchor } from "../../src/domain/first-message-anchor-decision";

const VAULT_ID = "11111111-2222-3333-4444-555555555555";

describe("decideFirstMessageAnchor", () => {
  it("rejects an explicit pending anchor when its Vault identity or ctime cannot be verified", () => {
    expect(
      decideFirstMessageAnchor({
        explicitPending: true,
        filePath: "Notes/design.md",
        vaultId: undefined,
        fileCtime: undefined
      })
    ).toEqual({
      kind: "reject",
      notice: "无法验证显式锚定笔记的 Vault 身份或 ctime，本次消息未发送"
    });
  });

  it("allows an unverifiable implicit active-file fallback without setting an anchor", () => {
    expect(
      decideFirstMessageAnchor({
        explicitPending: false,
        filePath: "Notes/design.md",
        vaultId: VAULT_ID,
        fileCtime: undefined
      })
    ).toEqual({ kind: "proceed", anchor: undefined });
  });
});
