import { describe, expect, it } from "vitest";
import {
  SidebarWorkspaceCoordinator,
  TREETALK_WORKSPACE_VIEW_TYPE,
  type SidebarWorkspacePort
} from "../../src/views/sidebar-workspace-coordinator";

class FakeSidebarWorkspace implements SidebarWorkspacePort {
  readonly active = new Set<string>();
  readonly openedTypes: string[] = [];
  readonly detachedTypes: string[] = [];

  has(type: string): boolean {
    return this.active.has(type);
  }

  openRight(type: string): Promise<void> {
    this.active.add(type);
    this.openedTypes.push(type);
    return Promise.resolve();
  }

  detach(type: string): Promise<void> {
    this.active.delete(type);
    this.detachedTypes.push(type);
    return Promise.resolve();
  }
}

describe("SidebarWorkspaceCoordinator", () => {
  it("opens one TreeTalk view in the right sidebar", async () => {
    const workspace = new FakeSidebarWorkspace();
    const coordinator = new SidebarWorkspaceCoordinator(workspace);
    await coordinator.open();
    expect(workspace.openedTypes).toEqual([TREETALK_WORKSPACE_VIEW_TYPE]);
  });

  it("toggles the single workspace view", async () => {
    const workspace = new FakeSidebarWorkspace();
    const coordinator = new SidebarWorkspaceCoordinator(workspace);
    await coordinator.open();
    await coordinator.toggle();
    expect(workspace.has(TREETALK_WORKSPACE_VIEW_TYPE)).toBe(false);
  });

  it("removes restored legacy leaves before opening the new view", async () => {
    const workspace = new FakeSidebarWorkspace();
    workspace.active.add("treetalk-tree");
    workspace.active.add("treetalk-conversation");
    const coordinator = new SidebarWorkspaceCoordinator(workspace);
    await coordinator.repairLegacyViews();
    expect(workspace.detachedTypes).toEqual([
      "treetalk-tree",
      "treetalk-conversation"
    ]);
    expect(workspace.has(TREETALK_WORKSPACE_VIEW_TYPE)).toBe(true);
  });
});
