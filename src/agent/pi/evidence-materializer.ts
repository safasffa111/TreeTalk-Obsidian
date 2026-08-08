import { estimateTextTokens } from "../../domain/context-engine";
import type { PiContextWorkspace } from "./context-workspace";
import { sha256Hex } from "./cache-identity";
import { compareStable } from "./cache-identity";
import {
  priorityRank,
  type PiContextPriority,
  type PiContextSelection
} from "./context-selection";

export interface PiEvidenceMaterializerOptions {
  tokenBudget: number;
  alreadyMaterializedKeys?: ReadonlySet<string>;
  excludedNotePaths?: ReadonlySet<string>;
  excludedNodeIds?: ReadonlySet<string>;
}

export interface PiEvidenceOmission {
  sourceId: string;
  reason: string;
}

export interface PiMaterializedEvidence {
  markdown: string;
  evidenceHash: string;
  estimatedTokens: number;
  tokenBudget: number;
  selectedNoteCount: number;
  selectedNodeCount: number;
  materializedNotePaths: string[];
  materializedNodeIds: string[];
  materializedKeys: string[];
  omitted: PiEvidenceOmission[];
  truncated: boolean;
}

interface EvidenceCandidate {
  key: string;
  sourceId: string;
  priority: PiContextPriority;
  sourceKind: "note" | "node";
  notePath?: string;
  nodeId?: string;
  header: string;
  content: string;
}

function clean(value: string): string {
  return value.replace(/\r\n?/gu, "\n").trim();
}

export function clipMarkdownToTokenBudget(
  header: string,
  content: string,
  tokenBudget: number
): { text: string; tokens: number; truncated: boolean } | undefined {
  const normalized = clean(content);
  if (normalized.length === 0 || tokenBudget <= 0) return undefined;
  const full = `${header}\n\n${normalized}`;
  const fullTokens = estimateTextTokens(full);
  if (fullTokens <= tokenBudget) {
    return { text: full, tokens: fullTokens, truncated: false };
  }

  const marker = "\n\n…（证据已按本轮 Token 预算截断）";
  const paragraphs = normalized.split(/\n{2,}/u);
  const included: string[] = [];
  for (const paragraph of paragraphs) {
    const candidate = `${header}\n\n${[...included, paragraph].join("\n\n")}${marker}`;
    if (estimateTextTokens(candidate) > tokenBudget) break;
    included.push(paragraph);
  }
  if (included.length > 0) {
    const text = `${header}\n\n${included.join("\n\n")}${marker}`;
    return {
      text,
      tokens: estimateTextTokens(text),
      truncated: true
    };
  }

  let low = 0;
  let high = normalized.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = `${header}\n\n${normalized.slice(0, middle).trimEnd()}${marker}`;
    if (estimateTextTokens(candidate) <= tokenBudget) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  if (low <= 0) return undefined;
  const text = `${header}\n\n${normalized.slice(0, low).trimEnd()}${marker}`;
  return { text, tokens: estimateTextTokens(text), truncated: true };
}

