import { buildNoteLinkGraph, type NoteLinkResolver } from "./note-link-graph";
import { attachNoteContextGraphToMessage } from "./tree-commands";
import { isNoteSelectionContext } from "./types";
import type {
  ConversationFile,
  NoteContextTokenBudget,
  RelatedNoteDepth
} from "./types";

export interface FreezeNoteContextInput {
  nodeId: string;
  messageId: string;
  builtAt: string;
  fullNoteContext: boolean;
  perNoteBudget: NoteContextTokenBudget;
  relatedNotesEnabled: boolean;
  maxDepth: RelatedNoteDepth;
  resolver: NoteLinkResolver;
}

export interface FreezeNoteContextResult {
  state: ConversationFile;
  frozen: boolean;
}

export async function freezeNoteContextForMessage(
  conversation: ConversationFile,
  input: FreezeNoteContextInput
): Promise<FreezeNoteContextResult> {
  const node = conversation.nodes[input.nodeId];
  const message = node?.messages.find((entry) => entry.id === input.messageId);
  if (message === undefined || message.role !== "user") {
    throw new Error(`User message not found: ${input.messageId}`);
  }
  const roots = new Map<
    string,
    { filePath: string; fileName: string; sourceText: string }
  >();
  for (const context of message.selectionContexts ?? []) {
    if (!isNoteSelectionContext(context) || context.snapshot === undefined) {
      continue;
    }
    const key = `${context.filePath}\u0000${context.snapshot.contentHash}`;
    if (!roots.has(key)) {
      roots.set(key, {
        filePath: context.filePath,
        fileName: context.fileName,
        sourceText: context.snapshot.content
      });
    }
  }
  if (roots.size === 0) return { state: conversation, frozen: false };
  const graph = await buildNoteLinkGraph({
    roots: [...roots.values()],
    relatedNotesEnabled: input.relatedNotesEnabled,
    fullNoteContext: input.fullNoteContext,
    perNoteBudget: input.fullNoteContext ? "full" : input.perNoteBudget,
    maxDepth: input.maxDepth,
    builtAt: input.builtAt,
    resolver: input.resolver
  });
  return {
    state: attachNoteContextGraphToMessage(
      conversation,
      input.nodeId,
      input.messageId,
      graph,
      input.builtAt
    ),
    frozen: true
  };
}
