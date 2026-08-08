import {
  RelationshipGraphGpuGeometry,
  RelationshipGraphSharedGeometry,
  relationshipGraphWebGlSupported,
  type RelationshipGraphSharedEdgeEndpoint
} from "./pixi-shared-geometry";
import type { RelationshipGraphWorkerSharedState } from "./worker-client";
import { stepRelationshipGraphRadius } from "./frame-interpolator";
import { RelationshipGraphEdgeSpatialIndex, RelationshipGraphSpatialIndex } from "./spatial-index";
import { createRelationshipGraphRenderFrame, type RelationshipGraphRenderFrame, type RelationshipGraphVisualState } from "./render-model";
import {
  relationshipGraphLabelAlpha,
  shouldShowRelationshipGraphLabels,
  type RelationshipGraphCamera
} from "./camera";
import type { RelationshipGraphSnapshot } from "./types";

export interface RelationshipGraphPixiSurface {
  readonly canvas: HTMLCanvasElement;
  readonly labelObjectHighWaterMark: number;
  readonly liveLabelObjectCount: number;
  readonly nodeObjectHighWaterMark?: number;
  readonly edgeObjectHighWaterMark?: number;
  readonly sharedRenderingSupported?: boolean;
  render(frame: RelationshipGraphRenderFrame): void;
  renderPositions?(frame: RelationshipGraphRenderFrame): void;
  renderCamera?(camera: RelationshipGraphCamera): void;
  renderLabels?(camera: RelationshipGraphCamera, labels: RelationshipGraphRenderFrame["labels"]): void;
  configureShared?(state: RelationshipGraphWorkerSharedState, endpoints: readonly RelationshipGraphSharedEdgeEndpoint[], frame: RelationshipGraphRenderFrame): void;
  renderShared?(pageIndex: number, sequence: number, camera: RelationshipGraphCamera, labels: RelationshipGraphRenderFrame["labels"]): void;
  clearShared?(): void;
  refreshTheme?(): void;
  resize(width: number, height: number): void;
  destroy(): void;
}

export interface RelationshipGraphHit { nodeId: string; }
export interface RelationshipGraphEdgeHit { edgeId: string; }
export interface RelationshipGraphThemeColors { accent: number; node: number; edge: number; text: string; }

type GraphGl = WebGLRenderingContext | WebGL2RenderingContext;

