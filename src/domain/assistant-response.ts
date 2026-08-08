import { parseConversation } from "./schema";
import type { AgentRunRecord } from "./agent-run";
import type { ChatMessage, ConversationFile } from "./types";

export interface AssistantResponseInput {
  conversationId: string;
  nodeId: string;
  messageId: string;
  content: string;
  modelId: string;
  providerProfileId?: string;
  referencedNoteNames?: string[];
  now: string;
}

export interface StartAssistantResponseInput {
  conversationId: string;
  nodeId: string;
  messageId: string;
  modelId: string;
  providerProfileId?: string;
  now: string;
  agentRun?: AgentRunRecord;
}

export interface AssistantDeltaInput {
  conversationId: string;
  nodeId: string;
  messageId: string;
  delta: string;
  now: string;
}

export interface FinishAssistantResponseInput {
  conversationId: string;
  nodeId: string;
  messageId: string;
  status: "complete" | "interrupted" | "failed";
  now: string;
  finalContent?: string;
  referencedNoteNames?: string[];
  agentRun?: AgentRunRecord;
}

export interface UpdateAssistantAgentRunInput {
  conversationId: string;
  nodeId: string;
  messageId: string;
  agentRun: AgentRunRecord;
  now: string;
}

export interface RestartAssistantResponseInput {
  conversationId: string;
  nodeId: string;
  messageId: string;
  now: string;
}

function mutableNode(
  conversation: ConversationFile,
  conversationId: string,
  nodeId: string
): {
  next: ConversationFile;
  node: ConversationFile["nodes"][string];
} {
  if (
    conversation.status !== "active" ||
    conversation.id !== conversationId
  ) {
    throw new Error("Conversation is no longer active");
  }
  const next = structuredClone(conversation);
  const node = next.nodes[nodeId];
  if (node === undefined) {
    throw new Error(`Conversation node no longer exists: ${nodeId}`);
  }
  return { next, node };
}

function commit(
  conversation: ConversationFile,
  nodeId: string,
  now: string
): ConversationFile {
  const node = conversation.nodes[nodeId];
  if (node === undefined) throw new Error(`Conversation node no longer exists: ${nodeId}`);
  node.updatedAt = now;
  conversation.updatedAt = now;
  conversation.revision += 1;
  return parseConversation(conversation);
}

export function startAssistantResponse(
  conversation: ConversationFile,
  input: StartAssistantResponseInput
): ConversationFile {
  const { next, node } = mutableNode(
    conversation,
    input.conversationId,
    input.nodeId
  );
  if (node.messages.some((message) => message.id === input.messageId)) {
    throw new Error(`Assistant message already exists: ${input.messageId}`);
  }
  const message: ChatMessage = {
    id: input.messageId,
    role: "assistant",
    content: "",
    status: "streaming",
    modelId: input.modelId,
    createdAt: input.now,
    updatedAt: input.now
  };
  if (input.providerProfileId !== undefined) {
    message.providerProfileId = input.providerProfileId;
  }
  if (input.agentRun !== undefined) {
    message.agentRun = structuredClone(input.agentRun);
  }
  node.messages.push(message);
  return commit(next, input.nodeId, input.now);
}

export function appendAssistantDelta(
  conversation: ConversationFile,
  input: AssistantDeltaInput
): ConversationFile {
  const { next, node } = mutableNode(
    conversation,
    input.conversationId,
    input.nodeId
  );
  const message = node.messages.find((entry) => entry.id === input.messageId);
  if (message === undefined || message.status !== "streaming") {
    throw new Error("Streaming assistant message is unavailable");
  }
  message.content += input.delta;
  message.updatedAt = input.now;
  return commit(next, input.nodeId, input.now);
}

export function finishAssistantResponse(
  conversation: ConversationFile,
  input: FinishAssistantResponseInput
): ConversationFile {
  const { next, node } = mutableNode(
    conversation,
    input.conversationId,
    input.nodeId
  );
  const message = node.messages.find((entry) => entry.id === input.messageId);
  if (message === undefined || message.status !== "streaming") {
    throw new Error("Streaming assistant message is unavailable");
  }
  if (input.finalContent !== undefined) message.content = input.finalContent;
  if (input.agentRun !== undefined) message.agentRun = structuredClone(input.agentRun);
  message.status = input.status;
  if (input.status === "complete") {
    message.referencedNoteNames = [...(input.referencedNoteNames ?? [])];
  } else {
    delete message.referencedNoteNames;
  }
  message.updatedAt = input.now;
  return commit(next, input.nodeId, input.now);
}

/**
 * Resets a failed or interrupted assistant message back to an empty streaming
 * message so the same bubble can be retried in place.
 */
export function restartAssistantResponse(
  conversation: ConversationFile,
  input: RestartAssistantResponseInput
): ConversationFile {
  const { next, node } = mutableNode(
    conversation,
    input.conversationId,
    input.nodeId
  );
  const message = node.messages.find((entry) => entry.id === input.messageId);
  if (message === undefined || message.role !== "assistant") {
    throw new Error("Assistant message is unavailable");
  }
  if (message.status !== "failed" && message.status !== "interrupted") {
    throw new Error("Only failed or interrupted assistant messages can be retried");
  }
  message.content = "";
  message.status = "streaming";
  delete message.referencedNoteNames;
  delete message.agentRun;
  message.updatedAt = input.now;
  return commit(next, input.nodeId, input.now);
}

export function updateAssistantAgentRun(
  conversation: ConversationFile,
  input: UpdateAssistantAgentRunInput
): ConversationFile {
  const { next, node } = mutableNode(
    conversation,
    input.conversationId,
    input.nodeId
  );
  const message = node.messages.find((entry) => entry.id === input.messageId);
  if (message === undefined || message.role !== "assistant") {
    throw new Error("Assistant message is unavailable");
  }
  message.agentRun = structuredClone(input.agentRun);
  message.updatedAt = input.now;
  return commit(next, input.nodeId, input.now);
}

export function appendAssistantResponse(
  conversation: ConversationFile,
  input: AssistantResponseInput
): ConversationFile {
  if (
    conversation.status !== "active" ||
    conversation.id !== input.conversationId
  ) {
    throw new Error("Conversation is no longer active");
  }
  const next = structuredClone(conversation);
  const node = next.nodes[input.nodeId];
  if (node === undefined) {
    throw new Error(`Conversation node no longer exists: ${input.nodeId}`);
  }
  const message: ChatMessage = {
    id: input.messageId,
    role: "assistant",
    content: input.content,
    status: "complete",
    modelId: input.modelId,
    createdAt: input.now,
    updatedAt: input.now
  };
  if (input.providerProfileId !== undefined) {
    message.providerProfileId = input.providerProfileId;
  }
  message.referencedNoteNames = [...(input.referencedNoteNames ?? [])];
  node.messages.push(message);
  node.updatedAt = input.now;
  next.updatedAt = input.now;
  next.revision += 1;
  return parseConversation(next);
}
