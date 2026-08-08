export type RelationshipGraphRadialLayoutNodeKind = "conversation" | "note";
export type RelationshipGraphRadialNoteRelation = "source-note" | "related-note";

export interface RelationshipGraphRadialLayoutNode {
  id: string;
  kind: RelationshipGraphRadialLayoutNodeKind;
  parentId?: string;
  hostId?: string;
  root?: boolean;
  order: number;
  orbitIndex?: number;
  orbitCount?: number;
  noteRelation?: RelationshipGraphRadialNoteRelation;
}

export interface RelationshipGraphRadialLayoutViewport {
  width: number;
  height: number;
}

export interface RelationshipGraphRadialLayoutTarget {
  id: string;
  kind: RelationshipGraphRadialLayoutNodeKind;
  depth: number;
  angle: number;
  radius: number;
  sectorStart: number;
  sectorEnd: number;
  x: number;
  y: number;
  parentId?: string;
  hostId?: string;
}

export interface RelationshipGraphRadialLayoutPlan {
  centerX: number;
  centerY: number;
  targets: Map<string, RelationshipGraphRadialLayoutTarget>;
}

const FULL_CIRCLE = Math.PI * 2;
const START_ANGLE = -Math.PI / 2;
const BASE_RING_RADIUS = 165;
const LEVEL_SPACING = 145;
const NOTE_SOURCE_OFFSET = 92;
const NOTE_RELATED_OFFSET = 128;
const MIN_SIBLING_TARGET_SPACING = 58;
const NOTES_PER_RING = 6;
const NOTE_RING_SPACING = 58;

