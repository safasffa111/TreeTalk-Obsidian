import { describe, expect, it, vi } from "vitest";
import { TransientResponseStatusStore } from "../../src/providers/transient-response-status-store";

describe("transient response status", () => {
  it("isolates status by assistant message and notifies subscribers", () => {
    const store = new TransientResponseStatusStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.set("assistant-a", "thinking");
    store.set("assistant-b", "searching-web");

    expect(store.get("assistant-a")).toEqual({ status: "thinking" });
    expect(store.get("assistant-b")).toEqual({ status: "searching-web" });
    expect(listener).toHaveBeenCalledTimes(2);

    store.delete("assistant-a");
    expect(store.get("assistant-a")).toBeUndefined();
    expect(store.get("assistant-b")).toEqual({ status: "searching-web" });

    store.clear();
    expect(store.get("assistant-b")).toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(4);
    unsubscribe();
  });
});
