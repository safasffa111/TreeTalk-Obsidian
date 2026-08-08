import { RelationshipGraphWorkerRuntime } from "./worker-runtime";

interface RelationshipGraphWorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  setInterval(callback: () => void, delay: number): number;
  clearInterval(id: number): void;
}

const scope = globalThis as unknown as RelationshipGraphWorkerScope;
const runtime = new RelationshipGraphWorkerRuntime({
  postMessage: (message, transfer) => scope.postMessage(message, transfer),
  now: () => performance.now(),
  setInterval: (callback, delay) => scope.setInterval(callback, delay),
  clearInterval: (id) => scope.clearInterval(id)
});
scope.onmessage = (event) => runtime.handle(event.data);
