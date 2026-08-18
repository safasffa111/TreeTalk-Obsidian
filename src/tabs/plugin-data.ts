import type { ContextMode } from "../domain/context-engine";
import type { ExecutionMode } from "../execution/types";
import type { AnswerThinkingMode } from "../execution/answer-thinking";
import {
  getProviderPreset,
  normalizeProviderKey
} from "../providers/presets";
import {
  parseTabsWorkspaceData,
  type TabsWorkspaceData
} from "./workspace-state";
import { logWarning } from "../utils/error-log";
import { parseProviderProfiles, type ProviderProfilesState } from "../providers/provider-profiles";

export type NoteContextTokenBudget = "minimal" | "full" | number;
export type CompressedNoteTokenBudget = Exclude<NoteContextTokenBudget, "full">;
export type RelatedNoteDepth = "unlimited" | number;

export interface DepositGraphWindowState {
  x: number;
  y: number;
  width: number;
  height: number;
  minimized: boolean;
  maximized: boolean;
}

export interface TreeTalkSettings {
  executionMode: ExecutionMode;
  /** Provider preset key (see providers/presets). Free-form to allow custom endpoints. */
  provider: string;
  model: string;
  baseUrl: string;
  providerProfiles?: ProviderProfilesState;
  treeWidth: number;
  knowledgeFolder: string;
  treeCaptureFolder: string;
  obsidianMarkdownCompatibility: boolean;
  contextOptimizationEnabled: boolean;
  contextMode: ContextMode;
  webSearchEnabled: boolean;
  streamingOutputEnabled: boolean;
  answerThinkingMode: AnswerThinkingMode;
  fullNoteContext: boolean;
  noteContextTokenBudget: NoteContextTokenBudget;
  lastCompressedNoteTokenBudget: CompressedNoteTokenBudget;
  relatedNoteContextEnabled: boolean;
  contextDivergenceEnabled: boolean;
  relatedNoteDepth: RelatedNoteDepth;
  depositGraphWindow: DepositGraphWindowState;
}

export interface TreeTalkPluginData {
  settings: TreeTalkSettings;
  tabs: TabsWorkspaceData;
}

export const DEFAULT_SETTINGS: TreeTalkSettings = {
  executionMode: "pi",
  provider: "deepseek",
  model: "deepseek-v4-flash",
  baseUrl: "",
  providerProfiles: { activeProfileId: null, profiles: [] },
  treeWidth: 220,
  knowledgeFolder: "TreeTalk 知识",
  treeCaptureFolder: "TreeTalk",
  obsidianMarkdownCompatibility: true,
  contextOptimizationEnabled: false,
  contextMode: "full",
  webSearchEnabled: false,
  streamingOutputEnabled: true,
  answerThinkingMode: "disabled",
  fullNoteContext: true,
  noteContextTokenBudget: "full",
  lastCompressedNoteTokenBudget: 512,
  relatedNoteContextEnabled: false,
  contextDivergenceEnabled: false,
  relatedNoteDepth: 1,
  depositGraphWindow: {
    x: 120,
    y: 96,
    width: 880,
    height: 620,
    minimized: false,
    maximized: false
  }
};

