import {
  nextRelationshipGraphWheelScale,
  zoomRelationshipGraphAtPoint,
  type RelationshipGraphCamera
} from "./camera";
import type { RelationshipGraphVisualState } from "./render-model";

export interface RelationshipGraphInteractionView {
  hitTest(worldPoint: { x: number; y: number }): { nodeId: string } | { edgeId: string } | undefined;
  hitTestNode?(worldPoint: { x: number; y: number }): { nodeId: string } | undefined;
  hitTestEdge?(worldPoint: { x: number; y: number }): { edgeId: string } | undefined;
}

export interface RelationshipGraphInteractionWorker {
  dragStart(nodeId: string, x: number, y: number): void;
  dragMove(nodeId: string, x: number, y: number): void;
  dragEnd(nodeId: string): void;
  resize?(width: number, height: number): void;
}

export interface RelationshipGraphInteractionOptions {
  element: HTMLElement;
  view: RelationshipGraphInteractionView;
  worker: RelationshipGraphInteractionWorker;
  camera(): RelationshipGraphCamera;
  targetCamera?(): RelationshipGraphCamera;
  onCameraChange(camera: RelationshipGraphCamera, mode: "direct" | "target"): void;
  onCameraCommit?(): void;
  onActivityChange?(active: boolean): void;
  onDragPreview?(nodeId: string, point: { x: number; y: number } | undefined): void;
  onVisualChange(state: RelationshipGraphVisualState): void;
  onActivateNode(nodeId: string): void;
  onToggleNode(nodeId: string): void;
  onToggleEdge(edgeId: string): void;
  canMutate(): boolean;
  viewport(): { width: number; height: number };
}

type Gesture =
  | { type: "pending-node"; pointerId: number; nodeId: string; startX: number; startY: number }
  | { type: "dragging-node"; pointerId: number; nodeId: string }
  | { type: "panning"; pointerId: number; startX: number; startY: number; camera: RelationshipGraphCamera };

function distance(aX: number, aY: number, bX: number, bY: number): number {
  return Math.hypot(aX - bX, aY - bY);
}

export class RelationshipGraphInteraction {
  private gesture: Gesture | undefined;
  private hoveredNodeId: string | undefined;
  private readOnly: boolean;
  private destroyed = false;

  constructor(private readonly options: RelationshipGraphInteractionOptions) {
    this.readOnly = !options.canMutate();
    options.element.tabIndex = 0;
    options.element.addEventListener("pointerdown", this.onPointerDown);
    options.element.addEventListener("pointermove", this.onPointerMove);
    options.element.addEventListener("pointerup", this.onPointerUp);
    options.element.addEventListener("pointercancel", this.onPointerCancel);
    options.element.addEventListener("pointerleave", this.onPointerLeave);
    options.element.addEventListener("wheel", this.onWheel, { passive: false });
    options.element.addEventListener("contextmenu", this.onContextMenu);
    options.element.addEventListener("keydown", this.onKeyDown);
  }

  setReadOnly(readOnly: boolean): void { this.readOnly = readOnly; }

