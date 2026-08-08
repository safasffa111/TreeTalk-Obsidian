import type { DepositGraphPosition } from "../domain/types";
import type { RelationshipGraphWorkerFrame } from "./types";
import type { RelationshipGraphSharedMemoryDescriptor } from "./shared-memory";
import type { RelationshipGraphWorkerLinkInput, RelationshipGraphWorkerNodeInput } from "./worker-core";

export type { RelationshipGraphWorkerFrame } from "./types";

export type RelationshipGraphWorkerCommand =
  | {
      type: "init";
      sessionId: string;
      revision: number;
      nodes: RelationshipGraphWorkerNodeInput[];
      links: RelationshipGraphWorkerLinkInput[];
      sharedMemory?: RelationshipGraphSharedMemoryDescriptor;
    }
  | {
      type: "topology";
      sessionId: string;
      revision: number;
      nodes: RelationshipGraphWorkerNodeInput[];
      links: RelationshipGraphWorkerLinkInput[];
      sharedMemory?: RelationshipGraphSharedMemoryDescriptor;
    }
  | { type: "drag-start"; sessionId: string; nodeId: string; x: number; y: number }
  | { type: "drag-move"; sessionId: string; nodeId: string; x: number; y: number }
  | { type: "drag-end"; sessionId: string; nodeId: string }
  | { type: "viewport"; sessionId: string; width: number; height: number }
  | { type: "pause"; sessionId: string }
  | { type: "resume"; sessionId: string }
  | { type: "retry"; sessionId: string }
  | { type: "return-buffer"; sessionId: string; revision: number; positionBuffer: ArrayBuffer }
  | { type: "destroy"; sessionId: string };

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be finite`);
  }
  return value;
}

function parsePositions(value: unknown, target: Record<string, DepositGraphPosition>): Record<string, DepositGraphPosition> {
  const source = record(value, "frame.positions");
  for (const [nodeId, raw] of Object.entries(source)) {
    const position = record(raw, `frame.positions.${nodeId}`);
    const x = finiteNumber(position.x, `frame.positions.${nodeId}.x`);
    const y = finiteNumber(position.y, `frame.positions.${nodeId}.y`);
    const cached = target[nodeId];
    if (cached === undefined) target[nodeId] = { x, y, fixed: position.fixed === true };
    else {
      cached.x = x;
      cached.y = y;
      cached.fixed = position.fixed === true;
    }
  }
  return target;
}

function parsePackedPositions(
  idsValue: unknown,
  valuesValue: unknown,
  target: Record<string, DepositGraphPosition>
): { positions: Record<string, DepositGraphPosition>; values: Float32Array } {
  if (!Array.isArray(idsValue)) throw new TypeError("frame.positionIds must be an array");
  const values = valuesValue instanceof ArrayBuffer
    ? new Float32Array(valuesValue)
    : ArrayBuffer.isView(valuesValue)
      ? new Float32Array(valuesValue.buffer, valuesValue.byteOffset, Math.floor(valuesValue.byteLength / Float32Array.BYTES_PER_ELEMENT))
      : undefined;
  if (values === undefined) throw new TypeError("frame.positionBuffer must be a typed array or ArrayBuffer");
  if (values.length !== idsValue.length * 2) throw new TypeError("frame.positionBuffer length does not match topology");
  for (let index = 0; index < idsValue.length; index += 1) {
    const nodeId: unknown = idsValue[index];
    if (typeof nodeId !== "string") throw new TypeError("frame.positionIds must contain strings");
    const x = finiteNumber(values[index * 2], `frame.positionBuffer.${nodeId}.x`);
    const y = finiteNumber(values[index * 2 + 1], `frame.positionBuffer.${nodeId}.y`);
    const cached = target[nodeId];
    if (cached === undefined) target[nodeId] = { x, y, fixed: false };
    else {
      cached.x = x;
      cached.y = y;
      cached.fixed = false;
    }
  }
  return { positions: target, values };
}

export function parseRelationshipGraphWorkerFrame(
  value: unknown,
  sessionId: string,
  latestRevision: number,
  target: Record<string, DepositGraphPosition> = {},
  positionIds?: readonly string[]
): RelationshipGraphWorkerFrame {
  const source = record(value, "frame");
  if (source.sessionId !== sessionId) throw new Error("stale session");
  const revision = finiteNumber(source.revision, "frame.revision");
  if (revision <= latestRevision) throw new Error("stale revision");
  if (typeof source.active !== "boolean") {
    throw new TypeError("frame.active must be boolean");
  }
  const packed = source.positionBuffer === undefined
    ? undefined
    : parsePackedPositions(positionIds ?? source.positionIds, source.positionBuffer, target);
  return {
    sessionId,
    revision,
    sequence: source.sequence === undefined ? revision : finiteNumber(source.sequence, "frame.sequence"),
    receivedAt: source.timestamp === undefined ? 0 : finiteNumber(source.timestamp, "frame.timestamp"),
    values: packed?.values ?? new Float32Array(0),
    positions: packed?.positions ?? parsePositions(source.positions, target),
    active: source.active
  };
}
