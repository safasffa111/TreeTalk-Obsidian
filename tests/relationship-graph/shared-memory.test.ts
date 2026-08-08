import { describe, expect, it } from "vitest";
import {
  RELATIONSHIP_GRAPH_POSITION_COMPONENTS,
  RELATIONSHIP_GRAPH_POSITION_PAGE_COUNT,
  RelationshipGraphSharedDragReader,
  RelationshipGraphSharedDragWriter,
  RelationshipGraphSharedMemoryReader,
  RelationshipGraphSharedMemoryWriter,
  createRelationshipGraphSharedMemory
} from "../../src/relationship-graph/shared-memory";

describe("relationship graph shared memory", () => {
  it("allocates three RGBA position pages and exposes a stable published page", () => {
    const descriptor = createRelationshipGraphSharedMemory(2, 7);
    expect(descriptor.pageCount).toBe(RELATIONSHIP_GRAPH_POSITION_PAGE_COUNT);
    expect(descriptor.positionStride).toBe(RELATIONSHIP_GRAPH_POSITION_COMPONENTS);
    const writer = new RelationshipGraphSharedMemoryWriter(descriptor);
    const reader = new RelationshipGraphSharedMemoryReader(descriptor);
    const lease = writer.beginWrite();
    expect(lease).toBeDefined();
    if (lease === undefined) throw new Error("missing write lease");
    lease.values.set([10, 20, 0, 1, 30, 40, 0, 1]);
    writer.publish(lease, true);
    const frame = reader.acquire();
    expect(frame).toBeDefined();
    expect(frame?.revision).toBe(7);
    expect(frame?.active).toBe(true);
    expect([...frame?.values ?? []]).toEqual([10, 20, 0, 1, 30, 40, 0, 1]);
    frame?.release();
  });


  it("does not expose a page while the publish seqlock is odd", () => {
    const descriptor = createRelationshipGraphSharedMemory(1, 1);
    const reader = new RelationshipGraphSharedMemoryReader(descriptor);
    const control = new Int32Array(descriptor.controlBuffer);
    Atomics.store(control, 8, 1);
    expect(reader.acquire()).toBeUndefined();
    Atomics.store(control, 8, 2);
    expect(reader.acquire()).toBeDefined();
  });

  it("never gives the Worker a page held by the renderer", () => {
    const descriptor = createRelationshipGraphSharedMemory(1, 1);
    const writer = new RelationshipGraphSharedMemoryWriter(descriptor);
    const reader = new RelationshipGraphSharedMemoryReader(descriptor);
    const first = writer.beginWrite();
    if (first === undefined) throw new Error("missing first page");
    first.values.set([1, 2, 0, 1]);
    writer.publish(first, true);
    const held = reader.acquire();
    if (held === undefined) throw new Error("missing held page");
    const second = writer.beginWrite();
    expect(second?.pageIndex).not.toBe(held.pageIndex);
    if (second === undefined) throw new Error("missing second page");
    second.values.set([3, 4, 0, 1]);
    writer.publish(second, true);
    const third = writer.beginWrite();
    expect(third?.pageIndex).not.toBe(held.pageIndex);
    held.release();
  });


  it("does not consume drag coordinates while the drag seqlock is odd", () => {
    const descriptor = createRelationshipGraphSharedMemory(1, 1);
    const reader = new RelationshipGraphSharedDragReader(descriptor);
    const interaction = new Int32Array(descriptor.interactionBuffer);
    Atomics.store(interaction, 0, 1);
    Atomics.store(interaction, 3, 1);
    expect(reader.consume()).toBeUndefined();
  });

  it("publishes drag state atomically and preserves the latest point", () => {
    const descriptor = createRelationshipGraphSharedMemory(3, 1);
    const writer = new RelationshipGraphSharedDragWriter(descriptor);
    const reader = new RelationshipGraphSharedDragReader(descriptor);
    writer.start(2, 10, 20);
    writer.move(2, 30, 40);
    const active = reader.consume();
    expect(active).toEqual(expect.objectContaining({ active: true, nodeIndex: 2, x: 30, y: 40 }));
    expect(reader.consume()).toBeUndefined();
    writer.end(2);
    expect(reader.consume()).toEqual(expect.objectContaining({ active: false, nodeIndex: 2 }));
  });
});
