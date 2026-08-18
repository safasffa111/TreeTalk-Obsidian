export function deepSeekApiRoot(baseUrl: string): string {
  const configured =
    baseUrl.trim().length > 0 ? baseUrl.trim() : "https://api.deepseek.com";
  try {
    const parsed = new URL(configured);
    if (parsed.hostname.toLowerCase() === "api.deepseek.com") {
      return `${parsed.protocol}//${parsed.host}`;
    }
  } catch {
    // Preserve custom compatible endpoints while removing a known request path.
  }
  return configured
    .replace(/\/+$/u, "")
    .replace(/\/(?:anthropic(?:\/v1(?:\/messages)?)?|chat\/completions)$/u, "");
}
