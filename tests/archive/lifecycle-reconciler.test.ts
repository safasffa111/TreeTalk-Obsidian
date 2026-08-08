import { describe, expect, it } from "vitest";
import { LifecycleReconciler } from "../../src/archive/lifecycle-reconciler";
import { checksumConversation } from "../../src/storage/checksum";
import { ConversationRepository } from "../../src/storage/conversation-repository";
import { privateConversationRoots } from "../../src/storage/private-paths";
import { validConversation } from "../fixtures";
import { FakeVault } from "../storage/fake-vault";

const ROOTS = privateConversationRoots(".obsidian");
const ACTIVE_FOLDER = `${ROOTS.active}/active`;
const HISTORY_FOLDER = `${ROOTS.history}/history`;

describe("LifecycleReconciler", () => {
  it("repairs status mismatches from interrupted moves and backup recovery", async () => {
    const misplacedActive = structuredClone(validConversation());
    misplacedActive.status = "archived";
    misplacedActive.revision = 2;
    misplacedActive.checksum = await checksumConversation(misplacedActive);
    const historyBackup = structuredClone(validConversation());
    historyBackup.id = "history";
    historyBackup.status = "active";
    historyBackup.revision = 3;
    historyBackup.checksum = await checksumConversation(historyBackup);
    const vault = new FakeVault({
      [`${ACTIVE_FOLDER}/tree.json`]: JSON.stringify(misplacedActive),
      [`${HISTORY_FOLDER}/tree.json`]: "{broken",
      [`${HISTORY_FOLDER}/tree.backup.json`]: JSON.stringify(historyBackup)
    });
    const repository = new ConversationRepository(vault);

    await new LifecycleReconciler(repository, vault, ROOTS).reconcile();

    expect((await repository.load(ACTIVE_FOLDER)).conversation.status).toBe("active");
    expect((await repository.load(HISTORY_FOLDER)).conversation.status).toBe("archived");
  });
});
