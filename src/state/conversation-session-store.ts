import { parseConversation } from "../domain/schema";
import type { ConversationFile } from "../domain/types";

export type ConversationListener = () => void;
export type ConversationUpdater = (conversation: ConversationFile) => ConversationFile;

export class ConversationSessionStore {
  private conversation: ConversationFile;
  private readonly listeners = new Set<ConversationListener>();

  constructor(initial: ConversationFile) {
    this.conversation = parseConversation(structuredClone(initial));
  }

  getSnapshot(): ConversationFile {
    return this.conversation;
  }

  subscribe(listener: ConversationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  update(updater: ConversationUpdater): void {
    const next = parseConversation(updater(this.conversation));
    if (next === this.conversation) return;
    this.conversation = next;
    for (const listener of this.listeners) listener();
  }

  replace(conversation: ConversationFile): void {
    this.update(() => conversation);
  }

  selectNode(nodeId: string): void {
    if (this.conversation.nodes[nodeId] === undefined) {
      throw new Error(`Node not found: ${nodeId}`);
    }
    this.update((conversation) => ({
      ...structuredClone(conversation),
      currentNodeId: nodeId
    }));
  }
}
