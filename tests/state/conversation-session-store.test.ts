import { describe, expect, it, vi } from "vitest";
import { ConversationSessionStore } from "../../src/state/conversation-session-store";
import { validConversation } from "../fixtures";

describe("ConversationSessionStore", () => {
  it("publishes immutable conversation updates", () => {
    const store = new ConversationSessionStore(validConversation());
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.update((conversation) => ({ ...conversation, title: "Changed" }));
    expect(store.getSnapshot().title).toBe("Changed");
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it("switches the current node without mutating the previous snapshot", () => {
    const initial = validConversation();
    const store = new ConversationSessionStore(initial);
    store.selectNode("root");
    expect(store.getSnapshot().currentNodeId).toBe("root");
    expect(initial.currentNodeId).toBe("child");
  });
});
