import type { ConversationFile, SelectionAnchor } from "../domain/types";
import { decodeSourceAnchor } from "../knowledge/excerpt-drag";

export interface TreeTalkSource {
  conversationId: string;
  nodeId: string;
  messageId?: string;
  anchor?: SelectionAnchor;
}

export interface SourceWorkspacePort {
  openActive(source: TreeTalkSource): Promise<boolean>;
  openHistory(source: TreeTalkSource): Promise<boolean>;
}

export function conversationContainsSource(
  conversation: ConversationFile,
  source: TreeTalkSource
): boolean {
  if (conversation.id !== source.conversationId) return false;
  const node = conversation.nodes[source.nodeId];
  if (node === undefined) return false;
  return source.messageId === undefined
    ? true
    : node.messages.some((message) => message.id === source.messageId);
}

function sourceFromParameters(
  parameters: Record<string, string>
): TreeTalkSource | undefined {
  const conversationId = parameters.conversationId?.trim();
  const nodeId = parameters.nodeId?.trim();
  const messageId = parameters.messageId?.trim();
  const encodedAnchor = parameters.anchor?.trim();
  if (
    conversationId === undefined ||
    conversationId.length === 0 ||
    nodeId === undefined ||
    nodeId.length === 0
  ) {
    return undefined;
  }
  const source: TreeTalkSource = { conversationId, nodeId };
  if (messageId !== undefined && messageId.length > 0) {
    source.messageId = messageId;
  }
  if (encodedAnchor !== undefined && encodedAnchor.length > 0) {
    const anchor = decodeSourceAnchor(encodedAnchor);
    if (
      anchor === undefined ||
      source.messageId === undefined ||
      anchor.messageId !== source.messageId ||
      anchor.sourceNodeId !== nodeId
    ) {
      return undefined;
    }
    source.anchor = anchor;
  }
  return source;
}

export class SourceLinkHandler {
  constructor(private readonly workspace: SourceWorkspacePort) {}

  async open(
    parameters: Record<string, string>
  ): Promise<"opened" | "missing"> {
    const source = sourceFromParameters(parameters);
    if (source === undefined) return "missing";
    return (await this.workspace.openActive(source)) ||
      (await this.workspace.openHistory(source))
      ? "opened"
      : "missing";
  }
}
