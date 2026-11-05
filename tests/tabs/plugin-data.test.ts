import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  parsePluginData
} from "../../src/tabs/plugin-data";

describe("TreeTalk plugin data", () => {
  it("migrates old flat settings and starts with an empty tab workspace", () => {
    const data = parsePluginData({
      provider: "anthropic",
      model: "claude-test",
      baseUrl: "https://example.test",
      treeWidth: 280
    });
    expect(data.settings).toMatchObject({
      executionMode: "pi",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      baseUrl: "https://example.test",
      treeWidth: 280,
      knowledgeFolder: "TreeTalk 知识",
      treeCaptureFolder: "TreeTalk",
      obsidianMarkdownCompatibility: true,
      contextOptimizationEnabled: false,
      contextMode: "full",
      webSearchEnabled: false
    });
    expect(data.tabs).toEqual({
      schemaVersion: 1,
      activeConversationId: null,
      openConversationIds: []
    });
  });

  it("preserves valid nested settings and workspace order", () => {
    const data = parsePluginData({
      settings: {
        ...DEFAULT_SETTINGS,
        treeWidth: 260
      },
      tabs: {
        schemaVersion: 1,
        activeConversationId: "two",
        openConversationIds: ["one", "two"]
      }
    });

    expect(data.settings.treeWidth).toBe(260);
    expect(data.tabs.openConversationIds).toEqual(["one", "two"]);
    expect(data.tabs.activeConversationId).toBe("two");
  });

  it("preserves an explicit disabled Markdown compatibility setting", () => {
    const data = parsePluginData({
      settings: {
        ...DEFAULT_SETTINGS,
        obsidianMarkdownCompatibility: false
      }
    });

    expect(data.settings.obsidianMarkdownCompatibility).toBe(false);
  });

  it("normalizes the legacy optimization toggle and context mode to full", () => {
    const balanced = parsePluginData({
      settings: {
        ...DEFAULT_SETTINGS,
        contextOptimizationEnabled: true,
        contextMode: "full"
      }
    });
    const full = parsePluginData({
      settings: {
        ...DEFAULT_SETTINGS,
        contextOptimizationEnabled: false,
        contextMode: "balanced"
      }
    });

    expect(balanced.settings.contextMode).toBe("full");
    expect(balanced.settings.contextOptimizationEnabled).toBe(false);
    expect(full.settings.contextMode).toBe("full");
    expect(full.settings.contextOptimizationEnabled).toBe(false);
  });

  it("migrates legacy DeepSeek model names and preserves the web-search toggle", () => {
    const data = parsePluginData({
      settings: {
        ...DEFAULT_SETTINGS,
        provider: "deepseek",
        model: "deepseek-reasoner",
        webSearchEnabled: true
      }
    });

    expect(data.settings.model).toBe("deepseek-v4-flash");
    expect(data.settings.webSearchEnabled).toBe(true);
  });

  it("defaults the optional default prompt to empty and enabled", () => {
    const data = parsePluginData({ provider: "deepseek" });

    expect(data.settings.defaultPrompt).toBe("");
    expect(data.settings.defaultPromptEnabled).toBe(true);
    expect(DEFAULT_SETTINGS.defaultPrompt).toBe("");
  });

  it("preserves a configured default prompt and its toggle", () => {
    const data = parsePluginData({
      settings: {
        ...DEFAULT_SETTINGS,
        defaultPrompt: "请用中文回答",
        defaultPromptEnabled: false
      }
    });

    expect(data.settings.defaultPrompt).toBe("请用中文回答");
    expect(data.settings.defaultPromptEnabled).toBe(false);
  });

  it("starts with the conversation list collapsed and keeps an explicit choice", () => {
    expect(parsePluginData({ provider: "deepseek" }).settings.treePanelCollapsed).toBe(
      true
    );
    expect(DEFAULT_SETTINGS.treePanelCollapsed).toBe(true);
    expect(
      parsePluginData({
        settings: { ...DEFAULT_SETTINGS, treePanelCollapsed: false }
      }).settings.treePanelCollapsed
    ).toBe(false);
  });

  it("recovers from corrupt workspace data without discarding settings", () => {
    const data = parsePluginData({
      settings: {
        provider: "openai",
        model: "gpt-test",
        baseUrl: "",
        treeWidth: 240,
        knowledgeFolder: "TreeTalk 知识",
        obsidianMarkdownCompatibility: true
      },
      tabs: {
        schemaVersion: 1,
        activeConversationId: "one",
        openConversationIds: ["one", "one"]
      }
    });

    expect(data.settings.model).toBe("deepseek-v4-flash");
    expect(data.tabs.openConversationIds).toEqual([]);
  });
});
