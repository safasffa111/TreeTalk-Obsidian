import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRequestDeadline,
  RequestTimeoutError,
  runWithRequestDeadline,
  waitForRetry
} from "../../src/providers/request-control";

describe("request control", () => {
  afterEach(() => vi.useRealTimers());

  it("releases a buffered operation immediately when the caller aborts", async () => {
    const caller = new AbortController();
    const pending = runWithRequestDeadline(
      () => new Promise<never>(() => undefined),
      caller.signal,
      60_000
    );

    caller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("reports deadline expiry separately from caller cancellation", async () => {
    vi.useFakeTimers();
    const pending = runWithRequestDeadline(
      () => new Promise<never>(() => undefined),
      new AbortController().signal,
      25
    );
    const rejection = expect(pending).rejects.toBeInstanceOf(
      RequestTimeoutError
    );

    await vi.advanceTimersByTimeAsync(25);

    await rejection;
  });

  it("aborts retry waiting before its timer completes", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const pending = waitForRetry(300, caller.signal);

    caller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("aborts one linked signal when the streaming deadline expires", () => {
    vi.useFakeTimers();
    const deadline = createRequestDeadline(
      new AbortController().signal,
      25
    );

    vi.advanceTimersByTime(25);

    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.timedOut).toBe(true);
    deadline.dispose();
  });
});
