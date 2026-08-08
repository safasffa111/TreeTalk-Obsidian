// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  renderConversationSwitcher,
  type ConversationSwitcherActions
} from "../../src/views/conversation-switcher";
import {
  conversationTab,
  conversationTabsStore
} from "../helpers/tab-fixtures";

function actions(
  overrides: Partial<ConversationSwitcherActions> = {}
): ConversationSwitcherActions {
  return {
    create: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    reorder: vi.fn(),
    ...overrides
  };
}

describe("conversation tree switcher", () => {
  it("expands the ordered open conversations below the current space", () => {
    const container = document.createElement("div");
    renderConversationSwitcher(
      container,
      conversationTabsStore("one", "two"),
      actions()
    );
    const trigger = container.querySelector<HTMLButtonElement>(
      ".treetalk-space-trigger"
    );

    expect(trigger?.textContent).toContain("对话列表");
    expect(trigger?.textContent).not.toContain("one");
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    expect(trigger?.querySelector(".treetalk-node-dot")).toBeNull();
    expect(container.querySelector(".treetalk-space-list")).toBeNull();

    trigger?.click();

    expect(
      container
        .querySelector(".treetalk-space-trigger")
        ?.getAttribute("aria-expanded")
    ).toBe("true");
    expect(
      [...container.querySelectorAll("[data-conversation-id]")].map(
        (row) => row.getAttribute("data-conversation-id")
      )
    ).toEqual(["one", "two"]);
    expect(container.querySelector(".treetalk-space-create")).toBeTruthy();
  });

  it("switches conversation while keeping the space list expanded", () => {
    const container = document.createElement("div");
    const store = conversationTabsStore("one", "two");
    renderConversationSwitcher(container, store, actions());
    container.querySelector<HTMLButtonElement>(".treetalk-space-trigger")?.click();

    container
      .querySelector<HTMLButtonElement>(
        "[data-conversation-id='two'] .treetalk-space-select"
      )
      ?.click();

    expect(store.getSnapshot().activeTabId).toBe("two");
    expect(
      container
        .querySelector(".treetalk-space-trigger")
        ?.getAttribute("aria-expanded")
    ).toBe("true");
    expect(container.querySelector(".treetalk-space-list")).toBeTruthy();
  });

  it("closes a space without selecting it or collapsing the list", () => {
    const container = document.createElement("div");
    const store = conversationTabsStore("one", "two");
    const close = vi.fn((tabId: string) => {
      store.remove(tabId);
      return Promise.resolve();
    });
    renderConversationSwitcher(container, store, actions({ close }));
    container.querySelector<HTMLButtonElement>(".treetalk-space-trigger")?.click();

    container
      .querySelector<HTMLButtonElement>(
        "[data-conversation-id='two'] .treetalk-space-close"
      )
      ?.click();

    expect(close).toHaveBeenCalledWith("two");
    expect(store.getSnapshot().activeTabId).toBe("one");
    expect(container.querySelector(".treetalk-space-list")).toBeTruthy();
  });

  it("creates a conversation while keeping the list expanded", () => {
    const container = document.createElement("div");
    const store = conversationTabsStore("one");
    const create = vi.fn(() => {
      store.open(conversationTab("two"));
      return Promise.resolve();
    });
    renderConversationSwitcher(container, store, actions({ create }));
    container.querySelector<HTMLButtonElement>(".treetalk-space-trigger")?.click();

    container.querySelector<HTMLButtonElement>(".treetalk-space-create")?.click();

    expect(create).toHaveBeenCalledOnce();
    expect(store.getSnapshot().activeTabId).toBe("two");
    expect(container.querySelector(".treetalk-space-list")).toBeTruthy();
  });

  it("stays expanded after Escape and when focus leaves the switcher", () => {
    const container = document.createElement("div");
    const outside = document.createElement("button");
    document.body.append(container, outside);
    const cleanup = renderConversationSwitcher(
      container,
      conversationTabsStore("one", "two"),
      actions()
    );
    container.querySelector<HTMLButtonElement>(".treetalk-space-trigger")?.click();

    container.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
    );
    expect(container.querySelector(".treetalk-space-list")).toBeTruthy();
    outside.focus();
    expect(container.querySelector(".treetalk-space-list")).toBeTruthy();

    cleanup();
    container.remove();
    outside.remove();
  });

  it("reports drag reorder by the target space index", () => {
    const container = document.createElement("div");
    const reorder = vi.fn();
    renderConversationSwitcher(
      container,
      conversationTabsStore("one", "two"),
      actions({ reorder })
    );
    container.querySelector<HTMLButtonElement>(".treetalk-space-trigger")?.click();
    const first = container.querySelector<HTMLElement>(
      "[data-conversation-id='one']"
    );
    const second = container.querySelector<HTMLElement>(
      "[data-conversation-id='two']"
    );
    if (first === null || second === null) throw new Error("Spaces are missing");

    first.dispatchEvent(new Event("dragstart", { bubbles: true }));
    second.dispatchEvent(new Event("dragover", { bubbles: true }));
    second.dispatchEvent(new Event("drop", { bubbles: true }));

    expect(reorder).toHaveBeenCalledWith("one", 1);
  });

  it("shows unread state and disables closing while lifecycle work is active", () => {
    const container = document.createElement("div");
    const store = conversationTabsStore("one", "two");
    store.updateTab("two", (tab) => ({
      ...tab,
      unread: true,
      lifecycle: "closing"
    }));
    renderConversationSwitcher(container, store, actions());
    container.querySelector<HTMLButtonElement>(".treetalk-space-trigger")?.click();

    const row = container.querySelector<HTMLElement>(
      "[data-conversation-id='two']"
    );
    expect(row?.classList.contains("has-unread")).toBe(true);
    expect(
      row?.querySelector<HTMLButtonElement>(".treetalk-space-close")?.disabled
    ).toBe(true);
  });

  it("renders no virtual first row when no conversation is open", () => {
    const container = document.createElement("div");
    renderConversationSwitcher(container, conversationTabsStore(), actions());

    expect(container.querySelector(".treetalk-space-trigger")).toBeNull();
    expect(container.querySelector(".treetalk-space-list")).toBeNull();
  });

  it("uses the compact transparent visual contract of the node tree", () => {
    const css = readFileSync("styles.css", "utf8");
    const rule = (selector: string): string =>
      css.match(
        new RegExp(
          `${selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s*\\{([^}]*)\\}`,
          "su"
        )
      )?.[1] ?? "";

    expect(rule("button.treetalk-space-trigger")).toContain(
      "border: 0 !important"
    );
    expect(rule("button.treetalk-space-trigger")).toContain(
      "background: transparent !important"
    );
    expect(rule("button.treetalk-space-select")).toContain(
      "border: 0 !important"
    );
    expect(rule("button.treetalk-space-select")).toContain(
      "background: transparent !important"
    );
    expect(rule(".treetalk-space-row.is-active")).toContain(
      "var(--background-modifier-hover)"
    );
    expect(rule(".treetalk-space-label")).toContain("text-overflow: ellipsis");
    expect(rule(".treetalk-space-switcher")).toContain("padding: 4px 6px 0");
    expect(rule(".treetalk-tree-list")).toContain("padding: 4px 6px");
    expect(rule(".treetalk-space-direction")).toContain("width: 6px");
    expect(rule(".treetalk-space-direction")).toContain("flex: 0 0 6px");
    expect(css).not.toContain(".treetalk-tab-region");
    expect(css).not.toContain(".treetalk-tab-region-host");
  });
});
