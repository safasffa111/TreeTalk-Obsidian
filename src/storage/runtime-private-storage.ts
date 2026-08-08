import type { Vault } from "obsidian";
import { ObsidianPrivateStoragePort } from "./obsidian-private-storage-port";
import {
  privateConversationRoots,
  type ConversationRoots
} from "./private-paths";

export interface PrivateStorageRuntime {
  roots: ConversationRoots;
  port: ObsidianPrivateStoragePort;
}

export function createPrivateStorageRuntime(
  vault: Pick<Vault, "configDir" | "adapter">
): PrivateStorageRuntime {
  return {
    roots: privateConversationRoots(vault.configDir),
    port: new ObsidianPrivateStoragePort(vault.adapter)
  };
}
