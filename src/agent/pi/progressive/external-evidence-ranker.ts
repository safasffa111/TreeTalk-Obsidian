import { estimateTextTokens } from "../../../domain/context-engine";
import { renderConversationNodeTranscript } from "../context-index";
import { sha256Hex } from "../cache-identity";
import { compareStable } from "../cache-identity";
import { splitMarkdownIntoLogicalSections } from "./section-locator";
import type { ProgressiveContextSnapshot, ProgressiveSourceKind } from "./types";

export interface ExternalEvidenceScoreBreakdown {
  structuralProximity: number;
  titleMatch: number;
  headingMatch: number;
  bodyKeywordMatch: number;
  explicitLinkBonus: number;
  prerequisiteOrConclusionBonus: number;
  distancePenalty: number;
  lengthPenalty: number;
}

export interface RankedExternalEvidenceCandidate {
  key: string;
  level: 3 | 4;
  sourceKind: ProgressiveSourceKind;
  sourceId: string;
  sourceRevision: string;
  title: string;
  relationship: string;
  content: string;
  estimatedTokens: number;
  relatedNote: boolean;
  notePaths: string[];
  nodeIds: string[];
  score: number;
  scoreBreakdown: ExternalEvidenceScoreBreakdown;
}

export interface RankExternalEvidenceInput {
  question: string;
  targetText: string;
  relatedNotesAllowed: boolean;
  snapshot: ProgressiveContextSnapshot;
}

function lexicalTerms(value: string): string[] {
  const lowered = value.toLowerCase();
  const result = new Set<string>();
  for (const word of lowered.match(/[a-z0-9_]{2,}/gu) ?? []) result.add(word);
  for (const block of lowered.match(/[\p{Script=Han}]+/gu) ?? []) {
    if (block.length === 1) result.add(block);
    for (let index = 0; index < block.length - 1; index += 1) {
      result.add(block.slice(index, index + 2));
    }
  }
  return [...result].slice(0, 48);
}

function overlapCount(content: string, terms: readonly string[]): number {
  const lowered = content.toLowerCase();
  return terms.reduce((count, term) => count + (lowered.includes(term) ? 1 : 0), 0);
}

function scoreCandidate(input: {
  title: string;
  heading: string;
  body: string;
  terms: string[];
  distance: number;
  relatedNote: boolean;
  linked: boolean;
}): { score: number; breakdown: ExternalEvidenceScoreBreakdown } {
  const titleHits = overlapCount(input.title, input.terms);
  const headingHits = overlapCount(input.heading, input.terms);
  const bodyHits = overlapCount(input.body, input.terms);
  const estimatedTokens = estimateTextTokens(input.body);
  const structuralProximity = input.relatedNote ? Math.max(10, 52 - input.distance * 8) : Math.max(20, 90 - input.distance * 14);
  const titleMatch = titleHits * 22;
  const headingMatch = headingHits * 30;
  const bodyKeywordMatch = Math.min(
    80,
    Math.round((bodyHits / Math.max(1, estimatedTokens)) * 320)
  );
  const explicitLinkBonus = input.linked ? 15 : 0;
  const prerequisiteOrConclusionBonus = /(定义|前提|基础|结论|总结|definition|conclusion|summary)/iu.test(`${input.heading} ${input.body.slice(0, 160)}`) ? 30 : 0;
  const lengthPenalty = Math.max(0, estimatedTokens - 800) * 0.01;
  const distancePenalty = Math.max(0, input.distance - 1) * 6;
  const breakdown = {
    structuralProximity,
    titleMatch,
    headingMatch,
    bodyKeywordMatch,
    explicitLinkBonus,
    prerequisiteOrConclusionBonus,
    distancePenalty,
    lengthPenalty
  };
  return {
    score:
      structuralProximity +
      titleMatch +
      headingMatch +
      bodyKeywordMatch +
      explicitLinkBonus +
      prerequisiteOrConclusionBonus -
      distancePenalty -
      lengthPenalty,
    breakdown
  };
}

