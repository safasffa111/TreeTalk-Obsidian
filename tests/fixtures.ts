import type { ConversationFile, ConversationNode } from "../src/domain/types";

export const NOW = "2026-07-29T00:00:00.000Z";

export function validConversation(): ConversationFile {
  return {
    schemaVersion: 1,
    id: "conversation-1",
    title: "TCP 学习",
    status: "active",
    revision: 1,
    checksum: "checksum",
    createdAt: NOW,
    updatedAt: NOW,
    rootNodeId: "root",
    currentNodeId: "child",
    nodes: {
      root: {
        id: "root",
        parentId: null,
        childIds: ["child"],
        title: "TCP 为什么可靠？",
        messages: [],
        draft: {
          text: "",
          mode: "continue",
          selectionContexts: []
        },
        createdAt: NOW,
        updatedAt: NOW
      },
      child: {
        id: "child",
        parentId: "root",
        childIds: [],
        title: "三次握手",
        messages: [],
        draft: {
          text: "",
          mode: "continue",
          selectionContexts: []
        },
        createdAt: NOW,
        updatedAt: NOW
      }
    },
    ui: {
      expandedNodeIds: ["root"],
      treeScrollTop: 0,
      messageScrollTopByNode: {}
    }
  };
}

export function requireNode(conversation: ConversationFile, nodeId: string): ConversationNode {
  const node = conversation.nodes[nodeId];
  if (node === undefined) {
    throw new Error(`Fixture node is missing: ${nodeId}`);
  }
  return node;
}
