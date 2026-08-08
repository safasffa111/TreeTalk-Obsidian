import type { DepositGraphPosition } from "../domain/types";
import type { RelationshipGraphEdgeKind } from "./types";
import {
  planRelationshipGraphRadialLayout,
  type RelationshipGraphRadialLayoutNode,
  type RelationshipGraphRadialLayoutTarget
} from "./radial-layout";

export const RELATIONSHIP_GRAPH_ALPHA_MIN = 0.001;
export const RELATIONSHIP_GRAPH_ALPHA_DECAY = 1 - Math.pow(0.001, 1 / 300);
export const RELATIONSHIP_GRAPH_REHEAT_ALPHA = 0.3;
/** The display loop stops after the simulation cools; interaction reheats it on demand. */
export const RELATIONSHIP_GRAPH_AMBIENT_ALPHA_TARGET = 0;
export const RELATIONSHIP_GRAPH_REPEL_STRENGTH = -150;
export const RELATIONSHIP_GRAPH_COLLISION_RADIUS = 22;
export const RELATIONSHIP_GRAPH_PARENT_LINK_DISTANCE = 145;
export const RELATIONSHIP_GRAPH_SOURCE_NOTE_DISTANCE = 96;
export const RELATIONSHIP_GRAPH_RELATED_NOTE_DISTANCE = 128;

export interface RelationshipGraphWorkerNodeInput {
  id: string;
  kind?: RelationshipGraphRadialLayoutNode["kind"];
  parentId?: string;
  hostId?: string;
  root?: boolean;
  order?: number;
  orbitIndex?: number;
  orbitCount?: number;
  noteRelation?: RelationshipGraphRadialLayoutNode["noteRelation"];
  x?: number;
  y?: number;
  restored?: boolean;
}

export interface RelationshipGraphWorkerLinkInput {
  id: string;
  sourceId: string;
  targetId: string;
  kind?: RelationshipGraphEdgeKind;
}

interface ForceNode extends RelationshipGraphRadialLayoutNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  fx: number | null;
  fy: number | null;
  target: RelationshipGraphRadialLayoutTarget;
}

interface ForceLink {
  id: string;
  kind: RelationshipGraphEdgeKind;
  source: ForceNode;
  target: ForceNode;
  strength: number;
  distance: number;
}

interface Quad {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  mass: number;
  cx: number;
  cy: number;
  node?: ForceNode | undefined;
  coincident?: ForceNode[] | undefined;
  children?: [Quad | undefined, Quad | undefined, Quad | undefined, Quad | undefined] | undefined;
}

function hash(value: string): number {
  let result = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16_777_619);
  }
  return result >>> 0;
}

function deterministicJitter(left: string, right: string, axis: "x" | "y"): number {
  return ((hash(`${axis}:${left}:${right}`) / 4_294_967_296) - 0.5) * 1e-3;
}

export function relationshipLinkStrength(sourceDegree: number, targetDegree: number): number {
  return 1 / Math.max(1, Math.min(sourceDegree, targetDegree));
}

function childIndex(quad: Quad, x: number, y: number): number {
  const middleX = (quad.x0 + quad.x1) / 2;
  const middleY = (quad.y0 + quad.y1) / 2;
  return (y >= middleY ? 2 : 0) + (x >= middleX ? 1 : 0);
}

function makeChild(quad: Quad, index: number): Quad {
  const middleX = (quad.x0 + quad.x1) / 2;
  const middleY = (quad.y0 + quad.y1) / 2;
  const right = (index & 1) !== 0;
  const bottom = (index & 2) !== 0;
  return {
    x0: right ? middleX : quad.x0,
    y0: bottom ? middleY : quad.y0,
    x1: right ? quad.x1 : middleX,
    y1: bottom ? quad.y1 : middleY,
    mass: 0,
    cx: 0,
    cy: 0
  };
}

