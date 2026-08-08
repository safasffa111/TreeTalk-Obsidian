import type { MetadataCache, TFile, Vault } from "obsidian";
import type {
  NoteLinkResolver,
  ReadNoteResult,
  ResolvedNoteLink
} from "../domain/note-link-graph";

interface FileLike {
  path: string;
  name: string;
  extension?: string;
}

function markdownFile(value: unknown): value is FileLike {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<FileLike>;
  const extension = candidate.extension?.toLocaleLowerCase();
  return (
    typeof candidate.path === "string" &&
    typeof candidate.name === "string" &&
    (extension === "md" || candidate.path.toLocaleLowerCase().endsWith(".md"))
  );
}

export class ObsidianNoteLinkResolver implements NoteLinkResolver {
  private backlinkPathsByTarget: Map<string, string[]> | undefined;

  constructor(
    private readonly vault: Pick<Vault, "getAbstractFileByPath" | "cachedRead">,
    private readonly metadataCache: Pick<
      MetadataCache,
      "getFirstLinkpathDest" | "resolvedLinks"
    >
  ) {}

  resolveLink(linkText: string, sourcePath: string): ResolvedNoteLink | undefined {
    const file = this.metadataCache.getFirstLinkpathDest(linkText, sourcePath);
    if (!markdownFile(file)) return undefined;
    return { filePath: file.path, fileName: file.name };
  }

  findBacklinks(filePath: string): ResolvedNoteLink[] {
    const normalizedTarget = filePath.replace(/\\/gu, "/").replace(/^\.\//u, "");
    const backlinks: ResolvedNoteLink[] = [];
    for (const sourcePath of this.backlinkIndex().get(normalizedTarget) ?? []) {
      const file = this.vault.getAbstractFileByPath(sourcePath);
      if (!markdownFile(file)) continue;
      backlinks.push({ filePath: file.path, fileName: file.name });
    }
    return backlinks.sort((left, right) =>
      left.filePath.localeCompare(right.filePath, undefined, {
        sensitivity: "base"
      })
    );
  }

  private backlinkIndex(): Map<string, string[]> {
    if (this.backlinkPathsByTarget !== undefined) {
      return this.backlinkPathsByTarget;
    }
    const index = new Map<string, string[]>();
    for (const [sourcePath, targets] of Object.entries(
      this.metadataCache.resolvedLinks ?? {}
    )) {
      for (const [targetPath, count] of Object.entries(targets)) {
        if (count <= 0) continue;
        const normalizedTarget = targetPath
          .replace(/\\/gu, "/")
          .replace(/^\.\//u, "");
        const sources = index.get(normalizedTarget) ?? [];
        if (!sources.includes(sourcePath)) sources.push(sourcePath);
        index.set(normalizedTarget, sources);
      }
    }
    this.backlinkPathsByTarget = index;
    return index;
  }

  async readMarkdown(filePath: string): Promise<ReadNoteResult> {
    const file = this.vault.getAbstractFileByPath(filePath);
    if (!markdownFile(file)) throw new Error(`Markdown note not found: ${filePath}`);
    const sourceText = await this.vault.cachedRead(file as TFile);
    return {
      filePath: file.path,
      fileName: file.name,
      sourceText
    };
  }
}
