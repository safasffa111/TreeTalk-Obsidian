import type { DepositGraphPosition } from "../domain/types";
import type { ConversationStorePort } from "../tabs/active-conversation-store";
import type { DepositGraphWindowState } from "../tabs/plugin-data";
import { setRelationshipEdgeOverride, setRelationshipGraphNodeIncluded, setRelationshipNodeIncluded } from "./state";
import {
  RelationshipGraphModelAdapter,
  relationshipGraphInputSignature,
  relationshipGraphVisualStateSignature,
  relationshipGraphWorkerTopology
} from "./model";
import { RelationshipGraphInteraction, type RelationshipGraphInteractionView, type RelationshipGraphInteractionWorker } from "./interaction";
import { RelationshipGraphPixiView, createRelationshipGraphPixiSurface } from "./pixi-view";
import type { RelationshipGraphCamera } from "./camera";
import { relationshipGraphCameraSettled, stepRelationshipGraphCamera } from "./camera";
import { RelationshipGraphFrameInterpolator } from "./frame-interpolator";
import type { RelationshipGraphSnapshot } from "./types";
import { planRelationshipGraphRadialLayout } from "./radial-layout";
import {
  RelationshipGraphWorkerClient,
  type RelationshipGraphTopologyInput,
  type RelationshipGraphWorkerClientOptions,
  type RelationshipGraphWorkerSharedState
} from "./worker-client";

export interface RelationshipGraphViewLike extends RelationshipGraphInteractionView {
  render(snapshot: RelationshipGraphSnapshot, camera: RelationshipGraphCamera, visual: { hoveredNodeId?: string; activeNodeId?: string; focusedNodeId?: string }): void;
  renderPositions?(snapshot: RelationshipGraphSnapshot, camera: RelationshipGraphCamera, now?: number): boolean;
  renderCamera?(camera: RelationshipGraphCamera): void;
  renderLabels?(camera: RelationshipGraphCamera): void;
  setSharedState?(state: RelationshipGraphWorkerSharedState | undefined): void;
  supportsSharedRendering?(): boolean;
  isSharedMode?(): boolean;
  renderShared?(snapshot: RelationshipGraphSnapshot, camera: RelationshipGraphCamera, now?: number): { active: boolean; sequence: number } | false;
  syncSharedPositions?(snapshot?: RelationshipGraphSnapshot): boolean;
  resize(width: number, height: number): void;
  destroy(): void;
}

export type RelationshipGraphViewFactory = (canvas: HTMLCanvasElement, snapshot: RelationshipGraphSnapshot) => RelationshipGraphViewLike;
export type RelationshipGraphWorkerFactory = (options: RelationshipGraphWorkerClientOptions) => RelationshipGraphWorkerClientLike;

export interface RelationshipGraphWorkerClientLike extends RelationshipGraphInteractionWorker {
  updateTopology(topology: RelationshipGraphTopologyInput): number;
  sharedState?(): RelationshipGraphWorkerSharedState | undefined;
  isPhysicsActive?(): boolean;
  pause(): void;
  resume(): void;
  retry(): void;
  destroy(): void;
}

export interface RelationshipGraphWindowOptions {
  document: Document;
  store: ConversationStorePort;
  getWindowState(): DepositGraphWindowState;
  setWindowState(state: DepositGraphWindowState): void;
  onOpenNote(filePath: string): Promise<boolean>;
  onClose(): void;
  viewFactory?: RelationshipGraphViewFactory;
  workerFactory?: RelationshipGraphWorkerFactory;
}

function defaultCamera(): RelationshipGraphCamera { return { scale: 1, panX: 0, panY: 0 }; }

function rawConversationNodeId(graphNodeId: string): string | undefined {
  return graphNodeId.startsWith("conversation:") ? graphNodeId.slice("conversation:".length) : undefined;
}

function relationshipGraphSeed(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) / 4_294_967_296;
}