function insertQuad(root: Quad, node: ForceNode): void {
  let quad = root;
  for (let depth = 0; depth < 32; depth += 1) {
    if (quad.children === undefined && quad.node === undefined) {
      quad.node = node;
      return;
    }
    if (quad.children === undefined && quad.node !== undefined) {
      const existing = quad.node;
      if (Math.abs(existing.x - node.x) < 1e-8 && Math.abs(existing.y - node.y) < 1e-8) {
        quad.coincident ??= [existing];
        quad.coincident.push(node);
        quad.node = undefined;
        return;
      }
      quad.node = undefined;
      quad.children = [undefined, undefined, undefined, undefined];
      const existingIndex = childIndex(quad, existing.x, existing.y);
      const existingChild = makeChild(quad, existingIndex);
      quad.children[existingIndex] = existingChild;
      existingChild.node = existing;
    }
    if (quad.coincident !== undefined) {
      quad.coincident.push(node);
      return;
    }
    const index = childIndex(quad, node.x, node.y);
    const children = quad.children as [Quad | undefined, Quad | undefined, Quad | undefined, Quad | undefined];
    let child = children[index];
    if (child === undefined) {
      child = makeChild(quad, index);
      children[index] = child;
    }
    quad = child;
  }
  quad.coincident ??= quad.node === undefined ? [] : [quad.node];
  quad.node = undefined;
  quad.coincident.push(node);
}

function accumulateQuad(quad: Quad): void {
  if (quad.node !== undefined) {
    quad.mass = 1;
    quad.cx = quad.node.x;
    quad.cy = quad.node.y;
    return;
  }
  if (quad.coincident !== undefined) {
    quad.mass = quad.coincident.length;
    let x = 0;
    let y = 0;
    for (const node of quad.coincident) {
      x += node.x;
      y += node.y;
    }
    quad.cx = x / Math.max(1, quad.mass);
    quad.cy = y / Math.max(1, quad.mass);
    return;
  }
  let mass = 0;
  let weightedX = 0;
  let weightedY = 0;
  for (const child of quad.children ?? []) {
    if (child === undefined) continue;
    accumulateQuad(child);
    mass += child.mass;
    weightedX += child.cx * child.mass;
    weightedY += child.cy * child.mass;
  }
  quad.mass = mass;
  if (mass > 0) {
    quad.cx = weightedX / mass;
    quad.cy = weightedY / mass;
  }
}

function buildQuadTree(nodes: readonly ForceNode[]): Quad | undefined {
  if (nodes.length === 0) return undefined;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const node of nodes) {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x);
    maxY = Math.max(maxY, node.y);
  }
  const span = Math.max(1, maxX - minX, maxY - minY);
  const root: Quad = { x0: minX, y0: minY, x1: minX + span, y1: minY + span, mass: 0, cx: 0, cy: 0 };
  for (const node of nodes) insertQuad(root, node);
  accumulateQuad(root);
  return root;
}

function applyRepulsion(node: ForceNode, root: Quad, alpha: number): void {
  const stack: Quad[] = [root];
  const thetaSquared = 0.81;
  const minimumSquared = 20 * 20;
  const charge = -RELATIONSHIP_GRAPH_REPEL_STRENGTH * alpha;
  while (stack.length > 0) {
    const quad = stack.pop();
    if (quad === undefined || quad.mass === 0) continue;
    if (quad.node === node && quad.mass === 1) continue;
    let dx = node.x - quad.cx;
    let dy = node.y - quad.cy;
    if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) {
      dx = deterministicJitter(node.id, String(quad.mass), "x");
      dy = deterministicJitter(node.id, String(quad.mass), "y");
    }
    const distanceSquared = dx * dx + dy * dy;
    const width = quad.x1 - quad.x0;
    const leaf = quad.children === undefined;
    if (leaf || width * width / Math.max(distanceSquared, 1e-9) < thetaSquared) {
      const safeSquared = Math.max(minimumSquared, distanceSquared);
      const scale = charge * quad.mass / safeSquared;
      node.vx += dx * scale;
      node.vy += dy * scale;
      continue;
    }
    for (const child of quad.children ?? []) if (child !== undefined) stack.push(child);
  }
}

