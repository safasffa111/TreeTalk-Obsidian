import { parseConversation } from "./schema";
import type { ConversationFile } from "./types";

export function createConversation(title = "新对话"): ConversationFile {
  const now = new Date().toISOString();
  const conversationId = crypto.randomUUID();
  const rootNodeId = crypto.randomUUID();
  return parseConversation({
    schemaVersion: 1,
    id: conversationId,
    title,
    status: "active",
    revision: 0,
    checksum: "",
    createdAt: now,
    updatedAt: now,
    rootNodeId,
    currentNodeId: rootNodeId,
    nodes: {
      [rootNodeId]: {
        id: rootNodeId,
        parentId: null,
        childIds: [],
        title,
        titleSource: "question",
        messages: [],
        draft: { text: "", mode: "continue", selectionContexts: [] },
        createdAt: now,
        updatedAt: now
      }
    },
    ui: {
      expandedNodeIds: [rootNodeId],
      treeScrollTop: 0,
      messageScrollTopByNode: {}
    }
  });
}
