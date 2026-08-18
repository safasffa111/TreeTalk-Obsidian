import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TreeTalkSettingTab,
  type TreeTalkSettingsPort
} from "../../src/settings-tab";
import { DEFAULT_SETTINGS, type TreeTalkSettings } from "../../src/tabs/plugin-data";
import type { ProviderProfileConfig } from "../../src/providers/provider-profiles";

interface RecordedSecret {
  id: string;
  value: string;
}

class FakeSettingsPort implements TreeTalkSettingsPort {
  settings: TreeTalkSettings;
  apiKey = "";
  secrets: RecordedSecret[] = [];
  webSearchListeners = new Set<() => void>();
  composerListeners = new Set<() => void>();

  constructor(settings: TreeTalkSettings) {
    this.settings = settings;
  }

  getSettings(): TreeTalkSettings {
    return this.settings;
  }

  async updateSettings(next: TreeTalkSettings): Promise<void> {
    this.settings = next;
  }

  getApiKey(): string {
    return this.apiKey;
  }

  setApiKey(value: string): void {
    this.apiKey = value;
  }

  clearProfileSecret(profileId: string): void {
    this.secrets.push({ id: `treetalk-key-${profileId}`, value: "" });
  }

  subscribeWebSearch(listener: () => void): () => void {
    this.webSearchListeners.add(listener);
    return () => this.webSearchListeners.delete(listener);
  }

  subscribeComposerControls(listener: () => void): () => void {
    this.composerListeners.add(listener);
    return () => this.composerListeners.delete(listener);
  }
}

function buildProfile(overrides: Partial<ProviderProfileConfig>): ProviderProfileConfig {
  return {
    id: "alpha",
    label: "Alpha",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    baseUrl: "",
    ...overrides
  };
}

function settingsWith(
  activeProfileId: string | null,
  profiles: ProviderProfileConfig[]
): TreeTalkSettings {
  return {
    ...DEFAULT_SETTINGS,
    providerProfiles: { activeProfileId, profiles }
  };
}

interface GroupLike {
  type: string;
  heading?: string;
  items?: Array<{ name: string; desc?: string; control?: unknown; render?: (setting: unknown) => void }>;
}

function findGroup(definitions: unknown[], heading: string): GroupLike {
  const match = (definitions as GroupLike[]).find((entry) => entry.type === "group" && entry.heading === heading);
  if (match === undefined) throw new Error(`group "${heading}" not found`);
  return match;
}

function findItem(group: GroupLike, name: string): NonNullable<GroupLike["items"]>[number] {
  const item = (group.items ?? []).find((entry) => entry.name === name);
  if (item === undefined) throw new Error(`item "${name}" not found`);
  return item;
}

/**
 * Build a stand-in for the Obsidian `PluginSettingTab` constructor so we can
 * exercise settings-tab logic without booting the real Obsidian runtime. The
 * constructor in `settings-tab.ts` calls `super(app, plugin)` and then sets
 * up subscribers; both are no-ops for our purposes.
 */
function makeTab(port: TreeTalkSettingsPort): TreeTalkSettingTab {
  const fakeApp = { secretStorage: { setSecret: () => undefined } } as never;
  // The settings tab reads `this.plugin.getSettings()` etc., so the object
  // we hand it must satisfy TreeTalkSettingsPort directly.
  const fakePlugin = port as unknown as { app: typeof fakeApp };
  fakePlugin.app = fakeApp;
  // Bypass PluginSettingTab's constructor entirely by using Object.create on
  // the prototype. We then manually wire the fields the production code
  // touches: `update` and the two unsubscribers (captured by the ctor).
  const tab = Object.create(TreeTalkSettingTab.prototype) as Record<string, unknown>;
  tab.app = fakeApp;
  tab.plugin = fakePlugin;
  tab.containerEl = { empty: () => undefined } as never;
  // Obsidian's PluginSettingTab.update() is defined as an instance method on
  // the parent prototype; tests override it via vi.spyOn.
  tab.update = () => undefined;
  // Subscriber plumbing that the real ctor installs. Tests below ignore them.
  port.subscribeWebSearch(() => undefined);
  port.subscribeComposerControls(() => undefined);
  return tab as unknown as TreeTalkSettingTab;
}

async function triggerButton(item: { render?: (setting: unknown) => void }): Promise<() => Promise<void>> {
  let captured: (() => Promise<void>) | undefined;
  const fakeSetting = {
    addButton: (callback: (button: { setButtonText: (text: string) => unknown; onClick: (cb: () => Promise<void>) => unknown }) => void) => {
      const button = {
        setButtonText: () => button,
        onClick: (cb: () => Promise<void>) => { captured = cb; return button; }
      };
      callback(button);
    },
    addText: (callback: (text: unknown) => void) => { callback({}); }
  };
  if (item.render === undefined) throw new Error("item has no render");
  item.render(fakeSetting);
  if (captured === undefined) throw new Error("onClick handler not registered");
  return captured;
}

