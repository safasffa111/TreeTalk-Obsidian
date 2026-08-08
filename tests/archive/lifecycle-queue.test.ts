import { describe, expect, it } from "vitest";
import { LifecycleQueue } from "../../src/archive/lifecycle-queue";

describe("LifecycleQueue", () => {
  it("does not start reconciliation until an active move finishes", async () => {
    const queue = new LifecycleQueue();
    const events: string[] = [];
    let releaseMove: (() => void) | undefined;
    let reportStarted: (() => void) | undefined;
    const moveStarted = new Promise<void>((resolve) => {
      reportStarted = resolve;
    });
    const move = queue.run(async () => {
      events.push("move-start");
      reportStarted?.();
      await new Promise<void>((resolve) => {
        releaseMove = resolve;
      });
      events.push("move-end");
    });
    const reconcile = queue.run(() => {
      events.push("reconcile");
      return Promise.resolve();
    });
    await moveStarted;
    expect(events).toEqual(["move-start"]);

    releaseMove?.();
    await Promise.all([move, reconcile]);

    expect(events).toEqual(["move-start", "move-end", "reconcile"]);
  });
});
