import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  Component: class {
    addChild(): void {}
    removeChild(): void {}
  },
  MarkdownRenderer: {
    render: vi.fn(() => Promise.resolve())
  },
  Plugin: class {
    onload(): void {}
  },
  PluginSettingTab: class {
    readonly mock = true;
  },
  ItemView: class {
    readonly mock = true;
  },
  Notice: class {
    readonly mock = true;
  },
  Setting: class {
    readonly mock = true;
  },
  TFile: class {
    readonly mock = true;
  },
  FuzzySuggestModal: class {
    readonly mock = true;
  },
  Modal: class {
    readonly contentEl = document.createElement("div");
    open(): void {}
    close(): void {}
  },
  setIcon: vi.fn(),
  normalizePath: (value: string) => value,
  requestUrl: vi.fn()
}));

import { COMMAND_IDS, PLUGIN_ID } from "../src/main";

describe("plugin manifest contract", () => {
  it("exports the treetalk plugin id", () => {
    expect(PLUGIN_ID).toBe("treetalk");
  });

  it("exposes tab commands without overriding Obsidian Ctrl+W", () => {
    expect(COMMAND_IDS).toEqual({
      close: "close-current-conversation-tab",
      new: "new-conversation-tab",
      next: "next-conversation-tab",
      previous: "previous-conversation-tab",
      toggleBranch: "toggle-current-branch",
      depositGraph: "open-deposit-relationship-graph"
    });
    expect(Object.values(COMMAND_IDS)).not.toContain("ctrl-w");
  });
});
