export function nativeMarkdownRenderIntervalMs(contentLength: number): number {
  if (contentLength <= 2_000) return 120;
  if (contentLength <= 8_000) return 220;
  return 360;
}
