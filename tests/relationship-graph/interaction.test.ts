// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { RelationshipGraphInteraction } from "../../src/relationship-graph/interaction";
import type { RelationshipGraphCamera } from "../../src/relationship-graph/camera";

function pointer(type: string, x: number, y: number, pointerId = 1): PointerEvent {
  const event = new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  return event;
}

describe("relationship graph 0.8.34 interaction contract", () => {
  it("clicks a node and drags only after five CSS pixels", () => {
    const element = document.createElement("canvas");
    const view = { hitTest: vi.fn(() => ({ nodeId: "conversation:root" })) };
    const worker = { dragStart: vi.fn(), dragMove: vi.fn(), dragEnd: vi.fn() };
    const camera: RelationshipGraphCamera = { scale: 1, panX: 0, panY: 0 };
    const onActivateNode = vi.fn();
    const onDragPreview = vi.fn();
    new RelationshipGraphInteraction({
      element,
      view,
      worker,
      camera: () => camera,
      onCameraChange: vi.fn(),
      onDragPreview,
      onVisualChange: vi.fn(),
      onActivateNode,
      onToggleNode: vi.fn(),
      onToggleEdge: vi.fn(),
      canMutate: () => true,
      viewport: () => ({ width: 800, height: 600 })
    });
    element.dispatchEvent(pointer("pointerdown", 100, 100));
    element.dispatchEvent(pointer("pointermove", 104, 103));
    element.dispatchEvent(pointer("pointerup", 104, 103));
    expect(onActivateNode).toHaveBeenCalledWith("conversation:root");
    element.dispatchEvent(pointer("pointerdown", 100, 100));
    element.dispatchEvent(pointer("pointermove", 110, 100));
    expect(worker.dragStart).toHaveBeenCalledWith("conversation:root", 110, 100);
    expect(onDragPreview).toHaveBeenCalledWith("conversation:root", { x: 110, y: 100 });
    element.dispatchEvent(pointer("pointermove", 130, 120));
    expect(worker.dragMove).toHaveBeenCalledWith("conversation:root", 130, 120);
    expect(onDragPreview).toHaveBeenLastCalledWith("conversation:root", { x: 130, y: 120 });
    element.dispatchEvent(pointer("pointerup", 130, 120));
    expect(worker.dragEnd).toHaveBeenCalledWith("conversation:root");
    expect(onDragPreview).toHaveBeenLastCalledWith("conversation:root", undefined);
  });

  it("pans blank space and zooms around the pointer", () => {
    const element = document.createElement("canvas");
    const view = { hitTest: vi.fn(() => undefined) };
    const worker = { dragStart: vi.fn(), dragMove: vi.fn(), dragEnd: vi.fn() };
    let camera: RelationshipGraphCamera = { scale: 1, panX: 0, panY: 0 };
    const onCameraChange = vi.fn((next: RelationshipGraphCamera, mode: "direct" | "target") => {
      void mode;
      camera = next;
    });
    const onCameraCommit = vi.fn();
    new RelationshipGraphInteraction({
      element,
      view,
      worker,
      camera: () => camera,
      onCameraChange,
      onCameraCommit,
      onVisualChange: vi.fn(),
      onActivateNode: vi.fn(),
      onToggleNode: vi.fn(),
      onToggleEdge: vi.fn(),
      canMutate: () => true,
      viewport: () => ({ width: 800, height: 600 })
    });
    element.dispatchEvent(pointer("pointerdown", 50, 50));
    element.dispatchEvent(pointer("pointermove", 80, 70));
    element.dispatchEvent(pointer("pointerup", 80, 70));
    expect(camera.panX).toBe(30);
    expect(camera.panY).toBe(20);
    expect(onCameraCommit).toHaveBeenCalledOnce();
    expect(onCameraChange).toHaveBeenLastCalledWith(camera, "direct");
    const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: 200, clientY: 150, deltaY: -120 });
    element.dispatchEvent(wheel);
    const wheelCall = onCameraChange.mock.calls.at(-1);
    expect(wheelCall?.[0].scale).toBeGreaterThan(1);
    expect(wheelCall?.[1]).toBe("target");
  });

  it("blocks right-click mutation only when the graph is read-only", () => {
    const element = document.createElement("canvas");
    const onToggleNode = vi.fn();
    let canMutate = false;
    const interaction = new RelationshipGraphInteraction({
      element,
      view: { hitTest: vi.fn(() => ({ nodeId: "conversation:root" })) },
      worker: { dragStart: vi.fn(), dragMove: vi.fn(), dragEnd: vi.fn() },
      camera: () => ({ scale: 1, panX: 0, panY: 0 }),
      onCameraChange: vi.fn(), onVisualChange: vi.fn(), onActivateNode: vi.fn(),
      onToggleNode, onToggleEdge: vi.fn(), canMutate: () => canMutate, viewport: () => ({ width: 800, height: 600 })
    });
    element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10, button: 2 }));
    expect(onToggleNode).not.toHaveBeenCalled();
    interaction.setReadOnly(false);
    canMutate = true;
    element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10, button: 2 }));
    expect(onToggleNode).toHaveBeenCalledWith("conversation:root");
  });

  it("routes a right-click on a relationship edge to the edge override", () => {
    const element = document.createElement("canvas");
    const onToggleEdge = vi.fn();
    const interaction = new RelationshipGraphInteraction({
      element,
      view: { hitTest: vi.fn(() => ({ edgeId: "edge:root:child" })) },
      worker: { dragStart: vi.fn(), dragMove: vi.fn(), dragEnd: vi.fn() },
      camera: () => ({ scale: 1, panX: 0, panY: 0 }),
      onCameraChange: vi.fn(), onVisualChange: vi.fn(), onActivateNode: vi.fn(),
      onToggleNode: vi.fn(), onToggleEdge, canMutate: () => true,
      viewport: () => ({ width: 800, height: 600 })
    });
    element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10, button: 2 }));
    expect(onToggleEdge).toHaveBeenCalledWith("edge:root:child");
    interaction.destroy();
  });

  it("routes a right-click on a note node through the same toggle contract", () => {
    const element = document.createElement("canvas");
    const onToggleNode = vi.fn();
    const interaction = new RelationshipGraphInteraction({
      element,
      view: { hitTest: vi.fn(() => ({ nodeId: "note:Notes/example.md" })) },
      worker: { dragStart: vi.fn(), dragMove: vi.fn(), dragEnd: vi.fn() },
      camera: () => ({ scale: 1, panX: 0, panY: 0 }),
      onCameraChange: vi.fn(), onVisualChange: vi.fn(), onActivateNode: vi.fn(),
      onToggleNode, onToggleEdge: vi.fn(), canMutate: () => true,
      viewport: () => ({ width: 800, height: 600 })
    });
    element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10, button: 2 }));
    expect(onToggleNode).toHaveBeenCalledWith("note:Notes/example.md");
    interaction.destroy();
  });

  it("uses node-only hit testing during pointer movement", () => {
    const element = document.createElement("canvas");
    const hitTest = vi.fn(() => undefined);
    const hitTestNode = vi.fn(() => undefined);
    const interaction = new RelationshipGraphInteraction({
      element,
      view: { hitTest, hitTestNode },
      worker: { dragStart: vi.fn(), dragMove: vi.fn(), dragEnd: vi.fn() },
      camera: () => ({ scale: 1, panX: 0, panY: 0 }),
      onCameraChange: vi.fn(), onVisualChange: vi.fn(), onActivateNode: vi.fn(),
      onToggleNode: vi.fn(), onToggleEdge: vi.fn(), canMutate: () => true,
      viewport: () => ({ width: 800, height: 600 })
    });
    element.dispatchEvent(pointer("pointermove", 40, 40));
    expect(hitTestNode).toHaveBeenCalledOnce();
    expect(hitTest).not.toHaveBeenCalled();
    interaction.destroy();
  });

  it("exposes whether a pointer gesture is keeping the display loop active", () => {
    const element = document.createElement("canvas");
    const activity = vi.fn();
    const interaction = new RelationshipGraphInteraction({
      element,
      view: { hitTest: vi.fn(() => undefined) },
      worker: { dragStart: vi.fn(), dragMove: vi.fn(), dragEnd: vi.fn() },
      camera: () => ({ scale: 1, panX: 0, panY: 0 }),
      onCameraChange: vi.fn(), onVisualChange: vi.fn(), onActivateNode: vi.fn(),
      onToggleNode: vi.fn(), onToggleEdge: vi.fn(), canMutate: () => true,
      onActivityChange: activity,
      viewport: () => ({ width: 800, height: 600 })
    });
    expect(interaction.isActive()).toBe(false);
    element.dispatchEvent(pointer("pointerdown", 40, 40));
    expect(interaction.isActive()).toBe(true);
    expect(activity).toHaveBeenLastCalledWith(true);
    element.dispatchEvent(pointer("pointerup", 40, 40));
    expect(interaction.isActive()).toBe(false);
    expect(activity).toHaveBeenLastCalledWith(false);
    interaction.destroy();
  });

  it("releases a temporarily fixed node when the surface is destroyed", () => {
    const element = document.createElement("canvas");
    const worker = { dragStart: vi.fn(), dragMove: vi.fn(), dragEnd: vi.fn() };
    const interaction = new RelationshipGraphInteraction({
      element,
      view: { hitTest: vi.fn(() => ({ nodeId: "conversation:root" })) },
      worker,
      camera: () => ({ scale: 1, panX: 0, panY: 0 }),
      onCameraChange: vi.fn(),
      onVisualChange: vi.fn(),
      onActivateNode: vi.fn(),
      onToggleNode: vi.fn(),
      onToggleEdge: vi.fn(),
      canMutate: () => true,
      viewport: () => ({ width: 800, height: 600 })
    });
    element.dispatchEvent(pointer("pointerdown", 100, 100));
    element.dispatchEvent(pointer("pointermove", 110, 100));
    interaction.destroy();
    expect(worker.dragEnd).toHaveBeenCalledWith("conversation:root");
  });
});
