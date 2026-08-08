// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("obsidian", () => ({
  Component: class {
    addChild(): void {}
    removeChild(): void {}
  },
  MarkdownRenderer: {
    render: vi.fn(() => Promise.resolve())
  },
  setIcon: vi.fn((element: HTMLElement, icon: string) => {
    element.dataset.icon = icon;
  }),
  ItemView: class {
    readonly app = {};
    readonly containerEl = document.createElement("div");
    readonly contentEl = document.createElement("div");
    constructor() {
      const header = document.createElement("div");
      header.className = "view-header";
      const actions = document.createElement("div");
      actions.className = "view-actions";
      header.append(actions);
      this.containerEl.append(header, this.contentEl);
    }
  }
}));

import { ConversationSessionStore } from "../../src/state/conversation-session-store";
import { ActiveConversationStore } from "../../src/tabs/active-conversation-store";
import { conversationTabsStore } from "../helpers/tab-fixtures";
import { TreeTalkWorkspaceView } from "../../src/views/obsidian-views";
import { TREETALK_WORKSPACE_VIEW_TYPE } from "../../src/views/sidebar-workspace-coordinator";
import { validConversation } from "../fixtures";

describe("TreeTalkWorkspaceView", () => {
  let view: TreeTalkWorkspaceView;

  beforeEach(() => {
    view = new TreeTalkWorkspaceView(
      {} as never,
      new ConversationSessionStore(validConversation()),
      { send: vi.fn(() => Promise.resolve()) }
    );
  });

  it("exposes one native sidebar icon", () => {
    expect(view.getViewType()).toBe(TREETALK_WORKSPACE_VIEW_TYPE);
    expect(view.getIcon()).toBe("messages-square");
    expect(view.getDisplayText()).toBe("TreeTalk");
  });

  it("mounts tree and conversation regions inside one view", async () => {
    await view.onOpen();
    expect(view.contentEl.classList.contains("treetalk-view-content")).toBe(true);
    expect(view.contentEl.querySelector(".treetalk-workspace-tree")).toBeTruthy();
    expect(
      view.contentEl.querySelector(".treetalk-workspace-conversation")
    ).toBeTruthy();
    const conversationMount = view.contentEl.querySelector(
      ".treetalk-conversation-mount"
    );
    expect(conversationMount).toBeTruthy();
    expect(
      conversationMount?.querySelector(":scope > .treetalk-conversation")
    ).toBeTruthy();
    expect(
      view.contentEl.querySelector(".treetalk-resizer")?.getAttribute("role")
    ).toBe("separator");
    await view.onClose();
    expect(view.contentEl.classList.contains("treetalk-view-content")).toBe(false);
  });

  it("passes its message renderer factory into the conversation panel", async () => {
    const conversation = validConversation();
    conversation.nodes.child?.messages.push({
      id: "answer",
      role: "assistant",
      content: "**native**",
      status: "complete",
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt
    });
    const render = vi.fn((markdown: string, element: HTMLElement) => {
      element.textContent = markdown;
      return Promise.resolve();
    });
    view = new TreeTalkWorkspaceView(
      {} as never,
      new ConversationSessionStore(conversation),
      { send: vi.fn(() => Promise.resolve()) },
      undefined,
      undefined,
      undefined,
      { create: () => ({ render, dispose: vi.fn() }) }
    );

    await view.onOpen();
    await vi.waitFor(() =>
      expect(render).toHaveBeenCalledWith(
        "**native**",
        expect.any(HTMLElement)
      )
    );
  });

  it("mounts the conversation switcher before the real node tree", async () => {
    const tabs = conversationTabsStore("one", "two");
    view = new TreeTalkWorkspaceView(
      {} as never,
      new ActiveConversationStore(tabs),
      { send: vi.fn(() => Promise.resolve()) },
      undefined,
      tabs,
      {
        create: vi.fn(() => Promise.resolve()),
        close: vi.fn(() => Promise.resolve()),
        reorder: vi.fn()
      }
    );

    await view.onOpen();

    const tree = view.contentEl.querySelector(".treetalk-workspace-tree");
    const switcher = tree?.querySelector(
      ":scope > .treetalk-space-switcher"
    );
    const nodeTree = tree?.querySelector(":scope > .treetalk-tree");
    expect(switcher).toBeTruthy();
    expect(nodeTree).toBeTruthy();
    if (
      switcher === null ||
      switcher === undefined ||
      nodeTree === null ||
      nodeTree === undefined
    ) {
      throw new Error("Tree mounts are missing");
    }
    expect(
      switcher.compareDocumentPosition(nodeTree) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      view.containerEl.querySelector(".treetalk-tab-region-host")
    ).toBeNull();
    expect(
      view.containerEl.querySelector("[role='tablist']")
    ).toBeNull();
    expect(
      view.contentEl.querySelector(".treetalk-workspace-conversation")
        ?.firstElementChild?.className
    ).toBe("treetalk-conversation-mount");

    await view.onClose();
    expect(
      view.containerEl.querySelector(".treetalk-space-switcher")
    ).toBeNull();
  });

  it("keeps the switcher out of a hidden native view header", async () => {
    const tabs = conversationTabsStore("one");
    view = new TreeTalkWorkspaceView(
      {} as never,
      new ActiveConversationStore(tabs),
      { send: vi.fn(() => Promise.resolve()) },
      undefined,
      tabs,
      {
        create: vi.fn(() => Promise.resolve()),
        close: vi.fn(() => Promise.resolve()),
        reorder: vi.fn()
      }
    );
    const header = view.containerEl.querySelector<HTMLElement>(".view-header");
    if (header === null) throw new Error("Local view header is missing");
    header.style.display = "none";

    await view.onOpen();

    expect(header.querySelector(".treetalk-space-switcher")).toBeNull();
    expect(
      view.contentEl.querySelector(
        ".treetalk-workspace-tree > .treetalk-space-switcher"
      )
    ).toBeTruthy();
  });

  it("uses a one pixel separator and fills the scoped view", () => {
    const css = readFileSync("styles.css", "utf8");
    expect(css).toMatch(
      /grid-template-columns:\s*var\(--treetalk-tree-width\)\s+1px\s+minmax\(0,\s*1fr\)/u
    );
    expect(css).toMatch(/\.treetalk-view-content\s*\{[^}]*padding:\s*0;/su);
    expect(css).toMatch(/\.treetalk-resizer\s*\{[^}]*height:\s*100%;/su);
    expect(css).toMatch(
      /\.treetalk-resizer::before\s*\{[^}]*background:\s*transparent;/su
    );
    expect(css).toMatch(
      /\.treetalk-workspace-tree\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;/su
    );
    expect(css).toMatch(
      /\.treetalk-workspace-tree\s*>\s*\.treetalk-tree\s*\{[^}]*overflow:\s*auto;/su
    );
  });
});