describe("TreeTalk settings tab - profile integration", () => {
  let port: FakeSettingsPort;
  let tab: TreeTalkSettingTab;
  let updateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    port = new FakeSettingsPort(
      settingsWith("alpha", [
        buildProfile({ id: "alpha", label: "Alpha", provider: "deepseek", model: "deepseek-v4-flash" }),
        buildProfile({ id: "beta", label: "Beta", provider: "minimax", model: "MiniMax-M2" })
      ])
    );
    tab = makeTab(port);
    updateSpy = vi.spyOn(tab, "update").mockImplementation(() => undefined);
  });

  afterEach(() => {
    (updateSpy as { mockRestore: () => void }).mockRestore();
  });

  it("exposes the active profile's provider/model/baseUrl in getControlValue", () => {
    expect(tab.getControlValue("provider")).toBe("deepseek");
    expect(tab.getControlValue("model")).toBe("deepseek-v4-flash");
    expect(tab.getControlValue("baseUrl")).toBe("");
    expect(tab.getControlValue("profileLabel")).toBe("Alpha");
  });

  it("reads provider-specific desc/placeholder/disabled from the active profile, not the legacy top-level field", () => {
    port.settings = {
      ...port.settings,
      // Plant a stale legacy field; the active profile is still DeepSeek.
      provider: "minimax",
      model: "MiniMax-M3"
    };
    const group = findGroup(tab.getSettingDefinitions(), "模型 API");
    const modelItem = findItem(group, "模型");
    const baseUrlItem = findItem(group, "API 地址");
    const webSearchItem = findItem(group, "联网模式");
    // Active profile is still DeepSeek, so descriptors reflect that and
    // ignore the stale top-level `provider: "minimax"` we just stuck in.
    expect(modelItem.desc).toContain("deepseek-v4-flash");
    expect((baseUrlItem.control as { placeholder: string }).placeholder).toBe("https://api.deepseek.com");
    expect((webSearchItem.control as { disabled: () => boolean }).disabled()).toBe(false);
  });

  it("switching the active profile refreshes model/baseUrl/apiKey without touching other profiles", async () => {
    await tab.setControlValue("activeProfileId", "beta");
    expect(tab.getControlValue("provider")).toBe("minimax");
    expect(tab.getControlValue("model")).toBe("MiniMax-M2");
    expect(tab.getControlValue("profileLabel")).toBe("Beta");
    expect(updateSpy).toHaveBeenCalled();
  });

  it("rejects a switch request to an unknown profile id", async () => {
    await tab.setControlValue("activeProfileId", "does-not-exist");
    expect(tab.getControlValue("activeProfileId")).toBe("alpha");
  });

  it("renames the active profile and refreshes the dropdown options", async () => {
    await tab.setControlValue("profileLabel", "  DeepSeek 主号  ");
    expect(tab.getControlValue("profileLabel")).toBe("DeepSeek 主号");
    const group = findGroup(tab.getSettingDefinitions(), "模型 API");
    const dropdownItem = findItem(group, "活动配置档");
    const options = (dropdownItem.control as { options: Record<string, string> }).options;
    expect(options).toMatchObject({ alpha: "DeepSeek 主号" });
    expect(updateSpy).toHaveBeenCalled();
  });

  it("normalizes an empty rename to the default label", async () => {
    await tab.setControlValue("profileLabel", "   ");
    expect(tab.getControlValue("profileLabel")).toBe("未命名配置档");
  });

  it("switching provider replaces the model and clears baseUrl with the preset default", async () => {
    port.settings.providerProfiles!.profiles = [
      buildProfile({
        id: "alpha",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        baseUrl: "https://custom.example.com"
      }),
      buildProfile({ id: "beta", provider: "minimax", model: "MiniMax-M2" })
    ];
    await tab.setControlValue("provider", "minimax");
    expect(tab.getControlValue("provider")).toBe("minimax");
    expect(tab.getControlValue("model")).toBe("MiniMax-M3");
    expect(tab.getControlValue("baseUrl")).toBe("");
  });

  it("does not leak the previous preset's model or baseUrl when switching back", async () => {
    port.settings.providerProfiles!.profiles = [
      buildProfile({
        id: "alpha",
        provider: "minimax",
        model: "MiniMax-M3",
        baseUrl: "https://custom-minimax.example.com"
      }),
      buildProfile({ id: "beta", provider: "deepseek", model: "deepseek-v4-flash" })
    ];
    await tab.setControlValue("activeProfileId", "beta");
    await tab.setControlValue("provider", "deepseek");
    expect(tab.getControlValue("model")).toBe("deepseek-v4-flash");
    expect(tab.getControlValue("baseUrl")).toBe("");
  });

  it("adding a profile makes the new one active and refreshes the UI", async () => {
    const beforeProfileCount = port.settings.providerProfiles!.profiles.length;
    const group = findGroup(tab.getSettingDefinitions(), "模型 API");
    const addItem = findItem(group, "新增配置档");
    const onClick = await triggerButton(addItem);
    await onClick();
    const profiles = port.settings.providerProfiles!.profiles;
    expect(profiles).toHaveLength(beforeProfileCount + 1);
    expect(profiles[profiles.length - 1]?.label).toBe("新配置档");
    expect(port.settings.providerProfiles!.activeProfileId).toBe(profiles[profiles.length - 1]!.id);
    expect(updateSpy).toHaveBeenCalled();
  });

  it("deleting a profile clears its secret and refreshes the UI", async () => {
    const group = findGroup(tab.getSettingDefinitions(), "模型 API");
    const deleteItem = findItem(group, "删除当前配置档");
    const onClick = await triggerButton(deleteItem);
    await onClick();
    expect(port.settings.providerProfiles!.profiles.map((entry) => entry.id)).toEqual(["beta"]);
    expect(port.settings.providerProfiles!.activeProfileId).toBe("beta");
    expect(port.secrets).toEqual([{ id: "treetalk-key-alpha", value: "" }]);
    expect(updateSpy).toHaveBeenCalled();
  });
});