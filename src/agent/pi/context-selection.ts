import type {
  PiFocusDecision,
  PiFocusScope
} from "../../execution/types";

export type PiContextPriority = "essential" | "supporting" | "optional";
export type PiConversationNodePart = "question" | "answer" | "selection" | "all";

export interface PiNoteSelection {
  id: string;
  priority: PiContextPriority;
  sections: string[];
  reason: string;
}

export interface PiConversationNodeSelection {
  id: string;
  priority: PiContextPriority;
  parts: PiConversationNodePart[];
  reason: string;
}

export interface PiContextSelection {
  focusScope: PiFocusScope;
  focusReason: string;
  focusDecisions: PiFocusDecision[];
  notes: PiNoteSelection[];
  nodes: PiConversationNodeSelection[];
}

export interface PiNeedMoreContextRequest {
  status: "need_more_context";
  missing: string;
}

const PRIORITY_ORDER: Record<PiContextPriority, number> = {
  essential: 0,
  supporting: 1,
  optional: 2
};

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function requiredId(value: unknown, label: string, prefix: "P" | "N"): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a compact ${prefix}-prefixed source ID`);
  }
  const normalized = value.trim();
  const stable = new RegExp(`^${prefix}-[0-9a-f]{10}$`, "u");
  const legacy = new RegExp(`^${prefix}\\d+$`, "u");
  if (!stable.test(normalized) && !legacy.test(normalized)) {
    throw new TypeError(`${label} must be a compact ${prefix}-prefixed source ID`);
  }
  return normalized;
}

function priority(value: unknown): PiContextPriority {
  return value === "essential" || value === "optional" ? value : "supporting";
}

function stringList(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return [...new Set(value.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new TypeError(`${label}[${String(index)}] must be a non-empty string`);
    }
    return entry.trim();
  }))];
}

function reason(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 500) : "";
}

function noteSelection(value: unknown, index: number): PiNoteSelection {
  const source = asRecord(value, `notes[${String(index)}]`);
  return {
    id: requiredId(source.id, `notes[${String(index)}].id`, "P"),
    priority: priority(source.priority),
    sections: stringList(source.sections, `notes[${String(index)}].sections`),
    reason: reason(source.reason)
  };
}

function nodeSelection(value: unknown, index: number): PiConversationNodeSelection {
  const source = asRecord(value, `nodes[${String(index)}]`);
  const parts = stringList(source.parts, `nodes[${String(index)}].parts`);
  const normalized = parts.length === 0 ? ["answer"] : parts;
  for (const part of normalized) {
    if (part !== "question" && part !== "answer" && part !== "selection" && part !== "all") {
      throw new TypeError(`nodes[${String(index)}].parts contains an unsupported part: ${part}`);
    }
  }
  return {
    id: requiredId(source.id, `nodes[${String(index)}].id`, "N"),
    priority: priority(source.priority),
    parts: normalized as PiConversationNodePart[],
    reason: reason(source.reason)
  };
}

function focusScope(
  value: unknown,
  fallback: PiFocusScope
): PiFocusScope {
  return value === "selection_only" ||
    value === "containing_section" ||
    value === "source_message" ||
    value === "latest_round" ||
    value === "full_source"
    ? value
    : fallback;
}

function focusAnchorId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^F[1-9][0-9]*$/u.test(value.trim())) {
    throw new TypeError(`${label} must be an F-prefixed focus anchor ID`);
  }
  return value.trim();
}

function focusDecision(
  value: unknown,
  index: number,
  fallback: PiFocusScope
): PiFocusDecision {
  const source = asRecord(value, `focus[${String(index)}]`);
  return {
    anchorId: focusAnchorId(source.id, `focus[${String(index)}].id`),
    scope: focusScope(source.scope, fallback),
    reason: reason(source.reason)
  };
}

function focusDecisions(
  value: unknown,
  fallback: PiFocusScope
): PiFocusDecision[] {
  if (!Array.isArray(value)) return [];
  const decisions = value.map((entry, index) =>
    focusDecision(entry, index, fallback)
  );
  const merged = new Map<string, PiFocusDecision>();
  for (const decision of decisions) merged.set(decision.anchorId, decision);
  return [...merged.values()];
}

function focusSelection(
  value: unknown,
  fallback: PiFocusScope
): { scope: PiFocusScope; reason: string } {
  if (value === undefined) return { scope: fallback, reason: "" };
  const source = asRecord(value, "focus");
  return {
    scope: focusScope(source.scope, fallback),
    reason: reason(source.reason)
  };
}

function jsonObjectText(value: string): string {
  const trimmed = value.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "")
    .trim();
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new TypeError("Pi context selection must contain a valid JSON object");
  }
  return unfenced.slice(start, end + 1);
}

export function parsePiContextSelection(
  value: string,
  fallbackFocusScope: PiFocusScope = "latest_round"
): PiContextSelection {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonObjectText(value)) as unknown;
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError("Pi context selection is not valid JSON", {
      cause: error
    });
  }
  const source = asRecord(parsed, "selection");
  const rawNotes = source.notes ?? [];
  const rawNodes = source.nodes ?? [];
  if (!Array.isArray(rawNotes) || !Array.isArray(rawNodes)) {
    throw new TypeError("selection.notes and selection.nodes must be arrays");
  }
  const decisions = focusDecisions(source.focus, fallbackFocusScope);
  const focus = Array.isArray(source.focus)
    ? { scope: fallbackFocusScope, reason: "" }
    : focusSelection(source.focus, fallbackFocusScope);
  return mergePiContextSelections(
    {
      focusScope: focus.scope,
      focusReason: focus.reason,
      focusDecisions: decisions,
      notes: rawNotes.map(noteSelection),
      nodes: rawNodes.map(nodeSelection)
    },
    {
      focusScope: focus.scope,
      focusReason: "",
      focusDecisions: [],
      notes: [],
      nodes: []
    }
  );
}

export function parsePiNeedMoreContext(
  value: string
): PiNeedMoreContextRequest | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonObjectText(value)) as unknown;
  } catch {
    return undefined;
  }
  const source = asRecord(parsed, "supplementary response");
  if (source.status !== "need_more_context") return undefined;
  if (typeof source.missing !== "string" || source.missing.trim().length === 0) {
    throw new TypeError(
      "supplementary response.missing must describe the missing evidence"
    );
  }
  return {
    status: "need_more_context",
    missing: source.missing.trim().slice(0, 1_000)
  };
}

function strongerPriority(
  left: PiContextPriority,
  right: PiContextPriority
): PiContextPriority {
  return PRIORITY_ORDER[left] <= PRIORITY_ORDER[right] ? left : right;
}

export function mergePiContextSelections(
  first: PiContextSelection,
  second: PiContextSelection
): PiContextSelection {
  const focusDecisions = new Map<string, PiFocusDecision>();
  for (const decision of [
    ...(first.focusDecisions ?? []),
    ...(second.focusDecisions ?? [])
  ]) {
    focusDecisions.set(decision.anchorId, { ...decision });
  }
  const notes = new Map<string, PiNoteSelection>();
  for (const selection of [...first.notes, ...second.notes]) {
    const existing = notes.get(selection.id);
    if (existing === undefined) {
      notes.set(selection.id, {
        ...selection,
        sections: [...selection.sections]
      });
      continue;
    }
    const wholeNote = existing.sections.length === 0 || selection.sections.length === 0;
    notes.set(selection.id, {
      id: selection.id,
      priority: strongerPriority(existing.priority, selection.priority),
      sections: wholeNote
        ? []
        : [...new Set([...existing.sections, ...selection.sections])],
      reason: [existing.reason, selection.reason].filter(Boolean).join("; ").slice(0, 500)
    });
  }

  const nodes = new Map<string, PiConversationNodeSelection>();
  for (const selection of [...first.nodes, ...second.nodes]) {
    const existing = nodes.get(selection.id);
    if (existing === undefined) {
      nodes.set(selection.id, { ...selection, parts: [...selection.parts] });
      continue;
    }
    const all = existing.parts.includes("all") || selection.parts.includes("all");
    nodes.set(selection.id, {
      id: selection.id,
      priority: strongerPriority(existing.priority, selection.priority),
      parts: all ? ["all"] : [...new Set([...existing.parts, ...selection.parts])],
      reason: [existing.reason, selection.reason].filter(Boolean).join("; ").slice(0, 500)
    });
  }

  return {
    focusScope: first.focusScope ?? second.focusScope ?? "latest_round",
    focusReason: [first.focusReason ?? "", second.focusReason ?? ""]
      .filter(Boolean)
      .join("; ")
      .slice(0, 500),
    focusDecisions: [...focusDecisions.values()],
    notes: [...notes.values()],
    nodes: [...nodes.values()]
  };
}

export function priorityRank(value: PiContextPriority): number {
  return PRIORITY_ORDER[value];
}