export function rankExternalEvidenceCandidates(
  input: RankExternalEvidenceInput
): RankedExternalEvidenceCandidate[] {
  const terms = lexicalTerms(`${input.targetText} ${input.question}`);
  const candidates: RankedExternalEvidenceCandidate[] = [];
  const nodes = [...input.snapshot.conversationNodes].sort(
    (a, b) => a.depth - b.depth || compareStable(a.id, b.id)
  );
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const current = nodes.find((node) => node.current) ?? nodes.at(-1);
  const ancestorDistance = new Map<string, number>();
  let parentId = current?.parentId ?? null;
  let distance = 1;
  while (parentId !== null) {
    const parent = byId.get(parentId);
    if (parent === undefined || ancestorDistance.has(parent.id)) break;
    ancestorDistance.set(parent.id, distance);
    parentId = parent.parentId;
    distance += 1;
  }
  for (const node of nodes) {
    const nodeDistance = ancestorDistance.get(node.id);
    if (nodeDistance === undefined) continue;
    const distance = nodeDistance;
    const transcript = renderConversationNodeTranscript(node);
    for (const section of splitMarkdownIntoLogicalSections(transcript)) {
      const scored = scoreCandidate({ title: node.title, heading: section.heading, body: section.content, terms, distance, relatedNote: false, linked: false });
      candidates.push({
        key: `ancestor:${node.id}:section:${section.lineStart}:${section.endOffset}`,
        level: 3,
        sourceKind: "section",
        sourceId: node.id,
        sourceRevision: sha256Hex(`${node.id}\n${transcript}`),
        title: `${node.title} · ${section.heading}`,
        relationship: `ancestor-distance-${String(distance)}`,
        content: section.content,
        estimatedTokens: estimateTextTokens(section.content),
        relatedNote: false,
        notePaths: [],
        nodeIds: [node.id],
        score: scored.score,
        scoreBreakdown: scored.breakdown
      });
    }
    const fullScore = scoreCandidate({ title: node.title, heading: "完整节点", body: transcript, terms, distance, relatedNote: false, linked: false });
    candidates.push({
      key: `ancestor:${node.id}:full`, level: 4, sourceKind: "conversation-node", sourceId: node.id,
      sourceRevision: sha256Hex(`${node.id}\n${transcript}`), title: node.title,
      relationship: `ancestor-distance-${String(distance)}`, content: transcript,
      estimatedTokens: estimateTextTokens(transcript), relatedNote: false, notePaths: [], nodeIds: [node.id],
      score: fullScore.score, scoreBreakdown: fullScore.breakdown
    });
  }

  if (input.relatedNotesAllowed) {
    const edgeIds = new Set(input.snapshot.edges.flatMap((edge) => [edge.sourceNodeId, edge.targetNodeId]));
    for (const note of input.snapshot.notes) {
      if (note.root) continue;
      const distance = Math.max(1, note.depth);
      const linked = edgeIds.has(note.id);
      for (const section of splitMarkdownIntoLogicalSections(note.content)) {
        const scored = scoreCandidate({ title: note.fileName, heading: section.heading, body: section.content, terms, distance, relatedNote: true, linked });
        candidates.push({
          key: `note:${note.id}:section:${section.lineStart}:${section.endOffset}`,
          level: 3, sourceKind: "section", sourceId: note.id, sourceRevision: note.revision,
          title: `${note.fileName} · ${section.heading}`, relationship: `related-note-depth-${String(note.depth)}`,
          content: section.content, estimatedTokens: estimateTextTokens(section.content), relatedNote: true,
          notePaths: [note.filePath], nodeIds: [], score: scored.score, scoreBreakdown: scored.breakdown
        });
      }
      const fullScore = scoreCandidate({ title: note.fileName, heading: "完整笔记", body: note.content, terms, distance, relatedNote: true, linked });
      candidates.push({
        key: `note:${note.id}:full`, level: 4, sourceKind: "note", sourceId: note.id,
        sourceRevision: note.revision, title: note.fileName, relationship: `related-note-depth-${String(note.depth)}`,
        content: note.content, estimatedTokens: estimateTextTokens(note.content), relatedNote: true,
        notePaths: [note.filePath], nodeIds: [], score: fullScore.score, scoreBreakdown: fullScore.breakdown
      });
    }
  }
  return candidates.sort((left,right)=>right.score-left.score || compareStable(left.relationship, right.relationship) || compareStable(left.key, right.key));
}