function normalizeAngleDelta(value: number): number {
  let result = value;
  while (result > Math.PI) result -= Math.PI * 2;
  while (result < -Math.PI) result += Math.PI * 2;
  return result;
}

function unwrapAngleNear(angle: number, reference: number): number {
  return reference + normalizeAngleDelta(angle - reference);
}

function linkParameters(
  kind: RelationshipGraphEdgeKind,
  sourceDegree: number,
  targetDegree: number
): { strength: number; distance: number } {
  const degreeScale = 1 / Math.sqrt(Math.max(1, Math.min(sourceDegree, targetDegree)));
  if (kind === "parent-child") {
    return { strength: 0.06 * degreeScale, distance: RELATIONSHIP_GRAPH_PARENT_LINK_DISTANCE };
  }
  if (kind === "source-note") {
    return { strength: 0.045 * degreeScale, distance: RELATIONSHIP_GRAPH_SOURCE_NOTE_DISTANCE };
  }
  return { strength: 0.02 * degreeScale, distance: RELATIONSHIP_GRAPH_RELATED_NOTE_DISTANCE };
}

export class RelationshipGraphForceCore {
  private orderedNodes: ForceNode[] = [];
  private links: ForceLink[] = [];
  private readonly nodesById = new Map<string, ForceNode>();
  private readonly positionCache: Record<string, DepositGraphPosition> = {};
  private readonly packedNodeIds: string[] = [];
  private packedPositions = new Float32Array(0);
  private topologyKey = "";
  private currentRevision = 0;
  private viewportWidth = 1000;
  private viewportHeight = 720;
  private currentAlpha = 0;
  private currentAlphaTarget = 0;
  private layoutInputs: RelationshipGraphRadialLayoutNode[] = [];
  private preserveRestoredLayout = false;
  private restoredViewportSynchronized = false;

  setViewport(width: number, height: number): void {
    const nextWidth = Math.max(1, width);
    const nextHeight = Math.max(1, height);
    const changed = nextWidth !== this.viewportWidth || nextHeight !== this.viewportHeight;
    if (!changed) {
      if (this.preserveRestoredLayout && !this.restoredViewportSynchronized) {
        this.restoredViewportSynchronized = true;
      }
      return;
    }
    this.viewportWidth = nextWidth;
    this.viewportHeight = nextHeight;
    this.recomputeLayoutTargets();
    if (this.orderedNodes.length === 0) return;
    if (this.preserveRestoredLayout && !this.restoredViewportSynchronized) {
      this.restoredViewportSynchronized = true;
      return;
    }
    this.preserveRestoredLayout = false;
    this.currentAlpha = Math.max(this.currentAlpha, 0.12);
    this.currentAlphaTarget = RELATIONSHIP_GRAPH_AMBIENT_ALPHA_TARGET;
  }

