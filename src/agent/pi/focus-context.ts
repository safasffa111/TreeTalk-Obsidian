import type { TreeOperation } from "../../domain/tree-commands";
import type {
  ChatMessage,
  ConversationFile,
  ConversationNode,
  SelectionContext
} from "../../domain/types";
import { isNoteSelectionContext } from "../../domain/types";
import type {
  PiFocusAnchor,
  PiFocusContext,
  PiResponseTarget
} from "../../execution/types";

function requiredNode(
  conversation: ConversationFile,
  nodeId: string
): ConversationNode {
  const node = conversation.nodes[nodeId];
  if (node === undefined) throw new Error(`Node not found: ${nodeId}`);
  return node;
}

function requiredUserMessage(
  node: ConversationNode,
  messageId: string
): ChatMessage {
  const message = node.messages.find((entry) => entry.id === messageId);
  if (message === undefined || message.role !== "user") {
    throw new Error(`User message not found: ${messageId}`);
  }
  return message;
}

function latestCompletedAssistantBefore(
  node: ConversationNode,
  messageId: string
): ChatMessage | undefined {
  const currentIndex = node.messages.findIndex((entry) => entry.id === messageId);
  const boundary = currentIndex < 0 ? node.messages.length : currentIndex;
  for (let index = boundary - 1; index >= 0; index -= 1) {
    const message = node.messages[index];
    if (
      message?.role === "assistant" &&
      message.status === "complete" &&
      message.content.trim().length > 0
    ) {
      return message;
    }
  }
  return undefined;
}

function anchorFromSelection(
  context: SelectionContext,
  id: string
): PiFocusAnchor {
  if (isNoteSelectionContext(context)) {
    return {
      id,
      defaultScope: "selection_only",
      kind: "note-selection",
      filePath: context.filePath,
      fileName: context.fileName,
      quote: context.quote,
      prefix: context.prefix,
      suffix: context.suffix,
      ...(context.snapshot === undefined
        ? {}
        : {
            selectionStartOffset: context.snapshot.selectionStartOffset,
            selectionEndOffset: context.snapshot.selectionEndOffset
          })
    };
  }
  return {
    id,
    defaultScope: "source_message",
    kind: "message-selection",
    sourceNodeId: context.sourceNodeId,
    sourceMessageId: context.messageId,
    sourceRole: context.sourceRole,
    quote: context.quote,
    prefix: context.prefix,
    suffix: context.suffix
  };
}


function targetFromSelectionAnchor(anchor: PiFocusAnchor): PiResponseTarget | undefined {
  if (anchor.id === undefined || anchor.kind === "conversation-round") return undefined;
  if (anchor.kind === "note-selection") {
    return {
      kind: "exact-selection",
      anchorId: anchor.id,
      text: anchor.quote,
      source: {
        type: "note",
        filePath: anchor.filePath,
        fileName: anchor.fileName
      }
    };
  }
  return {
    kind: "exact-selection",
    anchorId: anchor.id,
    text: anchor.quote,
    source: {
      type: "conversation-message",
      nodeId: anchor.sourceNodeId,
      messageId: anchor.sourceMessageId,
      role: anchor.sourceRole
    }
  };
}

function structuralTarget(anchor: PiFocusAnchor): PiResponseTarget {
  if (anchor.id === undefined || anchor.kind !== "conversation-round") {
    throw new Error("Structural focus target requires a conversation-round anchor ID");
  }
  return {
    kind: "conversation-round",
    anchorId: anchor.id,
    sourceNodeId: anchor.sourceNodeId,
    ...(anchor.sourceMessageId === undefined
      ? {}
      : { sourceMessageId: anchor.sourceMessageId }),
    reason: anchor.reason
  };
}

export function buildPiFocusContext(
  conversation: ConversationFile,
  operation: TreeOperation,
  userMessageId: string
): PiFocusContext {
  const interactionMode = operation.kind === "create-child" ? "child" : "continue";
  const responseNodeId =
    operation.kind === "create-child" ? operation.childId : operation.nodeId;
  const responseNode = requiredNode(conversation, responseNodeId);
  const userMessage = requiredUserMessage(responseNode, userMessageId);
  const selections = userMessage.selectionContexts ?? [];
  const selectionAnchors = selections.map((selection, index) =>
    anchorFromSelection(selection, `F${String(index + 1)}`)
  );
  const sourceNodeId =
    operation.kind === "create-child" ? operation.parentId : operation.nodeId;
  const sourceNode = requiredNode(conversation, sourceNodeId);
  const assistant = latestCompletedAssistantBefore(
    sourceNode,
    operation.kind === "create-child" ? "" : userMessageId
  );
  const structuralAnchor: PiFocusAnchor = {
    id: `F${String(selectionAnchors.length + 1)}`,
    defaultScope: "latest_round",
    kind: "conversation-round",
    sourceNodeId,
    reason:
      operation.kind === "create-child" ? "direct-parent" : "previous-turn",
    ...(assistant === undefined ? {} : { sourceMessageId: assistant.id })
  };
  if (selectionAnchors.length === 0) {
    return {
      interactionMode,
      defaultScope: "latest_round",
      anchors: [structuralAnchor],
      targets: [structuralTarget(structuralAnchor)]
    };
  }
  const structuralAlreadySelected = selectionAnchors.some((anchor) =>
    anchor.kind === "message-selection" &&
    anchor.sourceNodeId === structuralAnchor.sourceNodeId &&
    anchor.sourceMessageId === structuralAnchor.sourceMessageId
  );
  return {
    interactionMode,
    defaultScope: "source_message",
    anchors: structuralAlreadySelected
      ? selectionAnchors
      : [...selectionAnchors, structuralAnchor],
    targets: selectionAnchors
      .map(targetFromSelectionAnchor)
      .filter((target): target is PiResponseTarget => target !== undefined)
  };
}
