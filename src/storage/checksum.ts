import type { ConversationFile } from "../domain/types";

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalize(entry)).join(",")}]`;
  }

  const source = value as Record<string, unknown>;
  const entries = Object.keys(source)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(source[key])}`);
  return `{${entries.join(",")}}`;
}

function checksumPayload(conversation: ConversationFile): string {
  return canonicalize({
    ...conversation,
    checksum: ""
  });
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function checksumConversation(conversation: ConversationFile): Promise<string> {
  return sha256(checksumPayload(conversation));
}

export async function verifyConversationChecksum(
  conversation: ConversationFile
): Promise<boolean> {
  return conversation.checksum === (await checksumConversation(conversation));
}
