export const RELATIONSHIP_GRAPH_POSITION_COMPONENTS = 4;
export const RELATIONSHIP_GRAPH_POSITION_PAGE_COUNT = 3;

const CONTROL_LENGTH = 12;
const CONTROL_BYTES = CONTROL_LENGTH * Int32Array.BYTES_PER_ELEMENT;
const DRAG_LENGTH = 6;
const DRAG_BYTES = DRAG_LENGTH * Int32Array.BYTES_PER_ELEMENT;

const enum ControlIndex {
  Sequence = 0,
  ActivePage = 1,
  ReaderPage = 2,
  NodeCount = 3,
  Revision = 4,
  PhysicsActive = 5,
  Paused = 6,
  Destroyed = 7,
  PublishEpoch = 8
}

const enum DragIndex {
  Sequence = 0,
  Active = 1,
  NodeIndex = 2,
  PublishEpoch = 3
}

const DRAG_X_FLOAT_INDEX = 4;
const DRAG_Y_FLOAT_INDEX = 5;

export interface RelationshipGraphSharedMemoryDescriptor {
  controlBuffer: SharedArrayBuffer;
  positionBuffer: SharedArrayBuffer;
  interactionBuffer: SharedArrayBuffer;
  nodeCount: number;
  revision: number;
  pageCount: number;
  positionStride: number;
  textureWidth: number;
  textureHeight: number;
}

export interface RelationshipGraphSharedReadLease {
  readonly sequence: number;
  readonly pageIndex: number;
  readonly values: Float32Array;
  readonly active: boolean;
  readonly revision: number;
  release(): void;
}

export interface RelationshipGraphSharedWriteLease {
  readonly pageIndex: number;
  readonly values: Float32Array;
}

export interface RelationshipGraphSharedDragState {
  readonly sequence: number;
  readonly active: boolean;
  readonly nodeIndex: number;
  readonly x: number;
  readonly y: number;
}

export function relationshipGraphSharedMemorySupported(): boolean {
  return typeof SharedArrayBuffer === "function" && typeof Atomics === "object";
}

export function createRelationshipGraphSharedMemory(
  nodeCount: number,
  revision: number,
  SharedBuffer: typeof SharedArrayBuffer = SharedArrayBuffer
): RelationshipGraphSharedMemoryDescriptor {
  const safeNodeCount = Math.max(0, Math.floor(nodeCount));
  const controlBuffer = new SharedBuffer(CONTROL_BYTES);
  const textureWidth = Math.max(1, Math.ceil(Math.sqrt(Math.max(1, safeNodeCount))));
  const textureHeight = Math.max(1, Math.ceil(Math.max(1, safeNodeCount) / textureWidth));
  const pageFloats = textureWidth * textureHeight * RELATIONSHIP_GRAPH_POSITION_COMPONENTS;
  const positionBuffer = new SharedBuffer(
    pageFloats * RELATIONSHIP_GRAPH_POSITION_PAGE_COUNT * Float32Array.BYTES_PER_ELEMENT
  );
  const interactionBuffer = new SharedBuffer(DRAG_BYTES);
  const control = new Int32Array(controlBuffer);
  Atomics.store(control, ControlIndex.Sequence, 0);
  Atomics.store(control, ControlIndex.ActivePage, 0);
  Atomics.store(control, ControlIndex.ReaderPage, -1);
  Atomics.store(control, ControlIndex.NodeCount, safeNodeCount);
  Atomics.store(control, ControlIndex.Revision, revision);
  Atomics.store(control, ControlIndex.PhysicsActive, 0);
  Atomics.store(control, ControlIndex.Paused, 0);
  Atomics.store(control, ControlIndex.Destroyed, 0);
  Atomics.store(control, ControlIndex.PublishEpoch, 0);
  return {
    controlBuffer,
    positionBuffer,
    interactionBuffer,
    nodeCount: safeNodeCount,
    revision,
    pageCount: RELATIONSHIP_GRAPH_POSITION_PAGE_COUNT,
    positionStride: RELATIONSHIP_GRAPH_POSITION_COMPONENTS,
    textureWidth,
    textureHeight
  };
}