function seedRelationshipGraphPositions(
  snapshot: RelationshipGraphSnapshot,
  current: Record<string, DepositGraphPosition>,
  viewport: { width: number; height: number }
): Record<string, DepositGraphPosition> {
  const next: Record<string, DepositGraphPosition> = {};
  for (const node of snapshot.nodes) {
    const position = current[node.id];
    if (position !== undefined && Number.isFinite(position.x) && Number.isFinite(position.y)) {
      next[node.id] = { x: position.x, y: position.y, fixed: position.fixed };
    }
  }
  const plan = planRelationshipGraphRadialLayout(snapshot.nodes.map((node) => ({
    id: node.id,
    kind: node.kind,
    order: node.layoutOrder ?? 0,
    ...(node.layoutParentId === undefined ? {} : { parentId: node.layoutParentId }),
    ...(node.layoutRoot === true ? { root: true } : {}),
    ...(node.layoutHostId === undefined ? {} : { hostId: node.layoutHostId }),
    ...(node.layoutNoteRelation === undefined ? {} : { noteRelation: node.layoutNoteRelation }),
    ...(node.layoutOrbitIndex === undefined ? {} : { orbitIndex: node.layoutOrbitIndex }),
    ...(node.layoutOrbitCount === undefined ? {} : { orbitCount: node.layoutOrbitCount })
  })), viewport);
  for (const node of snapshot.nodes) {
    if (next[node.id] !== undefined) continue;
    const target = plan.targets.get(node.id);
    const seed = relationshipGraphSeed(node.id);
    const jitter = node.kind === "note" ? 5 : 3;
    next[node.id] = {
      x: (target?.x ?? plan.centerX) + (seed - 0.5) * jitter,
      y: (target?.y ?? plan.centerY) + (0.5 - seed) * jitter,
      fixed: false
    };
  }
  return next;
}

function relationshipTopologySignature(snapshot: RelationshipGraphSnapshot): string {
  return JSON.stringify([
    snapshot.nodes.map((node) => [
      node.id,
      node.kind,
      node.layoutParentId,
      node.layoutRoot === true,
      node.layoutOrder,
      node.layoutHostId,
      node.layoutNoteRelation,
      node.layoutOrbitIndex,
      node.layoutOrbitCount
    ]),
    snapshot.edges.map((edge) => [edge.id, edge.sourceId, edge.targetId, edge.kind])
  ]);
}

export class RelationshipGraphWindow {
  private root: HTMLElement | undefined;
  private stage: HTMLElement | undefined;
  private title: HTMLElement | undefined;
  private counts: HTMLElement | undefined;
  private zoomLabel: HTMLElement | undefined;
  private emptyOverlay: HTMLElement | undefined;
  private errorOverlay: HTMLElement | undefined;
  private unsubscribe: (() => void) | undefined;
  private resizeObserver: ResizeObserver | undefined;
  private view: RelationshipGraphViewLike | undefined;
  private worker: RelationshipGraphWorkerClientLike | undefined;
  private interaction: RelationshipGraphInteraction | undefined;
  private canvas: HTMLCanvasElement | undefined;
  private sessionId: string | undefined;
  private snapshot: RelationshipGraphSnapshot | undefined;
  private positions: Record<string, DepositGraphPosition> = {};
  private topologySignature = "";
  private visual: { hoveredNodeId?: string; activeNodeId?: string; focusedNodeId?: string } = {};
  private refreshing = false;
  private refreshRequested = false;
  private paused = false;
  private readonly cameras = new Map<string, RelationshipGraphCamera>();
  private readonly displayedCameras = new Map<string, RelationshipGraphCamera>();
  private scheduledRender = false;
  private animationFrameId: number | undefined;
  private pendingFullRender = false;
  private pendingPositionRender = false;
  private pendingLabelRender = false;
  private lastRenderTimestamp: number | undefined;
  private frameInterpolator: RelationshipGraphFrameInterpolator | undefined;
  private displayPositionValues = new Float32Array(0);
  private positionNodeIds: string[] = [];
  private readonly positionIndexById = new Map<string, number>();
  private positionAnimationActive = false;
  private graphInputSignature = "";
  private graphVisualStateSignature = "";
  private cameraNeedsLabelCommit = false;

  constructor(private readonly options: RelationshipGraphWindowOptions) {}

