import { describe, expect, it } from "vitest";
import { isVaultRelativeMarkdownPath } from "../../src/domain/anchor-path";

describe("isVaultRelativeMarkdownPath", () => {
  it.each([
    ["Notes/design.md", true],
    ["Notes\\design.MD", true],
    ["draft.v1.md", true],
    ["", false],
    ["/Notes/design.md", false],
    ["C:\\Notes\\design.md", false],
    ["../Notes/design.md", false],
    ["Notes/./design.md", false],
    ["Notes/design.pdf", false],
    ["Notes/\u0000design.md", false]
  ])("accepts only a non-empty Vault-relative Markdown path: %j", (path, expected) => {
    expect(isVaultRelativeMarkdownPath(path)).toBe(expected);
  });
});