  isActive(): boolean { return this.gesture !== undefined; }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.gesture?.type === "dragging-node") {
      this.options.worker.dragEnd(this.gesture.nodeId);
      this.options.onDragPreview?.(this.gesture.nodeId, undefined);
    }
    this.finishGesture(false);
    const element = this.options.element;
    element.removeEventListener("pointerdown", this.onPointerDown);
    element.removeEventListener("pointermove", this.onPointerMove);
    element.removeEventListener("pointerup", this.onPointerUp);
    element.removeEventListener("pointercancel", this.onPointerCancel);
    element.removeEventListener("pointerleave", this.onPointerLeave);
    element.removeEventListener("wheel", this.onWheel);
    element.removeEventListener("contextmenu", this.onContextMenu);
    element.removeEventListener("keydown", this.onKeyDown);
  }

  private worldPoint(event: PointerEvent | WheelEvent | MouseEvent): { x: number; y: number } {
    const rect = this.options.element.getBoundingClientRect();
    const camera = this.options.camera();
    return {
      x: (event.clientX - rect.left - camera.panX) / camera.scale,
      y: (event.clientY - rect.top - camera.panY) / camera.scale
    };
  }

  private screenPoint(event: PointerEvent | WheelEvent | MouseEvent): { x: number; y: number } {
    const rect = this.options.element.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private capture(pointerId: number): void {
    if (typeof this.options.element.setPointerCapture === "function") {
      this.options.element.setPointerCapture(pointerId);
    }
  }

  private release(pointerId: number): void {
    const element = this.options.element;
    if (typeof element.hasPointerCapture === "function" && element.hasPointerCapture(pointerId) && typeof element.releasePointerCapture === "function") {
      element.releasePointerCapture(pointerId);
    }
  }

  private hitTestNode(worldPoint: { x: number; y: number }): { nodeId: string } | undefined {
    if (this.options.view.hitTestNode !== undefined) return this.options.view.hitTestNode(worldPoint);
    const hit = this.options.view.hitTest(worldPoint);
    return hit !== undefined && "nodeId" in hit ? hit : undefined;
  }

  private hitTestContext(worldPoint: { x: number; y: number }): { nodeId: string } | { edgeId: string } | undefined {
    const node = this.hitTestNode(worldPoint);
    if (node !== undefined) return node;
    if (this.options.view.hitTestEdge !== undefined) return this.options.view.hitTestEdge(worldPoint);
    const hit = this.options.view.hitTest(worldPoint);
    return hit !== undefined && "edgeId" in hit ? hit : undefined;
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (this.destroyed || event.button !== 0) return;
    event.preventDefault();
    this.options.element.focus({ preventScroll: true });
    const screen = this.screenPoint(event);
    const hit = this.hitTestNode(this.worldPoint(event));
    this.capture(event.pointerId);
    this.gesture = hit === undefined
      ? { type: "panning", pointerId: event.pointerId, startX: screen.x, startY: screen.y, camera: { ...this.options.camera() } }
      : { type: "pending-node", pointerId: event.pointerId, nodeId: hit.nodeId, startX: screen.x, startY: screen.y };
    this.options.onActivityChange?.(true);
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (this.destroyed) return;
    if (this.gesture === undefined) {
      const hit = this.hitTestNode(this.worldPoint(event));
      const hoveredNodeId = hit?.nodeId;
      if (hoveredNodeId !== this.hoveredNodeId) {
        this.hoveredNodeId = hoveredNodeId;
        this.options.onVisualChange(
          this.hoveredNodeId === undefined ? {} : { hoveredNodeId: this.hoveredNodeId }
        );
      }
      return;
    }
    if (event.pointerId !== this.gesture.pointerId) return;
    const screen = this.screenPoint(event);
    if (this.gesture.type === "pending-node") {
      if (distance(screen.x, screen.y, this.gesture.startX, this.gesture.startY) <= 5) return;
      const nodeId = this.gesture.nodeId;
      this.gesture = { type: "dragging-node", pointerId: event.pointerId, nodeId };
      const point = this.worldPoint(event);
      this.options.onDragPreview?.(nodeId, point);
      this.options.worker.dragStart(nodeId, point.x, point.y);
      return;
    }
    if (this.gesture.type === "dragging-node") {
      const point = this.worldPoint(event);
      this.options.onDragPreview?.(this.gesture.nodeId, point);
      this.options.worker.dragMove(this.gesture.nodeId, point.x, point.y);
      return;
    }
    const camera = this.gesture.camera;
    this.options.onCameraChange({
      ...camera,
      panX: camera.panX + screen.x - this.gesture.startX,
      panY: camera.panY + screen.y - this.gesture.startY
    }, "direct");
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (this.destroyed || this.gesture === undefined || event.pointerId !== this.gesture.pointerId) return;
    if (this.gesture.type === "panning") this.options.onCameraCommit?.();
    if (this.gesture.type === "pending-node") this.options.onActivateNode(this.gesture.nodeId);
    if (this.gesture.type === "dragging-node") {
      this.options.onDragPreview?.(this.gesture.nodeId, undefined);
      this.options.worker.dragEnd(this.gesture.nodeId);
    }
    this.finishGesture(true);
  };

  private readonly onPointerCancel = (event: PointerEvent): void => {
    if (this.gesture?.pointerId !== event.pointerId) return;
    if (this.gesture.type === "dragging-node") {
      this.options.onDragPreview?.(this.gesture.nodeId, undefined);
      this.options.worker.dragEnd(this.gesture.nodeId);
    }
    this.finishGesture(true);
  };

  private finishGesture(releaseCapture: boolean): void {
    const gesture = this.gesture;
    this.gesture = undefined;
    if (releaseCapture && gesture !== undefined) this.release(gesture.pointerId);
    if (gesture !== undefined) this.options.onActivityChange?.(false);
  }

  private readonly onPointerLeave = (): void => {
    if (this.gesture !== undefined) return;
    if (this.hoveredNodeId === undefined) return;
    this.hoveredNodeId = undefined;
    this.options.onVisualChange({});
  };

  private readonly onWheel = (event: WheelEvent): void => {
    if (this.destroyed) return;
    event.preventDefault();
    const screen = this.screenPoint(event);
    const camera = this.options.targetCamera?.() ?? this.options.camera();
    const scale = nextRelationshipGraphWheelScale(camera.scale, event.deltaY);
    this.options.onCameraChange(zoomRelationshipGraphAtPoint(camera, screen, scale), "target");
  };

  private readonly onContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
    const hit = this.hitTestContext(this.worldPoint(event));
    if (hit === undefined || this.readOnly || !this.options.canMutate()) return;
    if ("nodeId" in hit) this.options.onToggleNode(hit.nodeId);
    else this.options.onToggleEdge(hit.edgeId);
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      if (this.gesture?.type === "dragging-node") {
        this.options.onDragPreview?.(this.gesture.nodeId, undefined);
        this.options.worker.dragEnd(this.gesture.nodeId);
      }
      this.finishGesture(true);
      return;
    }
    const camera = this.options.camera();
    const viewport = this.options.viewport();
    const center = { x: viewport.width / 2, y: viewport.height / 2 };
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      this.options.onCameraChange(zoomRelationshipGraphAtPoint(camera, center, camera.scale * 1.2), "target");
    } else if (event.key === "-") {
      event.preventDefault();
      this.options.onCameraChange(zoomRelationshipGraphAtPoint(camera, center, camera.scale / 1.2), "target");
    } else if (event.key === "0") {
      event.preventDefault();
      this.options.onCameraChange({ scale: 1, panX: 0, panY: 0 }, "direct");
      this.options.onCameraCommit?.();
    }
  };
}
