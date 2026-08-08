// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { SourceHighlightStore } from "../../src/navigation/source-highlight-store";
import { ConversationSessionStore } from "../../src/state/conversation-session-store";
import type { ConversationStorePort } from "../../src/tabs/active-conversation-store";
import { renderTreePanel } from "../../src/views/tree-view";
import { validConversation } from "../fixtures";

describe("tree panel", () => {
  it("renders an empty tree when no conversation tab is open", () => {
    const store: ConversationStorePort = {
      getSnapshot: () => undefined,
      subscribe: () => () => undefined,
      update: () => {
        throw new Error("not available");
      },
      selectNode: () => {
        throw new Error("not available");
      }
    };
    const container = document.createElement("div");

    renderTreePanel(container, store);

    expect(container.querySelectorAll(".treetalk-tree-row")).toHaveLength(0);
  });

  it("renders dots and indentation without duplicate headings or connector glyphs", () => {
    const container = document.createElement("div");
    const store = new ConversationSessionStore(validConversation());
    const cleanup = renderTreePanel(container, store);
    expect(container.querySelectorAll(".treetalk-node-dot")).toHaveLength(2);
    expect(container.querySelector('[data-depth="1"]')).toBeTruthy();
    expect(container.textContent).not.toMatch(/[├└│]/u);
    expect(container.querySelector(".treetalk-tree-title")).toBeNull();
    cleanup();
  });

  it("switches the active node when a row is clicked", () => {
    const container = document.createElement("div");
    const store = new ConversationSessionStore(validConversation());
    renderTreePanel(container, store);
    container.querySelector<HTMLElement>('[data-node-id="root"]')?.click();
    expect(store.getSnapshot().currentNodeId).toBe("root");
  });

  it("uses a compact borderless left-aligned visual contract", () => {
    const css = readFileSync("styles.css", "utf8");
    expect(css).toContain(".treetalk-workspace {");
    expect(css).toMatch(/button\.treetalk-tree-row\s*\{[^}]*min-height:\s*28px;/su);
    expect(css).toMatch(/button\.treetalk-tree-row\s*\{[^}]*border:\s*0 !important;/su);
    expect(css).toMatch(
      /button\.treetalk-tree-row\s*\{[^}]*box-shadow:\s*none !important;/su
    );
    expect(css).toMatch(/button\.treetalk-tree-row\s*\{[^}]*text-align:\s*left;/su);
    const resetRule = css.match(/button\.treetalk-tree-row\s*\{([^}]*)\}/su)?.[1];
    const activeRule = css.match(
      /button\.treetalk-tree-row\.is-active\s*\{([^}]*)\}/su
    )?.[1];
    const hoverRule = css.match(/button\.treetalk-tree-row:hover\s*\{([^}]*)\}/su)?.[1];
    expect(resetRule).toContain("background: transparent !important");
    expect(resetRule).toContain("border: 0 !important");
    expect(resetRule).toContain("box-shadow: none !important");
    expect(resetRule).toContain("outline: 0 !important");
    expect(hoverRule).toContain("background: transparent !important");
    expect(activeRule).toContain("var(--background-modifier-hover)");
    expect(activeRule).toContain("!important");
  });
  it("scrolls to and flashes a source node published after navigation", () => {
    const container = document.createElement("div");
    const store = new ConversationSessionStore(validConversation());
    const highlights = new SourceHighlightStore();
    renderTreePanel(container, store, highlights);
    const row = container.querySelector<HTMLElement>(
      '[data-node-id="child"]'
    );
    if (row === null) throw new Error("Target tree row is missing");
    const scrollIntoView = vi.fn();
    row.scrollIntoView = scrollIntoView;

    highlights.publish({
      conversationId: "conversation-1",
      nodeId: "child"
    });

    expect(row.classList.contains("treetalk-source-node-flash")).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  });

});
