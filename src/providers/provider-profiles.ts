import { getProviderPreset } from "./presets";

export interface ProviderProfileConfig {
  id: string;
  label: string;
  provider: string;
  model: string;
  baseUrl: string;
}

export interface ProviderProfilesState {
  activeProfileId: string | null;
  profiles: ProviderProfileConfig[];
}

export interface LegacyProviderSettings {
  provider: string;
  model: string;
  baseUrl: string;
}

const PROFILE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export const DEFAULT_PROFILE_LABEL = "未命名配置档";

/**
 * Validate a profile id. Obsidian SecretStorage rejects ids that contain
 * anything other than lowercase alphanumerics and hyphens, so the same
 * shape is enforced here to keep `profileSecretId(id)` always writable.
 */
export function isValidProfileId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && PROFILE_ID_PATTERN.test(id);
}

/**
 * Normalize a user-entered profile label: trim surrounding whitespace, and
 * fall back to a stable default when the trimmed value is empty so multiple
 * "new profile" entries remain distinguishable in the dropdown.
 */
export function normalizeProfileLabel(label: string): string {
  const trimmed = label.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_PROFILE_LABEL;
}

export function createDefaultProfileFromLegacy(
  settings: LegacyProviderSettings,
  id = crypto.randomUUID()
): ProviderProfileConfig {
  return { id, label: "默认", provider: settings.provider, model: settings.model, baseUrl: settings.baseUrl };
}

export function profileSecretId(profileId: string): string {
  return `treetalk-key-${profileId}`;
}

/**
 * Parse a raw stored value into a sanitized profiles state. Drops profiles
 * with illegal ids or shapes, de-duplicates by id (first wins), normalizes
 * labels, and falls back to the first surviving id when the recorded
 * active id was filtered out.
 */
export function parseProviderProfiles(value: unknown): ProviderProfilesState {
  if (value === null || value === undefined || typeof value !== "object") {
    return { activeProfileId: null, profiles: [] };
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.profiles)) {
    return { activeProfileId: null, profiles: [] };
  }
  const seen = new Set<string>();
  const profiles: ProviderProfileConfig[] = [];
  for (const entry of record.profiles) {
    if (entry === null || typeof entry !== "object") continue;
    const candidate = entry as Record<string, unknown>;
    if (!isValidProfileId(candidate.id)) continue;
    if (typeof candidate.provider !== "string") continue;
    if (typeof candidate.model !== "string") continue;
    if (typeof candidate.baseUrl !== "string") continue;
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    profiles.push({
      id: candidate.id,
      label: normalizeProfileLabel(typeof candidate.label === "string" ? candidate.label : ""),
      provider: candidate.provider,
      model: candidate.model,
      baseUrl: candidate.baseUrl
    });
  }
  const recordedActive = typeof record.activeProfileId === "string" ? record.activeProfileId : null;
  const activeProfileId = recordedActive !== null && profiles.some((profile) => profile.id === recordedActive)
    ? recordedActive
    : profiles[0]?.id ?? null;
  return { activeProfileId, profiles };
}

export function resolveActiveProfile(
  state: ProviderProfilesState | undefined,
  legacyFallback: ProviderProfileConfig
): ProviderProfileConfig {
  const profiles = state?.profiles ?? [];
  return profiles.find((profile) => profile.id === state?.activeProfileId) ?? profiles[0] ?? legacyFallback;
}

/**
 * Pick the next "new profile" label that does not collide with any existing
 * label. "新配置档" is used the first time, "新配置档 2", "新配置档 3", ...
 * thereafter so each new entry is visually distinguishable in the dropdown.
 */
