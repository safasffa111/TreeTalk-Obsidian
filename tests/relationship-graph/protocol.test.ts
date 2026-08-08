import { describe, expect, it } from "vitest";
import { parseRelationshipGraphWorkerFrame } from "../../src/relationship-graph/protocol";

describe("relationship graph Worker protocol", () => {
  it("rejects a frame from another session", () => {
    expect(() =>
      parseRelationshipGraphWorkerFrame(
        { sessionId: "old", revision: 1, positions: {}, active: false },
        "current",
        0
      )
    ).toThrow("stale session");
  });

  it("rejects frames that do not advance the topology revision", () => {
    expect(() =>
      parseRelationshipGraphWorkerFrame(
        { sessionId: "current", revision: 2, positions: {}, active: false },
        "current",
        2
      )
    ).toThrow("stale revision");
  });

  it("accepts only finite position coordinates", () => {
    const frame = parseRelationshipGraphWorkerFrame(
      {
        sessionId: "current",
        revision: 3,
        positions: { "conversation:root": { x: 4, y: -8, fixed: false } },
        active: true
      },
      "current",
      2
    );
    expect(frame.positions["conversation:root"]).toEqual({ x: 4, y: -8, fixed: false });
  });

  it("parses compact Worker position buffers using topology IDs cached by the client", () => {
    const target: Record<string, { x: number; y: number; fixed: boolean }> = {
      a: { x: 0, y: 0, fixed: true }
    };
    const first = parseRelationshipGraphWorkerFrame(
      { type: "positions", sessionId: "current", revision: 3, sequence: 7, timestamp: 120, positionBuffer: new Float32Array([4, -8, 12, 16]).buffer, active: true },
      "current",
      2,
      target,
      ["a", "b"]
    );
    const second = parseRelationshipGraphWorkerFrame(
      { type: "positions", sessionId: "current", revision: 4, sequence: 8, timestamp: 153, positionBuffer: new Float32Array([5, -9, 13, 17]).buffer, active: true },
      "current",
      3,
      target,
      ["a", "b"]
    );
    expect(second.positions).toBe(first.positions);
    expect(second.sequence).toBe(8);
    expect(second.receivedAt).toBe(153);
    if (second.values === undefined) throw new Error("missing packed values");
    expect([...second.values]).toEqual([5, -9, 13, 17]);
    expect(second.positions.a).toEqual({ x: 5, y: -9, fixed: false });
    expect(second.positions.b).toEqual({ x: 13, y: 17, fixed: false });
  });

  it("rejects a packed frame whose topology IDs do not match its buffer", () => {
    expect(() => parseRelationshipGraphWorkerFrame(
      { type: "positions", sessionId: "current", revision: 3, sequence: 1, timestamp: 0, positionBuffer: new Float32Array([1, 2, 3, 4]).buffer, active: true },
      "current",
      2,
      {},
      ["a"]
    )).toThrow("length");
  });
});