function stableNodeOrder(left: RelationshipGraphRadialLayoutNode, right: RelationshipGraphRadialLayoutNode): number {
  return left.order - right.order || left.id.localeCompare(right.id);
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

export function angleWithinSector(angle: number, sectorStart: number, sectorEnd: number): boolean {
  const span = Math.max(0, sectorEnd - sectorStart);
  if (span >= FULL_CIRCLE - 1e-9) return true;
  const normalized = positiveModulo(angle - sectorStart, FULL_CIRCLE);
  return normalized >= -1e-9 && normalized <= span + 1e-9;
}

function clampAngleToSector(angle: number, sectorStart: number, sectorEnd: number, padding = 0): number {
  const span = Math.max(0, sectorEnd - sectorStart);
  if (span >= FULL_CIRCLE - 1e-9) return angle;
  const safePadding = Math.min(Math.max(0, padding), span / 2);
  const minimum = sectorStart + safePadding;
  const maximum = sectorEnd - safePadding;
  let candidate = angle;
  while (candidate < sectorStart) candidate += FULL_CIRCLE;
  while (candidate > sectorEnd) candidate -= FULL_CIRCLE;
  return Math.max(minimum, Math.min(maximum, candidate));
}

function deterministicAngle(id: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return START_ANGLE + (hash >>> 0) / 4_294_967_296 * FULL_CIRCLE;
}

export function planRelationshipGraphRadialLayout(
  nodes: readonly RelationshipGraphRadialLayoutNode[],
  viewport: RelationshipGraphRadialLayoutViewport
): RelationshipGraphRadialLayoutPlan {
  const centerX = Math.max(1, viewport.width) / 2;
  const centerY = Math.max(1, viewport.height) / 2;
  const targets = new Map<string, RelationshipGraphRadialLayoutTarget>();
  const conversations = nodes.filter((node) => node.kind === "conversation");
  const conversationById = new Map(conversations.map((node) => [node.id, node]));
  const childrenByParent = new Map<string, RelationshipGraphRadialLayoutNode[]>();
  for (const node of conversations) {
    if (node.parentId === undefined || !conversationById.has(node.parentId)) continue;
    const children = childrenByParent.get(node.parentId) ?? [];
    children.push(node);
    childrenByParent.set(node.parentId, children);
  }
  for (const children of childrenByParent.values()) children.sort(stableNodeOrder);

  const roots = conversations
    .filter((node) => node.parentId === undefined || !conversationById.has(node.parentId))
    .sort((left, right) => Number(right.root === true) - Number(left.root === true) || stableNodeOrder(left, right));
  const primaryRoot = roots.find((node) => node.root === true) ?? roots[0] ?? conversations.slice().sort(stableNodeOrder)[0];

  const weightCache = new Map<string, number>();
  const visiting = new Set<string>();
  const subtreeWeight = (nodeId: string): number => {
    const cached = weightCache.get(nodeId);
    if (cached !== undefined) return cached;
    if (visiting.has(nodeId)) return 1;
    visiting.add(nodeId);
    const children = childrenByParent.get(nodeId) ?? [];
    const weight = children.length === 0
      ? 1
      : Math.max(1, children.reduce((total, child) => total + subtreeWeight(child.id), 0));
    visiting.delete(nodeId);
    weightCache.set(nodeId, weight);
    return weight;
  };

  const radiusFor = (depth: number, weight: number): number => {
    if (depth <= 0) return 0;
    const crowdingOffset = Math.min(72, Math.max(0, Math.sqrt(weight) - 1) * 18);
    return BASE_RING_RADIUS + (depth - 1) * LEVEL_SPACING + crowdingOffset;
  };

  const setTarget = (
    node: RelationshipGraphRadialLayoutNode,
    depth: number,
    sectorStart: number,
    sectorEnd: number,
    angle: number,
    radius: number
  ): void => {
    targets.set(node.id, {
      id: node.id,
      kind: node.kind,
      depth,
      angle,
      radius,
      sectorStart,
      sectorEnd,
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius,
      ...(node.parentId === undefined ? {} : { parentId: node.parentId }),
      ...(node.hostId === undefined ? {} : { hostId: node.hostId })
    });
  };

  const allocateChildren = (
    parent: RelationshipGraphRadialLayoutNode,
    depth: number,
    sectorStart: number,
    sectorEnd: number,
    parentRadius: number
  ): void => {
    const children = childrenByParent.get(parent.id) ?? [];
    if (children.length === 0) return;
    const span = Math.max(0.001, sectorEnd - sectorStart);
    const gap = children.length <= 1 ? 0 : Math.min(0.075, span / Math.max(20, children.length * 10));
    const available = Math.max(0.001, span - gap * (children.length - 1));
    const totalWeight = children.reduce((total, child) => total + subtreeWeight(child.id), 0);
    const allocations: Array<{
      child: RelationshipGraphRadialLayoutNode;
      start: number;
      end: number;
      angle: number;
      weight: number;
    }> = [];
    let cursor = sectorStart;
    children.forEach((child, index) => {
      const childSpan = index === children.length - 1
        ? sectorEnd - cursor
        : available * subtreeWeight(child.id) / Math.max(1, totalWeight);
      const childStart = cursor;
      const childEnd = Math.min(sectorEnd, childStart + childSpan);
      allocations.push({
        child,
        start: childStart,
        end: childEnd,
        angle: (childStart + childEnd) / 2,
        weight: subtreeWeight(child.id)
      });
      cursor = childEnd + gap;
    });

    let minimumAngleDelta = Number.POSITIVE_INFINITY;
    for (let index = 1; index < allocations.length; index += 1) {
      const current = allocations[index];
      const previous = allocations[index - 1];
      if (current === undefined || previous === undefined) continue;
      minimumAngleDelta = Math.min(minimumAngleDelta, current.angle - previous.angle);
    }
    if (allocations.length > 1 && span >= FULL_CIRCLE - 1e-6) {
      const first = allocations[0];
      const last = allocations[allocations.length - 1];
      if (first !== undefined && last !== undefined) {
        const wrapDelta = FULL_CIRCLE - (last.angle - first.angle);
        minimumAngleDelta = Math.min(minimumAngleDelta, wrapDelta);
      }
    }
    const spacingRadius = Number.isFinite(minimumAngleDelta)
      ? MIN_SIBLING_TARGET_SPACING / Math.max(0.001, 2 * Math.sin(minimumAngleDelta / 2))
      : 0;
    const groupRadius = Math.max(
      parentRadius + LEVEL_SPACING,
      spacingRadius,
      ...allocations.map((allocation) => radiusFor(depth, allocation.weight))
    );

    for (const allocation of allocations) {
      setTarget(
        allocation.child,
        depth,
        allocation.start,
        allocation.end,
        allocation.angle,
        groupRadius
      );
      allocateChildren(
        allocation.child,
        depth + 1,
        allocation.start,
        allocation.end,
        groupRadius
      );
    }
  };

  if (primaryRoot !== undefined) {
    setTarget(primaryRoot, 0, START_ANGLE, START_ANGLE + FULL_CIRCLE, START_ANGLE, 0);
    const primaryChildren = [...(childrenByParent.get(primaryRoot.id) ?? [])];
    const additionalRoots = roots.filter((root) => root.id !== primaryRoot.id);
    if (additionalRoots.length > 0) {
      const combined = [...primaryChildren, ...additionalRoots].sort(stableNodeOrder);
      childrenByParent.set(primaryRoot.id, combined);
    }
    allocateChildren(primaryRoot, 1, START_ANGLE, START_ANGLE + FULL_CIRCLE, 0);
  }

  for (const conversation of conversations) {
    if (targets.has(conversation.id)) continue;
    const angle = deterministicAngle(conversation.id);
    setTarget(conversation, 1, angle - 0.12, angle + 0.12, angle, BASE_RING_RADIUS);
  }

  const notesByHost = new Map<string, RelationshipGraphRadialLayoutNode[]>();
  for (const note of nodes.filter((node) => node.kind === "note")) {
    if (note.hostId === undefined) continue;
    const attached = notesByHost.get(note.hostId) ?? [];
    attached.push(note);
    notesByHost.set(note.hostId, attached);
  }
  for (const attached of notesByHost.values()) attached.sort(stableNodeOrder);

  for (const note of nodes.filter((node) => node.kind === "note").sort(stableNodeOrder)) {
    const host = note.hostId === undefined ? undefined : targets.get(note.hostId);
    if (host === undefined) {
      const angle = deterministicAngle(note.id);
      const radius = BASE_RING_RADIUS + LEVEL_SPACING;
      setTarget(note, 2, angle - 0.1, angle + 0.1, angle, radius);
      continue;
    }
    const siblings = notesByHost.get(note.hostId ?? "") ?? [note];
    const derivedIndex = Math.max(0, siblings.findIndex((candidate) => candidate.id === note.id));
    const orbitCount = Math.max(1, note.orbitCount ?? siblings.length);
    const orbitIndex = Math.min(orbitCount - 1, Math.max(0, note.orbitIndex ?? derivedIndex));
    const ringIndex = Math.floor(orbitIndex / NOTES_PER_RING);
    const ringStart = ringIndex * NOTES_PER_RING;
    const slotsInRing = Math.min(NOTES_PER_RING, orbitCount - ringStart);
    const slotIndex = orbitIndex - ringStart;
    const spread = Math.min(0.55, 0.11 * Math.max(0, slotsInRing - 1));
    const offset = slotsInRing === 1 ? 0 : -spread / 2 + spread * slotIndex / (slotsInRing - 1);
    const sectorAllowance = Math.min(0.14, Math.max(0.04, (host.sectorEnd - host.sectorStart) * 0.18));
    const noteSectorStart = host.sectorStart - sectorAllowance;
    const noteSectorEnd = host.sectorEnd + sectorAllowance;
    const angle = clampAngleToSector(host.angle + offset, noteSectorStart, noteSectorEnd, 0.015);
    const radius = host.radius
      + (note.noteRelation === "related-note" ? NOTE_RELATED_OFFSET : NOTE_SOURCE_OFFSET)
      + ringIndex * NOTE_RING_SPACING;
    setTarget(note, host.depth + 1 + ringIndex, noteSectorStart, noteSectorEnd, angle, radius);
  }

  return { centerX, centerY, targets };
}