  reconcile(
    revision: number,
    inputs: readonly RelationshipGraphWorkerNodeInput[],
    links: readonly RelationshipGraphWorkerLinkInput[]
  ): boolean {
    this.currentRevision = revision;
    const normalizedInputs: RelationshipGraphRadialLayoutNode[] = inputs.map((input) => ({
      id: input.id,
      kind: input.kind ?? "conversation",
      order: input.order ?? 0,
      ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
      ...(input.hostId === undefined ? {} : { hostId: input.hostId }),
      ...(input.root === true ? { root: true } : {}),
      ...(input.orbitIndex === undefined ? {} : { orbitIndex: input.orbitIndex }),
      ...(input.orbitCount === undefined ? {} : { orbitCount: input.orbitCount }),
      ...(input.noteRelation === undefined ? {} : { noteRelation: input.noteRelation })
    }));
    const normalizedLinks = links.map((link) => ({ ...link, kind: link.kind ?? "parent-child" as const }));
    const inputById = new Map(inputs.map((input) => [input.id, input]));
    const nextTopologyKey = JSON.stringify([
      normalizedInputs.map((node) => [
        node.id,
        node.kind,
        node.parentId,
        node.hostId,
        node.root === true,
        node.order,
        node.orbitIndex,
        node.orbitCount,
        node.noteRelation
      ]),
      normalizedLinks.map((link) => [link.id, link.sourceId, link.targetId, link.kind])
    ]);
    if (nextTopologyKey === this.topologyKey) return false;
    this.layoutInputs = normalizedInputs.map((input) => ({ ...input }));
    const plan = planRelationshipGraphRadialLayout(this.layoutInputs, {
      width: this.viewportWidth,
      height: this.viewportHeight
    });
    const previous = new Map(this.nodesById);
    const fullyRestoredInitialTopology = previous.size === 0 && inputs.length > 0 && inputs.every((input) =>
      input.restored === true && Number.isFinite(input.x) && Number.isFinite(input.y)
    );
    this.nodesById.clear();
    const connectedPreviousNode = (input: RelationshipGraphRadialLayoutNode): ForceNode | undefined => {
      const structuralAnchorId = input.parentId ?? input.hostId;
      if (structuralAnchorId !== undefined) {
        const structuralAnchor = previous.get(structuralAnchorId);
        if (structuralAnchor !== undefined) return structuralAnchor;
      }
      const neighborIds = normalizedLinks.flatMap((link) => link.sourceId === input.id
        ? [link.targetId]
        : link.targetId === input.id ? [link.sourceId] : []).sort((left, right) => left.localeCompare(right));
      for (const neighborId of neighborIds) {
        const neighbor = previous.get(neighborId);
        if (neighbor !== undefined) return neighbor;
      }
      return undefined;
    };
    this.orderedNodes = normalizedInputs.map((input) => {
      const rawInput = inputById.get(input.id);
      const target = plan.targets.get(input.id);
      if (target === undefined) throw new Error(`missing radial target for ${input.id}`);
      const existing = previous.get(input.id);
      const anchor = existing === undefined ? connectedPreviousNode(input) : undefined;
      const seedAngle = target.angle + ((hash(`seed:${input.id}`) / 4_294_967_296) - 0.5) * 0.08;
      const seedDistance = input.kind === "note" ? 20 : 14;
      const seededX = anchor === undefined ? target.x : anchor.x + Math.cos(seedAngle) * seedDistance;
      const seededY = anchor === undefined ? target.y : anchor.y + Math.sin(seedAngle) * seedDistance;
      const node: ForceNode = existing ?? {
        id: input.id,
        kind: input.kind,
        order: input.order,
        ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
        ...(input.hostId === undefined ? {} : { hostId: input.hostId }),
        ...(input.root === true ? { root: true } : {}),
        ...(input.orbitIndex === undefined ? {} : { orbitIndex: input.orbitIndex }),
        ...(input.orbitCount === undefined ? {} : { orbitCount: input.orbitCount }),
        ...(input.noteRelation === undefined ? {} : { noteRelation: input.noteRelation }),
        x: rawInput?.x ?? seededX,
        y: rawInput?.y ?? seededY,
        vx: 0,
        vy: 0,
        fx: null,
        fy: null,
        target
      };
      node.kind = input.kind;
      node.order = input.order;
      if (input.parentId === undefined) Reflect.deleteProperty(node, "parentId");
      else node.parentId = input.parentId;
      if (input.hostId === undefined) Reflect.deleteProperty(node, "hostId");
      else node.hostId = input.hostId;
      if (input.root === undefined) Reflect.deleteProperty(node, "root");
      else node.root = input.root;
      if (input.orbitIndex === undefined) Reflect.deleteProperty(node, "orbitIndex");
      else node.orbitIndex = input.orbitIndex;
      if (input.orbitCount === undefined) Reflect.deleteProperty(node, "orbitCount");
      else node.orbitCount = input.orbitCount;
      if (input.noteRelation === undefined) Reflect.deleteProperty(node, "noteRelation");
      else node.noteRelation = input.noteRelation;
      node.target = target;
      node.fx = null;
      node.fy = null;
      this.nodesById.set(node.id, node);
      return node;
    });
    const nextNodeIds = new Set(this.orderedNodes.map((node) => node.id));
    for (const nodeId of Object.keys(this.positionCache)) {
      if (!nextNodeIds.has(nodeId)) Reflect.deleteProperty(this.positionCache, nodeId);
    }
    this.packedNodeIds.length = 0;
    this.packedNodeIds.push(...this.orderedNodes.map((node) => node.id));
    this.packedPositions = new Float32Array(this.orderedNodes.length * 2);
    const degrees = new Map<string, number>();
    for (const link of normalizedLinks) {
      degrees.set(link.sourceId, (degrees.get(link.sourceId) ?? 0) + 1);
      degrees.set(link.targetId, (degrees.get(link.targetId) ?? 0) + 1);
    }
    this.links = normalizedLinks.flatMap((link) => {
      const source = this.nodesById.get(link.sourceId);
      const target = this.nodesById.get(link.targetId);
      if (source === undefined || target === undefined) return [];
      const parameters = linkParameters(
        link.kind,
        degrees.get(link.sourceId) ?? 1,
        degrees.get(link.targetId) ?? 1
      );
      return [{ id: link.id, kind: link.kind, source, target, ...parameters }];
    });
    if (fullyRestoredInitialTopology) {
      this.currentAlpha = 0;
      this.currentAlphaTarget = 0;
      this.preserveRestoredLayout = true;
      this.restoredViewportSynchronized = false;
    } else {
      this.currentAlpha = Math.max(this.currentAlpha, RELATIONSHIP_GRAPH_REHEAT_ALPHA);
      this.currentAlphaTarget = RELATIONSHIP_GRAPH_AMBIENT_ALPHA_TARGET;
      this.preserveRestoredLayout = false;
      this.restoredViewportSynchronized = true;
    }
    this.topologyKey = nextTopologyKey;
    return true;
  }

