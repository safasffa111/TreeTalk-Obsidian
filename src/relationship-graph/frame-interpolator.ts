export interface RelationshipGraphPositionSample {
  sequence: number;
  receivedAt: number;
  values: Float32Array;
}

interface RelationshipGraphDragOverride {
  x: number;
  y: number;
  releaseStartedAt?: number;
}

const DRAG_RELEASE_DURATION_MS = 90;
const RADIUS_GROWTH_TIME_CONSTANT_MS = 900;

function finiteSample(sample: RelationshipGraphPositionSample): boolean {
  return Number.isFinite(sample.sequence) && Number.isFinite(sample.receivedAt);
}

export function stepRelationshipGraphRadius(
  current: number,
  target: number,
  deltaMs: number
): number {
  if (!Number.isFinite(current) || !Number.isFinite(target)) return target;
  const elapsed = Math.max(0, Number.isFinite(deltaMs) ? deltaMs : 0);
  const amount = 1 - Math.exp(-elapsed / RADIUS_GROWTH_TIME_CONSTANT_MS);
  return current + (target - current) * amount;
}

export class RelationshipGraphFrameInterpolator {
  private previous: RelationshipGraphPositionSample | undefined;
  private current: RelationshipGraphPositionSample | undefined;
  private readonly dragOverrides = new Map<number, RelationshipGraphDragOverride>();

  constructor(private readonly nodeCount: number) {
    if (!Number.isInteger(nodeCount) || nodeCount < 0) {
      throw new RangeError("nodeCount must be a non-negative integer");
    }
  }

  push(sample: RelationshipGraphPositionSample): boolean {
    if (
      !finiteSample(sample) ||
      sample.values.length !== this.nodeCount * 2 ||
      (this.current !== undefined && sample.sequence <= this.current.sequence)
    ) {
      return false;
    }
    const stable = {
      sequence: sample.sequence,
      receivedAt: sample.receivedAt,
      values: new Float32Array(sample.values)
    };
    this.previous = this.current ?? stable;
    this.current = stable;
    return true;
  }

  sample(now: number, target: Float32Array): Float32Array {
    if (target.length !== this.nodeCount * 2) {
      throw new RangeError("target length does not match node count");
    }
    const current = this.current;
    if (current === undefined) {
      target.fill(0);
      return target;
    }
    const previous = this.previous ?? current;
    const duration = Math.max(1, current.receivedAt - previous.receivedAt);
    const progress = Math.max(0, Math.min(1, (now - previous.receivedAt) / duration));
    for (let index = 0; index < target.length; index += 1) {
      const from = previous.values[index] ?? 0;
      target[index] = from + ((current.values[index] ?? from) - from) * progress;
    }
    for (const [nodeIndex, override] of this.dragOverrides) {
      const offset = nodeIndex * 2;
      if (offset < 0 || offset + 1 >= target.length) continue;
      if (override.releaseStartedAt === undefined) {
        target[offset] = override.x;
        target[offset + 1] = override.y;
        continue;
      }
      const releaseProgress = Math.max(
        0,
        Math.min(1, (now - override.releaseStartedAt) / DRAG_RELEASE_DURATION_MS)
      );
      if (releaseProgress >= 1) {
        this.dragOverrides.delete(nodeIndex);
        continue;
      }
      const workerX = target[offset] ?? override.x;
      const workerY = target[offset + 1] ?? override.y;
      target[offset] = override.x + (workerX - override.x) * releaseProgress;
      target[offset + 1] = override.y + (workerY - override.y) * releaseProgress;
    }
    return target;
  }

  setDragOverride(nodeIndex: number, x: number, y: number): void {
    if (!Number.isInteger(nodeIndex) || nodeIndex < 0 || nodeIndex >= this.nodeCount) return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    this.dragOverrides.set(nodeIndex, { x, y });
  }

  releaseDragOverride(nodeIndex: number, now: number): void {
    const current = this.dragOverrides.get(nodeIndex);
    if (current === undefined || !Number.isFinite(now)) return;
    current.releaseStartedAt = now;
  }

  needsFrame(now: number): boolean {
    for (const override of this.dragOverrides.values()) {
      if (override.releaseStartedAt === undefined) return true;
      if (now - override.releaseStartedAt < DRAG_RELEASE_DURATION_MS) return true;
    }
    const previous = this.previous;
    const current = this.current;
    return (
      previous !== undefined &&
      current !== undefined &&
      previous.sequence < current.sequence &&
      now < current.receivedAt
    );
  }
}
