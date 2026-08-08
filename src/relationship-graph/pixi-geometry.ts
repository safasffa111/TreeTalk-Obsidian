import type { RelationshipGraphRenderFrame } from "./render-model";

type RelationshipGraphRenderNode = RelationshipGraphRenderFrame["nodes"][number];
type RelationshipGraphRenderEdge = RelationshipGraphRenderFrame["edges"][number];

export interface RelationshipGraphGeometryAdapter<NodeHandle, EdgeHandle> {
  createNode(id: string): NodeHandle;
  updateNode(handle: NodeHandle, node: RelationshipGraphRenderNode): void;
  setNodeVisible(handle: NodeHandle, visible: boolean): void;
  destroyNode(handle: NodeHandle): void;
  createEdge(id: string): EdgeHandle;
  updateEdge(handle: EdgeHandle, edge: RelationshipGraphRenderEdge): void;
  setEdgeVisible(handle: EdgeHandle, visible: boolean): void;
  destroyEdge(handle: EdgeHandle): void;
  setCamera(camera: RelationshipGraphRenderFrame["camera"]): void;
  render(): void;
  destroy(): void;
}

export interface RelationshipGraphGeometryDiagnostics {
  readonly nodeObjectHighWaterMark: number;
  readonly edgeObjectHighWaterMark: number;
  readonly topologyAllocationCount: number;
  readonly frameCount: number;
  readonly cameraOnlyFrameCount: number;
  readonly positionOnlyFrameCount: number;
}

export class RelationshipGraphPersistentGeometry<NodeHandle, EdgeHandle> {
  private readonly nodes = new Map<string, NodeHandle>();
  private readonly edges = new Map<string, EdgeHandle>();
  private topologyAllocations = 0;
  private frames = 0;
  private cameraOnlyFrames = 0;
  private positionOnlyFrames = 0;
  private destroyed = false;

  constructor(private readonly adapter: RelationshipGraphGeometryAdapter<NodeHandle, EdgeHandle>) {}

  get diagnostics(): RelationshipGraphGeometryDiagnostics {
    return {
      nodeObjectHighWaterMark: this.nodes.size,
      edgeObjectHighWaterMark: this.edges.size,
      topologyAllocationCount: this.topologyAllocations,
      frameCount: this.frames,
      cameraOnlyFrameCount: this.cameraOnlyFrames,
      positionOnlyFrameCount: this.positionOnlyFrames
    };
  }

  render(frame: RelationshipGraphRenderFrame): void {
    if (this.destroyed) return;
    const visibleNodes = new Set<string>();
    const visibleEdges = new Set<string>();
    for (const node of frame.nodes) {
      visibleNodes.add(node.id);
      let handle = this.nodes.get(node.id);
      if (handle === undefined) {
        handle = this.adapter.createNode(node.id);
        this.nodes.set(node.id, handle);
        this.topologyAllocations += 1;
      }
      this.adapter.updateNode(handle, node);
      this.adapter.setNodeVisible(handle, true);
    }
    for (const [id, handle] of this.nodes) {
      if (!visibleNodes.has(id)) this.adapter.setNodeVisible(handle, false);
    }
    for (const edge of frame.edges) {
      visibleEdges.add(edge.id);
      let handle = this.edges.get(edge.id);
      if (handle === undefined) {
        handle = this.adapter.createEdge(edge.id);
        this.edges.set(edge.id, handle);
        this.topologyAllocations += 1;
      }
      this.adapter.updateEdge(handle, edge);
      this.adapter.setEdgeVisible(handle, true);
    }
    for (const [id, handle] of this.edges) {
      if (!visibleEdges.has(id)) this.adapter.setEdgeVisible(handle, false);
    }
    this.adapter.setCamera(frame.camera);
    this.adapter.render();
    this.frames += 1;
  }

  renderCamera(camera: RelationshipGraphRenderFrame["camera"]): void {
    if (this.destroyed) return;
    this.adapter.setCamera(camera);
    this.adapter.render();
    this.frames += 1;
    this.cameraOnlyFrames += 1;
  }

  renderPositions(frame: RelationshipGraphRenderFrame): void {
    if (this.destroyed) return;
    for (const node of frame.nodes) {
      const handle = this.nodes.get(node.id);
      if (handle !== undefined) this.adapter.updateNode(handle, node);
    }
    for (const edge of frame.edges) {
      const handle = this.edges.get(edge.id);
      if (handle !== undefined) this.adapter.updateEdge(handle, edge);
    }
    this.adapter.setCamera(frame.camera);
    this.adapter.render();
    this.frames += 1;
    this.positionOnlyFrames += 1;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const handle of this.nodes.values()) this.adapter.destroyNode(handle);
    for (const handle of this.edges.values()) this.adapter.destroyEdge(handle);
    this.nodes.clear();
    this.edges.clear();
    this.adapter.destroy();
  }
}
