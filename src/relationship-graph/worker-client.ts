import { parseRelationshipGraphWorkerFrame } from "./protocol";
import { embeddedRelationshipGraphWorkerSource } from "./worker-source";
import { logWarning } from "../utils/error-log";
import type {
  RelationshipGraphWorkerCommand,
  RelationshipGraphWorkerFrame
} from "./protocol";
import type { RelationshipGraphWorkerLinkInput, RelationshipGraphWorkerNodeInput } from "./worker-core";
import type { DepositGraphPosition } from "../domain/types";
import {
  RelationshipGraphSharedDragWriter,
  RelationshipGraphSharedMemoryReader,
  RelationshipGraphSharedMemoryWriter,
  createRelationshipGraphSharedMemory,
  relationshipGraphSharedMemorySupported,
  type RelationshipGraphSharedMemoryDescriptor
} from "./shared-memory";

export interface RelationshipGraphWorkerPort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: RelationshipGraphWorkerCommand, transfer?: Transferable[]): void;
  terminate(): void;
}

interface RelationshipGraphWorkerEnvironment {
  Worker: typeof Worker;
  Blob: typeof Blob;
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

function browserEnvironment(): RelationshipGraphWorkerEnvironment {
  return {
    Worker,
    Blob,
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url)
  };
}

export function createRelationshipGraphWorker(
  environment = browserEnvironment()
): RelationshipGraphWorkerPort {
  const blob = new environment.Blob([embeddedRelationshipGraphWorkerSource], { type: "text/javascript" });
  const url = environment.createObjectURL(blob);
  try {
    return new environment.Worker(url, { name: "TreeTalk Relationship Graph" });
  } finally {
    environment.revokeObjectURL(url);
  }
}

export interface RelationshipGraphWorkerClientOptions {
  sessionId: string;
  worker?: RelationshipGraphWorkerPort;
  onFrame(frame: RelationshipGraphWorkerFrame): void;
  onError(message: string): void;
  onSharedActivity?(): void;
  /** Disable only for compatibility tests or runtimes without SharedArrayBuffer. */
  sharedMemory?: boolean;
  sharedMemoryFactory?(nodeCount: number, revision: number): RelationshipGraphSharedMemoryDescriptor;
}

export interface RelationshipGraphTopologyInput {
  nodes: RelationshipGraphWorkerNodeInput[];
  links: RelationshipGraphWorkerLinkInput[];
}

interface PendingTopology extends RelationshipGraphTopologyInput {
  sharedMemory?: RelationshipGraphSharedMemoryDescriptor;
}

export interface RelationshipGraphWorkerSharedState {
  readonly revision: number;
  readonly nodeIds: readonly string[];
  readonly reader: RelationshipGraphSharedMemoryReader;
}

export class RelationshipGraphWorkerClient {
  private readonly worker: RelationshipGraphWorkerPort;
  private latestRevision = 0;
  private pending: PendingTopology | undefined;
  private queued = false;
  private destroyed = false;
  private hasInitialized = false;
  private readonly positions: Record<string, DepositGraphPosition> = {};
  private nodeIds = new Set<string>();
  private orderedNodeIds: string[] = [];
  private readonly nodeIndexById = new Map<string, number>();
  private latestSequence = 0;
  private readonly pendingDragMoves = new Map<string, { x: number; y: number }>();
  private dragMoveQueued = false;
  private sharedDescriptor: RelationshipGraphSharedMemoryDescriptor | undefined;
  private sharedReader: RelationshipGraphSharedMemoryReader | undefined;
  private sharedDragWriter: RelationshipGraphSharedDragWriter | undefined;
  private latestFallbackActive = false;
  private frameFailureWarned = false;

  constructor(private readonly options: RelationshipGraphWorkerClientOptions) {
    this.worker = options.worker ?? createRelationshipGraphWorker();
    this.worker.onmessage = (event) => this.handleMessage(event.data);
    this.worker.onerror = (event) => {
      if (!this.destroyed) {
        this.sharedReader?.markDestroyed();
        options.onError(event.message);
      }
    };
  }

