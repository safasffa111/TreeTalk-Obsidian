import { sha256Hex, stripYamlFrontmatter } from "./note-snapshot";
import { logWarning } from "../utils/error-log";
import type {
  NoteContextGraphEdge,
  NoteContextGraphNode,
  NoteContextGraphSnapshot,
  NoteContextTokenBudget,
  RelatedNoteDepth,
  UnresolvedNoteLink
} from "./types";

export interface ExtractedForwardNoteLink {
  target: string;
  label: string;
}

export interface ResolvedNoteLink {
  filePath: string;
  fileName: string;
}

export interface ReadNoteResult extends ResolvedNoteLink {
  sourceText: string;
}

export interface NoteLinkResolver {
  resolveLink(
    linkText: string,
    sourcePath: string
  ): ResolvedNoteLink | undefined | Promise<ResolvedNoteLink | undefined>;
  findBacklinks?(
    filePath: string
  ): ResolvedNoteLink[] | Promise<ResolvedNoteLink[]>;
  readMarkdown(filePath: string): Promise<ReadNoteResult>;
}

export interface NoteLinkGraphRoot {
  filePath: string;
  fileName: string;
  sourceText: string;
}

export interface BuildNoteLinkGraphInput {
  roots: NoteLinkGraphRoot[];
  relatedNotesEnabled: boolean;
  fullNoteContext: boolean;
  perNoteBudget: NoteContextTokenBudget;
  maxDepth: RelatedNoteDepth;
  builtAt: string;
  resolver: NoteLinkResolver;
}

