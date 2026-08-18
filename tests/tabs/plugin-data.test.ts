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
      provider: "anthropic",
      model: "claude-test",
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

  it("parses provider profiles and defaults missing profiles to empty state", () => {
    const data = parsePluginData({ settings: { ...DEFAULT_SETTINGS } });
    expect(data.settings.providerProfiles).toEqual({ activeProfileId: null, profiles: [] });
    const withProfiles = parsePluginData({ settings: {
      ...DEFAULT_SETTINGS,
      providerProfiles: {
        activeProfileId: "two",
        profiles: [{ id: "one", label: "One", provider: "deepseek", model: "a", baseUrl: "" }, { id: "two", label: "Two", provider: "minimax", model: "b", baseUrl: "" }]
      }
    }});
    expect(withProfiles.settings.providerProfiles?.profiles).toHaveLength(2);
    expect(withProfiles.settings.providerProfiles?.activeProfileId).toBe("two");
  });

  it("preserves a configured DeepSeek model and the web-search toggle", () => {
    const data = parsePluginData({
      settings: {
        ...DEFAULT_SETTINGS,
        provider: "deepseek",
        model: "deepseek-reasoner",
        webSearchEnabled: true
      }
    });

    expect(data.settings.provider).toBe("deepseek");
    expect(data.settings.model).toBe("deepseek-reasoner");
    expect(data.settings.webSearchEnabled).toBe(true);
  });

  it("resolves a provider alias to its canonical key", () => {
    const data = parsePluginData({
      settings: {
        ...DEFAULT_SETTINGS,
        provider: "glm",
        model: "glm-4.6"
      }
    });

    expect(data.settings.provider).toBe("zhipu");
    expect(data.settings.model).toBe("glm-4.6");
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

    expect(data.settings.provider).toBe("openai");
    expect(data.settings.model).toBe("gpt-test");
    expect(data.tabs.openConversationIds).toEqual([]);
  });
});
