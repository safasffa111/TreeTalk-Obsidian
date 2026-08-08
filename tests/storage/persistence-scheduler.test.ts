import { afterEach, describe, expect, it, vi } from "vitest";
import { BatchedPersistenceScheduler } from "../../src/storage/persistence-scheduler";

afterEach(() => vi.useRealTimers());

describe("BatchedPersistenceScheduler", () => {
  it("coalesces rapid streaming updates into one persistence pass", () => {
    vi.useFakeTimers();
    const persist = vi.fn();
    const scheduler = new BatchedPersistenceScheduler(persist, 100);

    scheduler.schedule();
    scheduler.schedule();
    scheduler.schedule();
    vi.advanceTimersByTime(99);
    expect(persist).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(persist).toHaveBeenCalledOnce();
  });

  it("flushes a pending pass before plugin shutdown", () => {
    vi.useFakeTimers();
    const persist = vi.fn();
    const scheduler = new BatchedPersistenceScheduler(persist, 100);
    scheduler.schedule();

    scheduler.flush();

    expect(persist).toHaveBeenCalledOnce();
    vi.runAllTimers();
    expect(persist).toHaveBeenCalledOnce();
  });
});
