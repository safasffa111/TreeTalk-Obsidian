import type { TreeTalkSource } from "./source-link-handler";

export type SourceHighlightListener = (source: TreeTalkSource) => void;

export interface SourceHighlightPort {
  subscribe(listener: SourceHighlightListener): () => void;
}

export class SourceHighlightStore implements SourceHighlightPort {
  private readonly listeners = new Set<SourceHighlightListener>();

  publish(source: TreeTalkSource): void {
    const snapshot = structuredClone(source);
    for (const listener of this.listeners) listener(snapshot);
  }

  subscribe(listener: SourceHighlightListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
