import { parseConversation } from "./schema";
import type { ConversationFile } from "./types";

export function interruptOrphanedResponses(
  conversation: ConversationFile,
  now: string
): ConversationFile {
  const hasOrphanedResponse = Object.values(conversation.nodes).some((node) =>
    node.messages.some(
      (message) =>
        message.role === "assistant" && message.status === "streaming"
    )
  );
  if (!hasOrphanedResponse) return conversation;

  const next = structuredClone(conversation);
  for (const node of Object.values(next.nodes)) {
    let nodeChanged = false;
    for (const message of node.messages) {
      if (message.role !== "assistant" || message.status !== "streaming") {
        continue;
      }
      message.status = "interrupted";
      message.updatedAt = now;
      nodeChanged = true;
    }
    if (nodeChanged) node.updatedAt = now;
  }
  next.updatedAt = now;
  next.revision += 1;
  return parseConversation(next);
}
