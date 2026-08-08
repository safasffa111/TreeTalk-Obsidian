// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { ConversationFile } from "../../src/domain/types";
import type { RelationshipGraphWorkerFrame } from "../../src/relationship-graph/protocol";
import type { RelationshipGraphWorkerClientOptions } from "../../src/relationship-graph/worker-client";
import { RelationshipGraphWindow } from "../../src/relationship-graph/window";
import {
  RelationshipGraphSharedMemoryReader,
  RelationshipGraphSharedMemoryWriter,
  createRelationshipGraphSharedMemory
} from "../../src/relationship-graph/shared-memory";

function pointerEvent(type: string, x: number, y: number, pointerId = 1): PointerEvent {
  const event = new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  return event;
}

function conversation(id: string, positions: Record<string, { x: number; y: number; fixed: boolean }> = {}): ConversationFile {
  return {
    schemaVersion: 1,
    id,
    title: id,
    status: "active",
    revision: 1,
    checksum: "checksum",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    rootNodeId: "root",
    currentNodeId: "root",
    nodes: {
      root: {
        id: "root",
        parentId: null,
        childIds: [],
        title: "Root",
        messages: []
      }
    },
    ui: {},
    depositGraphState: {
      protocol: "deposit-graph:v1",
      nodeStates: {},
      edgeOverrides: {},
      nodePositions: positions
    }
  } as unknown as ConversationFile;
}

function conversationWithNote(): ConversationFile {
  const current = conversation("space-a");
  const root = current.nodes.root;
  if (root === undefined) throw new Error("Missing root fixture");
  root.messages = [{
    id: "question",
    role: "user",
    content: "question",
    status: "complete",
    createdAt: current.createdAt,
    updatedAt: current.updatedAt,
    selectionContexts: [{
      sourceType: "note",
      filePath: "Notes/example.md",
      fileName: "example.md",
      basis: "note-source-v1",
      startOffset: 0,
      endOffset: 3,
      quote: "one",
      prefix: "",
      suffix: "",
      contentHash: "fixture"
    }]
  }];
  return current;
}

