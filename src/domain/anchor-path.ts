/**
 * Returns whether a path is a Markdown file path relative to the current Vault.
 * Backslashes are normalized before validation; a valid path is never absolute
 * and never traverses through `.` or `..` segments.
 */
export function isVaultRelativeMarkdownPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\u0000")) {
    return false;
  }
  const path = value.replace(/\\/gu, "/");
  if (path.startsWith("/") || /^[a-z]:/iu.test(path) || !/\.md$/iu.test(path)) {
    return false;
  }
  return !path.split("/").some((segment) => segment === "." || segment === "..");
}