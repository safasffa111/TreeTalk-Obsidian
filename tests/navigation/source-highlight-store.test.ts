import { describe, expect, it, vi } from "vitest";
import { SourceHighlightStore } from "../../src/navigation/source-highlight-store";

const target = {
  conversationId: "conversation-1",
  nodeId: "node-1",
  messageId: "message-1"
};

describe("SourceHighlightStore", () => {
  it("publishes one navigation target to current subscribers", () => {
    const store = new SourceHighlightStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.publish(target);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(target);
    unsubscribe();
    store.publish({ ...target, nodeId: "node-2" });
    expect(listener).toHaveBeenCalledOnce();
  });
});