  open(): void {
    if (this.root !== undefined) {
      this.refresh();
      this.resizeStage();
      this.focus();
      return;
    }
    const document = this.options.document;
    const root = document.createElement("section");
    root.className = "relationship-graph-window";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "TreeTalk 关系图谱");
    const titlebar = document.createElement("header");
    titlebar.className = "relationship-graph-titlebar";
    const title = document.createElement("div");
    title.className = "relationship-graph-title";
    const controls = document.createElement("div");
    controls.className = "relationship-graph-window-controls";
    controls.append(
      this.controlButton("—", "最小化", () => this.minimize()),
      this.controlButton("□", "最大化或恢复", () => this.toggleMaximize()),
      this.controlButton("×", "关闭", () => this.close())
    );
    titlebar.append(title, controls);
    const toolbar = document.createElement("div");
    toolbar.className = "relationship-graph-toolbar";
    const counts = document.createElement("span");
    counts.className = "relationship-graph-counts";
    const zoom = document.createElement("span");
    zoom.className = "relationship-graph-zoom";
    const fit = this.controlButton("适配", "适配视图", () => this.fitView());
    const pause = this.controlButton("暂停", "暂停或继续图谱", () => {
      this.paused = !this.paused;
      if (this.paused || this.isDisplaySuspended()) this.worker?.pause(); else this.worker?.resume();
      pause.textContent = this.paused ? "继续" : "暂停";
      this.scheduleRender("positions");
    });
    toolbar.append(counts, zoom, fit, pause);
    const stage = document.createElement("div");
    stage.className = "relationship-graph-stage";
    const empty = document.createElement("div");
    empty.className = "relationship-graph-empty-overlay";
    empty.hidden = true;
    const error = document.createElement("div");
    error.className = "relationship-graph-error-overlay";
    error.hidden = true;
    stage.append(empty, error);
    const resizeHandle = document.createElement("div");
    resizeHandle.className = "relationship-graph-resize-handle";
    root.append(titlebar, toolbar, stage, resizeHandle);
    document.body.append(root);
    this.root = root;
    this.stage = stage;
    this.title = title;
    this.counts = counts;
    this.zoomLabel = zoom;
    this.emptyOverlay = empty;
    this.errorOverlay = error;
    this.installWindowDrag(titlebar);
    this.installResize(resizeHandle);
    root.addEventListener("pointerdown", () => this.bringToFront());
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    this.unsubscribe = this.options.store.subscribe(() => this.refresh());
    if (typeof ResizeObserver === "function") {
      this.resizeObserver = new ResizeObserver(() => this.resizeStage());
      this.resizeObserver.observe(stage);
    }
    this.applyWindowState();
    this.refresh();
    this.focus();
  }

  focus(): void {
    if (this.root === undefined) return;
    const state = this.options.getWindowState();
    if (state.minimized) {
      this.options.setWindowState({ ...state, minimized: false });
      this.applyWindowState();
    }
    this.bringToFront();
    this.root.focus({ preventScroll: true });
  }

  close(): void { this.destroy(); this.options.onClose(); }

  destroy(): void {
    this.cancelScheduledRender();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.destroySession();
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    this.options.document.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.root?.remove();
    this.root = undefined;
    this.stage = undefined;
    this.title = undefined;
    this.counts = undefined;
    this.zoomLabel = undefined;
    this.emptyOverlay = undefined;
    this.errorOverlay = undefined;
  }

  private controlButton(text: string, label: string, action: () => void): HTMLButtonElement {
    const button = this.options.document.createElement("button");
    button.type = "button";
    button.textContent = text;
    button.setAttribute("aria-label", label);
    button.title = label;
    button.addEventListener("click", action);
    return button;
  }

  private bringToFront(): void {
    if (this.root === undefined) return;
    for (const element of this.options.document.querySelectorAll<HTMLElement>(".relationship-graph-window")) element.classList.remove("is-focused");
    this.root.classList.add("is-focused");
  }

  private minimize(): void {
    const state = this.options.getWindowState();
    this.options.setWindowState({ ...state, minimized: !state.minimized, maximized: false });
    this.applyWindowState();
  }

  private toggleMaximize(): void {
    const state = this.options.getWindowState();
    this.options.setWindowState({ ...state, minimized: false, maximized: !state.maximized });
    this.applyWindowState();
  }

  private applyWindowState(): void {
    const root = this.root;
    if (root === undefined) return;
    const state = this.options.getWindowState();
    root.classList.toggle("is-minimized", state.minimized);
    root.classList.toggle("is-maximized", state.maximized);
    if (state.maximized) {
      root.style.left = "12px";
      root.style.top = "12px";
      root.style.width = "calc(100vw - 24px)";
      root.style.height = "calc(100vh - 24px)";
    } else {
      root.style.left = `${String(Math.max(0, state.x))}px`;
      root.style.top = `${String(Math.max(0, state.y))}px`;
      root.style.width = `${String(state.width)}px`;
      root.style.height = state.minimized ? "42px" : `${String(state.height)}px`;
    }
    const suspended = state.minimized || this.options.document.hidden;
    if (suspended) {
      this.worker?.pause();
      this.cancelScheduledRender();
      this.lastRenderTimestamp = undefined;
    } else if (this.paused) this.worker?.pause();
    else this.worker?.resume();
    this.resizeStage();
  }

  private readonly onVisibilityChange = (): void => this.applyWindowState();

  private installWindowDrag(titlebar: HTMLElement): void {
    titlebar.addEventListener("pointerdown", (event) => {
      if ((event.target as Element).closest("button") !== null || this.options.getWindowState().maximized) return;
      event.preventDefault();
      const state = this.options.getWindowState();
      const startX = event.clientX;
      const startY = event.clientY;
      const onMove = (move: PointerEvent): void => {
        if (this.root === undefined) return;
        this.root.style.left = `${String(Math.max(0, state.x + move.clientX - startX))}px`;
        this.root.style.top = `${String(Math.max(0, state.y + move.clientY - startY))}px`;
      };
      const onUp = (up: PointerEvent): void => {
        this.options.document.removeEventListener("pointermove", onMove);
        this.options.setWindowState({ ...this.options.getWindowState(), x: Math.max(0, state.x + up.clientX - startX), y: Math.max(0, state.y + up.clientY - startY) });
        this.applyWindowState();
      };
      this.options.document.addEventListener("pointermove", onMove);
      this.options.document.addEventListener("pointerup", onUp, { once: true });
    });
  }

  private installResize(handle: HTMLElement): void {
    handle.addEventListener("pointerdown", (event) => {
      const state = this.options.getWindowState();
      if (state.maximized || state.minimized) return;
      event.preventDefault();
      const startX = event.clientX;
      const startY = event.clientY;
      const onMove = (move: PointerEvent): void => {
        if (this.root === undefined) return;
        this.root.style.width = `${String(Math.max(560, state.width + move.clientX - startX))}px`;
        this.root.style.height = `${String(Math.max(360, state.height + move.clientY - startY))}px`;
      };
      const onUp = (up: PointerEvent): void => {
        this.options.document.removeEventListener("pointermove", onMove);
        this.options.setWindowState({ ...this.options.getWindowState(), width: Math.max(560, state.width + up.clientX - startX), height: Math.max(360, state.height + up.clientY - startY) });
        this.applyWindowState();
      };
      this.options.document.addEventListener("pointermove", onMove);
      this.options.document.addEventListener("pointerup", onUp, { once: true });
    });
  }

  private refresh(): void {
    this.refreshRequested = true;
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      while (this.refreshRequested) {
        this.refreshRequested = false;
        this.refreshOnce();
      }
    } finally {
      this.refreshing = false;
    }
  }

  private refreshOnce(): void {
    const conversation = this.options.store.getSnapshot();
    if (conversation === undefined) {
      this.destroySession();
      if (this.title !== undefined) this.title.textContent = "关系图谱";
      if (this.emptyOverlay !== undefined) {
        this.emptyOverlay.textContent = "当前没有打开的 TreeTalk 对话空间。";
        this.emptyOverlay.hidden = false;
      }
      return;
    }
    if (this.emptyOverlay !== undefined) this.emptyOverlay.hidden = true;
    const nextInputSignature = relationshipGraphInputSignature(conversation);
    const nextVisualStateSignature = relationshipGraphVisualStateSignature(conversation);
    if (this.title !== undefined) this.title.textContent = `关系图谱 · ${conversation.title}`;
    if (
      this.sessionId === conversation.id &&
      nextInputSignature === this.graphInputSignature &&
      nextVisualStateSignature === this.graphVisualStateSignature
    ) {
      this.interaction?.setReadOnly(!(this.options.store.canMutate?.() ?? true));
      return;
    }
    const adapter = new RelationshipGraphModelAdapter();
    const snapshot = adapter.snapshot(conversation.id, conversation);
    if (this.counts !== undefined) this.counts.textContent = `${String(snapshot.nodes.length)} 节点 · ${String(snapshot.edges.length)} 连线`;
    if (this.sessionId !== conversation.id) this.createSession(snapshot);
    else {
      const nextTopologySignature = relationshipTopologySignature(snapshot);
      if (nextTopologySignature !== this.topologySignature) {
        if (this.snapshot !== undefined) this.view?.syncSharedPositions?.(this.snapshot);
        this.positions = seedRelationshipGraphPositions(snapshot, this.positions, this.graphViewport());
      }
      this.snapshot = snapshot;
      snapshot.topologySignature = nextTopologySignature;
      snapshot.positions = this.positions;
      this.updateSession(snapshot, nextTopologySignature);
    }
    this.graphInputSignature = nextInputSignature;
    this.graphVisualStateSignature = nextVisualStateSignature;
  }

  private createSession(snapshot: RelationshipGraphSnapshot): void {
    this.destroySession();
    const stage = this.stage;
    if (stage === undefined) return;
    const canvas = this.options.document.createElement("canvas");
    canvas.className = "relationship-graph-canvas";
    stage.querySelector("canvas")?.remove();
    stage.append(canvas);
    const camera = this.cameras.get(snapshot.sessionId) ?? defaultCamera();
    this.cameras.set(snapshot.sessionId, camera);
    this.displayedCameras.set(snapshot.sessionId, { ...camera });
    this.snapshot = snapshot;
    this.topologySignature = relationshipTopologySignature(snapshot);
    snapshot.topologySignature = this.topologySignature;
    this.positions = seedRelationshipGraphPositions(snapshot, snapshot.positions, this.graphViewport());
    snapshot.positions = this.positions;
    this.resetFrameInterpolator(snapshot);
    const view = this.options.viewFactory?.(canvas, snapshot) ?? new RelationshipGraphPixiView(createRelationshipGraphPixiSurface(canvas));
    const onFrame = (frame: Parameters<NonNullable<RelationshipGraphWorkerClientOptions["onFrame"]>>[0]): void => {
      if (this.sessionId !== snapshot.sessionId) return;
      if (frame.values !== undefined && frame.values.length === this.displayPositionValues.length) {
        this.positionAnimationActive = frame.active;
        this.frameInterpolator?.push({
          sequence: frame.sequence ?? frame.revision,
          receivedAt: performance.now(),
          values: frame.values
        });
        this.scheduleRender("positions");
      } else {
        this.positions = frame.positions;
        if (this.snapshot?.sessionId === snapshot.sessionId) this.snapshot.positions = this.positions;
        if (this.snapshot !== undefined) this.resetFrameInterpolator(this.snapshot);
        this.scheduleRender("full");
      }
    };
    const onError = (message: string): void => {
      if (this.sessionId === snapshot.sessionId) this.renderError(message);
    };
    const workerOptions: RelationshipGraphWorkerClientOptions = {
      sessionId: snapshot.sessionId,
      onFrame,
      onError,
      onSharedActivity: () => this.scheduleRender("positions"),
      sharedMemory: view.supportsSharedRendering?.() === true && view.renderShared !== undefined
    };
    const worker = this.options.workerFactory?.(workerOptions) ?? new RelationshipGraphWorkerClient(workerOptions);
    this.sessionId = snapshot.sessionId;
    this.canvas = canvas;
    this.view = view;
    this.worker = worker;
    this.interaction = new RelationshipGraphInteraction({
      element: canvas,
      view,
      worker,
      camera: () => this.displayedCameras.get(snapshot.sessionId) ?? defaultCamera(),
      targetCamera: () => this.cameras.get(snapshot.sessionId) ?? defaultCamera(),
      onCameraChange: (next, mode) => {
        this.cameras.set(snapshot.sessionId, { ...next });
        if (mode === "direct") this.displayedCameras.set(snapshot.sessionId, { ...next });
        else this.cameraNeedsLabelCommit = true;
        this.scheduleRender("camera");
      },
      onCameraCommit: () => this.scheduleRender("labels"),
      onActivityChange: () => this.scheduleRender("positions"),
      onDragPreview: (nodeId, point) => {
        if (view.isSharedMode?.() === true) {
          this.scheduleRender("positions");
          return;
        }
        const index = this.positionIndexById.get(nodeId);
        if (index === undefined) return;
        this.positionAnimationActive = true;
        if (point === undefined) this.frameInterpolator?.releaseDragOverride(index, performance.now());
        else this.frameInterpolator?.setDragOverride(index, point.x, point.y);
        this.scheduleRender("positions");
      },
      onVisualChange: (state) => { this.visual = state; this.scheduleRender("full"); },
      onActivateNode: (graphNodeId) => this.activateNode(graphNodeId),
      onToggleNode: (graphNodeId) => this.toggleNode(graphNodeId),
      onToggleEdge: (edgeId) => this.toggleEdge(edgeId),
      canMutate: () => this.options.store.canMutate?.() ?? true,
      viewport: () => ({ width: this.stage?.clientWidth || this.options.getWindowState().width, height: this.stage?.clientHeight || this.options.getWindowState().height })
    });
    worker.updateTopology(relationshipGraphWorkerTopology(snapshot));
    view.setSharedState?.(worker.sharedState?.());
    this.resizeStage();
    this.renderNow(undefined, "full");
    this.ensureAnimationFrame();
  }

  private updateSession(snapshot: RelationshipGraphSnapshot, nextTopologySignature = relationshipTopologySignature(snapshot)): void {
    if (nextTopologySignature !== this.topologySignature) {
      this.topologySignature = nextTopologySignature;
      snapshot.positions = this.positions;
      this.worker?.updateTopology(relationshipGraphWorkerTopology(snapshot));
      this.view?.setSharedState?.(this.worker?.sharedState?.());
      this.resetFrameInterpolator(snapshot);
    }
    this.interaction?.setReadOnly(!(this.options.store.canMutate?.() ?? true));
    this.scheduleRender("full");
  }

  private graphViewport(): { width: number; height: number } {
    return {
      width: this.stage?.clientWidth || this.options.getWindowState().width || 1000,
      height: this.stage?.clientHeight || this.options.getWindowState().height || 720
    };
  }

  private renderNow(timestamp = performance.now(), mode: "full" | "positions" | "labels" | "camera" = "full"): void {
    if (this.snapshot === undefined || this.view === undefined || this.sessionId === undefined || this.isDisplaySuspended()) return;
    const targetCamera = this.cameras.get(this.sessionId) ?? defaultCamera();
    const currentCamera = this.displayedCameras.get(this.sessionId) ?? targetCamera;
    const deltaMs = this.lastRenderTimestamp === undefined ? 16 : Math.max(0, timestamp - this.lastRenderTimestamp);
    this.lastRenderTimestamp = timestamp;
    const steppedCamera = relationshipGraphCameraSettled(currentCamera, targetCamera)
      ? targetCamera
      : stepRelationshipGraphCamera(currentCamera, targetCamera, deltaMs);
    const camera = relationshipGraphCameraSettled(steppedCamera, targetCamera) ? targetCamera : steppedCamera;
    this.displayedCameras.set(this.sessionId, { ...camera });

    const sharedState = this.worker?.sharedState?.();
    const sharedMode = sharedState !== undefined && this.view.renderShared !== undefined;
    if (sharedMode && this.view.isSharedMode?.() !== true) this.view.setSharedState?.(sharedState);

    if (!sharedMode && (mode === "full" || mode === "positions") && this.positionAnimationActive && this.frameInterpolator !== undefined && this.displayPositionValues.length > 0) {
      this.frameInterpolator.sample(timestamp, this.displayPositionValues);
      this.applyDisplayPositionValues();
    }
    this.snapshot.positions = this.positions;

    if (sharedMode) {
      if (mode === "full") this.view.render(this.snapshot, camera, this.visual);
      else if (mode === "labels" || mode === "camera") this.view.renderLabels?.(camera);
      this.view.renderShared?.(this.snapshot, camera, timestamp);
    } else if (mode === "camera" && this.view.renderCamera !== undefined) this.view.renderCamera(camera);
    else if (mode === "labels") {
      if (this.view.renderLabels !== undefined) this.view.renderLabels(camera);
      else this.view.renderCamera?.(camera);
    } else if (mode === "positions" && this.view.renderPositions?.(this.snapshot, camera, timestamp) === true) {
      // The fallback position path updated persistent Pixi objects in place.
    } else this.view.render(this.snapshot, camera, this.visual);

    if (this.zoomLabel !== undefined) this.zoomLabel.textContent = `${String(Math.round(camera.scale * 100))}%`;
    if (relationshipGraphCameraSettled(camera, targetCamera) && this.cameraNeedsLabelCommit) {
      this.cameraNeedsLabelCommit = false;
      this.pendingLabelRender = true;
    }
  }

  private shouldContinueAnimation(timestamp: number): boolean {
    if (this.isDisplaySuspended()) return false;
    if (this.pendingFullRender || this.pendingPositionRender || this.pendingLabelRender) return true;
    if (this.sessionId !== undefined) {
      const target = this.cameras.get(this.sessionId) ?? defaultCamera();
      const current = this.displayedCameras.get(this.sessionId) ?? target;
      if (!relationshipGraphCameraSettled(current, target)) return true;
    }
    if (this.worker?.sharedState?.() !== undefined) {
      return this.interaction?.isActive() === true || this.worker.isPhysicsActive?.() === true;
    }
    return this.frameInterpolator?.needsFrame(timestamp) === true;
  }

  private resizeStage(): void {
    if (this.stage === undefined || this.view === undefined) return;
    const width = this.stage.clientWidth || this.options.getWindowState().width;
    const height = this.stage.clientHeight || this.options.getWindowState().height - 70;
    this.view.resize(width, height);
    this.worker?.resize?.(width, height);
    this.scheduleRender("labels");
  }

  private fitView(): void {
    this.cameras.set(this.sessionId ?? "", defaultCamera());
    this.displayedCameras.set(this.sessionId ?? "", defaultCamera());
    this.scheduleRender("labels");
  }

  private scheduleRender(mode: "full" | "positions" | "labels" | "camera" = "full"): void {
    if (this.root === undefined || this.isDisplaySuspended()) return;
    if (mode === "full") this.pendingFullRender = true;
    else if (mode === "positions") this.pendingPositionRender = true;
    else if (mode === "labels") this.pendingLabelRender = true;
    this.ensureAnimationFrame();
  }

  private ensureAnimationFrame(): void {
    if (this.scheduledRender || this.root === undefined || this.isDisplaySuspended()) return;
    const browserWindow = this.options.document.defaultView;
    const raf = browserWindow === null ? undefined : browserWindow.requestAnimationFrame.bind(browserWindow);
    if (typeof raf !== "function") {
      const renderMode = this.consumePendingRenderMode();
      this.renderNow(undefined, renderMode);
      return;
    }
    this.scheduledRender = true;
    this.animationFrameId = raf((timestamp) => {
      this.animationFrameId = undefined;
      this.scheduledRender = false;
      const renderMode = this.consumePendingRenderMode();
      this.renderNow(timestamp, renderMode);
      if (this.shouldContinueAnimation(timestamp)) this.ensureAnimationFrame();
    });
  }

  private consumePendingRenderMode(): "full" | "positions" | "labels" | "camera" {
    if (this.pendingFullRender) {
      this.pendingFullRender = false;
      this.pendingPositionRender = false;
      this.pendingLabelRender = false;
      return "full";
    }
    if (this.pendingLabelRender) {
      this.pendingLabelRender = false;
      return "labels";
    }
    if (this.pendingPositionRender) {
      this.pendingPositionRender = false;
      return "positions";
    }
    return "camera";
  }

  private cancelScheduledRender(): void {
    if (this.animationFrameId !== undefined) {
      const browserWindow = this.options.document.defaultView;
      const cancel = browserWindow === null ? undefined : browserWindow.cancelAnimationFrame.bind(browserWindow);
      if (typeof cancel === "function") cancel(this.animationFrameId);
    }
    this.animationFrameId = undefined;
    this.scheduledRender = false;
    this.pendingFullRender = false;
    this.pendingPositionRender = false;
    this.pendingLabelRender = false;
  }

  private isDisplaySuspended(): boolean {
    return this.options.getWindowState().minimized || this.options.document.hidden;
  }

  private activateNode(graphNodeId: string): void {
    const node = this.snapshot?.nodes.find((candidate) => candidate.id === graphNodeId);
    if (node?.kind === "conversation") {
      const nodeId = rawConversationNodeId(graphNodeId);
      if (nodeId !== undefined) this.options.store.selectNode(nodeId);
    } else if (node?.kind === "note" && node.filePath !== undefined) {
      void this.options.onOpenNote(node.filePath);
    }
  }

  private toggleNode(graphNodeId: string): void {
    const graphNode = this.snapshot?.nodes.find((node) => node.id === graphNodeId);
    const nodeId = rawConversationNodeId(graphNodeId);
    if (graphNode === undefined || this.options.store.canMutate?.() === false) return;
    this.options.store.update((current) => ({
      ...structuredClone(current),
      depositGraphState: graphNode.kind === "conversation" && nodeId !== undefined
        ? setRelationshipNodeIncluded(current, current.depositGraphState, nodeId, !(current.depositGraphState?.nodeStates[nodeId]?.included ?? true))
        : setRelationshipGraphNodeIncluded(current.depositGraphState, graphNode.id, !(current.depositGraphState?.nodeStates[graphNode.id]?.included ?? true)),
      revision: current.revision + 1,
      updatedAt: new Date().toISOString()
    }));
  }

  private toggleEdge(edgeId: string): void {
    if (this.options.store.canMutate?.() === false) return;
    this.options.store.update((current) => {
      const included = current.depositGraphState?.edgeOverrides[edgeId]?.included ?? true;
      return {
        ...structuredClone(current),
        depositGraphState: setRelationshipEdgeOverride(current.depositGraphState, edgeId, !included),
        revision: current.revision + 1,
        updatedAt: new Date().toISOString()
      };
    });
  }

  private destroySession(): void {
    if (this.snapshot !== undefined) this.view?.syncSharedPositions?.(this.snapshot);
    if (this.sessionId !== undefined && Object.keys(this.positions).length > 0) {
      this.options.store.checkpointGraphPositions?.(this.sessionId, this.positions);
    }
    this.interaction?.destroy();
    this.worker?.destroy();
    this.view?.destroy();
    this.interaction = undefined;
    this.worker = undefined;
    this.view = undefined;
    this.canvas?.remove();
    this.canvas = undefined;
    this.sessionId = undefined;
    this.snapshot = undefined;
    this.positions = {};
    this.topologySignature = "";
    this.frameInterpolator = undefined;
    this.displayPositionValues = new Float32Array(0);
    this.positionNodeIds = [];
    this.positionIndexById.clear();
    this.lastRenderTimestamp = undefined;
    this.positionAnimationActive = false;
    this.graphInputSignature = "";
    this.graphVisualStateSignature = "";
    this.visual = {};
    this.cameraNeedsLabelCommit = false;
  }

  private resetFrameInterpolator(snapshot: RelationshipGraphSnapshot): void {
    this.positionAnimationActive = false;
    this.positionNodeIds = snapshot.nodes.map((node) => node.id);
    this.positionIndexById.clear();
    this.positionNodeIds.forEach((id, index) => this.positionIndexById.set(id, index));
    this.displayPositionValues = new Float32Array(this.positionNodeIds.length * 2);
    for (let index = 0; index < this.positionNodeIds.length; index += 1) {
      const id = this.positionNodeIds[index];
      const position = id === undefined ? undefined : this.positions[id];
      this.displayPositionValues[index * 2] = position?.x ?? 0;
      this.displayPositionValues[index * 2 + 1] = position?.y ?? 0;
    }
    this.frameInterpolator = new RelationshipGraphFrameInterpolator(this.positionNodeIds.length);
    this.frameInterpolator.push({ sequence: 0, receivedAt: performance.now(), values: this.displayPositionValues });
  }

  private applyDisplayPositionValues(): void {
    for (let index = 0; index < this.positionNodeIds.length; index += 1) {
      const id = this.positionNodeIds[index];
      if (id === undefined) continue;
      const position = this.positions[id] ?? { x: 0, y: 0, fixed: false };
      position.x = this.displayPositionValues[index * 2] ?? position.x;
      position.y = this.displayPositionValues[index * 2 + 1] ?? position.y;
      position.fixed = false;
      this.positions[id] = position;
    }
  }

  private renderError(message: string): void {
    if (this.errorOverlay === undefined) return;
    this.errorOverlay.replaceChildren();
    const text = this.options.document.createElement("span");
    text.textContent = `关系图谱渲染失败：${message}`;
    const retry = this.controlButton("重试", "重试图谱 Worker", () => {
      this.errorOverlay?.setAttribute("hidden", "true");
      this.worker?.retry();
    });
    this.errorOverlay.append(text, retry);
    this.errorOverlay.hidden = false;
  }
}
