import type { PiToolDefinition } from "../context-workspace";
import type {
  ProgressiveContextLevel,
  ProgressiveContextState,
  ProgressiveExpansionResult
} from "./types";

export const CONTEXT_TARGETS = [
  "current_section",
  "current_source",
  "related_sections",
  "related_full_source"
] as const;

export type ContextTarget = (typeof CONTEXT_TARGETS)[number];
export type ContextMode = "convergent" | "divergent";

export const CONTEXT_TARGET_DESCRIPTIONS: Record<ContextTarget, string> = {
  current_section: "返回当前框选所在的 Markdown 章节；无标题时返回附近文本。",
  current_source: "返回当前笔记、节点或父回答的下一批正文。",
  related_sections: "返回祖先节点及允许范围内关联笔记的相关章节。",
  related_full_source: "返回一个祖先节点或允许范围内关联笔记的完整正文；过长时分批返回。"
};

const TARGET_LEVELS: Record<ContextTarget, 1 | 2 | 3 | 4> = {
  current_section: 1,
  current_source: 2,
  related_sections: 3,
  related_full_source: 4
};

export interface ContextTargetAvailability {
  target: ContextTarget;
  nextLevel: 1 | 2 | 3 | 4;
}

export interface RequestContextArguments {
  target: ContextTarget;
  reason: string;
}

export interface CompactContextToolResult {
  source: string;
  scope: "section" | "local-window" | "partial-source" | "full-source";
  remaining: boolean;
  content: string;
}

function availability(target: ContextTarget): ContextTargetAvailability {
  return { target, nextLevel: TARGET_LEVELS[target] };
}

export function availableContextTargets(input: {
  state: ProgressiveContextState;
  exactSelection: boolean;
  divergenceEnabled: boolean;
  availableLevels: ReadonlySet<1 | 2 | 3 | 4>;
}): ContextTargetAvailability[] {
  const available = CONTEXT_TARGETS
    .filter((target) => input.availableLevels.has(TARGET_LEVELS[target]))
    .map(availability);
  if (input.divergenceEnabled) {
    const minimumLevel = Math.max(1, input.state.currentLevel);
    return available.filter((entry) => entry.nextLevel >= minimumLevel);
  }

  const result: ContextTargetAvailability[] = [];
  if (input.state.currentLevel >= 2) {
    const sameLevel = available.find(
      (entry) => entry.nextLevel === input.state.currentLevel
    );
    if (sameLevel !== undefined) result.push(sameLevel);
  }
  const nextLevel = available.find(
    (entry) => entry.nextLevel > input.state.currentLevel
  );
  if (nextLevel !== undefined) result.push(nextLevel);
  return result;
}

function visibleDescription(
  target: ContextTarget,
  relatedNotesAllowed: boolean
): string {
  if (target === "related_sections") {
    return relatedNotesAllowed
      ? "返回祖先节点及关联笔记的相关章节。"
      : "返回祖先节点的相关章节。";
  }
  if (target === "related_full_source") {
    return relatedNotesAllowed
      ? "返回一个祖先节点或关联笔记的完整正文；过长时分批返回。"
      : "返回一个祖先节点的完整正文；过长时分批返回。";
  }
  return CONTEXT_TARGET_DESCRIPTIONS[target];
}

export function buildRequestContextTool(
  _available: ContextTargetAvailability[],
  relatedNotesAllowed: boolean
): PiToolDefinition {
  const description = [
    "上下文接口：",
    ...CONTEXT_TARGETS.map(
      (target) => `- ${target}：${visibleDescription(target, relatedNotesAllowed)}`
    )
  ].join("\n");
  return {
    name: "request_context",
    description,
    parameters: {
      type: "object",
      properties: {
        target: {
          type: "string",
          enum: [...CONTEXT_TARGETS]
        },
        reason: {
          type: "string",
          minLength: 1
        }
      },
      required: ["target", "reason"],
      additionalProperties: false
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseRequestContextArguments(
  value: unknown,
  availableTargets: readonly ContextTarget[]
): RequestContextArguments {
  if (!isRecord(value)) {
    throw new TypeError("request_context arguments must be an object");
  }
  const target = value.target;
  if (typeof target !== "string" || !CONTEXT_TARGETS.includes(target as ContextTarget)) {
    throw new TypeError("request_context target must be a semantic context target");
  }
  if (!availableTargets.includes(target as ContextTarget)) {
    throw new TypeError(`request_context target is unavailable: ${target}`);
  }
  const reason = value.reason;
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new TypeError("request_context reason must be a non-empty string");
  }
  return { target: target as ContextTarget, reason: reason.trim() };
}

export function buildCompactContextToolResult(
  expansion: ProgressiveExpansionResult
): CompactContextToolResult {
  const batch = expansion.batch;
  if (batch === undefined) {
    return {
      source: "TreeTalk",
      scope: "partial-source",
      remaining: !expansion.state.expansionDisabled,
      content: expansion.message
    };
  }
  return {
    source: batch.title,
    scope:
      batch.level === 1
        ? (batch.sourceKind === "section" ? "section" : "local-window")
        : batch.level === 4
          ? "full-source"
          : "partial-source",
    remaining: batch.hasMoreFromSource,
    content: batch.content
  };
}

export function targetForLevel(level: ProgressiveContextLevel): ContextTarget | undefined {
  if (level === 1) return "current_section";
  if (level === 2) return "current_source";
  if (level === 3) return "related_sections";
  if (level === 4) return "related_full_source";
  return undefined;
}