  revision(): number { return this.currentRevision; }
  alpha(): number { return this.currentAlpha; }
  alphaTarget(): number { return this.currentAlphaTarget; }
  isActive(): boolean { return this.currentAlpha >= RELATIONSHIP_GRAPH_ALPHA_MIN || this.currentAlphaTarget > 0; }
  isAmbient(): boolean { return this.currentAlpha <= 0.03 && this.currentAlphaTarget <= RELATIONSHIP_GRAPH_AMBIENT_ALPHA_TARGET; }
  nodeIds(): string[] { return this.orderedNodes.map((node) => node.id); }
  node(id: string): Readonly<ForceNode> | undefined { return this.nodesById.get(id); }

  beginDrag(nodeId: string, x: number, y: number): boolean {
    const node = this.nodesById.get(nodeId);
    if (node === undefined) return false;
    this.preserveRestoredLayout = false;
    this.restoredViewportSynchronized = true;
    node.fx = x;
    node.fy = y;
    node.x = x;
    node.y = y;
    node.vx = 0;
    node.vy = 0;
    this.currentAlpha = Math.max(this.currentAlpha, RELATIONSHIP_GRAPH_REHEAT_ALPHA);
    this.currentAlphaTarget = RELATIONSHIP_GRAPH_REHEAT_ALPHA;
    return true;
  }

  moveDrag(nodeId: string, x: number, y: number): boolean {
    const node = this.nodesById.get(nodeId);
    if (node === undefined || node.fx === null) return false;
    node.fx = x;
    node.fy = y;
    node.x = x;
    node.y = y;
    node.vx = 0;
    node.vy = 0;
    return true;
  }

  endDrag(nodeId: string): boolean {
    const node = this.nodesById.get(nodeId);
    if (node === undefined) return false;
    node.fx = null;
    node.fy = null;
    this.currentAlpha = Math.max(this.currentAlpha, 0.2);
    this.currentAlphaTarget = RELATIONSHIP_GRAPH_AMBIENT_ALPHA_TARGET;
    return true;
  }

