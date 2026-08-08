/**
 * A provider failure that is safe to retry with the exact same request prefix.
 *
 * Retrying with byte-identical messages is both a robustness improvement and a
 * cache optimization: the second attempt reuses the prefix the first attempt
 * already persisted into DeepSeek's disk cache instead of forcing the user to
 * restart the whole run (which would diverge on the next model response).
 */
export class TransientProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransientProviderError";
  }
}

export function isTransientProviderStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Recognizes transient HTTP failures from the buffered path (which throws
 * TransientProviderError) and from the streaming transport (which throws a
 * plain Error whose message is exactly `HTTP <status>`).
 */
export function isTransientHttpError(
  error: unknown
): error is TransientProviderError {
  if (error instanceof TransientProviderError) return true;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = String((error as { message?: unknown }).message);
    const match = /^HTTP (408|429|5\d{2})$/u.exec(message);
    if (match !== null) {
      return isTransientProviderStatus(Number(match[1]));
    }
  }
  return false;
}
