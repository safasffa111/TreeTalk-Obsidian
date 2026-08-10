import { describe, expect, it } from "vitest";
import { TextDeltaBatcher } from "../../src/execution/text-delta-batcher";

describe("TextDeltaBatcher", () => {
  it("uses a 100 ms default window for canonical stream updates", () => {
    let requestedDelay: number | undefined;
    const batcher = new TextDeltaBatcher(() => undefined, {
      schedule: (_run, delayMs) => {
        requestedDelay = delayMs;
        return 1;
      },
      cancel: () => undefined
    });

    batcher.append("first fragment");

    expect(requestedDelay).toBe(100);
  });

  it("coalesces ordered fragments into one scheduled delivery", () => {
    let scheduled: (() => void) | undefined;
    let scheduleCount = 0;
    const delivered: string[] = [];
    const batcher = new TextDeltaBatcher(
      (text) => delivered.push(text),
      {
        schedule: (run) => {
          scheduleCount += 1;
          scheduled = run;
          return 1;
        },
        cancel: () => undefined
      }
    );

    batcher.append("A");
    batcher.append("B");

    expect(delivered).toEqual([]);
    expect(scheduleCount).toBe(1);
    scheduled?.();
    expect(delivered).toEqual(["AB"]);
  });

  it("flush delivers the remaining suffix exactly once", () => {
    const delivered: string[] = [];
    const batcher = new TextDeltaBatcher((text) => delivered.push(text));

    batcher.append("tail");
    batcher.flush();
    batcher.flush();

    expect(delivered).toEqual(["tail"]);
  });
});
