import {
  RelationshipGraphForceCore,
  RELATIONSHIP_GRAPH_ALPHA_MIN
} from "./worker-core";
import type { RelationshipGraphWorkerCommand } from "./protocol";
import {
  RelationshipGraphSharedDragReader,
  RelationshipGraphSharedMemoryWriter
} from "./shared-memory";

export interface RelationshipGraphWorkerRuntimePort {
  postMessage(event: unknown, transfer?: Transferable[]): void;
  now(): number;
  setInterval(callback: () => void, delay: number): number;
  clearInterval(id: number): void;
}

export class RelationshipGraphWorkerRuntime {
  private readonly core = new RelationshipGraphForceCore();
  private timerId: number | undefined;
  private paused = false;
  private destroyed = false;
  private sessionId = "";
  private availableBuffers: ArrayBuffer[] = [];
  private expectedBufferBytes = 0;
  private sequence = 0;
  private lastPublishedAt = Number.NEGATIVE_INFINITY;
  private allocatedTransferBuffers = 0;
  private sharedWriter: RelationshipGraphSharedMemoryWriter | undefined;
  private sharedDragReader: RelationshipGraphSharedDragReader | undefined;
  private sharedDraggedNodeIndex = -1;
  private lastSharedActive = false;

  get transferBufferHighWaterMark(): number { return this.allocatedTransferBuffers; }
  get sharedMode(): boolean { return this.sharedWriter !== undefined; }

  constructor(private readonly port: RelationshipGraphWorkerRuntimePort) {}

