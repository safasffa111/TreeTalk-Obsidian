import type { Workspace, WorkspaceLeaf } from "obsidian";

export const TREETALK_WORKSPACE_VIEW_TYPE = "treetalk-workspace";
const LEGACY_VIEW_TYPES = ["treetalk-tree", "treetalk-conversation"] as const;

export interface SidebarWorkspacePort {
  has(type: string): boolean;
  openRight(type: string): Promise<void>;
  detach(type: string): Promise<void>;
}

export class SidebarWorkspaceCoordinator {
  constructor(private readonly workspace: SidebarWorkspacePort) {}

  async open(): Promise<void> {
    if (!this.workspace.has(TREETALK_WORKSPACE_VIEW_TYPE)) {
      await this.workspace.openRight(TREETALK_WORKSPACE_VIEW_TYPE);
    }
  }

  async close(): Promise<void> {
    await this.workspace.detach(TREETALK_WORKSPACE_VIEW_TYPE);
  }

  async toggle(): Promise<void> {
    if (this.workspace.has(TREETALK_WORKSPACE_VIEW_TYPE)) {
      await this.close();
    } else {
      await this.open();
    }
  }

  async repairLegacyViews(): Promise<void> {
    let foundLegacy = false;
    for (const type of LEGACY_VIEW_TYPES) {
      if (this.workspace.has(type)) {
        foundLegacy = true;
        await this.workspace.detach(type);
      }
    }
    if (foundLegacy) await this.open();
  }
}

export class ObsidianSidebarWorkspacePort implements SidebarWorkspacePort {
  constructor(private readonly workspace: Workspace) {}

  has(type: string): boolean {
    return this.workspace.getLeavesOfType(type).length > 0;
  }

  async openRight(type: string): Promise<void> {
    const leaf: WorkspaceLeaf | null =
      this.workspace.getRightLeaf(false) ?? this.workspace.getRightLeaf(true);
    if (leaf === null) throw new Error("无法创建 TreeTalk 右侧栏");
    await leaf.setViewState({ type, active: true });
    await this.workspace.revealLeaf(leaf);
  }

  detach(type: string): Promise<void> {
    this.workspace.detachLeavesOfType(type);
    return Promise.resolve();
  }
}
