import { describe, expect, it } from "vitest";
import {
  addProviderProfile,
  createDefaultProfileFromLegacy,
  deleteProviderProfile,
  isValidProfileId,
  migrateLegacyProviderProfile,
  normalizeProfileLabel,
  parseProviderProfiles,
  profileSecretId,
  renameProviderProfile,
  resolveActiveProfile,
  switchActiveProfile,
  switchProfileProvider,
  type ProviderProfileConfig,
  type ProviderProfilesState
} from "../../src/providers/provider-profiles";

function profile(overrides: Partial<ProviderProfileConfig>): ProviderProfileConfig {
  return {
    id: "alpha",
    label: "Alpha",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    baseUrl: "",
    ...overrides
  };
}

describe("provider profiles - pure operations", () => {
  it("validates profile ids (lowercase alphanumeric and hyphens, non-empty)", () => {
    expect(isValidProfileId("alpha-1")).toBe(true);
    expect(isValidProfileId("a")).toBe(true);
    expect(isValidProfileId("abc-123")).toBe(true);
    expect(isValidProfileId("")).toBe(false);
    expect(isValidProfileId("has space")).toBe(false);
    expect(isValidProfileId("Has_Caps")).toBe(false);
    expect(isValidProfileId("under_score")).toBe(false);
    expect(isValidProfileId("dot.dot")).toBe(false);
    expect(isValidProfileId("中文")).toBe(false);
    expect(isValidProfileId("-leading")).toBe(false);
    expect(isValidProfileId("trailing-")).toBe(false);
    expect(isValidProfileId("--double")).toBe(false);
  });

  it("normalizes empty / whitespace labels to the fallback name", () => {
    expect(normalizeProfileLabel("")).toBe("未命名配置档");
    expect(normalizeProfileLabel("   ")).toBe("未命名配置档");
    expect(normalizeProfileLabel("\t\n")).toBe("未命名配置档");
    expect(normalizeProfileLabel("  DeepSeek 主号  ")).toBe("DeepSeek 主号");
    expect(normalizeProfileLabel("MiniMax")).toBe("MiniMax");
  });

  it("renames the active profile and persists to settings", () => {
    const state: ProviderProfilesState = {
      activeProfileId: "alpha",
      profiles: [profile({ id: "alpha" }), profile({ id: "beta", label: "B" })]
    };
    const next = renameProviderProfile(state, "alpha", "  DeepSeek 主号  ");
    expect(next.profiles[0]?.label).toBe("DeepSeek 主号");
    expect(next.profiles[1]?.label).toBe("B");
    expect(next.activeProfileId).toBe("alpha");
  });

  it("normalizes empty rename labels back to the fallback name", () => {
    const state: ProviderProfilesState = {
      activeProfileId: "alpha",
      profiles: [profile({ id: "alpha", label: "原名" })]
    };
    const next = renameProviderProfile(state, "alpha", "   ");
    expect(next.profiles[0]?.label).toBe("未命名配置档");
  });

  it("refuses to rename a missing profile", () => {
    const state: ProviderProfilesState = {
      activeProfileId: "alpha",
      profiles: [profile({ id: "alpha" })]
    };
    expect(renameProviderProfile(state, "missing", "X")).toBe(state);
  });

  it("adds a new profile derived from the active one, makes it active, and yields a unique label", () => {
    const state: ProviderProfilesState = {
      activeProfileId: "alpha",
      profiles: [
        profile({ id: "alpha", label: "Alpha" }),
        profile({ id: "beta", label: "新配置档" })
      ]
    };
    const next = addProviderProfile(state, { id: "gamma", provider: "deepseek", model: "deepseek-v4-flash", baseUrl: "" });
    expect(next.profiles).toHaveLength(3);
    expect(next.activeProfileId).toBe("gamma");
    expect(next.profiles[2]?.label).toBe("新配置档 2");
  });

  it("starts the auto-incrementing default name from 1 on an empty state", () => {
    const state: ProviderProfilesState = { activeProfileId: null, profiles: [] };
    const next = addProviderProfile(state, { id: "alpha", provider: "deepseek", model: "deepseek-v4-flash", baseUrl: "" });
    expect(next.profiles[0]?.label).toBe("新配置档");
  });

  it("deletes a profile, clears its secret id, and parks active on a neighbour", () => {
    const state: ProviderProfilesState = {
      activeProfileId: "beta",
      profiles: [profile({ id: "alpha" }), profile({ id: "beta" }), profile({ id: "gamma" })]
    };
    const result = deleteProviderProfile(state, "beta");
    expect(result.state.profiles.map((entry) => entry.id)).toEqual(["alpha", "gamma"]);
    expect(result.state.activeProfileId).toBe("gamma");
    expect(result.removedSecretId).toBe(profileSecretId("beta"));
  });

  it("refuses to delete the last profile", () => {
    const state: ProviderProfilesState = {
      activeProfileId: "alpha",
      profiles: [profile({ id: "alpha" })]
    };
    const result = deleteProviderProfile(state, "alpha");
    expect(result.state).toBe(state);
    expect(result.removedSecretId).toBeNull();
  });

  it("switches active profile to a valid id", () => {
    const state: ProviderProfilesState = {
      activeProfileId: "alpha",
      profiles: [profile({ id: "alpha" }), profile({ id: "beta" })]
    };
    expect(switchActiveProfile(state, "beta").activeProfileId).toBe("beta");
  });

  it("ignores a switch request that targets a missing id", () => {
    const state: ProviderProfilesState = {
      activeProfileId: "alpha",
      profiles: [profile({ id: "alpha" })]
    };
    expect(switchActiveProfile(state, "missing")).toBe(state);
  });

  it("switches provider to a built-in preset using its defaultModel and clears baseUrl", () => {
    const state: ProviderProfilesState = {
      activeProfileId: "alpha",
      profiles: [
        profile({
          id: "alpha",
          provider: "deepseek",
          model: "deepseek-v4-flash",
          baseUrl: "https://custom.example.com"
        })
      ]
    };
    const next = switchProfileProvider(state, "minimax");
    expect(next.profiles[0]?.provider).toBe("minimax");
    expect(next.profiles[0]?.model).toBe("MiniMax-M3");
    expect(next.profiles[0]?.baseUrl).toBe("");
  });

  it("does not leak the previous preset's model or baseUrl when switching providers", () => {
    const state: ProviderProfilesState = {
      activeProfileId: "alpha",
      profiles: [
        profile({
          id: "alpha",
          provider: "minimax",
          model: "MiniMax-M3",
          baseUrl: "https://custom-minimax.example.com"
        })
      ]
    };
    const next = switchProfileProvider(state, "deepseek");
    expect(next.profiles[0]?.model).toBe("deepseek-v4-flash");
    expect(next.profiles[0]?.baseUrl).toBe("");
    expect(next.profiles[0]?.provider).toBe("deepseek");
  });

  it("switching provider on an unknown custom key keeps the existing model and clears baseUrl", () => {
    const state: ProviderProfilesState = {
      activeProfileId: "alpha",
      profiles: [
        profile({
          id: "alpha",
          provider: "my-custom-proxy",
          model: "my-custom-model",
          baseUrl: "https://proxy.example.com"
        })
      ]
    };
    const next = switchProfileProvider(state, "another-custom-proxy");
    expect(next.profiles[0]?.provider).toBe("another-custom-proxy");
    expect(next.profiles[0]?.model).toBe("my-custom-model");
    expect(next.profiles[0]?.baseUrl).toBe("");
  });
});