export const EMPTY_TABS_WORKSPACE: TabsWorkspaceData = {
  schemaVersion: 1,
  activeConversationId: null,
  openConversationIds: []
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeConfiguredModel(
  provider: string,
  model: string
): string {
  const trimmed = model.trim();
  if (trimmed.length > 0) return trimmed;
  const preset = getProviderPreset(provider);
  return preset?.defaultModel !== undefined && preset.defaultModel.length > 0
    ? preset.defaultModel
    : DEFAULT_SETTINGS.model;
}

export function normalizeTreeTalkSettings(
  settings: TreeTalkSettings
): TreeTalkSettings {
  const provider = normalizeProviderKey(settings.provider);
  return {
    ...settings,
    executionMode: "pi",
    provider,
    model: normalizeConfiguredModel(provider, settings.model),
    contextOptimizationEnabled: false,
    contextMode: "full",
    answerThinkingMode:
      settings.answerThinkingMode === "enabled" ? "enabled" : "disabled",
    fullNoteContext: true,
    noteContextTokenBudget: "full"
  };
}



function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function parseDepositGraphWindowState(value: unknown): DepositGraphWindowState {
  const fallback = DEFAULT_SETTINGS.depositGraphWindow;
  if (!isRecord(value)) return { ...fallback };
  return {
    x: finiteNumber(value.x, fallback.x),
    y: finiteNumber(value.y, fallback.y),
    width: Math.max(420, finiteNumber(value.width, fallback.width)),
    height: Math.max(280, finiteNumber(value.height, fallback.height)),
    minimized:
      typeof value.minimized === "boolean" ? value.minimized : fallback.minimized,
    maximized:
      typeof value.maximized === "boolean" ? value.maximized : fallback.maximized
  };
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value > 0
      ? value
      : undefined;
}

function parseCompressedNoteTokenBudget(
  value: unknown,
  fallback: CompressedNoteTokenBudget
): CompressedNoteTokenBudget {
  if (value === "minimal") return "minimal";
  return positiveInteger(value) ?? fallback;
}

function parseRelatedNoteDepth(
  value: unknown,
  fallback: RelatedNoteDepth
): RelatedNoteDepth {
  if (value === "unlimited") return "unlimited";
  return positiveInteger(value) ?? fallback;
}

function parseStoredProviderProfiles(value: unknown): ProviderProfilesState {
  return parseProviderProfiles(value);
}

function parseSettings(value: unknown): TreeTalkSettings {
  if (!isRecord(value)) return normalizeTreeTalkSettings({ ...DEFAULT_SETTINGS });
  const contextOptimizationEnabled =
    typeof value.contextOptimizationEnabled === "boolean"
      ? value.contextOptimizationEnabled
      : DEFAULT_SETTINGS.contextOptimizationEnabled;
  const provider = normalizeProviderKey(
    typeof value.provider === "string" ? value.provider : DEFAULT_SETTINGS.provider
  );
  const model = normalizeConfiguredModel(
    provider,
    typeof value.model === "string" ? value.model : DEFAULT_SETTINGS.model
  );
  const fullNoteContext =
    typeof value.fullNoteContext === "boolean"
      ? value.fullNoteContext
      : DEFAULT_SETTINGS.fullNoteContext;
  const lastCompressedNoteTokenBudget = parseCompressedNoteTokenBudget(
    value.lastCompressedNoteTokenBudget,
    DEFAULT_SETTINGS.lastCompressedNoteTokenBudget
  );
  const configuredNoteBudget =
    value.noteContextTokenBudget === "full"
      ? "full"
      : parseCompressedNoteTokenBudget(
          value.noteContextTokenBudget,
          lastCompressedNoteTokenBudget
        );
  const providerProfiles = parseStoredProviderProfiles(value.providerProfiles);
  return normalizeTreeTalkSettings({
    executionMode:
      value.executionMode === "legacy" || value.executionMode === "pi"
        ? value.executionMode
        : DEFAULT_SETTINGS.executionMode,
    provider,
    model,
    baseUrl:
      typeof value.baseUrl === "string"
        ? value.baseUrl
        : DEFAULT_SETTINGS.baseUrl,
    providerProfiles,
    treeWidth:
      typeof value.treeWidth === "number" &&
      Number.isFinite(value.treeWidth) &&
      value.treeWidth > 0
        ? value.treeWidth
        : DEFAULT_SETTINGS.treeWidth,
    knowledgeFolder:
      typeof value.knowledgeFolder === "string" &&
      value.knowledgeFolder.trim().length > 0
        ? value.knowledgeFolder.trim()
        : DEFAULT_SETTINGS.knowledgeFolder,
    treeCaptureFolder:
      typeof value.treeCaptureFolder === "string" &&
      value.treeCaptureFolder.trim().length > 0
        ? value.treeCaptureFolder.trim()
        : DEFAULT_SETTINGS.treeCaptureFolder,
    obsidianMarkdownCompatibility:
      typeof value.obsidianMarkdownCompatibility === "boolean"
        ? value.obsidianMarkdownCompatibility
        : DEFAULT_SETTINGS.obsidianMarkdownCompatibility,
    contextOptimizationEnabled,
    contextMode: contextOptimizationEnabled ? "balanced" : "full",
    webSearchEnabled:
      typeof value.webSearchEnabled === "boolean"
        ? value.webSearchEnabled
        : DEFAULT_SETTINGS.webSearchEnabled,
    streamingOutputEnabled:
      typeof value.streamingOutputEnabled === "boolean"
        ? value.streamingOutputEnabled
        : DEFAULT_SETTINGS.streamingOutputEnabled,
    answerThinkingMode:
      value.answerThinkingMode === "disabled" ||
      value.answerThinkingMode === "enabled" ||
      value.answerThinkingMode === "auto"
        ? value.answerThinkingMode
        : DEFAULT_SETTINGS.answerThinkingMode,
    fullNoteContext,
    noteContextTokenBudget: fullNoteContext ? "full" :
      configuredNoteBudget === "full"
        ? lastCompressedNoteTokenBudget
        : configuredNoteBudget,
    lastCompressedNoteTokenBudget,
    relatedNoteContextEnabled:
      typeof value.relatedNoteContextEnabled === "boolean"
        ? value.relatedNoteContextEnabled
        : DEFAULT_SETTINGS.relatedNoteContextEnabled,
    contextDivergenceEnabled:
      typeof value.contextDivergenceEnabled === "boolean"
        ? value.contextDivergenceEnabled
        : DEFAULT_SETTINGS.contextDivergenceEnabled,
    relatedNoteDepth: parseRelatedNoteDepth(
      value.relatedNoteDepth,
      DEFAULT_SETTINGS.relatedNoteDepth
    ),
    depositGraphWindow: parseDepositGraphWindowState(
      value.depositGraphWindow
    )
  });
}

export function parsePluginData(value: unknown): TreeTalkPluginData {
  const source = isRecord(value) ? value : {};
  const settingsSource = isRecord(source.settings) ? source.settings : source;
  let tabs = { ...EMPTY_TABS_WORKSPACE };
  try {
    tabs = parseTabsWorkspaceData(source.tabs);
  } catch (error) {
    logWarning("插件标签页布局解析失败，已回退为空布局", error);
    // Invalid UI workspace state never invalidates canonical Vault data.
  }
  return {
    settings: parseSettings(settingsSource),
    tabs
  };
}