describe("relationship graph window", () => {
  it("creates the new UI and exactly one view/Worker session", () => {
    let current = conversation("space-a");
    const listeners = new Set<() => void>();
    const viewDestroy = vi.fn();
    const workerDestroy = vi.fn();
    const renderedSnapshots: Array<{ positions: Record<string, { x: number; y: number; fixed: boolean }> }> = [];
    const viewFactory = vi.fn(() => ({
      render: vi.fn((snapshot: { positions: Record<string, { x: number; y: number; fixed: boolean }> }) => { renderedSnapshots.push(snapshot); }),
      resize: vi.fn(), hitTest: vi.fn(), destroy: viewDestroy
    }));
    const workerFactory = vi.fn(() => ({
      updateTopology: vi.fn(), dragStart: vi.fn(), dragMove: vi.fn(), dragEnd: vi.fn(),
      pause: vi.fn(), resume: vi.fn(), retry: vi.fn(), destroy: workerDestroy
    }));
    const window = new RelationshipGraphWindow({
      document,
      store: {
        getSnapshot: () => current,
        subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
        update: vi.fn(), selectNode: vi.fn(), canMutate: () => true,
        checkpointGraphPositions: () => undefined
      },
      getWindowState: () => ({ x: 10, y: 10, width: 760, height: 520, minimized: false, maximized: false }),
      setWindowState: vi.fn(), onOpenNote: vi.fn(() => Promise.resolve(true)), onClose: vi.fn(),
      viewFactory, workerFactory
    });
    window.open();
    expect(document.querySelectorAll(".relationship-graph-window")).toHaveLength(1);
    expect(document.querySelector(".relationship-graph-toolbar")).not.toBeNull();
    expect(viewFactory).toHaveBeenCalledOnce();
    expect(workerFactory).toHaveBeenCalledOnce();
    const seededRoot = renderedSnapshots[0]?.positions["conversation:root"];
    expect(seededRoot).toBeDefined();
    if (seededRoot === undefined) throw new Error("missing initial graph position");
    expect(Number.isFinite(seededRoot.x)).toBe(true);
    expect(Number.isFinite(seededRoot.y)).toBe(true);
    expect(seededRoot.fixed).toBe(false);
    current = conversation("space-b");
    for (const listener of listeners) listener();
    expect(viewFactory).toHaveBeenCalledTimes(2);
    expect(workerFactory).toHaveBeenCalledTimes(2);
    expect(renderedSnapshots.length).toBeGreaterThan(1);
    expect(viewDestroy).toHaveBeenCalledOnce();
    expect(workerDestroy).toHaveBeenCalledOnce();
    window.close();
    expect(viewDestroy).toHaveBeenCalledTimes(2);
    expect(workerDestroy).toHaveBeenCalledTimes(2);
  });

  it("keeps the current snapshot through session replacement and reopening", () => {
    let current = conversation("space-a", { "conversation:root": { x: 120, y: 140, fixed: false } });
    const listeners = new Set<() => void>();
    const checkpoint = vi.fn();
    const views: Array<{ render: ReturnType<typeof vi.fn>; hitTest: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }> = [];
    const workers: Array<{ dragStart: ReturnType<typeof vi.fn>; dragMove: ReturnType<typeof vi.fn>; dragEnd: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }> = [];
    const viewFactory = vi.fn(() => {
      const view = { render: vi.fn(), resize: vi.fn(), hitTest: vi.fn(() => ({ nodeId: "conversation:root" })), destroy: vi.fn() };
      views.push(view);
      return view;
    });
    const workerFactory = vi.fn(() => {
      const worker = { updateTopology: vi.fn(), dragStart: vi.fn(), dragMove: vi.fn(), dragEnd: vi.fn(), pause: vi.fn(), resume: vi.fn(), retry: vi.fn(), destroy: vi.fn() };
      workers.push(worker);
      return worker;
    });
    const graphWindow = new RelationshipGraphWindow({
      document,
      store: {
        getSnapshot: () => current,
        subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
        update: vi.fn(), selectNode: vi.fn(), canMutate: () => true,
        checkpointGraphPositions: checkpoint
      },
      getWindowState: () => ({ x: 10, y: 10, width: 760, height: 520, minimized: false, maximized: false }),
      setWindowState: vi.fn(), onOpenNote: vi.fn(() => Promise.resolve(true)), onClose: vi.fn(),
      viewFactory, workerFactory
    });

    graphWindow.open();
    expect(views[0]?.render).toHaveBeenCalledWith(expect.objectContaining({ positions: { "conversation:root": { x: 120, y: 140, fixed: false } } }), expect.anything(), expect.anything());

    current = conversation("space-b", { "conversation:root": { x: 320, y: 180, fixed: false } });
    for (const listener of listeners) listener();
    expect(views[1]?.render).toHaveBeenCalledWith(expect.objectContaining({ positions: { "conversation:root": { x: 320, y: 180, fixed: false } } }), expect.anything(), expect.anything());
    expect(checkpoint).toHaveBeenCalledWith("space-a", { "conversation:root": { x: 120, y: 140, fixed: false } });

    const canvas = document.querySelector<HTMLCanvasElement>(".relationship-graph-canvas");
    expect(canvas).not.toBeNull();
    const down = new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: 320, clientY: 180, button: 0 });
    Object.defineProperty(down, "pointerId", { value: 1 });
    canvas?.dispatchEvent(down);
    const move = new PointerEvent("pointermove", { bubbles: true, cancelable: true, clientX: 332, clientY: 180, button: 0 });
    Object.defineProperty(move, "pointerId", { value: 1 });
    canvas?.dispatchEvent(move);
    expect(workers[1]?.dragStart).toHaveBeenCalledWith("conversation:root", 332, 180);

    graphWindow.close();
    graphWindow.open();
    expect(viewFactory).toHaveBeenCalledTimes(3);
    expect(views[2]?.render).toHaveBeenCalledWith(expect.objectContaining({ positions: { "conversation:root": { x: 320, y: 180, fixed: false } } }), expect.anything(), expect.anything());
    graphWindow.close();
  });

  it("uses the minimize button as a minimize and restore toggle", () => {
    let state = { x: 10, y: 10, width: 760, height: 520, minimized: false, maximized: false };
    const graphWindow = new RelationshipGraphWindow({
      document,
      store: {
        getSnapshot: () => conversation("space-a"), subscribe: () => () => undefined,
        update: vi.fn(), selectNode: vi.fn(), canMutate: () => true, checkpointGraphPositions: vi.fn()
      },
      getWindowState: () => state,
      setWindowState: (next) => { state = next; },
      onOpenNote: vi.fn(() => Promise.resolve(true)), onClose: vi.fn(),
      viewFactory: () => ({ render: vi.fn(), resize: vi.fn(), hitTest: vi.fn(), destroy: vi.fn() }),
      workerFactory: () => ({ updateTopology: vi.fn(), resize: vi.fn(), dragStart: vi.fn(), dragMove: vi.fn(), dragEnd: vi.fn(), pause: vi.fn(), resume: vi.fn(), retry: vi.fn(), destroy: vi.fn() })
    });
    graphWindow.open();
    const button = document.querySelector<HTMLButtonElement>('button[aria-label="最小化"]');
    expect(button).not.toBeNull();
    button?.click();
    expect(state.minimized).toBe(true);
    expect(document.querySelector(".relationship-graph-window")?.classList.contains("is-minimized")).toBe(true);
    button?.click();
    expect(state.minimized).toBe(false);
    expect(document.querySelector(".relationship-graph-window")?.classList.contains("is-minimized")).toBe(false);
    graphWindow.close();
  });

  it("does not schedule Pixi or Worker work for 500 AI streaming content updates", () => {
    const current = conversation("space-a");
    const listeners = new Set<() => void>();
    const updateTopology = vi.fn();
    const render = vi.fn();
    const rafQueue: Array<FrameRequestCallback> = [];
    const browserWindow = document.defaultView;
    if (browserWindow === null) throw new Error("missing jsdom window");
    const originalRafDescriptor = Object.getOwnPropertyDescriptor(browserWindow, "requestAnimationFrame");
    Object.defineProperty(browserWindow, "requestAnimationFrame", {
      configurable: true,
      value: (callback: FrameRequestCallback): number => { rafQueue.push(callback); return rafQueue.length; }
    });
    const graphWindow = new RelationshipGraphWindow({
      document,
      store: {
        getSnapshot: () => current,
        subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
        update: vi.fn(), selectNode: vi.fn(), canMutate: () => true,
        checkpointGraphPositions: vi.fn()
      },
      getWindowState: () => ({ x: 10, y: 10, width: 760, height: 520, minimized: false, maximized: false }),
      setWindowState: vi.fn(), onOpenNote: vi.fn(() => Promise.resolve(true)), onClose: vi.fn(),
      viewFactory: () => ({ render, resize: vi.fn(), hitTest: vi.fn(), destroy: vi.fn() }),
      workerFactory: () => ({ updateTopology, resize: vi.fn(), dragStart: vi.fn(), dragMove: vi.fn(), dragEnd: vi.fn(), pause: vi.fn(), resume: vi.fn(), retry: vi.fn(), destroy: vi.fn() })
    });
    try {
      graphWindow.open();
      while (rafQueue.length > 0) rafQueue.shift()?.(0);
      expect(updateTopology).toHaveBeenCalledOnce();
      const baselineRenders = render.mock.calls.length;
      const root = current.nodes.root;
      if (root === undefined) throw new Error("missing root fixture");
      root.messages.push({
        id: "assistant",
        role: "assistant",
        content: "",
        status: "streaming",
        createdAt: current.createdAt,
        updatedAt: current.updatedAt
      });
      for (let index = 0; index < 500; index += 1) {
        const message = root.messages[0];
        if (message !== undefined) message.content = `chunk-${String(index)}`;
        current.revision += 1;
        for (const listener of listeners) listener();
      }
      expect(updateTopology).toHaveBeenCalledOnce();
      while (rafQueue.length > 0) rafQueue.shift()?.(500);
      expect(render).toHaveBeenCalledTimes(baselineRenders);
    } finally {
      graphWindow.close();
      if (originalRafDescriptor === undefined) Reflect.deleteProperty(browserWindow, "requestAnimationFrame");
      else Object.defineProperty(browserWindow, "requestAnimationFrame", originalRafDescriptor);
    }
  });

  it("coalesces Worker frames and camera updates into one display render", () => {
    const rafQueue: Array<FrameRequestCallback> = [];
    let latestRenderedPositions: Record<string, { x: number; y: number; fixed: boolean }> = {};
    const view = {
      render: vi.fn((snapshot: { positions: Record<string, { x: number; y: number; fixed: boolean }> }) => { latestRenderedPositions = snapshot.positions; }),
      resize: vi.fn(), hitTest: vi.fn(), destroy: vi.fn()
    };
    let onFrame: ((frame: RelationshipGraphWorkerFrame) => void) | undefined;
    const current = conversation("space-a", { "conversation:root": { x: 120, y: 140, fixed: false } });
    const raf = (callback: FrameRequestCallback): number => {
      rafQueue.push(callback);
      return rafQueue.length;
    };
    const browserWindow = document.defaultView;
    const originalRafDescriptor = browserWindow === null ? undefined : Object.getOwnPropertyDescriptor(browserWindow, "requestAnimationFrame");
    if (browserWindow === null) throw new Error("missing jsdom window");
    Object.defineProperty(browserWindow, "requestAnimationFrame", { configurable: true, value: raf });
    const graphWindow = new RelationshipGraphWindow({
      document,
      store: {
        getSnapshot: () => current,
        subscribe: () => () => undefined,
        update: vi.fn(), selectNode: vi.fn(), canMutate: () => true,
        checkpointGraphPositions: vi.fn()
      },
      getWindowState: () => ({ x: 10, y: 10, width: 760, height: 520, minimized: false, maximized: false }),
      setWindowState: vi.fn(), onOpenNote: vi.fn(() => Promise.resolve(true)), onClose: vi.fn(),
      viewFactory: () => view,
      workerFactory: (options: RelationshipGraphWorkerClientOptions) => {
        onFrame = (frame) => options.onFrame(frame);
        return {
          updateTopology: vi.fn(), dragStart: vi.fn(), dragMove: vi.fn(), dragEnd: vi.fn(),
          pause: vi.fn(), resume: vi.fn(), retry: vi.fn(), destroy: vi.fn()
        };
      }
    });
    try {
      graphWindow.open();
      const initialRenderCount = view.render.mock.calls.length;
      onFrame?.({ sessionId: "space-a", revision: 1, positions: { "conversation:root": { x: 130, y: 150, fixed: false } }, active: true });
      onFrame?.({ sessionId: "space-a", revision: 2, positions: { "conversation:root": { x: 140, y: 160, fixed: false } }, active: true });
      const canvas = document.querySelector<HTMLCanvasElement>(".relationship-graph-canvas");
      canvas?.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: 40, clientY: 40, deltaY: -120 }));
      expect(view.render.mock.calls.length).toBe(initialRenderCount);
      const callback = rafQueue.shift();
      if (callback === undefined) throw new Error("missing scheduled frame");
      callback(16);
      expect(view.render.mock.calls.length).toBe(initialRenderCount + 1);
      expect(latestRenderedPositions).toEqual({ "conversation:root": { x: 140, y: 160, fixed: false } });
    } finally {
      graphWindow.close();
      if (originalRafDescriptor === undefined) Reflect.deleteProperty(browserWindow, "requestAnimationFrame");
      else Object.defineProperty(browserWindow, "requestAnimationFrame", originalRafDescriptor);
    }
  });

  it("uses the camera-only Pixi fast path for every smooth zoom frame", () => {
    const rafQueue: Array<FrameRequestCallback> = [];
    const browserWindow = document.defaultView;
    if (browserWindow === null) throw new Error("missing jsdom window");
    const originalRafDescriptor = Object.getOwnPropertyDescriptor(browserWindow, "requestAnimationFrame");
    Object.defineProperty(browserWindow, "requestAnimationFrame", {
      configurable: true,
      value: (callback: FrameRequestCallback): number => { rafQueue.push(callback); return rafQueue.length; }
    });
    const view = {
      render: vi.fn(), renderCamera: vi.fn(), resize: vi.fn(), hitTest: vi.fn(() => undefined), destroy: vi.fn()
    };
    const graphWindow = new RelationshipGraphWindow({
      document,
      store: {
        getSnapshot: () => conversation("space-a"), subscribe: () => () => undefined,
        update: vi.fn(), selectNode: vi.fn(), canMutate: () => true, checkpointGraphPositions: vi.fn()
      },
      getWindowState: () => ({ x: 10, y: 10, width: 760, height: 520, minimized: false, maximized: false }),
      setWindowState: vi.fn(), onOpenNote: vi.fn(() => Promise.resolve(true)), onClose: vi.fn(),
      viewFactory: () => view,
      workerFactory: () => ({ updateTopology: vi.fn(), resize: vi.fn(), dragStart: vi.fn(), dragMove: vi.fn(), dragEnd: vi.fn(), pause: vi.fn(), resume: vi.fn(), retry: vi.fn(), destroy: vi.fn() })
    });
    try {
      graphWindow.open();
      while (rafQueue.length > 0) rafQueue.shift()?.(0);
      view.render.mockClear();
      view.renderCamera.mockClear();
      document.querySelector<HTMLCanvasElement>(".relationship-graph-canvas")?.dispatchEvent(
        new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: 200, clientY: 150, deltaY: -120 })
      );
      rafQueue.shift()?.(16);
      expect(view.render).not.toHaveBeenCalled();
      expect(view.renderCamera).toHaveBeenCalledOnce();
      expect(rafQueue.length).toBe(1);
      rafQueue.shift()?.(32);
      expect(view.renderCamera).toHaveBeenCalledTimes(2);
    } finally {
      graphWindow.close();
      if (originalRafDescriptor === undefined) Reflect.deleteProperty(browserWindow, "requestAnimationFrame");
      else Object.defineProperty(browserWindow, "requestAnimationFrame", originalRafDescriptor);
    }
  });

  it("finishes smooth zoom with labels only instead of a full topology render", () => {
    const rafQueue: Array<FrameRequestCallback> = [];
    const browserWindow = document.defaultView;
    if (browserWindow === null) throw new Error("missing jsdom window");
    const originalRafDescriptor = Object.getOwnPropertyDescriptor(browserWindow, "requestAnimationFrame");
    Object.defineProperty(browserWindow, "requestAnimationFrame", {
      configurable: true,
      value: (callback: FrameRequestCallback): number => { rafQueue.push(callback); return rafQueue.length; }
    });
    const render = vi.fn();
    const renderCamera = vi.fn();
    const renderLabels = vi.fn();
    const graphWindow = new RelationshipGraphWindow({
      document,
      store: {
        getSnapshot: () => conversation("space-a"), subscribe: () => () => undefined,
        update: vi.fn(), selectNode: vi.fn(), canMutate: () => true, checkpointGraphPositions: vi.fn()
      },
      getWindowState: () => ({ x: 10, y: 10, width: 760, height: 520, minimized: false, maximized: false }),
      setWindowState: vi.fn(), onOpenNote: vi.fn(() => Promise.resolve(true)), onClose: vi.fn(),
      viewFactory: () => ({ render, renderCamera, renderLabels, resize: vi.fn(), hitTest: vi.fn(), destroy: vi.fn() }),
      workerFactory: () => ({ updateTopology: vi.fn(), resize: vi.fn(), dragStart: vi.fn(), dragMove: vi.fn(), dragEnd: vi.fn(), pause: vi.fn(), resume: vi.fn(), retry: vi.fn(), destroy: vi.fn() })
    });
    try {
      graphWindow.open();
      while (rafQueue.length > 0) rafQueue.shift()?.(0);
      render.mockClear();
      renderLabels.mockClear();
      document.querySelector<HTMLCanvasElement>(".relationship-graph-canvas")?.dispatchEvent(
        new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: 200, clientY: 150, deltaY: -120 })
      );
      let timestamp = 16;
      let guard = 0;
      while (rafQueue.length > 0 && guard < 200) {
        rafQueue.shift()?.(timestamp);
        timestamp += 16;
        guard += 1;
      }
      expect(guard).toBeLessThan(200);
      expect(renderCamera).toHaveBeenCalled();
      expect(renderLabels).toHaveBeenCalledOnce();
      expect(render).not.toHaveBeenCalled();
    } finally {
      graphWindow.close();
      if (originalRafDescriptor === undefined) Reflect.deleteProperty(browserWindow, "requestAnimationFrame");
      else Object.defineProperty(browserWindow, "requestAnimationFrame", originalRafDescriptor);
    }
  });


  it("cancels the display frame loop while minimized and restarts with one full frame", () => {
    const rafQueue = new Map<number, FrameRequestCallback>();
    let nextFrameId = 0;
    const browserWindow = document.defaultView;
    if (browserWindow === null) throw new Error("missing jsdom window");
    const originalRafDescriptor = Object.getOwnPropertyDescriptor(browserWindow, "requestAnimationFrame");
    const originalCancelDescriptor = Object.getOwnPropertyDescriptor(browserWindow, "cancelAnimationFrame");
    const cancelAnimationFrame = vi.fn((id: number) => { rafQueue.delete(id); });
    Object.defineProperty(browserWindow, "requestAnimationFrame", {
      configurable: true,
      value: (callback: FrameRequestCallback): number => {
        nextFrameId += 1;
        rafQueue.set(nextFrameId, callback);
        return nextFrameId;
      }
    });
    Object.defineProperty(browserWindow, "cancelAnimationFrame", { configurable: true, value: cancelAnimationFrame });
    let state = { x: 10, y: 10, width: 760, height: 520, minimized: false, maximized: false };
    const render = vi.fn();
    const renderCamera = vi.fn();
    const worker = { updateTopology: vi.fn(), resize: vi.fn(), dragStart: vi.fn(), dragMove: vi.fn(), dragEnd: vi.fn(), pause: vi.fn(), resume: vi.fn(), retry: vi.fn(), destroy: vi.fn() };
    const graphWindow = new RelationshipGraphWindow({
      document,
      store: {
        getSnapshot: () => conversation("space-a"), subscribe: () => () => undefined,
        update: vi.fn(), selectNode: vi.fn(), canMutate: () => true, checkpointGraphPositions: vi.fn()
      },
      getWindowState: () => state,
      setWindowState: (next) => { state = next; },
      onOpenNote: vi.fn(() => Promise.resolve(true)), onClose: vi.fn(),
      viewFactory: () => ({ render, renderCamera, resize: vi.fn(), hitTest: vi.fn(), destroy: vi.fn() }),
      workerFactory: () => worker
    });
    try {
      graphWindow.open();
      for (const [id, callback] of [...rafQueue]) { rafQueue.delete(id); callback(0); }
      document.querySelector<HTMLCanvasElement>(".relationship-graph-canvas")?.dispatchEvent(
        new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: 200, clientY: 150, deltaY: -120 })
      );
      expect(rafQueue.size).toBe(1);
      document.querySelector<HTMLButtonElement>(".relationship-graph-window-controls button")?.click();
      expect(state.minimized).toBe(true);
      expect(worker.pause).toHaveBeenCalled();
      expect(cancelAnimationFrame).toHaveBeenCalled();
      expect(rafQueue.size).toBe(0);

      graphWindow.focus();
      expect(state.minimized).toBe(false);
      expect(worker.resume).toHaveBeenCalled();
      expect(rafQueue.size).toBe(1);
      const next = [...rafQueue.values()][0];
      if (next === undefined) throw new Error("missing resumed frame");
      next(16);
      expect(render).toHaveBeenCalled();
    } finally {
      graphWindow.close();
      if (originalRafDescriptor === undefined) Reflect.deleteProperty(browserWindow, "requestAnimationFrame");
      else Object.defineProperty(browserWindow, "requestAnimationFrame", originalRafDescriptor);
      if (originalCancelDescriptor === undefined) Reflect.deleteProperty(browserWindow, "cancelAnimationFrame");
      else Object.defineProperty(browserWindow, "cancelAnimationFrame", originalCancelDescriptor);
    }
  });


  it("cancels display frames while the Obsidian document is hidden", () => {
    const rafQueue = new Map<number, FrameRequestCallback>();
    let nextFrameId = 0;
    const browserWindow = document.defaultView;
    if (browserWindow === null) throw new Error("missing jsdom window");
    const originalRafDescriptor = Object.getOwnPropertyDescriptor(browserWindow, "requestAnimationFrame");
    const originalCancelDescriptor = Object.getOwnPropertyDescriptor(browserWindow, "cancelAnimationFrame");
    const originalHiddenDescriptor = Object.getOwnPropertyDescriptor(document, "hidden");
    const cancelAnimationFrame = vi.fn((id: number) => { rafQueue.delete(id); });
    Object.defineProperty(browserWindow, "requestAnimationFrame", {
      configurable: true,
      value: (callback: FrameRequestCallback): number => {
        nextFrameId += 1;
        rafQueue.set(nextFrameId, callback);
        return nextFrameId;
      }
    });
    Object.defineProperty(browserWindow, "cancelAnimationFrame", { configurable: true, value: cancelAnimationFrame });
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    const worker = { updateTopology: vi.fn(), resize: vi.fn(), dragStart: vi.fn(), dragMove: vi.fn(), dragEnd: vi.fn(), pause: vi.fn(), resume: vi.fn(), retry: vi.fn(), destroy: vi.fn() };
    const graphWindow = new RelationshipGraphWindow({
      document,
      store: {
        getSnapshot: () => conversation("space-a"), subscribe: () => () => undefined,
        update: vi.fn(), selectNode: vi.fn(), canMutate: () => true, checkpointGraphPositions: vi.fn()
      },
      getWindowState: () => ({ x: 10, y: 10, width: 760, height: 520, minimized: false, maximized: false }),
      setWindowState: vi.fn(), onOpenNote: vi.fn(() => Promise.resolve(true)), onClose: vi.fn(),
      viewFactory: () => ({ render: vi.fn(), renderCamera: vi.fn(), resize: vi.fn(), hitTest: vi.fn(), destroy: vi.fn() }),
      workerFactory: () => worker
    });
    try {
      graphWindow.open();
      for (const [id, callback] of [...rafQueue]) { rafQueue.delete(id); callback(0); }
      document.querySelector<HTMLCanvasElement>(".relationship-graph-canvas")?.dispatchEvent(
        new WheelEvent("wheel", { bubbles: true, cancelable: true, clientX: 200, clientY: 150, deltaY: -120 })
      );
      expect(rafQueue.size).toBe(1);
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      document.dispatchEvent(new Event("visibilitychange"));
      expect(worker.pause).toHaveBeenCalled();
      expect(cancelAnimationFrame).toHaveBeenCalled();
      expect(rafQueue.size).toBe(0);
      Object.defineProperty(document, "hidden", { configurable: true, value: false });
      document.dispatchEvent(new Event("visibilitychange"));
      expect(worker.resume).toHaveBeenCalled();
      expect(rafQueue.size).toBe(1);
    } finally {
      graphWindow.close();
      if (originalRafDescriptor === undefined) Reflect.deleteProperty(browserWindow, "requestAnimationFrame");
      else Object.defineProperty(browserWindow, "requestAnimationFrame", originalRafDescriptor);
      if (originalCancelDescriptor === undefined) Reflect.deleteProperty(browserWindow, "cancelAnimationFrame");
      else Object.defineProperty(browserWindow, "cancelAnimationFrame", originalCancelDescriptor);
      if (originalHiddenDescriptor === undefined) Reflect.deleteProperty(document, "hidden");
      else Object.defineProperty(document, "hidden", originalHiddenDescriptor);
    }
  });

  it("renders a dragged node at the pointer before any Worker frame returns", () => {
    const rafQueue: Array<FrameRequestCallback> = [];
    const browserWindow = document.defaultView;
    if (browserWindow === null) throw new Error("missing jsdom window");
    const originalRafDescriptor = Object.getOwnPropertyDescriptor(browserWindow, "requestAnimationFrame");
    Object.defineProperty(browserWindow, "requestAnimationFrame", {
      configurable: true,
      value: (callback: FrameRequestCallback): number => { rafQueue.push(callback); return rafQueue.length; }
    });
    const rendered: Array<{ x: number; y: number }> = [];
    const view = {
      render: vi.fn((snapshot: { positions: Record<string, { x: number; y: number }> }) => {
        const point = snapshot.positions["conversation:root"];
        if (point !== undefined) rendered.push({ x: point.x, y: point.y });
      }),
      resize: vi.fn(), hitTest: vi.fn(() => ({ nodeId: "conversation:root" })), destroy: vi.fn()
    };
    const worker = { updateTopology: vi.fn(), resize: vi.fn(), dragStart: vi.fn(), dragMove: vi.fn(), dragEnd: vi.fn(), pause: vi.fn(), resume: vi.fn(), retry: vi.fn(), destroy: vi.fn() };
    const graphWindow = new RelationshipGraphWindow({
      document,
      store: {
        getSnapshot: () => conversation("space-a", { "conversation:root": { x: 120, y: 140, fixed: false } }),
        subscribe: () => () => undefined, update: vi.fn(), selectNode: vi.fn(), canMutate: () => true, checkpointGraphPositions: vi.fn()
      },
      getWindowState: () => ({ x: 10, y: 10, width: 760, height: 520, minimized: false, maximized: false }),
      setWindowState: vi.fn(), onOpenNote: vi.fn(() => Promise.resolve(true)), onClose: vi.fn(),
      viewFactory: () => view, workerFactory: () => worker
    });
    try {
      graphWindow.open();
      while (rafQueue.length > 0) rafQueue.shift()?.(0);
      const canvas = document.querySelector<HTMLCanvasElement>(".relationship-graph-canvas");
      canvas?.dispatchEvent(pointerEvent("pointerdown", 120, 140));
      canvas?.dispatchEvent(pointerEvent("pointermove", 160, 180));
      expect(worker.dragStart).toHaveBeenCalledWith("conversation:root", 160, 180);
      rafQueue.shift()?.(16);
      expect(rendered.at(-1)).toEqual({ x: 160, y: 180 });
    } finally {
      graphWindow.close();
      if (originalRafDescriptor === undefined) Reflect.deleteProperty(browserWindow, "requestAnimationFrame");
      else Object.defineProperty(browserWindow, "requestAnimationFrame", originalRafDescriptor);
    }
  });

  it("routes interpolated Worker samples through the position-only Pixi path", () => {
    const rafQueue: Array<FrameRequestCallback> = [];
    const browserWindow = document.defaultView;
    if (browserWindow === null) throw new Error("missing jsdom window");
    const originalRafDescriptor = Object.getOwnPropertyDescriptor(browserWindow, "requestAnimationFrame");
    Object.defineProperty(browserWindow, "requestAnimationFrame", {
      configurable: true,
      value: (callback: FrameRequestCallback): number => { rafQueue.push(callback); return rafQueue.length; }
    });
    let onFrame: ((frame: RelationshipGraphWorkerFrame) => void) | undefined;
    const renderPositions = vi.fn(() => true);
    const view = {
      render: vi.fn(), renderPositions, resize: vi.fn(), hitTest: vi.fn(), destroy: vi.fn()
    };
    const graphWindow = new RelationshipGraphWindow({
      document,
      store: {
        getSnapshot: () => conversation("space-a", { "conversation:root": { x: 120, y: 140, fixed: false } }),
        subscribe: () => () => undefined, update: vi.fn(), selectNode: vi.fn(), canMutate: () => true, checkpointGraphPositions: vi.fn()
      },
      getWindowState: () => ({ x: 10, y: 10, width: 760, height: 520, minimized: false, maximized: false }),
      setWindowState: vi.fn(), onOpenNote: vi.fn(() => Promise.resolve(true)), onClose: vi.fn(), viewFactory: () => view,
      workerFactory: (options) => {
        onFrame = (frame) => options.onFrame(frame);
        return { updateTopology: vi.fn(), resize: vi.fn(), dragStart: vi.fn(), dragMove: vi.fn(), dragEnd: vi.fn(), pause: vi.fn(), resume: vi.fn(), retry: vi.fn(), destroy: vi.fn() };
      }
    });
    try {
      graphWindow.open();
      while (rafQueue.length > 0) rafQueue.shift()?.(0);
      view.render.mockClear();
      const receivedAt = performance.now();
      onFrame?.({
        sessionId: "space-a", revision: 1, sequence: 1, receivedAt,
        values: new Float32Array([160, 180]),
        positions: { "conversation:root": { x: 160, y: 180, fixed: false } }, active: true
      });
      rafQueue.shift()?.(receivedAt + 16);
      expect(renderPositions).toHaveBeenCalledOnce();
      expect(view.render).not.toHaveBeenCalled();
    } finally {
      graphWindow.close();
      if (originalRafDescriptor === undefined) Reflect.deleteProperty(browserWindow, "requestAnimationFrame");
      else Object.defineProperty(browserWindow, "requestAnimationFrame", originalRafDescriptor);
    }
  });

  it("toggles a note graph node off and on from the context menu", () => {
    let current = conversationWithNote();
    const update = vi.fn((updater: (value: ConversationFile) => ConversationFile) => { current = updater(current); });
    const view = {
      render: vi.fn(), resize: vi.fn(),
      hitTest: vi.fn(() => ({ nodeId: "note:Notes/example.md" })),
      destroy: vi.fn()
    };
    const graphWindow = new RelationshipGraphWindow({
      document,
      store: {
        getSnapshot: () => current,
        subscribe: () => () => undefined,
        update, selectNode: vi.fn(), canMutate: () => true,
        checkpointGraphPositions: vi.fn()
      },
      getWindowState: () => ({ x: 10, y: 10, width: 760, height: 520, minimized: false, maximized: false }),
      setWindowState: vi.fn(), onOpenNote: vi.fn(() => Promise.resolve(true)), onClose: vi.fn(),
      viewFactory: () => view,
      workerFactory: () => ({ updateTopology: vi.fn(), resize: vi.fn(), dragStart: vi.fn(), dragMove: vi.fn(), dragEnd: vi.fn(), pause: vi.fn(), resume: vi.fn(), retry: vi.fn(), destroy: vi.fn() })
    });
    graphWindow.open();
    const canvas = document.querySelector<HTMLCanvasElement>(".relationship-graph-canvas");
    if (canvas === null) throw new Error("missing graph canvas");
    const contextMenu = (): void => { canvas.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10, button: 2 })); };
    contextMenu();
    expect(current.depositGraphState?.nodeStates["note:Notes/example.md"]?.included).toBe(false);
    contextMenu();
    expect(current.depositGraphState?.nodeStates["note:Notes/example.md"]?.included).toBe(true);
    expect(update).toHaveBeenCalledTimes(2);
    graphWindow.close();
  });
  it("keeps one display-frame loop alive while shared physics is active", () => {
    const rafQueue: Array<FrameRequestCallback> = [];
    const browserWindow = document.defaultView;
    if (browserWindow === null) throw new Error("missing jsdom window");
    const originalRafDescriptor = Object.getOwnPropertyDescriptor(browserWindow, "requestAnimationFrame");
    Object.defineProperty(browserWindow, "requestAnimationFrame", {
      configurable: true,
      value: (callback: FrameRequestCallback): number => { rafQueue.push(callback); return rafQueue.length; }
    });
    const descriptor = createRelationshipGraphSharedMemory(1, 1);
    const reader = new RelationshipGraphSharedMemoryReader(descriptor);
    const writer = new RelationshipGraphSharedMemoryWriter(descriptor);
    const first = writer.beginWrite();
    if (first === undefined) throw new Error("missing shared write page");
    first.values.set([120, 140, 0, 1]);
    writer.publish(first, true);
    const sharedState = { revision: 1, nodeIds: ["conversation:root"], reader };
    const renderShared = vi.fn(() => ({ active: reader.active, sequence: reader.sequence }));
    const view = {
      render: vi.fn(), setSharedState: vi.fn(), renderShared, syncSharedPositions: vi.fn(() => true),
      resize: vi.fn(), hitTest: vi.fn(), destroy: vi.fn()
    };
    const graphWindow = new RelationshipGraphWindow({
      document,
      store: {
        getSnapshot: () => conversation("space-a", { "conversation:root": { x: 120, y: 140, fixed: false } }),
        subscribe: () => () => undefined, update: vi.fn(), selectNode: vi.fn(), canMutate: () => true, checkpointGraphPositions: vi.fn()
      },
      getWindowState: () => ({ x: 10, y: 10, width: 760, height: 520, minimized: false, maximized: false }),
      setWindowState: vi.fn(), onOpenNote: vi.fn(() => Promise.resolve(true)), onClose: vi.fn(), viewFactory: () => view,
      workerFactory: () => ({
        updateTopology: vi.fn(() => 1), sharedState: () => sharedState, isPhysicsActive: () => reader.active,
        resize: vi.fn(), dragStart: vi.fn(), dragMove: vi.fn(), dragEnd: vi.fn(), pause: vi.fn(), resume: vi.fn(), retry: vi.fn(), destroy: vi.fn()
      })
    });
    try {
      graphWindow.open();
      expect(view.setSharedState).toHaveBeenCalledWith(sharedState);
      expect(rafQueue.length).toBeGreaterThan(0);
      rafQueue.shift()?.(16);
      expect(renderShared).toHaveBeenCalled();
      expect(rafQueue.length).toBeGreaterThan(0);
      const finalPage = writer.beginWrite();
      if (finalPage === undefined) throw new Error("missing final shared write page");
      finalPage.values.set([122, 142, 0, 1]);
      writer.publish(finalPage, false);
      rafQueue.shift()?.(32);
      expect(rafQueue).toHaveLength(0);
    } finally {
      graphWindow.close();
      if (originalRafDescriptor === undefined) Reflect.deleteProperty(browserWindow, "requestAnimationFrame");
      else Object.defineProperty(browserWindow, "requestAnimationFrame", originalRafDescriptor);
    }
  });

});