function parseColor(value: string, fallback: number): number {
  const normalized = value.trim();
  const hex = /^#([\da-f]{6})$/iu.exec(normalized);
  if (hex?.[1] !== undefined) return Number.parseInt(hex[1], 16);
  const shortHex = /^#([\da-f])([\da-f])([\da-f])$/iu.exec(normalized);
  if (shortHex !== null) {
    return Number.parseInt(
      `${shortHex[1]}${shortHex[1]}${shortHex[2]}${shortHex[2]}${shortHex[3]}${shortHex[3]}`,
      16
    );
  }
  const rgb = /^rgba?\(\s*(\d+)\D+(\d+)\D+(\d+)/iu.exec(normalized);
  if (rgb !== null) return (Number(rgb[1]) << 16) | (Number(rgb[2]) << 8) | Number(rgb[3]);
  const hsl = /^hsla?\(\s*(-?[\d.]+)(?:deg)?(?:\s*,\s*|\s+)([\d.]+)%(?:\s*,\s*|\s+)([\d.]+)%/iu.exec(normalized);
  if (hsl !== null) {
    const hue = ((Number(hsl[1]) % 360) + 360) % 360;
    const saturation = Math.max(0, Math.min(1, Number(hsl[2]) / 100));
    const lightness = Math.max(0, Math.min(1, Number(hsl[3]) / 100));
    const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
    const sector = hue / 60;
    const secondary = chroma * (1 - Math.abs(sector % 2 - 1));
    const [redPrime, greenPrime, bluePrime] =
      sector < 1 ? [chroma, secondary, 0] :
      sector < 2 ? [secondary, chroma, 0] :
      sector < 3 ? [0, chroma, secondary] :
      sector < 4 ? [0, secondary, chroma] :
      sector < 5 ? [secondary, 0, chroma] : [chroma, 0, secondary];
    const match = lightness - chroma / 2;
    const channel = (entry: number): number => Math.round((entry + match) * 255);
    return (channel(redPrime) << 16) | (channel(greenPrime) << 8) | channel(bluePrime);
  }
  return fallback;
}

function cssColor(value: number, alpha = 1): string {
  const red = value >> 16 & 0xff;
  const green = value >> 8 & 0xff;
  const blue = value & 0xff;
  return `rgba(${String(red)}, ${String(green)}, ${String(blue)}, ${String(alpha)})`;
}

export function resolveRelationshipGraphThemeColors(canvas: HTMLCanvasElement): RelationshipGraphThemeColors {
  const style = canvas.ownerDocument.defaultView?.getComputedStyle(canvas);
  const get = (name: string): string => style?.getPropertyValue(name) ?? "";
  return {
    accent: parseColor(get("--interactive-accent") || get("--color-accent") || get("--graph-node-focused"), 0x7c3aed),
    node: parseColor(get("--graph-node") || get("--text-muted"), 0x8b8b96),
    edge: parseColor(get("--graph-line") || get("--background-modifier-border"), 0x6f6f78),
    text: get("--graph-text").trim() || get("--text-normal").trim() || "#d7d7dc"
  };
}

function textureDimensions(nodeCount: number): { width: number; height: number } {
  const width = Math.max(1, Math.ceil(Math.sqrt(Math.max(1, nodeCount))));
  return { width, height: Math.max(1, Math.ceil(Math.max(1, nodeCount) / width)) };
}

function createOverlayCanvas(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const overlay = canvas.ownerDocument.createElement("canvas");
  overlay.className = "relationship-graph-label-canvas";
  overlay.setAttribute("aria-hidden", "true");
  canvas.insertAdjacentElement("afterend", overlay);
  return overlay;
}

export function createRelationshipGraphPixiSurface(canvas: HTMLCanvasElement): RelationshipGraphPixiSurface {
  const attributes: WebGLContextAttributes = { alpha: true, antialias: true, premultipliedAlpha: true, preserveDrawingBuffer: false };
  const gl = (canvas.getContext("webgl2", attributes) ?? canvas.getContext("webgl", attributes)) as GraphGl | null;
  const fallback2d = gl === null ? canvas.getContext("2d", { alpha: true }) : null;
  const overlay = createOverlayCanvas(canvas);
  const labelContext = overlay.getContext("2d", { alpha: true });
  let theme = resolveRelationshipGraphThemeColors(canvas);
  const interfaceFont = canvas.ownerDocument.defaultView?.getComputedStyle(canvas).getPropertyValue("--font-interface").trim() || "sans-serif";
  const sharedRenderingSupported = gl !== null && relationshipGraphWebGlSupported(gl);
  let destroyed = false;
  let width = 1;
  let height = 1;
  let dpr = Math.min(2, canvas.ownerDocument.defaultView?.devicePixelRatio ?? 1);
  let highWaterMark = 0;
  let liveLabelCount = 0;
  let sharedGeometry: RelationshipGraphSharedGeometry | undefined;
  let sharedDescriptor: RelationshipGraphWorkerSharedState["reader"]["descriptor"] | undefined;
  let localGeometry: RelationshipGraphGpuGeometry | undefined;
  let localValues = new Float32Array(4);
  let localWidth = 1;
  let localHeight = 1;
  let localSequence = 0;
  let currentFrame: RelationshipGraphRenderFrame | undefined;
  let currentCamera: RelationshipGraphCamera = { scale: 1, panX: 0, panY: 0 };
  let sharedPage = 0;
  let sharedSequence = -1;
  let themeObserver: MutationObserver | undefined;

  const clearGl = (): void => {
    if (gl === null) return;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  };

  const drawLabels = (camera: RelationshipGraphCamera, labels: RelationshipGraphRenderFrame["labels"]): void => {
    liveLabelCount = Math.min(250, labels.length);
    highWaterMark = Math.max(highWaterMark, liveLabelCount);
    if (labelContext === null) return;
    labelContext.setTransform(dpr, 0, 0, dpr, 0, 0);
    labelContext.clearRect(0, 0, width, height);
    labelContext.textAlign = "center";
    labelContext.textBaseline = "top";
    labelContext.font = `13px ${interfaceFont}`;
    for (const label of labels.slice(0, 250)) {
      const x = label.x * camera.scale + camera.panX;
      const y = label.y * camera.scale + camera.panY;
      if (x < -160 || x > width + 160 || y < -40 || y > height + 40) continue;
      labelContext.globalAlpha = label.alpha;
      labelContext.fillStyle = label.highlighted ? cssColor(theme.accent) : theme.text;
      labelContext.fillText(label.text, x, y);
    }
    labelContext.globalAlpha = 1;
  };

  const drawCanvasFallback = (frame: RelationshipGraphRenderFrame): void => {
    if (fallback2d === null) return;
    const camera = frame.camera;
    fallback2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    fallback2d.clearRect(0, 0, width, height);
    fallback2d.save();
    fallback2d.translate(camera.panX, camera.panY);
    fallback2d.scale(camera.scale, camera.scale);
    fallback2d.lineCap = "round";
    for (const edge of frame.edges) {
      fallback2d.globalAlpha = edge.dimmed ? 0.1 : edge.excluded ? 0.24 : 0.62;
      fallback2d.strokeStyle = cssColor(edge.highlighted ? theme.accent : theme.edge);
      fallback2d.lineWidth = (edge.highlighted ? 2.2 : 1.1) / Math.max(camera.scale, 0.0001);
      fallback2d.beginPath();
      fallback2d.moveTo(edge.sourceX, edge.sourceY);
      fallback2d.lineTo(edge.targetX, edge.targetY);
      fallback2d.stroke();
    }
    for (const node of frame.nodes) {
      fallback2d.globalAlpha = node.dimmed ? (node.excluded ? 0.12 : 0.16) : 1;
      fallback2d.fillStyle = cssColor(node.highlighted || node.focused ? theme.accent : theme.node);
      fallback2d.beginPath();
      fallback2d.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
      fallback2d.fill();
    }
    fallback2d.restore();
    fallback2d.globalAlpha = 1;
    drawLabels(camera, frame.labels);
  };

  const endpointsForFrame = (frame: RelationshipGraphRenderFrame, nodeIds: readonly string[]): RelationshipGraphSharedEdgeEndpoint[] => {
    const indexById = new Map(nodeIds.map((id, index) => [id, index]));
    return frame.edges.flatMap((edge) => {
      const sourceIndex = indexById.get(edge.sourceId);
      const targetIndex = indexById.get(edge.targetId);
      return sourceIndex === undefined || targetIndex === undefined ? [] : [{ id: edge.id, sourceIndex, targetIndex }];
    });
  };

  const configureLocal = (frame: RelationshipGraphRenderFrame): void => {
    if (gl === null || !sharedRenderingSupported) return;
    const dimensions = textureDimensions(frame.nodes.length);
    if (localGeometry === undefined || dimensions.width !== localWidth || dimensions.height !== localHeight) {
      localGeometry?.destroy();
      localWidth = dimensions.width;
      localHeight = dimensions.height;
      localValues = new Float32Array(localWidth * localHeight * 4);
      localGeometry = new RelationshipGraphGpuGeometry(gl, [localValues], localWidth, localHeight, theme);
    }
    const nodeIds = frame.nodes.map((node) => node.id);
    localGeometry.update(frame, nodeIds, endpointsForFrame(frame, nodeIds));
  };

  const uploadLocalPositions = (frame: RelationshipGraphRenderFrame): void => {
    localValues.fill(0);
    for (let index = 0; index < frame.nodes.length; index += 1) {
      const node = frame.nodes[index];
      if (node === undefined) continue;
      const offset = index * 4;
      localValues[offset] = node.x;
      localValues[offset + 1] = node.y;
      localValues[offset + 3] = 1;
    }
    localSequence += 1;
  };

  const renderLocal = (frame: RelationshipGraphRenderFrame, upload: boolean): void => {
    if (gl === null || !sharedRenderingSupported) {
      drawCanvasFallback(frame);
      return;
    }
    configureLocal(frame);
    if (upload) uploadLocalPositions(frame);
    clearGl();
    localGeometry?.renderValues(localValues, localSequence, frame.camera, { width, height });
    drawLabels(frame.camera, frame.labels);
  };

  const refreshTheme = (): void => {
    if (destroyed) return;
    const nextTheme = resolveRelationshipGraphThemeColors(canvas);
    if (
      nextTheme.accent === theme.accent &&
      nextTheme.node === theme.node &&
      nextTheme.edge === theme.edge &&
      nextTheme.text === theme.text
    ) return;
    theme = nextTheme;
    localGeometry?.setTheme(nextTheme);
    sharedGeometry?.setTheme(nextTheme);
    if (currentFrame === undefined) return;
    if (sharedGeometry !== undefined) {
      clearGl();
      sharedGeometry.render(sharedPage, sharedSequence, currentCamera, { width, height });
      drawLabels(currentCamera, currentFrame.labels);
    } else renderLocal(currentFrame, false);
  };

  const MutationObserverCtor = canvas.ownerDocument.defaultView?.MutationObserver;
  if (MutationObserverCtor !== undefined) {
    themeObserver = new MutationObserverCtor(() => refreshTheme());
    themeObserver.observe(canvas.ownerDocument.body, { attributes: true, attributeFilter: ["class", "style"] });
    themeObserver.observe(canvas.ownerDocument.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
  }

  return {
    canvas,
    sharedRenderingSupported,
    get labelObjectHighWaterMark() { return highWaterMark; },
    get liveLabelObjectCount() { return liveLabelCount; },
    get nodeObjectHighWaterMark() { return currentFrame === undefined ? 0 : gl !== null && sharedRenderingSupported ? 1 : currentFrame.nodes.length; },
    get edgeObjectHighWaterMark() { return currentFrame === undefined ? 0 : gl !== null && sharedRenderingSupported ? 1 : currentFrame.edges.length; },
    configureShared(state, endpoints, frame) {
      if (destroyed || gl === null || !sharedRenderingSupported) return;
      const descriptor = state.reader.descriptor;
      if (sharedGeometry === undefined || sharedDescriptor !== descriptor) {
        sharedGeometry?.destroy();
        sharedGeometry = new RelationshipGraphSharedGeometry(gl, descriptor, theme);
        sharedDescriptor = descriptor;
      }
      localGeometry?.destroy();
      localGeometry = undefined;
      currentFrame = frame;
      currentCamera = frame.camera;
      sharedGeometry.update(frame, state.nodeIds, endpoints);
      drawLabels(frame.camera, frame.labels);
    },
    clearShared() {
      sharedGeometry?.destroy();
      sharedGeometry = undefined;
      sharedDescriptor = undefined;
      sharedSequence = -1;
    },
    render(frame) {
      if (destroyed) return;
      currentFrame = frame;
      currentCamera = frame.camera;
      if (sharedGeometry !== undefined) {
        clearGl();
        sharedGeometry.render(sharedPage, sharedSequence, frame.camera, { width, height });
        drawLabels(frame.camera, frame.labels);
      } else renderLocal(frame, true);
    },
    renderPositions(frame) {
      if (destroyed || sharedGeometry !== undefined) return;
      currentFrame = frame;
      currentCamera = frame.camera;
      renderLocal(frame, true);
    },
    renderShared(pageIndex, sequence, camera, frameLabels) {
      if (destroyed || sharedGeometry === undefined) return;
      sharedPage = pageIndex;
      sharedSequence = sequence;
      currentCamera = camera;
      clearGl();
      sharedGeometry.render(pageIndex, sequence, camera, { width, height });
      drawLabels(camera, frameLabels);
    },
    renderCamera(camera) {
      if (destroyed) return;
      currentCamera = camera;
      if (sharedGeometry !== undefined) {
        clearGl();
        sharedGeometry.render(sharedPage, sharedSequence, camera, { width, height });
        drawLabels(camera, currentFrame?.labels ?? []);
      } else if (currentFrame !== undefined) {
        currentFrame.camera = camera;
        renderLocal(currentFrame, false);
      }
    },
    renderLabels(camera, frameLabels) {
      if (destroyed) return;
      drawLabels(camera, frameLabels);
    },
    refreshTheme,
    resize(nextWidth, nextHeight) {
      if (destroyed) return;
      width = Math.max(1, nextWidth);
      height = Math.max(1, nextHeight);
      dpr = Math.min(2, canvas.ownerDocument.defaultView?.devicePixelRatio ?? 1);
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      overlay.width = canvas.width;
      overlay.height = canvas.height;
      overlay.style.width = `${String(width)}px`;
      overlay.style.height = `${String(height)}px`;
      if (gl !== null) gl.viewport(0, 0, canvas.width, canvas.height);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      liveLabelCount = 0;
      themeObserver?.disconnect();
      themeObserver = undefined;
      sharedGeometry?.destroy();
      localGeometry?.destroy();
      overlay.remove();
      const lose = gl?.getExtension("WEBGL_lose_context");
      lose?.loseContext();
    }
  };
}
export class RelationshipGraphPixiView {
  private readonly index = new RelationshipGraphSpatialIndex();
  private readonly edgeIndex = new RelationshipGraphEdgeSpatialIndex();
  private readonly displayedRadii = new Map<string, number>();
  private width = 1;
  private height = 1;
  private destroyed = false;
  private lastRenderAt: number | undefined;
  private lastFrame: RelationshipGraphRenderFrame | undefined;
  private readonly frameNodesById = new Map<string, RelationshipGraphRenderFrame["nodes"][number]>();
  private readonly frameEdgesById = new Map<string, RelationshipGraphSnapshot["edges"][number]>();
  private readonly targetRadii = new Map<string, number>();
  private readonly nodeTitlesById = new Map<string, string>();
  private edgeIndexDirty = false;
  private sharedState: RelationshipGraphWorkerSharedState | undefined;
  private readonly sharedNodeIndexById = new Map<string, number>();
  private lastSnapshot: RelationshipGraphSnapshot | undefined;
  private lastSyncedSequence = -1;

  constructor(private readonly surface: RelationshipGraphPixiSurface) {}

  setSharedState(state: RelationshipGraphWorkerSharedState | undefined): void {
    this.sharedState = state;
    this.lastSyncedSequence = -1;
    this.sharedNodeIndexById.clear();
    state?.nodeIds.forEach((id, index) => this.sharedNodeIndexById.set(id, index));
    if (state === undefined) this.surface.clearShared?.();
  }

  supportsSharedRendering(): boolean { return this.surface.sharedRenderingSupported !== false; }

  isSharedMode(): boolean { return this.sharedState !== undefined; }

  get diagnostics(): { spatialIndexRebuildCount: number; spatialIndexUpdateCount: number; spatialIndexCellMutationCount: number } {
    const diagnostics = this.index.getDiagnostics();
    return {
      spatialIndexRebuildCount: diagnostics.rebuildCount,
      spatialIndexUpdateCount: diagnostics.updateCount,
      spatialIndexCellMutationCount: diagnostics.lastCellMutationCount
    };
  }

  render(snapshot: RelationshipGraphSnapshot, camera: RelationshipGraphCamera, visual: RelationshipGraphVisualState | undefined, now = performance.now()): void {
    if (this.destroyed) return;
    this.copySharedSnapshotPositions(snapshot);
    const deltaMs = this.lastRenderAt === undefined ? 0 : Math.max(0, now - this.lastRenderAt);
    this.lastRenderAt = now;
    const rawFrame = createRelationshipGraphRenderFrame(snapshot, camera, visual, { width: this.width, height: this.height });
    const visibleIds = new Set(rawFrame.nodes.map((node) => node.id));
    for (const id of this.displayedRadii.keys()) {
      if (!visibleIds.has(id)) this.displayedRadii.delete(id);
    }
    const frame: RelationshipGraphRenderFrame = {
      ...rawFrame,
      nodes: rawFrame.nodes.map((node) => {
        this.targetRadii.set(node.id, node.radius);
        const previous = this.displayedRadii.get(node.id) ?? Math.min(8, node.radius);
        const next = this.sharedState === undefined
          ? Math.max(8, Math.min(30, stepRelationshipGraphRadius(previous, node.radius, deltaMs)))
          : node.radius;
        this.displayedRadii.set(node.id, next);
        return { ...node, radius: next };
      })
    };
    this.lastFrame = frame;
    this.lastSnapshot = snapshot;
    this.nodeTitlesById.clear();
    for (const node of snapshot.nodes) this.nodeTitlesById.set(node.id, node.title);
    this.frameNodesById.clear();
    for (const node of frame.nodes) this.frameNodesById.set(node.id, node);
    this.frameEdgesById.clear();
    for (const edge of snapshot.edges) this.frameEdgesById.set(edge.id, edge);
    this.index.rebuild(frame.nodes);
    this.edgeIndexDirty = true;
    const shared = this.sharedState;
    if (shared !== undefined) {
      const endpoints = snapshot.edges.flatMap((edge) => {
        const sourceIndex = this.sharedNodeIndexById.get(edge.sourceId);
        const targetIndex = this.sharedNodeIndexById.get(edge.targetId);
        return sourceIndex === undefined || targetIndex === undefined
          ? []
          : [{ id: edge.id, sourceIndex, targetIndex }];
      });
      this.surface.configureShared?.(shared, endpoints, frame);
    } else {
      this.surface.clearShared?.();
      this.surface.render(frame);
    }
  }

  renderShared(snapshot: RelationshipGraphSnapshot, camera: RelationshipGraphCamera, now = performance.now()): { active: boolean; sequence: number } | false {
    if (this.destroyed || this.lastFrame === undefined || this.sharedState === undefined || this.surface.renderShared === undefined) return false;
    const lease = this.sharedState.reader.acquire();
    if (lease === undefined) return false;
    try {
      this.lastRenderAt = now;
      this.lastSnapshot = snapshot;
      const frame = this.lastFrame;
      frame.camera = camera;
      for (const label of frame.labels) {
        const nodeIndex = this.sharedNodeIndexById.get(label.id);
        const node = this.frameNodesById.get(label.id);
        if (nodeIndex === undefined || node === undefined) continue;
        const offset = nodeIndex * 4;
        label.x = lease.values[offset] ?? label.x;
        label.y = (lease.values[offset + 1] ?? label.y) + node.radius + 6;
      }
      this.surface.renderShared(lease.pageIndex, lease.sequence, camera, frame.labels);
      return { active: lease.active, sequence: lease.sequence };
    } finally {
      lease.release();
    }
  }

  syncSharedPositions(snapshot?: RelationshipGraphSnapshot): boolean {
    const targetSnapshot = snapshot ?? this.lastSnapshot;
    if (this.sharedState === undefined || targetSnapshot === undefined || this.lastFrame === undefined) return false;
    const lease = this.sharedState.reader.acquire();
    if (lease === undefined) return false;
    try {
      if (lease.sequence === this.lastSyncedSequence) return true;
      const frame = this.lastFrame;
      for (const node of frame.nodes) {
        const nodeIndex = this.sharedNodeIndexById.get(node.id);
        if (nodeIndex === undefined) continue;
        const offset = nodeIndex * 4;
        const x = lease.values[offset];
        const y = lease.values[offset + 1];
        if (x === undefined || y === undefined) continue;
        node.x = x;
        node.y = y;
        const position = targetSnapshot.positions[node.id] ?? { x, y, fixed: false };
        position.x = x;
        position.y = y;
        position.fixed = false;
        targetSnapshot.positions[node.id] = position;
      }
      for (const edge of frame.edges) {
        const topology = this.frameEdgesById.get(edge.id);
        if (topology === undefined) continue;
        const source = targetSnapshot.positions[topology.sourceId];
        const target = targetSnapshot.positions[topology.targetId];
        if (source === undefined || target === undefined) continue;
        edge.sourceX = source.x;
        edge.sourceY = source.y;
        edge.targetX = target.x;
        edge.targetY = target.y;
      }
      for (const label of frame.labels) {
        const node = this.frameNodesById.get(label.id);
        if (node === undefined) continue;
        label.x = node.x;
        label.y = node.y + node.radius + 6;
      }
      this.index.updatePositions(frame.nodes);
      this.edgeIndexDirty = true;
      this.lastSyncedSequence = lease.sequence;
      return true;
    } finally {
      lease.release();
    }
  }

  private copySharedSnapshotPositions(snapshot: RelationshipGraphSnapshot): void {
    if (this.sharedState === undefined) return;
    const lease = this.sharedState.reader.acquire();
    if (lease === undefined) return;
    try {
      if (lease.sequence === this.lastSyncedSequence && snapshot === this.lastSnapshot) return;
      for (const node of snapshot.nodes) {
        const nodeIndex = this.sharedNodeIndexById.get(node.id);
        if (nodeIndex === undefined) continue;
        const offset = nodeIndex * 4;
        const x = lease.values[offset];
        const y = lease.values[offset + 1];
        if (x === undefined || y === undefined) continue;
        const position = snapshot.positions[node.id] ?? { x, y, fixed: false };
        position.x = x;
        position.y = y;
        position.fixed = false;
        snapshot.positions[node.id] = position;
      }
      this.lastSyncedSequence = lease.sequence;
    } finally {
      lease.release();
    }
  }

  renderPositions(snapshot: RelationshipGraphSnapshot, camera: RelationshipGraphCamera, now = performance.now()): boolean {
    if (this.destroyed || this.lastFrame === undefined) return false;
    const deltaMs = this.lastRenderAt === undefined ? 0 : Math.max(0, now - this.lastRenderAt);
    this.lastRenderAt = now;
    const frame = this.lastFrame;
    frame.camera = camera;
    for (const node of frame.nodes) {
      const position = snapshot.positions[node.id];
      if (position === undefined) continue;
      node.x = position.x;
      node.y = position.y;
      const targetRadius = this.targetRadii.get(node.id) ?? node.radius;
      node.radius = Math.max(8, Math.min(30, stepRelationshipGraphRadius(node.radius, targetRadius, deltaMs)));
    }
    for (const edge of frame.edges) {
      const topology = this.frameEdgesById.get(edge.id);
      if (topology === undefined) continue;
      const source = snapshot.positions[topology.sourceId];
      const target = snapshot.positions[topology.targetId];
      if (source === undefined || target === undefined) continue;
      edge.sourceX = source.x;
      edge.sourceY = source.y;
      edge.targetX = target.x;
      edge.targetY = target.y;
    }
    for (const label of frame.labels) {
      const node = this.frameNodesById.get(label.id);
      if (node === undefined) continue;
      label.x = node.x;
      label.y = node.y + node.radius + 6;
    }
    this.index.updatePositions(frame.nodes);
    this.edgeIndexDirty = true;
    if (this.surface.renderPositions === undefined) this.surface.render(frame);
    else this.surface.renderPositions(frame);
    return true;
  }

  renderCamera(camera: RelationshipGraphCamera): void {
    if (this.destroyed) return;
    this.surface.renderCamera?.(camera);
    this.renderLabels(camera);
  }

  renderLabels(camera: RelationshipGraphCamera): void {
    if (this.destroyed || this.lastFrame === undefined) return;
    this.syncSharedPositions();
    const frame = this.lastFrame;
    frame.camera = camera;
    const highlighted = frame.nodes.find((node) => node.highlighted);
    const zoomLabelsVisible = shouldShowRelationshipGraphLabels(camera.scale);
    if (!zoomLabelsVisible && highlighted === undefined) {
      frame.labels = [];
      this.surface.renderLabels?.(camera, frame.labels);
      return;
    }
    const margin = 120;
    const scale = Math.max(camera.scale, Number.EPSILON);
    const baseAlpha = relationshipGraphLabelAlpha(camera.scale);
    const left = (-camera.panX - margin) / scale;
    const top = (-camera.panY - margin) / scale;
    const right = (this.width - camera.panX + margin) / scale;
    const bottom = (this.height - camera.panY + margin) / scale;
    const candidates = frame.nodes
      .filter((node) =>
        node.x >= left && node.x <= right && node.y >= top && node.y <= bottom &&
        (zoomLabelsVisible || node.highlighted)
      )
      .sort((leftNode, rightNode) =>
        Number(rightNode.highlighted) - Number(leftNode.highlighted) ||
        Number(rightNode.active) - Number(leftNode.active) ||
        Number(rightNode.focused) - Number(leftNode.focused) ||
        rightNode.radius - leftNode.radius ||
        leftNode.id.localeCompare(rightNode.id)
      )
      .slice(0, 250);
    frame.labels = candidates.map((node) => ({
      id: node.id,
      text: this.nodeTitlesById.get(node.id) ?? node.id,
      x: node.x,
      y: node.y + node.radius + 6,
      alpha: node.highlighted ? 1 : node.dimmed ? baseAlpha * 0.18 : baseAlpha,
      highlighted: node.highlighted
    }));
    this.surface.renderLabels?.(camera, frame.labels);
  }

  hitTest(worldPoint: { x: number; y: number }): RelationshipGraphHit | RelationshipGraphEdgeHit | undefined {
    const hit = this.hitTestNode(worldPoint);
    if (hit !== undefined) return hit;
    return this.hitTestEdge(worldPoint);
  }

  hitTestNode(worldPoint: { x: number; y: number }): RelationshipGraphHit | undefined {
    this.syncSharedPositions();
    const hit = this.index.hitTest(worldPoint);
    return hit === undefined ? undefined : { nodeId: hit.id };
  }

  hitTestEdge(worldPoint: { x: number; y: number }): RelationshipGraphEdgeHit | undefined {
    this.syncSharedPositions();
    if (this.edgeIndexDirty && this.lastFrame !== undefined) {
      this.edgeIndex.rebuild(this.lastFrame.edges);
      this.edgeIndexDirty = false;
    }
    const hit = this.edgeIndex.hitTest(worldPoint);
    return hit === undefined ? undefined : { edgeId: hit.edge.id };
  }

  resize(width: number, height: number): void {
    if (this.destroyed) return;
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.surface.resize(this.width, this.height);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.index.clear();
    this.edgeIndex.clear();
    this.displayedRadii.clear();
    this.frameNodesById.clear();
    this.frameEdgesById.clear();
    this.targetRadii.clear();
    this.nodeTitlesById.clear();
    this.lastFrame = undefined;
    this.lastSnapshot = undefined;
    this.sharedState = undefined;
    this.lastSyncedSequence = -1;
    this.sharedNodeIndexById.clear();
    this.surface.destroy();
  }
}