  beginDragIndex(nodeIndex: number, x: number, y: number): boolean {
    const node = this.orderedNodes[nodeIndex];
    return node === undefined ? false : this.beginDrag(node.id, x, y);
  }
  moveDragIndex(nodeIndex: number, x: number, y: number): boolean {
    const node = this.orderedNodes[nodeIndex];
    return node === undefined ? false : this.moveDrag(node.id, x, y);
  }
  endDragIndex(nodeIndex: number): boolean {
    const node = this.orderedNodes[nodeIndex];
    return node === undefined ? false : this.endDrag(node.id);
  }

  tick(iterations = 1): void {
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      this.currentAlpha += (this.currentAlphaTarget - this.currentAlpha) * RELATIONSHIP_GRAPH_ALPHA_DECAY;
      if (this.currentAlphaTarget === 0 && this.currentAlpha <= RELATIONSHIP_GRAPH_ALPHA_MIN) this.currentAlpha = 0;
      if (this.currentAlpha === 0 && this.currentAlphaTarget === 0) return;
      const alpha = this.currentAlpha;
      const centerX = this.viewportWidth / 2;
      const centerY = this.viewportHeight / 2;
      const tree = buildQuadTree(this.orderedNodes);
      for (const node of this.orderedNodes) {
        if (node.fx !== null) continue;
        this.applyLayoutForce(node, centerX, centerY, alpha);
        if (tree !== undefined) applyRepulsion(node, tree, alpha);
      }
      for (const link of this.links) {
        let dx = link.target.x - link.source.x;
        let dy = link.target.y - link.source.y;
        if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) {
          dx = deterministicJitter(link.source.id, link.target.id, "x");
          dy = deterministicJitter(link.source.id, link.target.id, "y");
        }
        const distance = Math.max(1e-6, Math.hypot(dx, dy));
        const spring = (distance - link.distance) / distance * link.strength * alpha * 0.5;
        const fx = dx * spring;
        const fy = dy * spring;
        if (link.source.fx === null) { link.source.vx += fx; link.source.vy += fy; }
        if (link.target.fx === null) { link.target.vx -= fx; link.target.vy -= fy; }
      }
      const collisionCell = RELATIONSHIP_GRAPH_COLLISION_RADIUS * 2;
      const grid = new Map<string, ForceNode[]>();
      for (const node of this.orderedNodes) {
        const cellX = Math.floor(node.x / collisionCell);
        const cellY = Math.floor(node.y / collisionCell);
        const key = `${cellX}:${cellY}`;
        const bucket = grid.get(key) ?? [];
        bucket.push(node);
        grid.set(key, bucket);
      }
      for (const node of this.orderedNodes) {
        const cellX = Math.floor(node.x / collisionCell);
        const cellY = Math.floor(node.y / collisionCell);
        for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
          for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
            for (const other of grid.get(`${cellX + offsetX}:${cellY + offsetY}`) ?? []) {
              if (other === node || other.id < node.id) continue;
              let dx = other.x - node.x;
              let dy = other.y - node.y;
              if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) {
                dx = deterministicJitter(node.id, other.id, "x");
                dy = deterministicJitter(node.id, other.id, "y");
              }
              const distance = Math.max(1e-6, Math.hypot(dx, dy));
              const minimum = RELATIONSHIP_GRAPH_COLLISION_RADIUS * 2;
              if (distance >= minimum) continue;
              const push = (minimum - distance) / distance * 0.35 * alpha;
              const px = dx * push;
              const py = dy * push;
              if (node.fx === null) { node.vx -= px; node.vy -= py; }
              if (other.fx === null) { other.vx += px; other.vy += py; }
            }
          }
        }
      }
      for (const node of this.orderedNodes) {
        if (node.fx !== null && node.fy !== null) {
          node.x = node.fx;
          node.y = node.fy;
          node.vx = 0;
          node.vy = 0;
        } else {
          node.vx *= 0.61;
          node.vy *= 0.61;
          node.x += node.vx;
          node.y += node.vy;
        }
      }
    }
  }

  positionSnapshot(): Record<string, DepositGraphPosition> {
    for (const node of this.orderedNodes) {
      const position = this.positionCache[node.id];
      if (position === undefined) this.positionCache[node.id] = { x: node.x, y: node.y, fixed: false };
      else { position.x = node.x; position.y = node.y; position.fixed = false; }
    }
    return this.positionCache;
  }

  packedPositionSnapshot(): { nodeIds: readonly string[]; values: Float32Array } {
    this.writePackedPositions(this.packedPositions);
    return { nodeIds: this.packedNodeIds, values: this.packedPositions };
  }

  writePackedPositions(target: Float32Array): void {
    if (target.length !== this.orderedNodes.length * 2) throw new RangeError("position target length does not match graph topology");
    for (let index = 0; index < this.orderedNodes.length; index += 1) {
      const node = this.orderedNodes[index];
      if (node === undefined) continue;
      target[index * 2] = node.x;
      target[index * 2 + 1] = node.y;
    }
  }

  writeSharedPositions(target: Float32Array): void {
    if (target.length < this.orderedNodes.length * 4) throw new RangeError("shared position target length does not match graph topology");
    target.fill(0);
    for (let index = 0; index < this.orderedNodes.length; index += 1) {
      const node = this.orderedNodes[index];
      if (node === undefined) continue;
      const offset = index * 4;
      target[offset] = node.x;
      target[offset + 1] = node.y;
      target[offset + 3] = 1;
    }
  }

  private recomputeLayoutTargets(): void {
    if (this.layoutInputs.length === 0) return;
    const plan = planRelationshipGraphRadialLayout(this.layoutInputs, {
      width: this.viewportWidth,
      height: this.viewportHeight
    });
    for (const node of this.orderedNodes) {
      const target = plan.targets.get(node.id);
      if (target !== undefined) node.target = target;
    }
  }

  private applyLayoutForce(node: ForceNode, centerX: number, centerY: number, alpha: number): void {
    if (node.root === true || node.target.depth === 0) {
      node.vx += (centerX - node.x) * 0.34 * alpha;
      node.vy += (centerY - node.y) * 0.34 * alpha;
      return;
    }
    if (node.kind === "note") {
      const host = node.hostId === undefined ? undefined : this.nodesById.get(node.hostId);
      const orbitDistance = host === undefined
        ? node.target.radius
        : Math.max(72, node.target.radius - host.target.radius);
      const desiredX = (host?.x ?? centerX) + Math.cos(node.target.angle) * orbitDistance;
      const desiredY = (host?.y ?? centerY) + Math.sin(node.target.angle) * orbitDistance;
      const strength = node.noteRelation === "related-note" ? 0.11 : 0.15;
      node.vx += (desiredX - node.x) * strength * alpha;
      node.vy += (desiredY - node.y) * strength * alpha;
      return;
    }

    let dx = node.x - centerX;
    let dy = node.y - centerY;
    let radius = Math.hypot(dx, dy);
    if (radius < 1e-6) {
      dx = Math.cos(node.target.angle);
      dy = Math.sin(node.target.angle);
      radius = 1;
    }
    const radialX = dx / radius;
    const radialY = dy / radius;
    const radialError = node.target.radius - radius;
    node.vx += radialX * radialError * 0.17 * alpha;
    node.vy += radialY * radialError * 0.17 * alpha;

    const currentAngle = unwrapAngleNear(Math.atan2(dy, dx), node.target.angle);
    const sectorPadding = Math.min(0.025, Math.max(0, (node.target.sectorEnd - node.target.sectorStart) / 8));
    const minimumAngle = node.target.sectorStart + sectorPadding;
    const maximumAngle = node.target.sectorEnd - sectorPadding;
    const sectorTarget = currentAngle < minimumAngle
      ? minimumAngle
      : currentAngle > maximumAngle
        ? maximumAngle
        : node.target.angle;
    const angularError = sectorTarget - currentAngle;
    const tangentialDistance = angularError * Math.max(80, node.target.radius);
    node.vx += -radialY * tangentialDistance * 0.13 * alpha;
    node.vy += radialX * tangentialDistance * 0.13 * alpha;
    node.vx += (node.target.x - node.x) * 0.06 * alpha;
    node.vy += (node.target.y - node.y) * 0.06 * alpha;
  }
}