  updateTopology(topology: RelationshipGraphTopologyInput): number {
    if (this.destroyed) return this.latestRevision;
    const revision = ++this.latestRevision;
    this.latestSequence = 0;
    this.sharedReader?.markDestroyed();
    this.sharedDescriptor = this.createSharedDescriptor(topology.nodes.length, revision);
    this.sharedReader = this.sharedDescriptor === undefined ? undefined : new RelationshipGraphSharedMemoryReader(this.sharedDescriptor);
    this.sharedDragWriter = this.sharedDescriptor === undefined ? undefined : new RelationshipGraphSharedDragWriter(this.sharedDescriptor);
    if (this.sharedDescriptor !== undefined) {
      const seedWriter = new RelationshipGraphSharedMemoryWriter(this.sharedDescriptor);
      const lease = seedWriter.beginWrite();
      if (lease !== undefined) {
        lease.values.fill(0);
        topology.nodes.forEach((node, index) => {
          const offset = index * 4;
          lease.values[offset] = node.x ?? 0;
          lease.values[offset + 1] = node.y ?? 0;
          lease.values[offset + 3] = 1;
        });
        seedWriter.publish(lease, true);
      }
    }
    this.pending = { ...topology, ...(this.sharedDescriptor === undefined ? {} : { sharedMemory: this.sharedDescriptor }) };
    this.nodeIds = new Set(topology.nodes.map((node) => node.id));
    this.orderedNodeIds = topology.nodes.map((node) => node.id);
    this.nodeIndexById.clear();
    this.orderedNodeIds.forEach((id, index) => this.nodeIndexById.set(id, index));
    if (!this.queued) {
      this.queued = true;
      queueMicrotask(() => this.flush());
    }
    return revision;
  }

  sharedState(): RelationshipGraphWorkerSharedState | undefined {
    if (this.sharedReader === undefined) return undefined;
    return { revision: this.latestRevision, nodeIds: this.orderedNodeIds, reader: this.sharedReader };
  }

  isPhysicsActive(): boolean {
    return this.sharedReader?.active ?? this.latestFallbackActive;
  }

  dragStart(nodeId: string, x: number, y: number): void {
    const index = this.nodeIndexById.get(nodeId);
    if (this.sharedDragWriter !== undefined && index !== undefined) {
      this.sharedDragWriter.start(index, x, y);
      // Coordinates live in shared memory; this lightweight command only wakes a cooled Worker.
      this.post({ type: "drag-start", sessionId: this.options.sessionId, nodeId, x, y });
      return;
    }
    this.post({ type: "drag-start", sessionId: this.options.sessionId, nodeId, x, y });
  }

  dragMove(nodeId: string, x: number, y: number): void {
    const index = this.nodeIndexById.get(nodeId);
    if (this.sharedDragWriter !== undefined && index !== undefined) {
      this.sharedDragWriter.move(index, x, y);
      return;
    }
    this.pendingDragMoves.set(nodeId, { x, y });
    if (this.dragMoveQueued) return;
    this.dragMoveQueued = true;
    queueMicrotask(() => this.flushDragMoves());
  }

  dragEnd(nodeId: string): void {
    const index = this.nodeIndexById.get(nodeId);
    if (this.sharedDragWriter !== undefined && index !== undefined) {
      this.sharedDragWriter.end(index);
      return;
    }
    this.flushDragMoves();
    this.post({ type: "drag-end", sessionId: this.options.sessionId, nodeId });
  }

  resize(width: number, height: number): void {
    this.post({ type: "viewport", sessionId: this.options.sessionId, width, height });
  }
  pause(): void { this.post({ type: "pause", sessionId: this.options.sessionId }); }
  resume(): void { this.post({ type: "resume", sessionId: this.options.sessionId }); }
  retry(): void { this.post({ type: "retry", sessionId: this.options.sessionId }); }

  destroy(): void {
    if (this.destroyed) return;
    this.sharedReader?.markDestroyed();
    this.post({ type: "destroy", sessionId: this.options.sessionId });
    this.destroyed = true;
    this.pending = undefined;
    this.pendingDragMoves.clear();
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.terminate();
  }