  handle(value: unknown): void {
    if (this.destroyed || typeof value !== "object" || value === null) return;
    const command = value as RelationshipGraphWorkerCommand;
    if (typeof command.sessionId !== "string") return;
    if (command.type !== "init" && command.sessionId !== this.sessionId) return;
    try {
      switch (command.type) {
        case "init":
        case "topology":
          this.sessionId = command.sessionId;
          this.core.reconcile(command.revision, command.nodes, command.links);
          this.configureTransport(command.sharedMemory, this.core.nodeIds().length);
          this.port.postMessage({
            type: "topology",
            sessionId: this.sessionId,
            revision: this.core.revision(),
            positionIds: this.core.nodeIds(),
            shared: this.sharedMode
          });
          this.publishSharedFrame();
          this.ensureTimer();
          return;
        case "drag-start":
          if (this.sharedMode) this.consumeSharedDrag();
          else this.core.beginDrag(command.nodeId, command.x, command.y);
          this.ensureTimer();
          return;
        case "drag-move":
          if (!this.sharedMode) this.core.moveDrag(command.nodeId, command.x, command.y);
          return;
        case "drag-end":
          if (!this.sharedMode) this.core.endDrag(command.nodeId);
          this.ensureTimer();
          return;
        case "viewport":
          this.core.setViewport(command.width, command.height);
          this.ensureTimer();
          return;
        case "pause":
          this.paused = true;
          this.sharedWriter?.setPaused(true);
          this.lastSharedActive = false;
          this.clearTimer();
          return;
        case "resume":
        case "retry":
          this.paused = false;
          this.sharedWriter?.setPaused(false);
          this.publishSharedFrame();
          this.ensureTimer();
          return;
        case "return-buffer":
          if (
            !this.sharedMode &&
            command.revision === this.core.revision() &&
            command.positionBuffer.byteLength === this.expectedBufferBytes
          ) {
            this.availableBuffers.push(command.positionBuffer);
          }
          return;
        case "destroy":
          this.destroyed = true;
          this.sharedWriter?.markDestroyed();
          this.clearTimer();
          return;
      }
    } catch (error) {
      this.port.postMessage({ sessionId: this.sessionId, type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  private configureTransport(
    descriptor: Extract<RelationshipGraphWorkerCommand, { type: "init" | "topology" }>["sharedMemory"],
    nodeCount: number
  ): void {
    this.sharedDraggedNodeIndex = -1;
    this.lastSharedActive = false;
    if (descriptor !== undefined) {
      this.sharedWriter?.markDestroyed();
      this.sharedWriter = new RelationshipGraphSharedMemoryWriter(descriptor);
      this.sharedDragReader = new RelationshipGraphSharedDragReader(descriptor);
      this.availableBuffers = [];
      this.expectedBufferBytes = 0;
      this.allocatedTransferBuffers = 0;
      return;
    }
    this.sharedWriter = undefined;
    this.sharedDragReader = undefined;
    this.resetTransferBuffers(nodeCount);
  }

  private ensureTimer(): void {
    if (this.destroyed || this.paused || !this.core.isActive() || this.timerId !== undefined) return;
    this.timerId = this.port.setInterval(() => this.tick(), 1000 / 60);
  }

  private clearTimer(): void {
    if (this.timerId === undefined) return;
    this.port.clearInterval(this.timerId);
    this.timerId = undefined;
  }

  private tick(): void {
    if (this.destroyed || this.paused) return;
    this.consumeSharedDrag();
    this.core.tick();
    if (this.sharedWriter !== undefined) {
      this.publishSharedFrame();
    } else {
      const now = this.port.now();
      const publishInterval = this.core.isAmbient() ? 50 : 1000 / 30;
      if (now - this.lastPublishedAt >= publishInterval) this.publishFallback(now);
    }
    if (!this.core.isActive()) this.clearTimer();
  }

  private consumeSharedDrag(): void {
    const state = this.sharedDragReader?.consume();
    if (state === undefined) return;
    if (!state.active) {
      if (this.sharedDraggedNodeIndex >= 0) this.core.endDragIndex(this.sharedDraggedNodeIndex);
      this.sharedDraggedNodeIndex = -1;
      return;
    }
    if (state.nodeIndex !== this.sharedDraggedNodeIndex) {
      if (this.sharedDraggedNodeIndex >= 0) this.core.endDragIndex(this.sharedDraggedNodeIndex);
      if (this.core.beginDragIndex(state.nodeIndex, state.x, state.y)) this.sharedDraggedNodeIndex = state.nodeIndex;
      return;
    }
    this.core.moveDragIndex(state.nodeIndex, state.x, state.y);
  }

  private publishSharedFrame(): void {
    const writer = this.sharedWriter;
    if (writer === undefined) return;
    const lease = writer.beginWrite();
    if (lease === undefined) return;
    this.core.writeSharedPositions(lease.values);
    const active = this.core.isActive();
    const sequence = writer.publish(lease, active);
    if (active && !this.lastSharedActive) {
      this.port.postMessage({
        type: "shared-activity",
        sessionId: this.sessionId,
        revision: this.core.revision(),
        sequence
      });
    }
    this.lastSharedActive = active;
  }

  private resetTransferBuffers(nodeCount: number): void {
    this.expectedBufferBytes = nodeCount * 2 * Float32Array.BYTES_PER_ELEMENT;
    this.availableBuffers = [
      new ArrayBuffer(this.expectedBufferBytes),
      new ArrayBuffer(this.expectedBufferBytes)
    ];
    this.allocatedTransferBuffers = 2;
    this.sequence = 0;
    this.lastPublishedAt = Number.NEGATIVE_INFINITY;
  }

  private publishFallback(timestamp: number): void {
    const positionBuffer = this.availableBuffers.shift();
    if (positionBuffer === undefined) return;
    this.core.writePackedPositions(new Float32Array(positionBuffer));
    this.lastPublishedAt = timestamp;
    this.port.postMessage({
      type: "positions",
      sessionId: this.sessionId,
      revision: this.core.revision(),
      sequence: ++this.sequence,
      timestamp,
      positionBuffer,
      active: this.core.alpha() >= RELATIONSHIP_GRAPH_ALPHA_MIN
    }, [positionBuffer]);
  }
}