describe("provider profiles - parser", () => {
  it("returns an empty state for malformed input", () => {
    expect(parseProviderProfiles(undefined)).toEqual({ activeProfileId: null, profiles: [] });
    expect(parseProviderProfiles(null)).toEqual({ activeProfileId: null, profiles: [] });
    expect(parseProviderProfiles("nope")).toEqual({ activeProfileId: null, profiles: [] });
    expect(parseProviderProfiles({})).toEqual({ activeProfileId: null, profiles: [] });
    expect(parseProviderProfiles({ profiles: "nope" })).toEqual({ activeProfileId: null, profiles: [] });
  });

  it("filters out profiles with illegal or missing fields", () => {
    const parsed = parseProviderProfiles({
      activeProfileId: "good",
      profiles: [
        { id: "good", label: "Good", provider: "deepseek", model: "m", baseUrl: "" },
        { id: "Has Space", label: "Bad", provider: "deepseek", model: "m", baseUrl: "" },
        { id: "under_score", label: "Bad", provider: "deepseek", model: "m", baseUrl: "" },
        { id: "", label: "Empty id", provider: "deepseek", model: "m", baseUrl: "" },
        { id: "no-fields" },
        { id: 42, label: "Number id", provider: "deepseek", model: "m", baseUrl: "" },
        null,
        "string-profile"
      ]
    });
    expect(parsed.profiles).toHaveLength(1);
    expect(parsed.profiles[0]?.id).toBe("good");
  });

  it("de-duplicates profiles that share the same id (first wins)", () => {
    const parsed = parseProviderProfiles({
      activeProfileId: "dup",
      profiles: [
        { id: "dup", label: "First", provider: "deepseek", model: "m1", baseUrl: "" },
        { id: "dup", label: "Second", provider: "minimax", model: "m2", baseUrl: "" },
        { id: "dup", label: "Third", provider: "openai", model: "m3", baseUrl: "" }
      ]
    });
    expect(parsed.profiles).toHaveLength(1);
    expect(parsed.profiles[0]?.label).toBe("First");
  });

  it("normalizes empty / whitespace labels to the fallback name", () => {
    const parsed = parseProviderProfiles({
      activeProfileId: "alpha",
      profiles: [
        { id: "alpha", label: "   ", provider: "deepseek", model: "m", baseUrl: "" },
        { id: "beta", label: "\t\n", provider: "deepseek", model: "m", baseUrl: "" },
        { id: "gamma", label: "Real", provider: "deepseek", model: "m", baseUrl: "" }
      ]
    });
    expect(parsed.profiles[0]?.label).toBe("未命名配置档");
    expect(parsed.profiles[1]?.label).toBe("未命名配置档");
    expect(parsed.profiles[2]?.label).toBe("Real");
  });

  it("falls back active id to the first valid profile when the recorded id was filtered out", () => {
    const parsed = parseProviderProfiles({
      activeProfileId: "Has Space",
      profiles: [
        { id: "Has Space", label: "Bad", provider: "deepseek", model: "m", baseUrl: "" },
        { id: "alpha", label: "Alpha", provider: "deepseek", model: "m", baseUrl: "" }
      ]
    });
    expect(parsed.activeProfileId).toBe("alpha");
    expect(parsed.profiles).toHaveLength(1);
  });

  it("yields null active id when no profiles survive filtering", () => {
    const parsed = parseProviderProfiles({
      activeProfileId: "anything",
      profiles: [
        { id: "Has Space", label: "Bad", provider: "deepseek", model: "m", baseUrl: "" }
      ]
    });
    expect(parsed.activeProfileId).toBeNull();
    expect(parsed.profiles).toEqual([]);
  });

  it("keeps the recorded active id when it points at a valid, surviving profile", () => {
    const parsed = parseProviderProfiles({
      activeProfileId: "beta",
      profiles: [
        { id: "alpha", label: "Alpha", provider: "deepseek", model: "m", baseUrl: "" },
        { id: "beta", label: "Beta", provider: "minimax", model: "m", baseUrl: "" }
      ]
    });
    expect(parsed.activeProfileId).toBe("beta");
  });
});

