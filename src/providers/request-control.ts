export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export class RequestTimeoutError extends Error {
  constructor(message = "Provider request timed out") {
    super(message);
    this.name = "RequestTimeoutError";
  }
}

export interface RequestDeadline {
  readonly signal: AbortSignal;
  readonly timedOut: boolean;
  wait<T>(operation: Promise<T>): Promise<T>;
  dispose(): void;
}

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

export function createRequestDeadline(
  callerSignal: AbortSignal,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
): RequestDeadline {
  const controller = new AbortController();
  let timedOut = false;
  const failure = (): Error =>
    timedOut ? new RequestTimeoutError() : abortError();
  const relay = (): void => controller.abort();
  callerSignal.addEventListener("abort", relay, { once: true });
  if (callerSignal.aborted) relay();
  const timeout = controller.signal.aborted
    ? undefined
    : setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, Math.max(0, timeoutMs));

  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    wait<T>(operation: Promise<T>): Promise<T> {
      if (controller.signal.aborted) return Promise.reject(failure());
      return new Promise<T>((resolve, reject) => {
        const cleanup = (): void =>
          controller.signal.removeEventListener("abort", rejectOnAbort);
        const rejectOnAbort = (): void => {
          cleanup();
          reject(failure());
        };
        controller.signal.addEventListener("abort", rejectOnAbort, {
          once: true
        });
        void operation.then(
          (value) => {
            cleanup();
            resolve(value);
          },
          (error: unknown) => {
            cleanup();
            reject(
              error instanceof Error ? error : new Error(String(error))
            );
          }
        );
      });
    },
    dispose(): void {
      if (timeout !== undefined) clearTimeout(timeout);
      callerSignal.removeEventListener("abort", relay);
    }
  };
}

export async function runWithRequestDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  callerSignal: AbortSignal,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
): Promise<T> {
  const deadline = createRequestDeadline(callerSignal, timeoutMs);
  try {
    return await deadline.wait(
      Promise.resolve().then(() => operation(deadline.signal))
    );
  } finally {
    deadline.dispose();
  }
}

export function waitForRetry(
  delayMs: number,
  signal: AbortSignal
): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, Math.max(0, delayMs));
    function cleanup(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
    }
    function finish(): void {
      cleanup();
      resolve();
    }
    function cancel(): void {
      cleanup();
      reject(abortError());
    }
    signal.addEventListener("abort", cancel, { once: true });
  });
}
