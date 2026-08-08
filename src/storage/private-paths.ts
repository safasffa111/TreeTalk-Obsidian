export interface ConversationRoots {
  root: string;
  active: string;
  history: string;
}

function normalizeDirectory(path: string): string {
  return path.replace(/\\/gu, "/").replace(/\/+$/u, "");
}

export function privateConversationRoots(configDir: string): ConversationRoots {
  const normalizedConfigDir = normalizeDirectory(configDir);
  const root = `${normalizedConfigDir}/treetalk-data`;
  return {
    root,
    active: `${root}/active`,
    history: `${root}/history`
  };
}

export function conversationFolder(root: string, conversationId: string): string {
  if (
    conversationId.length === 0 ||
    conversationId === "." ||
    conversationId === ".." ||
    conversationId.includes("/") ||
    conversationId.includes("\\")
  ) {
    throw new Error(`Invalid conversation id: ${conversationId}`);
  }
  return `${normalizeDirectory(root)}/${conversationId}`;
}
