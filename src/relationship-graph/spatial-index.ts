export interface RelationshipGraphSpatialNode {
  id: string;
  x: number;
  y: number;
  radius: number;
}

export interface RelationshipGraphPoint { x: number; y: number; }

const CELL_SIZE = 96;

function cellCoordinate(value: number): number {
  return Math.floor(value / CELL_SIZE);
}

function cellKey(x: number, y: number): string {
  return `${String(x)}:${String(y)}`;
}

export class RelationshipGraphSpatialIndex {
  private readonly nodes = new Map<string, RelationshipGraphSpatialNode>();
  private readonly cells = new Map<string, Set<string>>();
  private readonly cellByNodeId = new Map<string, { x: number; y: number; key: string }>();
  private visitedCount = 0;
  private rebuildCount = 0;
  private updateCount = 0;
  private lastCellMutationCount = 0;

  rebuild(nodes: readonly RelationshipGraphSpatialNode[]): void {
    this.nodes.clear();
    this.cells.clear();
    this.cellByNodeId.clear();
    this.rebuildCount += 1;
    for (const node of nodes) {
      this.nodes.set(node.id, node);
      const x = cellCoordinate(node.x);
      const y = cellCoordinate(node.y);
      const key = cellKey(x, y);
      const ids = this.cells.get(key) ?? new Set<string>();
      ids.add(node.id);
      this.cells.set(key, ids);
      this.cellByNodeId.set(node.id, { x, y, key });
    }
  }

  updatePositions(nodes: readonly RelationshipGraphSpatialNode[]): void {
    this.updateCount += 1;
    this.lastCellMutationCount = 0;
    if (nodes.length !== this.nodes.size || nodes.some((node) => !this.nodes.has(node.id))) {
      this.rebuild(nodes);
      return;
    }
    for (const node of nodes) {
      this.nodes.set(node.id, node);
      const previous = this.cellByNodeId.get(node.id);
      if (previous === undefined) {
        this.rebuild(nodes);
        return;
      }
      const x = cellCoordinate(node.x);
      const y = cellCoordinate(node.y);
      if (x === previous.x && y === previous.y) continue;
      const previousIds = this.cells.get(previous.key);
      previousIds?.delete(node.id);
      if (previousIds?.size === 0) this.cells.delete(previous.key);
      const key = cellKey(x, y);
      const nextIds = this.cells.get(key) ?? new Set<string>();
      nextIds.add(node.id);
      this.cells.set(key, nextIds);
      previous.x = x;
      previous.y = y;
      previous.key = key;
      this.lastCellMutationCount += 1;
    }
  }

  hitTest(point: RelationshipGraphPoint): RelationshipGraphSpatialNode | undefined {
    let nearest: RelationshipGraphSpatialNode | undefined;
    let nearestDistance = Number.POSITIVE_INFINITY;
    this.visitedCount = 0;
    const centerX = cellCoordinate(point.x);
    const centerY = cellCoordinate(point.y);
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        const ids = this.cells.get(cellKey(centerX + offsetX, centerY + offsetY));
        if (ids === undefined) continue;
        for (const id of ids) {
          const node = this.nodes.get(id);
          if (node === undefined) continue;
          this.visitedCount += 1;
          const distance = Math.hypot(point.x - node.x, point.y - node.y);
          if (distance > node.radius + 8 || distance >= nearestDistance) continue;
          nearest = node;
          nearestDistance = distance;
        }
      }
    }
    return nearest;
  }

  getLastVisitedCount(): number { return this.visitedCount; }

  getDiagnostics(): { rebuildCount: number; updateCount: number; lastCellMutationCount: number } {
    return {
      rebuildCount: this.rebuildCount,
      updateCount: this.updateCount,
      lastCellMutationCount: this.lastCellMutationCount
    };
  }

  clear(): void {
    this.nodes.clear();
    this.cells.clear();
    this.cellByNodeId.clear();
    this.visitedCount = 0;
    this.rebuildCount = 0;
    this.updateCount = 0;
    this.lastCellMutationCount = 0;
  }
}

export interface RelationshipGraphSpatialEdge {
  id: string;
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
}

function segmentDistance(point: RelationshipGraphPoint, edge: RelationshipGraphSpatialEdge): number {
  const deltaX = edge.targetX - edge.sourceX;
  const deltaY = edge.targetY - edge.sourceY;
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;
  const ratio = lengthSquared === 0
    ? 0
    : Math.max(0, Math.min(1, ((point.x - edge.sourceX) * deltaX + (point.y - edge.sourceY) * deltaY) / lengthSquared));
  const closestX = edge.sourceX + ratio * deltaX;
  const closestY = edge.sourceY + ratio * deltaY;
  return Math.hypot(point.x - closestX, point.y - closestY);
}

export class RelationshipGraphEdgeSpatialIndex {
  private readonly edges = new Map<string, RelationshipGraphSpatialEdge>();
  private readonly cells = new Map<string, Set<string>>();
  private visitedCount = 0;

  rebuild(edges: readonly RelationshipGraphSpatialEdge[]): void {
    this.edges.clear();
    this.cells.clear();
    for (const edge of edges) {
      this.edges.set(edge.id, edge);
      let x = cellCoordinate(edge.sourceX);
      let y = cellCoordinate(edge.sourceY);
      const targetX = cellCoordinate(edge.targetX);
      const targetY = cellCoordinate(edge.targetY);
      const deltaX = Math.abs(targetX - x);
      const deltaY = Math.abs(targetY - y);
      const stepX = x < targetX ? 1 : x > targetX ? -1 : 0;
      const stepY = y < targetY ? 1 : y > targetY ? -1 : 0;
      let error = deltaX - deltaY;
      const firstKey = cellKey(x, y);
      const firstIds = this.cells.get(firstKey) ?? new Set<string>();
      firstIds.add(edge.id);
      this.cells.set(firstKey, firstIds);
      while (x !== targetX || y !== targetY) {
        const doubledError = error * 2;
        if (doubledError > -deltaY) {
          error -= deltaY;
          x += stepX;
        }
        if (doubledError < deltaX) {
          error += deltaX;
          y += stepY;
        }
        const key = cellKey(x, y);
        const ids = this.cells.get(key) ?? new Set<string>();
        ids.add(edge.id);
        this.cells.set(key, ids);
      }
    }
  }

  hitTest(point: RelationshipGraphPoint): { edge: RelationshipGraphSpatialEdge; distance: number } | undefined {
    let nearest: { edge: RelationshipGraphSpatialEdge; distance: number } | undefined;
    const seen = new Set<string>();
    this.visitedCount = 0;
    const centerX = cellCoordinate(point.x);
    const centerY = cellCoordinate(point.y);
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        const ids = this.cells.get(cellKey(centerX + offsetX, centerY + offsetY));
        if (ids === undefined) continue;
        for (const id of ids) {
          if (seen.has(id)) continue;
          seen.add(id);
          const edge = this.edges.get(id);
          if (edge === undefined) continue;
          this.visitedCount += 1;
          const distance = segmentDistance(point, edge);
          if (distance > 8 || nearest !== undefined && distance >= nearest.distance) continue;
          nearest = { edge, distance };
        }
      }
    }
    return nearest;
  }

  getLastVisitedCount(): number { return this.visitedCount; }

  getCellEntryCount(): number {
    let count = 0;
    for (const ids of this.cells.values()) count += ids.size;
    return count;
  }

  clear(): void {
    this.edges.clear();
    this.cells.clear();
    this.visitedCount = 0;
  }
}