function nextDefaultLabel(profiles: readonly ProviderProfileConfig[]): string {
  const taken = new Set(profiles.map((profile) => profile.label.trim()));
  const base = "新配置档";
  if (!taken.has(base)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base} ${index}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base} ${Date.now()}`;
}

/**
 * Add a brand new profile seeded from the current active profile (or the
 * provided seed). The new profile becomes active. Pure function: returns a
 * new state without mutating the input.
 */
export function addProviderProfile(
  state: ProviderProfilesState,
  seed: Pick<ProviderProfileConfig, "id" | "provider" | "model" | "baseUrl">
): ProviderProfilesState {
  const profile: ProviderProfileConfig = {
    id: seed.id,
    label: nextDefaultLabel(state.profiles),
    provider: seed.provider,
    model: seed.model,
    baseUrl: seed.baseUrl
  };
  return {
    activeProfileId: profile.id,
    profiles: [...state.profiles, profile]
  };
}

export interface DeleteProfileResult {
  state: ProviderProfilesState;
  removedSecretId: string | null;
}

/**
 * Remove a profile from the state and report the secret id that callers
 * should clear. Refuses to remove the last remaining profile. The active
 * id is parked on the nearest surviving neighbour so the UI never points
 * at a missing profile.
 */
export function deleteProviderProfile(
  state: ProviderProfilesState,
  profileId: string
): DeleteProfileResult {
  if (state.profiles.length <= 1) return { state, removedSecretId: null };
  const index = state.profiles.findIndex((profile) => profile.id === profileId);
  if (index < 0) return { state, removedSecretId: null };
  const profiles = state.profiles.filter((profile) => profile.id !== profileId);
  let activeProfileId = state.activeProfileId;
  if (activeProfileId === profileId) {
    const fallback = profiles[index] ?? profiles[index - 1] ?? profiles[0];
    activeProfileId = fallback?.id ?? null;
  }
  return {
    state: { activeProfileId, profiles },
    removedSecretId: profileSecretId(profileId)
  };
}

/**
 * Update the label of one profile in place. Returns the input unchanged
 * when the id is missing. Empty / whitespace labels normalize to the
 * fallback name so the UI never shows a blank entry.
 */
export function renameProviderProfile(
  state: ProviderProfilesState,
  profileId: string,
  label: string
): ProviderProfilesState {
  if (!state.profiles.some((profile) => profile.id === profileId)) return state;
  const normalized = normalizeProfileLabel(label);
  return {
    ...state,
    profiles: state.profiles.map((profile) =>
      profile.id === profileId ? { ...profile, label: normalized } : profile
    )
  };
}

/**
 * Switch the active profile id. No-op when the requested id does not exist
 * so the UI can never enter an invalid state.
 */
export function switchActiveProfile(
  state: ProviderProfilesState,
  profileId: string
): ProviderProfilesState {
  if (!state.profiles.some((profile) => profile.id === profileId)) return state;
  return { ...state, activeProfileId: profileId };
}

/**
 * Switch the active profile's provider. For built-in presets, the model is
 * replaced with the preset's defaultModel and the user-entered baseUrl is
 * cleared so a previous provider's custom endpoint never leaks across.
 * Unknown custom keys keep the existing model (the user is presumed to know
 * which model their endpoint speaks) but still drop baseUrl so the new
 * provider starts from a clean slate.
 */
export function switchProfileProvider(
  state: ProviderProfilesState,
  nextProvider: string
): ProviderProfilesState {
  if (!state.profiles.some((profile) => profile.id === state.activeProfileId)) return state;
  const preset = getProviderPreset(nextProvider);
  const profiles = state.profiles.map((profile) => {
    if (profile.id !== state.activeProfileId) return profile;
    if (preset === undefined) {
      return { ...profile, provider: nextProvider, baseUrl: "" };
    }
    return {
      ...profile,
      provider: preset.key,
      model: preset.defaultModel,
      baseUrl: ""
    };
  });
  return { ...state, profiles };
}

export interface SecretPort {
  getSecret(id: string): string | null;
  setSecret(id: string, value: string): void;
  listSecrets(): string[];
}

export async function migrateLegacyProviderProfile(
  settings: { provider: string; model: string; baseUrl: string; providerProfiles?: ProviderProfilesState },
  secrets: SecretPort
): Promise<ProviderProfilesState> {
  const existing = settings.providerProfiles;
  if (existing !== undefined && existing.profiles.length > 0) return existing;
  const profile = createDefaultProfileFromLegacy(settings);
  const legacyKey = secrets.getSecret("treetalk-api-key") ?? "";
  secrets.setSecret(profileSecretId(profile.id), legacyKey);
  return { activeProfileId: profile.id, profiles: [profile] };
}