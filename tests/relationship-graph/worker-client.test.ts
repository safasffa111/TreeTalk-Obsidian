import { describe, expect, it, vi } from "vitest";
import { RelationshipGraphWorkerClient } from "../../src/relationship-graph/worker-client";
import type { RelationshipGraphWorkerFrame } from "../../src/relationship-graph/protocol";

class FakeWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly postMessage = vi.fn<(message: unknown, transfer?: Transferable[]) => void>();
  readonly terminate = vi.fn();
}

describe("relationship graph Worker client", () => {
  it("coalesces topology updates and ignores stale frames", async () => {
    const worker = new FakeWorker();
    const onFrame = vi.fn<(frame: RelationshipGraphWorkerFrame) => void>();
    const client = new RelationshipGraphWorkerClient({
      sessionId: "space-a",
      worker,
      onFrame,
      onError: vi.fn()
    });
    client.updateTopology({
      nodes: [{ id: "a" }],
      links: []
    });
    client.updateTopology({
      nodes: [{ id: "a" }, { id: "b" }],
      links: [{ id: "a-b", sourceId: "a", targetId: "b" }]
    });
    await Promise.resolve();
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    expect(worker.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "init",
      revision: 2,
      nodes: [{ id: "a" }, { id: "b" }]
    }));
    worker.onmessage?.({
      data: { sessionId: "old", revision: 1, positions: {}, active: false }
    } as MessageEvent);
    expect(onFrame).not.toHaveBeenCalled();
  });

  it("sends the current viewport to the Worker", () => {
    const worker = new FakeWorker();
    const client = new RelationshipGraphWorkerClient({ sessionId: "space-a", worker, onFrame: vi.fn(), onError: vi.fn() });
    client.resize(1000, 600);
    expect(worker.postMessage).toHaveBeenCalledWith({ type: "viewport", sessionId: "space-a", width: 1000, height: 600 });
    client.destroy();
  });

  it("uses topology IDs once, exposes typed samples, and returns transfer buffers", () => {
    const worker = new FakeWorker();
    const onFrame = vi.fn<(frame: RelationshipGraphWorkerFrame) => void>();
    const client = new RelationshipGraphWorkerClient({ sessionId: "space-a", worker, onFrame, onError: vi.fn() });
    client.updateTopology({ nodes: [{ id: "a" }], links: [] });
    return Promise.resolve().then(() => {
      worker.onmessage?.({ data: { type: "topology", sessionId: "space-a", revision: 1, positionIds: ["a"] } } as MessageEvent);
      const firstBuffer = new Float32Array([1, 2]).buffer;
      const secondBuffer = new Float32Array([3, 4]).buffer;
      worker.onmessage?.({ data: { type: "positions", sessionId: "space-a", revision: 1, sequence: 1, timestamp: 10, active: true, positionBuffer: firstBuffer } } as MessageEvent);
      worker.onmessage?.({ data: { type: "positions", sessionId: "space-a", revision: 1, sequence: 2, timestamp: 43, active: true, positionBuffer: secondBuffer } } as MessageEvent);
      const first = onFrame.mock.calls[0]?.[0].positions;
      const second = onFrame.mock.calls[1]?.[0].positions;
      expect(second).toBe(first);
      expect([...onFrame.mock.calls[1]?.[0].values ?? []]).toEqual([3, 4]);
      expect(worker.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "return-buffer", positionBuffer: firstBuffer }),
        [firstBuffer]
      );
      client.destroy();
    });
  });

  it("coalesces drag moves to the latest point in the current task", async () => {
    const worker = new FakeWorker();
    const client = new RelationshipGraphWorkerClient({ sessionId: "space-a", worker, onFrame: vi.fn(), onError: vi.fn() });
    client.dragMove("a", 1, 2);
    client.dragMove("a", 3, 4);
    client.dragMove("a", 5, 6);
    expect(worker.postMessage).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(worker.postMessage).toHaveBeenCalledOnce();
    expect(worker.postMessage).toHaveBeenCalledWith({ type: "drag-move", sessionId: "space-a", nodeId: "a", x: 5, y: 6 });
    client.destroy();
  });
});

it("allocates shared state with topology and uses one Worker wake signal for shared dragging", async () => {
  const worker = new FakeWorker();
  const client = new RelationshipGraphWorkerClient({
    sessionId: "space-shared",
    worker,
    onFrame: vi.fn(),
    onError: vi.fn(),
    sharedMemory: true
  });
  client.updateTopology({ nodes: [{ id: "a" }, { id: "b" }], links: [] });
  await Promise.resolve();
  const init = worker.postMessage.mock.calls[0]?.[0] as { sharedMemory?: unknown } | undefined;
  expect(init?.sharedMemory).toBeDefined();
  expect(client.sharedState()?.nodeIds).toEqual(["a", "b"]);
  worker.postMessage.mockClear();
  client.dragStart("b", 10, 20);
  client.dragMove("b", 30, 40);
  client.dragEnd("b");
  expect(worker.postMessage).toHaveBeenCalledOnce();
  expect(worker.postMessage).toHaveBeenCalledWith({
    type: "drag-start",
    sessionId: "space-shared",
    nodeId: "b",
    x: 10,
    y: 20
  });
  client.destroy();
});


it("forwards a shared activity transition so the display RAF can restart", async () => {
  const worker = new FakeWorker();
  const onSharedActivity = vi.fn();
  const client = new RelationshipGraphWorkerClient({
    sessionId: "space-shared-activity",
    worker,
    onFrame: vi.fn(),
    onError: vi.fn(),
    onSharedActivity,
    sharedMemory: true
  });
  client.updateTopology({ nodes: [{ id: "a" }], links: [] });
  await Promise.resolve();
  worker.onmessage?.({
    data: { type: "shared-activity", sessionId: "space-shared-activity", revision: 1, sequence: 2 }
  } as MessageEvent);
  expect(onSharedActivity).toHaveBeenCalledOnce();
  client.destroy();
});
