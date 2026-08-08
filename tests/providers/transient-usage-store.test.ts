import { describe, expect, it, vi } from "vitest";
import {
  shouldDisplayTokenStats,
  TransientUsageStore
} from "../../src/providers/transient-usage-store";

describe("transient usage statistics", () => {
  it("uses the approved visibility thresholds", () => {
    expect(
      shouldDisplayTokenStats({
        reducedTokens: 255,
        reductionRatio: 0.049,
        cacheHitTokens: 0
      })
    ).toBe(false);
    expect(
      shouldDisplayTokenStats({
        reducedTokens: 256,
        reductionRatio: 0.01,
        cacheHitTokens: 0
      })
    ).toBe(true);
    expect(
      shouldDisplayTokenStats({
        mode: "balanced",
        reducedTokens: 0,
        reductionRatio: 0,
        cacheHitTokens: 1
      })
    ).toBe(true);
    expect(
      shouldDisplayTokenStats({
        mode: "full",
        sentEstimatedTokens: 80,
        reducedTokens: 0,
        reductionRatio: 0
      })
    ).toBe(true);
  });

  it("keeps records only in memory and notifies views", () => {
    const store = new TransientUsageStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.set("message", {
      mode: "balanced",
      fullEstimatedTokens: 1000,
      sentEstimatedTokens: 700,
      reducedTokens: 300,
      reductionRatio: 0.3
    });

    expect(store.get("message")?.reducedTokens).toBe(300);
    expect(listener).toHaveBeenCalledTimes(1);
    store.clear();
    expect(store.get("message")).toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
