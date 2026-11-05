import {
  isNoteSelectionContext,
  type ChatMessage,
  type ConversationFile,
  type ConversationNode,
  type NoteSelectionContext,
  type SelectionAnchor
} from "../domain/types";
import type { VaultPort } from "../storage/conversation-repository";
import {
  appendMarkdownLinks,
  insertMarkdownLinks,
  resolveNoteMarkdownAnchor,
  type MarkdownLink
} from "./markdown-branch-links";

export interface DocumentReference {
  note: NoteSelectionContext;
  /** Question message whose context pointed at the note. */
  nodeId: string;
  messageId: string;
}

interface LocatedMessage {
  node: ConversationNode;
  index: number;
  message: ChatMessage;
}

const MAX_REFERENCE_CHAIN = 64;

function locateMessage(
  conversation: ConversationFile,
  nodeId: string,
  messageId: string
): LocatedMessage | undefined {
  const direct = conversation.nodes[nodeId];
  if (direct !== undefined) {
    const index = direct.messages.findIndex(
      (message) => message.id === messageId
    );
    const message = index < 0 ? undefined : direct.messages[index];
    if (message !== undefined) return { node: direct, index, message };
  }
  for (const node of Object.values(conversation.nodes)) {
    if (node.id === nodeId) continue;
    const index = node.messages.findIndex((message) => message.id === messageId);
    const message = index < 0 ? undefined : node.messages[index];
    if (message !== undefined) return { node, index, message };
  }
  return undefined;
}

function promptingUserMessage(
  located: LocatedMessage
): LocatedMessage | undefined {
  if (located.message.role === "user") return located;
  for (let index = located.index - 1; index >= 0; index -= 1) {
    const message = located.node.messages[index];
    if (message?.role === "user") {
      return { node: located.node, index, message };
    }
  }
  return undefined;
}

function sourceQuestion(
  conversation: ConversationFile,
  anchor: SelectionAnchor
): LocatedMessage | undefined {
  const located = locateMessage(
    conversation,
    anchor.sourceNodeId,
    anchor.messageId
  );
  return located === undefined ? undefined : promptingUserMessage(located);
}

/**
 * Follows the question that produced an answer back through its selected
 * context. Chat-message selections are followed recursively until the first
 * real note selection is found.
 */
export function findDocumentReference(
  conversation: ConversationFile,
  nodeId: string,
  messageId: string
): DocumentReference | undefined {
  const located = locateMessage(conversation, nodeId, messageId);
  const seed = located === undefined ? undefined : promptingUserMessage(located);
  if (seed === undefined) return undefined;

  const pending: LocatedMessage[] = [seed];
  const visited = new Set<string>();
  while (pending.length > 0 && visited.size < MAX_REFERENCE_CHAIN) {
    const candidate = pending.pop();
    if (candidate === undefined) break;
    const key = `${candidate.node.id}\u0000${candidate.message.id}`;
    if (visited.has(key)) continue;
    visited.add(key);

    const contexts = candidate.message.selectionContexts ?? [];
    for (let index = contexts.length - 1; index >= 0; index -= 1) {
      const context = contexts[index];
      if (context !== undefined && isNoteSelectionContext(context)) {
        return {
          note: context,
          nodeId: candidate.node.id,
          messageId: candidate.message.id
        };
      }
    }

    const next: LocatedMessage[] = [];
    for (let index = contexts.length - 1; index >= 0; index -= 1) {
      const context = contexts[index];
      if (context === undefined || isNoteSelectionContext(context)) continue;
      const source = sourceQuestion(conversation, context);
      if (source !== undefined) next.push(source);
    }
    for (let index = next.length - 1; index >= 0; index -= 1) {
      const source = next[index];
      if (source !== undefined) pending.push(source);
    }
  }
  return undefined;
}

export type ReferenceInsertionStatus =
  | "inserted"
  | "appended"
  | "unchanged"
  | "missing";

export async function insertDocumentReference(
  vault: VaultPort,
  reference: NoteSelectionContext,
  link: MarkdownLink
): Promise<ReferenceInsertionStatus> {
  if (!(await vault.exists(reference.filePath))) return "missing";
  const original = await vault.read(reference.filePath);
  const anchor = await resolveNoteMarkdownAnchor(original, reference);
  if (anchor !== undefined) {
    const updated = insertMarkdownLinks(original, [{ anchor, links: [link] }]);
    if (updated === original) return "unchanged";
    await vault.write(reference.filePath, updated);
    return "inserted";
  }
  const updated = appendMarkdownLinks(original, [link]);
  if (updated === original) return "unchanged";
  await vault.write(reference.filePath, updated);
  return "appended";
}
