/**
 * Developer-side diagnostics for silent catch sites.
 *
 * The plugin keeps user-facing failures as Notices; these warnings are the
 * console trail for the same failures. They never change control flow and
 * only appear in the developer console.
 */

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

/**
 * Writes `[TreeTalk] <context>: <message>` (without the suffix when no error
 * is provided) to the console.
 */
export function logWarning(context: string, error?: unknown): void {
  const detail = error === undefined ? "" : `: ${errorMessage(error)}`;
  console.warn(`[TreeTalk] ${context}${detail}`);
}

/**
 * Returns a logger that warns at most once for the lifetime of the returned
 * function. Use for hot paths that can fail repeatedly (streaming renders,
 * frame callbacks) so a persistent problem is visible without console spam.
 */
export function createWarnOnce(): (context: string, error?: unknown) => void {
  let warned = false;
  return (context, error) => {
    if (warned) return;
    warned = true;
    logWarning(context, error);
  };
}
