import { describe, expect, it, vi } from "vitest";
import { RelationshipGraphWorkerRuntime } from "../../src/relationship-graph/worker-runtime";
import { createRelationshipGraphSharedMemory, RelationshipGraphSharedMemoryReader, RelationshipGraphSharedDragWriter } from "../../src/relationship-graph/shared-memory";

describe("relationship graph Worker runtime", () => {
  it("publishes topology IDs once and reusable position buffers without strings", () => {
    let nextTimer = 1;
    let now = 0;
    const timers = new Map<number, () => void>();
    const postMessage = vi.fn();
    const runtime = new RelationshipGraphWorkerRuntime({
      postMessage,
      now: () => now,
      setInterval: (callback) => {
        const id = nextTimer++;
        timers.set(id, callback);
        return id;
      },
      clearInterval: (id) => timers.delete(id)
    });
    runtime.handle({
      type: "init",
      sessionId: "space-a",
      revision: 1,
      nodes: [{ id: "a" }],
      links: []
    });
    const callback = [...timers.values()][0];
    const topologyEvent = postMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(topologyEvent).toMatchObject({ type: "topology", sessionId: "space-a", revision: 1, positionIds: ["a"] });
    const publishedBuffers = new Set<ArrayBuffer>();
    for (let index = 0; index < 8; index += 1) {
      now = index * 17;
      callback?.();
      const call = postMessage.mock.calls.at(-1);
      const event = call?.[0] as { type?: string; positionBuffer?: ArrayBuffer } | undefined;
      if (event?.type !== "positions" || event.positionBuffer === undefined) continue;
      expect(event).not.toHaveProperty("positionIds");
      publishedBuffers.add(event.positionBuffer);
      runtime.handle({ type: "return-buffer", sessionId: "space-a", revision: 1, positionBuffer: event.positionBuffer });
    }
    expect(publishedBuffers.size).toBeLessThanOrEqual(2);
    expect(runtime.transferBufferHighWaterMark).toBe(2);
    const positionEvents = postMessage.mock.calls.filter((call) => (call[0] as { type?: string }).type === "positions");
    expect(positionEvents.length).toBeLessThanOrEqual(4);
    runtime.handle({ type: "destroy", sessionId: "space-a" });
    expect(timers.size).toBe(0);
  });

  it("ignores a viewport command from a stale session", () => {
    let nextTimer = 1;
    const timers = new Map<number, () => void>();
    const runtime = new RelationshipGraphWorkerRuntime({
      postMessage: vi.fn(),
      now: () => 0,
      setInterval: (callback) => { const id = nextTimer++; timers.set(id, callback); return id; },
      clearInterval: (id) => timers.delete(id)
    });
    runtime.handle({ type: "init", sessionId: "space-a", revision: 1, nodes: [{ id: "a" }], links: [] });
    const timerCount = timers.size;
    runtime.handle({ type: "viewport", sessionId: "space-b", width: 1000, height: 600 });
    expect(timers.size).toBe(timerCount);
  });
});

it("publishes every shared-mode tick through SharedArrayBuffer without position messages", () => {
  let nextTimer = 1;
  const timers = new Map<number, () => void>();
  const postMessage = vi.fn();
  const sharedMemory = createRelationshipGraphSharedMemory(2, 1);
  const runtime = new RelationshipGraphWorkerRuntime({
    postMessage,
    now: () => 0,
    setInterval: (callback) => { const id = nextTimer++; timers.set(id, callback); return id; },
    clearInterval: (id) => timers.delete(id)
  });
  runtime.handle({
    type: "init",
    sessionId: "space-shared",
    revision: 1,
    nodes: [{ id: "a", x: 10, y: 20 }, { id: "b", x: 30, y: 40 }],
    links: [{ id: "a-b", sourceId: "a", targetId: "b" }],
    sharedMemory
  });
  const tick = [...timers.values()][0];
  tick?.();
  const reader = new RelationshipGraphSharedMemoryReader(sharedMemory);
  const frame = reader.acquire();
  expect(frame?.sequence).toBeGreaterThan(0);
  expect(frame?.values.length).toBe(8);
  frame?.release();
  expect(postMessage.mock.calls.some((call) => (call[0] as { type?: string }).type === "positions")).toBe(false);
  expect(postMessage.mock.calls.filter((call) => (call[0] as { type?: string }).type === "shared-activity")).toHaveLength(1);

  const drag = new RelationshipGraphSharedDragWriter(sharedMemory);
  drag.start(0, 80, 90);
  tick?.();
  const dragged = reader.acquire();
  expect(dragged?.values[0]).toBe(80);
  expect(dragged?.values[1]).toBe(90);
  dragged?.release();
});


it("wakes a cooled shared Worker by consuming the shared drag before scheduling", () => {
  let nextTimer = 1;
  const timers = new Map<number, () => void>();
  const sharedMemory = createRelationshipGraphSharedMemory(1, 1);
  const runtime = new RelationshipGraphWorkerRuntime({
    postMessage: vi.fn(),
    now: () => 0,
    setInterval: (callback) => { const id = nextTimer++; timers.set(id, callback); return id; },
    clearInterval: (id) => timers.delete(id)
  });
  runtime.handle({
    type: "init",
    sessionId: "space-shared-wake",
    revision: 1,
    nodes: [{ id: "a", x: 0, y: 0 }],
    links: [],
    sharedMemory
  });
  for (let iteration = 0; iteration < 1000 && timers.size > 0; iteration += 1) {
    [...timers.values()][0]?.();
  }
  expect(timers.size).toBe(0);

  const drag = new RelationshipGraphSharedDragWriter(sharedMemory);
  drag.start(0, 120, 140);
  runtime.handle({
    type: "drag-start",
    sessionId: "space-shared-wake",
    nodeId: "a",
    x: 120,
    y: 140
  });
  expect(timers.size).toBe(1);
  [...timers.values()][0]?.();

  const reader = new RelationshipGraphSharedMemoryReader(sharedMemory);
  const frame = reader.acquire();
  expect(frame?.values[0]).toBe(120);
  expect(frame?.values[1]).toBe(140);
  frame?.release();
});