export function relationshipGraphSharedPositionPages(descriptor: RelationshipGraphSharedMemoryDescriptor): Float32Array[] {
  const pageFloats = descriptor.textureWidth * descriptor.textureHeight * descriptor.positionStride;
  const pages: Float32Array[] = [];
  for (let page = 0; page < descriptor.pageCount; page += 1) {
    pages.push(new Float32Array(
      descriptor.positionBuffer,
      page * pageFloats * Float32Array.BYTES_PER_ELEMENT,
      pageFloats
    ));
  }
  return pages;
}

export class RelationshipGraphSharedMemoryReader {
  private readonly control: Int32Array;
  private readonly pages: Float32Array[];

  constructor(readonly descriptor: RelationshipGraphSharedMemoryDescriptor) {
    this.control = new Int32Array(descriptor.controlBuffer);
    this.pages = relationshipGraphSharedPositionPages(descriptor);
  }

  get sequence(): number { return Atomics.load(this.control, ControlIndex.Sequence); }
  get active(): boolean { return Atomics.load(this.control, ControlIndex.PhysicsActive) === 1; }
  get paused(): boolean { return Atomics.load(this.control, ControlIndex.Paused) === 1; }
  get destroyed(): boolean { return Atomics.load(this.control, ControlIndex.Destroyed) === 1; }

  acquire(): RelationshipGraphSharedReadLease | undefined {
    if (this.destroyed) return undefined;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const publishEpoch = Atomics.load(this.control, ControlIndex.PublishEpoch);
      if ((publishEpoch & 1) !== 0) continue;
      const sequence = Atomics.load(this.control, ControlIndex.Sequence);
      const pageIndex = Atomics.load(this.control, ControlIndex.ActivePage);
      if (pageIndex < 0 || pageIndex >= this.pages.length) return undefined;
      Atomics.store(this.control, ControlIndex.ReaderPage, pageIndex);
      const confirmedEpoch = Atomics.load(this.control, ControlIndex.PublishEpoch);
      const confirmedSequence = Atomics.load(this.control, ControlIndex.Sequence);
      const confirmedPage = Atomics.load(this.control, ControlIndex.ActivePage);
      if (
        publishEpoch === confirmedEpoch &&
        (confirmedEpoch & 1) === 0 &&
        sequence === confirmedSequence &&
        pageIndex === confirmedPage
      ) {
        let released = false;
        return {
          sequence,
          pageIndex,
          values: this.pages[pageIndex] as Float32Array,
          active: Atomics.load(this.control, ControlIndex.PhysicsActive) === 1,
          revision: Atomics.load(this.control, ControlIndex.Revision),
          release: () => {
            if (released) return;
            released = true;
            Atomics.compareExchange(this.control, ControlIndex.ReaderPage, pageIndex, -1);
          }
        };
      }
      Atomics.compareExchange(this.control, ControlIndex.ReaderPage, pageIndex, -1);
    }
    return undefined;
  }

  markDestroyed(): void {
    Atomics.store(this.control, ControlIndex.Destroyed, 1);
    Atomics.store(this.control, ControlIndex.PhysicsActive, 0);
    Atomics.store(this.control, ControlIndex.ReaderPage, -1);
  }
}

export class RelationshipGraphSharedMemoryWriter {
  private readonly control: Int32Array;
  private readonly pages: Float32Array[];
  private cursor = 0;

  constructor(readonly descriptor: RelationshipGraphSharedMemoryDescriptor) {
    this.control = new Int32Array(descriptor.controlBuffer);
    this.pages = relationshipGraphSharedPositionPages(descriptor);
  }

  beginWrite(): RelationshipGraphSharedWriteLease | undefined {
    if (Atomics.load(this.control, ControlIndex.Destroyed) === 1) return undefined;
    const activePage = Atomics.load(this.control, ControlIndex.ActivePage);
    const readerPage = Atomics.load(this.control, ControlIndex.ReaderPage);
    for (let offset = 1; offset <= this.pages.length; offset += 1) {
      const pageIndex = (this.cursor + offset) % this.pages.length;
      if (pageIndex === activePage || pageIndex === readerPage) continue;
      this.cursor = pageIndex;
      return { pageIndex, values: this.pages[pageIndex] as Float32Array };
    }
    return undefined;
  }