describe("provider profiles - migration + resolve", () => {
  it("creates a default profile from legacy settings", () => {
    const profile = createDefaultProfileFromLegacy({ provider: "deepseek", model: "deepseek-chat", baseUrl: "" });
    expect(profile.label).toBe("默认");
    expect(profile.provider).toBe("deepseek");
    expect(isValidProfileId(profile.id)).toBe(true);
    expect(profileSecretId(profile.id)).toBe(`treetalk-key-${profile.id}`);
  });

  it("resolves active profile, then first profile, then legacy fallback", () => {
    const first = profile({ id: "first", label: "First" });
    const second = profile({ id: "second", label: "Second", provider: "minimax" });
    const state: ProviderProfilesState = { activeProfileId: "missing", profiles: [first, second] };
    expect(resolveActiveProfile(state, second)).toBe(first);
    expect(resolveActiveProfile({ activeProfileId: "second", profiles: [first, second] }, first)).toBe(second);
    expect(resolveActiveProfile({ activeProfileId: null, profiles: [] }, first)).toBe(first);
  });

  it("migrates the legacy secret once and never overwrites existing profiles", async () => {
    const secrets = new Map([["treetalk-api-key", "legacy-key"]]);
    const port = {
      getSecret: (id: string) => secrets.get(id) ?? null,
      setSecret: (id: string, value: string) => { secrets.set(id, value); },
      listSecrets: () => [...secrets.keys()]
    };
    const migrated = await migrateLegacyProviderProfile({ provider: "deepseek", model: "m", baseUrl: "" }, port);
    expect(migrated.profiles).toHaveLength(1);
    expect(secrets.get(profileSecretId(migrated.profiles[0]!.id))).toBe("legacy-key");
    const existing = { activeProfileId: "existing", profiles: [profile({ id: "existing", label: "Existing", provider: "minimax" })] } as ProviderProfilesState;
    expect(await migrateLegacyProviderProfile({ provider: "deepseek", model: "m", baseUrl: "", providerProfiles: existing }, port)).toBe(existing);
  });
});