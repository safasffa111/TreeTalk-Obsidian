import { parseConversation } from "./schema";
import type {
  BalancedFreezeArtifact,
  ConversationFile
} from "./types";
import type { ContextPlanPersistencePatch } from "./context-engine";

function artifactEquals(
  left: BalancedFreezeArtifact,
  right: BalancedFreezeArtifact
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function applyContextPlanPersistencePatch(
  conversation: ConversationFile,
  patch: ContextPlanPersistencePatch,
  now: string
): ConversationFile {
  const next = structuredClone(conversation);
  const balancedV3 = {
    ...(next.contextArtifacts?.balancedV3 ?? {})
  };
  for (const artifact of patch.artifacts) {
    const existing = balancedV3[artifact.key];
    if (existing !== undefined && !artifactEquals(existing, artifact)) {
      throw new Error(`Balanced context artifact conflict: ${artifact.key}`);
    }
    if (existing === undefined) balancedV3[artifact.key] = structuredClone(artifact);
  }

  let targetMessage:
    | ConversationFile["nodes"][string]["messages"][number]
    | undefined;
  let targetNode: ConversationFile["nodes"][string] | undefined;
  for (const node of Object.values(next.nodes)) {
    const message = node.messages.find(
      (entry) => entry.id === patch.currentUserMessageId && entry.role === "user"
    );
    if (message !== undefined) {
      targetMessage = message;
      targetNode = node;
      break;
    }
  }
  if (targetMessage === undefined || targetNode === undefined) {
    throw new Error(
      `Balanced context user message not found: ${patch.currentUserMessageId}`
    );
  }

  next.contextArtifacts = { balancedV3 };
  targetMessage.balancedContextState = structuredClone(patch.requestState);
  targetMessage.updatedAt = now;
  targetNode.updatedAt = now;
  next.updatedAt = now;
  next.revision += 1;
  return parseConversation(next);
}
