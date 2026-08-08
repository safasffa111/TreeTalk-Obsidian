import { describe, expect, it, vi } from "vitest";
import { LifecycleQueue } from "../../src/archive/lifecycle-queue";
import { TabLifecycleController } from "../../src/tabs/tab-lifecycle-controller";
import { conversationTab } from "../helpers/tab-fixtures";
import {
  ACTIVE_FOLDER,
  FakeArchiveLifecycle,
  FakeTabPersistence,
  HISTORY_FOLDER
} from "../helpers/tab-lifecycle-fixtures";
import { ConversationTabsStore } from "../../src/tabs/conversation-tabs-store";

function setup(mode: "active" | "archived" = "active") {
  const tabsStore = new ConversationTabsStore();
  const tab = conversationTab("one", "One", mode);
  tab.folder = mode === "active" ? ACTIVE_FOLDER : HISTORY_FOLDER;
  tabsStore.open(tab);
  const archive = new FakeArchiveLifecycle();
  const persistence = new FakeTabPersistence();
  const saveWorkspace = vi.fn(() => Promise.resolve());
  const controller = new TabLifecycleController(
    tabsStore,
    persistence,
    archive,
    new LifecycleQueue(),
    saveWorkspace
  );
  return {
    archive,
    controller,
    persistence,
    saveWorkspace,
    tabsStore
  };
}

describe("TabLifecycleController", () => {
  it("archives an active tab before removing it", async () => {
    const { archive, controller, persistence, tabsStore } = setup();

    const closing = controller.close("one");
    expect(tabsStore.getTab("one")?.lifecycle).toBe("closing");
    await closing;

    expect(persistence.flushed).toEqual([ACTIVE_FOLDER]);
    expect(archive.archivedFolders).toEqual([ACTIVE_FOLDER]);
    expect(tabsStore.getTab("one")).toBeUndefined();
  });

  it("keeps the tab open when saving fails", async () => {
    const { archive, controller, persistence, tabsStore } = setup();
    persistence.failFlush(new Error("save is blocked"));

    await expect(controller.close("one")).rejects.toThrow("save is blocked");

    expect(archive.archivedFolders).toEqual([]);
    expect(tabsStore.getTab("one")).toMatchObject({
      lifecycle: "idle",
      mode: "active"
    });
  });

  it("keeps the tab open when archive fails", async () => {
    const { archive, controller, tabsStore } = setup();
    archive.failArchive(new Error("destination exists"));

    await expect(controller.close("one")).rejects.toThrow("destination exists");

    expect(tabsStore.getTab("one")).toMatchObject({
      lifecycle: "idle",
      mode: "active"
    });
  });

  it("dismisses an archived tab without moving files", async () => {
    const { archive, controller, persistence, tabsStore } = setup("archived");

    await controller.close("one");

    expect(archive.archivedFolders).toEqual([]);
    expect(persistence.flushed).toEqual([]);
    expect(tabsStore.getTab("one")).toBeUndefined();
  });

  it("restores a historical tab in place", async () => {
    const {
      controller,
      persistence,
      saveWorkspace,
      tabsStore
    } = setup("archived");

    await controller.restore("one");

    expect(tabsStore.getTab("one")).toMatchObject({
      mode: "active",
      lifecycle: "idle",
      folder: ACTIVE_FOLDER
    });
    expect(persistence.renames).toContainEqual([
      HISTORY_FOLDER,
      ACTIVE_FOLDER
    ]);
    expect(saveWorkspace).toHaveBeenCalled();
  });

  it("leaves a failed restore read-only", async () => {
    const { archive, controller, tabsStore } = setup("archived");
    archive.failRestore(new Error("active destination exists"));

    await expect(controller.restore("one")).rejects.toThrow(
      "active destination exists"
    );

    expect(tabsStore.getTab("one")).toMatchObject({
      mode: "archived",
      lifecycle: "idle",
      folder: HISTORY_FOLDER
    });
  });
});