  private createSharedDescriptor(nodeCount: number, revision: number): RelationshipGraphSharedMemoryDescriptor | undefined {
    if (this.options.sharedMemory === false || !relationshipGraphSharedMemorySupported()) return undefined;
    return this.options.sharedMemoryFactory?.(nodeCount, revision) ?? createRelationshipGraphSharedMemory(nodeCount, revision);
  }

  private flush(): void {
    this.queued = false;
    const topology = this.pending;
    this.pending = undefined;
    if (this.destroyed || topology === undefined) return;
    this.post({
      type: this.hasInitialized ? "topology" : "init",
      sessionId: this.options.sessionId,
      revision: this.latestRevision,
      nodes: topology.nodes,
      links: topology.links,
      ...(topology.sharedMemory === undefined ? {} : { sharedMemory: topology.sharedMemory })
    });
    this.hasInitialized = true;
  }

  private post(command: RelationshipGraphWorkerCommand, transfer?: Transferable[]): void {
    if (this.destroyed) return;
    if (transfer === undefined) this.worker.postMessage(command);
    else this.worker.postMessage(command, transfer);
  }

  private handleMessage(value: unknown): void {
    if (this.destroyed || (typeof value === "object" && value !== null && (value as { type?: unknown }).type === "error")) {
      if (!this.destroyed && typeof value === "object" && value !== null) {
        this.sharedReader?.markDestroyed();
        const message = (value as { message?: unknown }).message;
        this.options.onError(typeof message === "string" ? message : "Worker error");
      }
      return;
    }
    try {
      const source = value as { type?: unknown; sessionId?: unknown; revision?: unknown; positionIds?: unknown; positionBuffer?: unknown; sequence?: unknown };
      if (source.type === "shared-activity") {
        if (source.sessionId === this.options.sessionId && source.revision === this.latestRevision) {
          this.options.onSharedActivity?.();
        }
        return;
      }
      if (source.type === "topology") {
        if (source.sessionId !== this.options.sessionId || source.revision !== this.latestRevision || !Array.isArray(source.positionIds)) return;
        if (!source.positionIds.every((id) => typeof id === "string")) return;
        this.orderedNodeIds = [...source.positionIds];
        this.nodeIndexById.clear();
        this.orderedNodeIds.forEach((id, index) => this.nodeIndexById.set(id, index));
        return;
      }
      if (typeof value === "object" && value !== null && typeof (value as { revision?: unknown }).revision === "number" && (value as { revision: number }).revision < this.latestRevision) return;
      const frame = parseRelationshipGraphWorkerFrame(value, this.options.sessionId, this.latestRevision - 1, this.positions, this.orderedNodeIds);
      if (frame.revision < this.latestRevision) return;
      const sequence = frame.sequence ?? 0;
      if (sequence <= this.latestSequence) return;
      this.latestSequence = sequence;
      this.latestFallbackActive = frame.active;
      for (const nodeId of Object.keys(this.positions)) {
        if (!this.nodeIds.has(nodeId)) Reflect.deleteProperty(this.positions, nodeId);
      }
      try {
        this.options.onFrame(frame);
      } finally {
        if (source.positionBuffer instanceof ArrayBuffer) {
          this.post({
            type: "return-buffer",
            sessionId: this.options.sessionId,
            revision: frame.revision,
            positionBuffer: source.positionBuffer
          }, [source.positionBuffer]);
        }
      }
    } catch (error) {
      if (!this.frameFailureWarned) {
        this.frameFailureWarned = true;
        logWarning("图谱帧处理失败", error);
      }
      return;
    }
  }

  private flushDragMoves(): void {
    this.dragMoveQueued = false;
    if (this.destroyed || this.pendingDragMoves.size === 0) return;
    const moves = [...this.pendingDragMoves];
    this.pendingDragMoves.clear();
    for (const [nodeId, point] of moves) {
      this.post({ type: "drag-move", sessionId: this.options.sessionId, nodeId, x: point.x, y: point.y });
    }
  }
}
