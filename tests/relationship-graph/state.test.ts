import { describe, expect, it } from "vitest";
import type { ConversationFile } from "../../src/domain/types";
import {
  setRelationshipNodePositions,
  setRelationshipNodeIncluded,
  setRelationshipGraphNodeIncluded
} from "../../src/relationship-graph/state";

const conversation = {
  id: "space-a",
  nodes: {
    root: { id: "root", childIds: ["child"] },
    child: { id: "child", childIds: [] }
  }
} as unknown as ConversationFile;

describe("relationship graph compatibility state", () => {
  it("writes positions without changing the persisted protocol", () => {
    const state = setRelationshipNodePositions(undefined, {
      "conversation:root": { x: 10, y: 20, fixed: false }
    });
    expect(state.protocol).toBe("deposit-graph:v1");
    expect(state.nodePositions["conversation:root"]).toEqual({ x: 10, y: 20, fixed: false });
  });

  it("cascades a disabled conversation node to descendants", () => {
    const state = setRelationshipNodeIncluded(conversation, undefined, "root", false);
    expect(state.nodeStates.root?.included).toBe(false);
    expect(state.nodeStates.child?.included).toBe(false);
  });

  it("toggles a stable note graph node without changing the protocol", () => {
    const id = "note:Notes/example.md";
    const disabled = setRelationshipGraphNodeIncluded(undefined, id, false);
    expect(disabled.protocol).toBe("deposit-graph:v1");
    expect(disabled.nodeStates[id]?.included).toBe(false);
    const enabled = setRelationshipGraphNodeIncluded(disabled, id, true);
    expect(enabled.nodeStates[id]?.included).toBe(true);
  });
});
