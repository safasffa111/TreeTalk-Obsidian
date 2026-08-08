import type { ChatMessage, ConversationFile, ConversationNode } from "./types";

export interface ContextLimits {
  systemPrompt: string;
  maxCharacters: number;
}

export interface ProviderMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface WeightedMessage extends ProviderMessage {
  protected: boolean;
}

function requiredNode(conversation: ConversationFile, nodeId: string): ConversationNode {
  const node = conversation.nodes[nodeId];
  if (node === undefined) {
    throw new Error(`Node not found: ${nodeId}`);
  }
  return node;
}

function pathToNode(conversation: ConversationFile, nodeId: string): ConversationNode[] {
  const reversed: ConversationNode[] = [];
  const seen = new Set<string>();
  let current: ConversationNode | undefined = requiredNode(conversation, nodeId);
  while (current !== undefined) {
    if (seen.has(current.id)) {
      throw new Error("Conversation path contains a cycle");
    }
    seen.add(current.id);
    reversed.push(current);
    current = current.parentId === null ? undefined : requiredNode(conversation, current.parentId);
  }
  return reversed.reverse();
}

function providerContent(message: ChatMessage): string {
  const contexts = message.selectionContexts ?? [];
  if (contexts.length === 0) return message.content;
  const rendered = contexts
    .map((context, index) =>
      [
        `[TreeTalk 引用上下文 ${String(index + 1)}]`,
        "以下内容仅作为回答参考：",
        "---",
        context.quote,
        "---",
        "[引用上下文结束]"
      ].join("\n")
    )
    .join("\n\n");
  return `${rendered}\n\n[当前问题]\n${message.content}`;
}

export function buildProviderContext(
  conversation: ConversationFile,
  nodeId: string,
  limits: ContextLimits
): ProviderMessage[] {
  if (!Number.isFinite(limits.maxCharacters) || limits.maxCharacters <= 0) {
    throw new Error("maxCharacters must be positive");
  }
  const path = pathToNode(conversation, nodeId);
  const weighted: WeightedMessage[] = [];
  if (limits.systemPrompt.length > 0) {
    weighted.push({ role: "system", content: limits.systemPrompt, protected: true });
  }
  for (const [nodeIndex, node] of path.entries()) {
    const isCurrent = nodeIndex === path.length - 1;
    for (const [messageIndex, message] of node.messages.entries()) {
      weighted.push({
        role: message.role,
        content: providerContent(message),
        protected:
          (message.selectionContexts?.length ?? 0) > 0 ||
          (isCurrent && messageIndex === node.messages.length - 1)
      });
    }
  }

  const size = (): number => weighted.reduce((total, entry) => total + entry.content.length, 0);
  while (size() > limits.maxCharacters) {
    const removableIndex = weighted.findIndex(
      (entry, index) => !entry.protected && entry.role !== "system" && index < weighted.length - 1
    );
    if (removableIndex < 0) break;
    weighted.splice(removableIndex, 1);
  }
  return weighted.map(({ role, content }) => ({ role, content }));
}