function withoutCode(markdown: string): string {
  const lines = markdown.replace(/\r\n?/gu, "\n").split("\n");
  let fence: string | undefined;
  return lines
    .map((line) => {
      const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/u);
      if (fence !== undefined) {
        if (fenceMatch !== null && (fenceMatch[1]?.[0] ?? "") === fence[0]) {
          fence = undefined;
        }
        return "";
      }
      if (fenceMatch !== null) {
        fence = fenceMatch[1];
        return "";
      }
      return line.replace(/`+[^`\n]*`+/gu, "");
    })
    .join("\n");
}

function stripFragment(target: string): string {
  const fragment = target.search(/[#^]/u);
  return (fragment < 0 ? target : target.slice(0, fragment)).trim();
}

function defaultWikiLabel(targetWithFragment: string): string {
  const target = stripFragment(targetWithFragment);
  return target.split("/").at(-1)?.trim() ?? target;
}

function markdownDestination(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  let destination: string;
  if (trimmed.startsWith("<")) {
    const close = trimmed.indexOf(">");
    if (close < 0) return undefined;
    destination = trimmed.slice(1, close);
  } else {
    destination = trimmed.split(/\s+/u)[0] ?? "";
  }
  try {
    destination = decodeURIComponent(destination);
  } catch {
    // Keep malformed percent escapes as written so Obsidian can attempt resolution.
  }
  if (
    destination.length === 0 ||
    destination.startsWith("#") ||
    destination.startsWith("//") ||
    /^[a-z][a-z0-9+.-]*:/iu.test(destination)
  ) {
    return undefined;
  }
  const target = stripFragment(destination);
  return target.length === 0 ? undefined : target;
}

export function extractForwardNoteLinks(
  markdown: string
): ExtractedForwardNoteLink[] {
  const source = withoutCode(markdown);
  const matches: Array<{ index: number; link: ExtractedForwardNoteLink }> = [];
  for (const match of source.matchAll(/!?\[\[([^\]\n]+)\]\]/gu)) {
    const inner = match[1] ?? "";
    const separator = inner.indexOf("|");
    const rawTarget = (separator < 0 ? inner : inner.slice(0, separator)).trim();
    const target = stripFragment(rawTarget);
    if (target.length === 0) continue;
    const alias = separator < 0 ? "" : inner.slice(separator + 1).trim();
    matches.push({
      index: match.index ?? 0,
      link: {
        target,
        label: alias.length > 0 ? alias : defaultWikiLabel(rawTarget)
      }
    });
  }
  for (const match of source.matchAll(/!?\[([^\]\n]*)\]\(([^)\n]+)\)/gu)) {
    const target = markdownDestination(match[2] ?? "");
    if (target === undefined) continue;
    const label = (match[1] ?? "").trim();
    matches.push({
      index: match.index ?? 0,
      link: {
        target,
        label: label.length > 0 ? label : defaultWikiLabel(target)
      }
    });
  }
  return matches
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.link);
}

function normalizePathKey(path: string): string {
  return path.replace(/\\/gu, "/").replace(/^\.\//u, "");
}

async function graphNode(
  id: string,
  source: ReadNoteResult,
  depth: number,
  root: boolean,
  primaryParentId?: string,
  primaryChain?: string[]
): Promise<NoteContextGraphNode> {
  const content = stripYamlFrontmatter(source.sourceText).content;
  return {
    id,
    filePath: normalizePathKey(source.filePath),
    fileName: source.fileName,
    content,
    contentHash: await sha256Hex(content),
    depth,
    root,
    ...(primaryParentId === undefined ? {} : { primaryParentId }),
    primaryChain: primaryChain ?? [id],
    parentIds: [],
    outgoingNodeIds: []
  };
}

function canExpand(depth: number, maxDepth: RelatedNoteDepth): boolean {
  return maxDepth === "unlimited" || depth < maxDepth;
}

function addUnique<T>(values: T[], value: T): void {
  if (!values.includes(value)) values.push(value);
}

interface RelatedNoteCandidate {
  neighbor: ResolvedNoteLink;
  edgeSourcePath: string;
  edgeTargetPath: string;
  labels: string[];
}

function defaultResolvedLabel(fileName: string): string {
  return fileName.replace(/\.md$/iu, "");
}

async function labelsPointingTo(
  sourceNode: NoteContextGraphNode,
  targetPath: string,
  resolver: NoteLinkResolver
): Promise<string[]> {
  const labels: string[] = [];
  for (const link of extractForwardNoteLinks(sourceNode.content)) {
    let resolved: ResolvedNoteLink | undefined;
    try {
      resolved = await resolver.resolveLink(link.target, sourceNode.filePath);
    } catch {
      resolved = undefined;
    }
    if (
      resolved !== undefined &&
      normalizePathKey(resolved.filePath) === targetPath
    ) {
      addUnique(labels, link.label);
    }
  }
  return labels;
}

export async function buildNoteLinkGraph(
  input: BuildNoteLinkGraphInput
): Promise<NoteContextGraphSnapshot> {
  const nodes: NoteContextGraphNode[] = [];
  const nodeByPath = new Map<string, NoteContextGraphNode>();
  const rootNodeIds: string[] = [];
  const edges: NoteContextGraphEdge[] = [];
  const edgeByPair = new Map<string, NoteContextGraphEdge>();
  const unresolvedLinks: UnresolvedNoteLink[] = [];
  const queue: NoteContextGraphNode[] = [];

  for (const root of input.roots) {
    const pathKey = normalizePathKey(root.filePath);
    const existing = nodeByPath.get(pathKey);
    if (existing !== undefined) {
      existing.root = true;
      addUnique(rootNodeIds, existing.id);
      continue;
    }
    const id = `N${String(nodes.length)}`;
    const node = await graphNode(
      id,
      { ...root, filePath: pathKey },
      0,
      true
    );
    nodes.push(node);
    nodeByPath.set(pathKey, node);
    rootNodeIds.push(id);
    queue.push(node);
  }

  if (input.relatedNotesEnabled) {
    for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
      const sourceNode = queue[queueIndex];
      if (sourceNode === undefined || !canExpand(sourceNode.depth, input.maxDepth)) {
        continue;
      }
      const candidates: RelatedNoteCandidate[] = [];
      const links = extractForwardNoteLinks(sourceNode.content);
      for (const link of links) {
        let resolved: ResolvedNoteLink | undefined;
        try {
          resolved = await input.resolver.resolveLink(link.target, sourceNode.filePath);
        } catch {
          resolved = undefined;
        }
        if (resolved === undefined) {
          unresolvedLinks.push({
            sourceNodeId: sourceNode.id,
            target: link.target,
            label: link.label,
            reason: "unresolved"
          });
          continue;
        }
        const resolvedPath = normalizePathKey(resolved.filePath);
        if (!/\.md$/iu.test(resolvedPath)) {
          unresolvedLinks.push({
            sourceNodeId: sourceNode.id,
            target: link.target,
            label: link.label,
            reason: "non-markdown"
          });
          continue;
        }
        candidates.push({
          neighbor: {
            filePath: resolvedPath,
            fileName: resolved.fileName
          },
          edgeSourcePath: sourceNode.filePath,
          edgeTargetPath: resolvedPath,
          labels: [link.label]
        });
      }

      let backlinks: ResolvedNoteLink[] = [];
      try {
        backlinks = await input.resolver.findBacklinks?.(sourceNode.filePath) ?? [];
      } catch {
        backlinks = [];
      }
      for (const backlink of backlinks) {
        const backlinkPath = normalizePathKey(backlink.filePath);
        if (!/\.md$/iu.test(backlinkPath)) continue;
        candidates.push({
          neighbor: {
            filePath: backlinkPath,
            fileName: backlink.fileName
          },
          edgeSourcePath: backlinkPath,
          edgeTargetPath: sourceNode.filePath,
          labels: []
        });
      }

      candidates.sort((left, right) => {
        const neighborOrder = left.neighbor.filePath.localeCompare(
          right.neighbor.filePath,
          undefined,
          { sensitivity: "base" }
        );
        if (neighborOrder !== 0) return neighborOrder;
        const sourceOrder = left.edgeSourcePath.localeCompare(
          right.edgeSourcePath,
          undefined,
          { sensitivity: "base" }
        );
        if (sourceOrder !== 0) return sourceOrder;
        return left.edgeTargetPath.localeCompare(
          right.edgeTargetPath,
          undefined,
          { sensitivity: "base" }
        );
      });

      for (const candidate of candidates) {
        const neighborPath = candidate.neighbor.filePath;
        let neighborNode = nodeByPath.get(neighborPath);
        if (neighborNode === undefined) {
          let read: ReadNoteResult;
          try {
            read = await input.resolver.readMarkdown(neighborPath);
          } catch (error) {
            logWarning(`读取关联笔记失败: ${neighborPath}`, error);
            unresolvedLinks.push({
              sourceNodeId: sourceNode.id,
              target: neighborPath,
              label: candidate.labels[0] ?? defaultResolvedLabel(candidate.neighbor.fileName),
              reason: "unreadable"
            });
            continue;
          }
          const id = `N${String(nodes.length)}`;
          neighborNode = await graphNode(
            id,
            {
              ...read,
              filePath: neighborPath,
              fileName: candidate.neighbor.fileName
            },
            sourceNode.depth + 1,
            false,
            sourceNode.id,
            [...sourceNode.primaryChain, id]
          );
          nodes.push(neighborNode);
          nodeByPath.set(neighborPath, neighborNode);
          queue.push(neighborNode);
        }

        const edgeSourceNode = nodeByPath.get(candidate.edgeSourcePath);
        const edgeTargetNode = nodeByPath.get(candidate.edgeTargetPath);
        if (edgeSourceNode === undefined || edgeTargetNode === undefined) {
          continue;
        }
        addUnique(edgeTargetNode.parentIds, edgeSourceNode.id);
        addUnique(edgeSourceNode.outgoingNodeIds, edgeTargetNode.id);

        const labels = [...candidate.labels];
        if (labels.length === 0) {
          for (const label of await labelsPointingTo(
            edgeSourceNode,
            edgeTargetNode.filePath,
            input.resolver
          )) {
            addUnique(labels, label);
          }
        }
        if (labels.length === 0) {
          labels.push(defaultResolvedLabel(edgeTargetNode.fileName));
        }

        const edgeKey = `${edgeSourceNode.id}\u0000${edgeTargetNode.id}`;
        const existingEdge = edgeByPair.get(edgeKey);
        if (existingEdge === undefined) {
          const edge: NoteContextGraphEdge = {
            sourceNodeId: edgeSourceNode.id,
            targetNodeId: edgeTargetNode.id,
            labels
          };
          edgeByPair.set(edgeKey, edge);
          edges.push(edge);
        } else {
          for (const label of labels) addUnique(existingEdge.labels, label);
        }
      }
    }
  }

  return {
    protocol: "note-context-graph:v1",
    rootNodeIds,
    fullNoteContext: input.fullNoteContext,
    relatedNotesEnabled: input.relatedNotesEnabled,
    perNoteBudget: input.perNoteBudget,
    maxDepth: input.maxDepth,
    builtAt: input.builtAt,
    nodes,
    edges,
    unresolvedLinks
  };
}
