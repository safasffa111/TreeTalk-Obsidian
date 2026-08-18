import type { ProviderProfile } from "./types";

/**
 * Hostname of the official MiniMax Anthropic-compatible endpoint. Centralised
 * so the CORS workaround and any future tooling (Observatory, diagnostics)
 * share the same allowlist.
 */
export const MINIMAX_OFFICIAL_HOST = "api.minimaxi.com";

/**
 * Path prefix that marks the endpoint as speaking the Anthropic Messages
 * protocol. MiniMax serves Chat Completions at `/v1` and the Anthropic
 * adapter at `/anthropic`; only the latter is blocked by the CORS policy
 * the user hit, so we treat that path as the discriminator.
 */
const MINIMAX_ANTHROPIC_PATH = "/anthropic";

/**
 * The MiniMax official Anthropic endpoint advertises the correct
 * `Access-Control-Allow-Origin` and `Access-Control-Allow-Methods` response
 * headers, but its preflight does **not** include `x-api-key` or
 * `anthropic-version` in `Access-Control-Allow-Headers`. Browser fetch
 * therefore fails the preflight and the streaming answer surfaces as a
 * generic `Failed to fetch`. The Obsidian `requestUrl` host bypasses the
 * browser, so a response is still obtainable — we just have to avoid
 * streaming it.
 *
 * Returns true only for the exact Anthropic endpoint on the official host.
 * Anything else (custom CORS proxy, OpenAI-compatible MiniMax path, malformed
 * URL, or a non-MiniMax provider) returns false so the existing behaviour
 * is preserved.
 */
export function isOfficialMiniMaxAnthropicEndpoint(baseUrl: string): boolean {
  const trimmed = baseUrl.trim();
  if (trimmed.length === 0) return false;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return false;
  }
  if (url.hostname.toLowerCase() !== MINIMAX_OFFICIAL_HOST) return false;
  return url.pathname.toLowerCase().startsWith(MINIMAX_ANTHROPIC_PATH);
}

/**
 * Decide whether the given resolved {@link ProviderProfile} is one whose
 * browser-streaming fetch path is known to be broken. Only the official
 * MiniMax Anthropic endpoint qualifies; DeepSeek, Anthropic official, custom
 * CORS proxies, and the wrong-protocol MiniMax path all return false.
 *
 * The function is intentionally read-only and free of side effects: callers
 * pass it a `profile` already resolved from settings, so the same answer is
 * reproducible from the same input.
 */
export function requiresBufferedTransport(profile: ProviderProfile): boolean {
  if (profile.kind !== "anthropic") return false;
  return isOfficialMiniMaxAnthropicEndpoint(profile.baseUrl);
}

/**
 * Resolve the value to write onto `ExecutionRequest.streamingOutputEnabled`.
 *
 * Rule:
 *   configured && !requiresBufferedTransport(profile)
 *
 * The user toggle is preserved unchanged when the active profile streams
 * fine, and silently overridden only for the official MiniMax Anthropic
 * endpoint. Returning the configured value (not the effective one) when the
 * profile is harmless means switching back to DeepSeek immediately restores
 * the user's preference — no state to clear.
 */
export function effectiveStreamingOutputEnabled(
  configured: boolean,
  profile: ProviderProfile
): boolean {
  return configured && !requiresBufferedTransport(profile);
}