function noteCandidates(
  workspace: PiContextWorkspace,
  selection: PiContextSelection,
  omitted: PiEvidenceOmission[]
): EvidenceCandidate[] {
  const candidates: EvidenceCandidate[] = [];
  for (const note of selection.notes) {
    let node;
    try {
      node = workspace.resolveNoteId(note.id);
    } catch (error) {
      omitted.push({
        sourceId: note.id,
        reason: error instanceof Error ? error.message : String(error)
      });
      continue;
    }
    if (note.sections.length === 0) {
      candidates.push({
        key: `note:${node.filePath}:full`,
        sourceId: note.id,
        priority: note.priority,
        sourceKind: "note",
        notePath: node.filePath,
        header: `## ${note.id} · ${node.fileName}\n\n- 路径：${node.filePath}\n- 范围：整篇笔记`,
        content: node.content
      });
      continue;
    }
    for (const requestedHeading of note.sections) {
      try {
        const section = workspace.noteSection(note.id, requestedHeading);
        candidates.push({
          key: `note:${node.filePath}:section:${section.heading.toLowerCase()}`,
          sourceId: note.id,
          priority: note.priority,
          sourceKind: "note",
          notePath: node.filePath,
          header: `## ${note.id} · ${node.fileName} / ${section.heading}\n\n- 路径：${node.filePath}`,
          content: section.content
        });
      } catch (error) {
        omitted.push({
          sourceId: note.id,
          reason: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }
  return candidates;
}

function nodeCandidates(
  workspace: PiContextWorkspace,
  selection: PiContextSelection,
  omitted: PiEvidenceOmission[]
): EvidenceCandidate[] {
  const candidates: EvidenceCandidate[] = [];
  for (const selectedNode of selection.nodes) {
    for (const part of selectedNode.parts) {
      try {
        const resolved = workspace.conversationNodePart(selectedNode.id, part);
        if (resolved.content.trim().length === 0) {
          omitted.push({
            sourceId: selectedNode.id,
            reason: `TreeTalk node ${selectedNode.id} has no ${part} content`
          });
          continue;
        }
        candidates.push({
          key: `node:${resolved.node.id}:${part}`,
          sourceId: selectedNode.id,
          priority: selectedNode.priority,
          sourceKind: "node",
          nodeId: resolved.node.id,
          header: `## ${selectedNode.id} · ${resolved.node.title} / ${resolved.label}`,
          content: resolved.content
        });
      } catch (error) {
        omitted.push({
          sourceId: selectedNode.id,
          reason: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }
  return candidates;
}

export function materializePiEvidence(
  workspace: PiContextWorkspace,
  selection: PiContextSelection,
  options: PiEvidenceMaterializerOptions
): PiMaterializedEvidence {
  const tokenBudget = Math.max(0, Math.trunc(options.tokenBudget));
  const omitted: PiEvidenceOmission[] = [];
  const already = options.alreadyMaterializedKeys ?? new Set<string>();
  const excludedNotePaths = options.excludedNotePaths ?? new Set<string>();
  const excludedNodeIds = options.excludedNodeIds ?? new Set<string>();
  const candidates = [
    ...noteCandidates(workspace, selection, omitted),
    ...nodeCandidates(workspace, selection, omitted)
  ]
    .filter((candidate, index, all) =>
      !already.has(candidate.key) &&
      (candidate.notePath === undefined || !excludedNotePaths.has(candidate.notePath)) &&
      (candidate.nodeId === undefined || !excludedNodeIds.has(candidate.nodeId)) &&
      all.findIndex((entry) => entry.key === candidate.key) === index
    )
    .sort((left, right) => {
      const priorityDifference =
        priorityRank(left.priority) - priorityRank(right.priority);
      if (priorityDifference !== 0) return priorityDifference;
      const kindDifference =
        (left.sourceKind === "node" ? 0 : 1) -
        (right.sourceKind === "node" ? 0 : 1);
      if (kindDifference !== 0) return kindDifference;
      const sourceDifference = compareStable(left.sourceId, right.sourceId);
      if (sourceDifference !== 0) return sourceDifference;
      return compareStable(left.key, right.key);
    });

  const documentHeader = "# Selected Evidence";
  const emptyDocument = `${documentHeader}\n\nNo source body was materialized.`;
  const headerTokens = estimateTextTokens(`${documentHeader}\n\n`);
  const blocks: string[] = [];
  const materializedNotePaths = new Set<string>();
  const materializedNodeIds = new Set<string>();
  const materializedKeys: string[] = [];
  let estimatedTokens = Math.min(headerTokens, tokenBudget);
  let truncated = tokenBudget < headerTokens;

  for (const candidate of candidates) {
    const separatorTokens = blocks.length === 0 ? 0 : estimateTextTokens("\n\n---\n\n");
    const remaining = tokenBudget - estimatedTokens - separatorTokens;
    if (remaining <= 0) {
      omitted.push({ sourceId: candidate.sourceId, reason: "Evidence token budget exhausted" });
      truncated = true;
      continue;
    }
    const clipped = clipMarkdownToTokenBudget(
      candidate.header,
      candidate.content,
      remaining
    );
    if (clipped === undefined) {
      omitted.push({ sourceId: candidate.sourceId, reason: "Insufficient remaining evidence budget" });
      truncated = true;
      continue;
    }
    blocks.push(clipped.text);
    estimatedTokens += separatorTokens + clipped.tokens;
    truncated ||= clipped.truncated;
    materializedKeys.push(candidate.key);
    if (candidate.notePath !== undefined) materializedNotePaths.add(candidate.notePath);
    if (candidate.nodeId !== undefined) materializedNodeIds.add(candidate.nodeId);
  }

  const markdown =
    blocks.length === 0
      ? emptyDocument
      : `${documentHeader}\n\n${blocks.join("\n\n---\n\n")}`;
  return {
    markdown,
    evidenceHash: sha256Hex(markdown),
    estimatedTokens:
      blocks.length === 0
        ? Math.min(estimateTextTokens(emptyDocument), tokenBudget)
        : estimatedTokens,
    tokenBudget,
    selectedNoteCount: selection.notes.length,
    selectedNodeCount: selection.nodes.length,
    materializedNotePaths: [...materializedNotePaths],
    materializedNodeIds: [...materializedNodeIds],
    materializedKeys,
    omitted,
    truncated
  };
}
