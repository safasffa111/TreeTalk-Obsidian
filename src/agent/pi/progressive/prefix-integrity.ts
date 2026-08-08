import type { PiConversationMessage } from "../pi-provider-transport";

/**
 * Verifies that `current` extends `previous` as an exact, byte-stable prefix.
 *
 * DeepSeek's automatic context caching only hits when a later request's input
 * tokens fully match a previously persisted prefix unit, so every Progressive
 * Pi request must append to the prior request's messages without changing any
 * earlier message. This helper compares the stored message objects through
 * deterministic JSON serialization so a violation is caught before the next
 * provider request is sent.
 */
export function isStrictMessagePrefix(
  previous: readonly PiConversationMessage[],
  current: readonly PiConversationMessage[]
): boolean {
  if (current.length < previous.length) return false;
  const currentPrefix = current.slice(0, previous.length);
  return JSON.stringify(currentPrefix) === JSON.stringify(previous);
}