  publish(lease: RelationshipGraphSharedWriteLease, active: boolean): number {
    Atomics.add(this.control, ControlIndex.PublishEpoch, 1);
    Atomics.store(this.control, ControlIndex.PhysicsActive, active ? 1 : 0);
    Atomics.store(this.control, ControlIndex.ActivePage, lease.pageIndex);
    const sequence = Atomics.add(this.control, ControlIndex.Sequence, 1) + 1;
    Atomics.add(this.control, ControlIndex.PublishEpoch, 1);
    return sequence;
  }

  setPaused(paused: boolean): void {
    Atomics.store(this.control, ControlIndex.Paused, paused ? 1 : 0);
    if (paused) Atomics.store(this.control, ControlIndex.PhysicsActive, 0);
  }

  markDestroyed(): void {
    Atomics.store(this.control, ControlIndex.Destroyed, 1);
    Atomics.store(this.control, ControlIndex.PhysicsActive, 0);
  }
}

export class RelationshipGraphSharedDragWriter {
  private readonly integers: Int32Array;
  private readonly floats: Float32Array;

  constructor(descriptor: RelationshipGraphSharedMemoryDescriptor) {
    this.integers = new Int32Array(descriptor.interactionBuffer);
    this.floats = new Float32Array(descriptor.interactionBuffer);
  }

  start(nodeIndex: number, x: number, y: number): void { this.write(true, nodeIndex, x, y); }
  move(nodeIndex: number, x: number, y: number): void { this.write(true, nodeIndex, x, y); }
  end(nodeIndex: number): void {
    const x = this.floats[DRAG_X_FLOAT_INDEX] ?? 0;
    const y = this.floats[DRAG_Y_FLOAT_INDEX] ?? 0;
    this.write(false, nodeIndex, x, y);
  }

  private write(active: boolean, nodeIndex: number, x: number, y: number): void {
    Atomics.add(this.integers, DragIndex.PublishEpoch, 1);
    this.floats[DRAG_X_FLOAT_INDEX] = x;
    this.floats[DRAG_Y_FLOAT_INDEX] = y;
    Atomics.store(this.integers, DragIndex.NodeIndex, nodeIndex);
    Atomics.store(this.integers, DragIndex.Active, active ? 1 : 0);
    Atomics.add(this.integers, DragIndex.Sequence, 1);
    Atomics.add(this.integers, DragIndex.PublishEpoch, 1);
  }
}

export class RelationshipGraphSharedDragReader {
  private readonly integers: Int32Array;
  private readonly floats: Float32Array;
  private lastSequence = 0;

  constructor(descriptor: RelationshipGraphSharedMemoryDescriptor) {
    this.integers = new Int32Array(descriptor.interactionBuffer);
    this.floats = new Float32Array(descriptor.interactionBuffer);
  }

  consume(): RelationshipGraphSharedDragState | undefined {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const publishEpoch = Atomics.load(this.integers, DragIndex.PublishEpoch);
      if ((publishEpoch & 1) !== 0) continue;
      const sequence = Atomics.load(this.integers, DragIndex.Sequence);
      if (sequence === this.lastSequence) return undefined;
      const active = Atomics.load(this.integers, DragIndex.Active) === 1;
      const nodeIndex = Atomics.load(this.integers, DragIndex.NodeIndex);
      const x = this.floats[DRAG_X_FLOAT_INDEX] ?? 0;
      const y = this.floats[DRAG_Y_FLOAT_INDEX] ?? 0;
      const confirmedEpoch = Atomics.load(this.integers, DragIndex.PublishEpoch);
      const confirmedSequence = Atomics.load(this.integers, DragIndex.Sequence);
      if (publishEpoch !== confirmedEpoch || (confirmedEpoch & 1) !== 0 || sequence !== confirmedSequence) continue;
      this.lastSequence = sequence;
      return { sequence, active, nodeIndex, x, y };
    }
    return undefined;
  }
}
