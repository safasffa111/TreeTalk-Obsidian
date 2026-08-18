import { normalizePath, type Vault } from "obsidian";
import { isVaultRelativeMarkdownPath } from "../domain/anchor-path";

/**
 * Obsidian Vault 文件目录适配器：把锚点状态判定需要的 I/O 适配到领域 Port。
 *
 * 仅暴露给领域层使用：
 * - `resolveCurrentPath(path)`：精确路径查询（getAbstractFileByPath + 规范化）。
 * - `getCtime(path)`：读取指定路径文件的 ctime（毫秒）。
 * - `findCandidatesByCtime(ctime)`：列出当前 Vault 中所有 ctime 等于给定值的 Markdown 文件。
 *
 * 不 import 任何领域类型，使用结构化 duck typing 以便测试中 mock。
 */
interface VaultFileLike {
  path: string;
  stat?: { ctime?: unknown } | null;
}

function isVaultFile(value: unknown): value is VaultFileLike {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { path?: unknown; stat?: unknown };
  return typeof candidate.path === "string" && typeof candidate.stat === "object" && candidate.stat !== null;
}

export class ObsidianAnchorFileIndex {
  constructor(private readonly vault: Pick<Vault, "getAbstractFileByPath" | "getMarkdownFiles">) {}

  resolveCurrentPath(filePath: string): string | undefined {
    if (!isVaultRelativeMarkdownPath(filePath)) return undefined;
    const normalized = normalizePath(filePath);
    const abstract = this.vault.getAbstractFileByPath(normalized);
    if (abstract === null || abstract === undefined) return undefined;
    if (!isVaultFile(abstract)) return undefined;
    const resolvedPath = normalizePath(abstract.path);
    return isVaultRelativeMarkdownPath(resolvedPath) ? resolvedPath : undefined;
  }

  getCtime(filePath: string): number | undefined {
    if (!isVaultRelativeMarkdownPath(filePath)) return undefined;
    const abstract = this.vault.getAbstractFileByPath(normalizePath(filePath));
    if (abstract === null || abstract === undefined) return undefined;
    if (!isVaultFile(abstract) || !isVaultRelativeMarkdownPath(abstract.path)) return undefined;
    const stat = (abstract as VaultFileLike).stat;
    if (typeof stat !== "object" || stat === null) return undefined;
    const ctime = (stat as { ctime?: unknown }).ctime;
    if (typeof ctime !== "number" || !Number.isFinite(ctime)) return undefined;
    return ctime;
  }

  findCandidatesByCtime(ctime: number): string[] {
    const files = this.vault.getMarkdownFiles();
    const matches: string[] = [];
    for (const file of files) {
      const stat = (file as { stat?: { ctime?: unknown } }).stat;
      const candidate = typeof stat === "object" && stat !== null ? stat.ctime : undefined;
      const path = normalizePath(file.path);
      if (candidate === ctime && isVaultRelativeMarkdownPath(path)) {
        matches.push(path);
      }
    }
    matches.sort();
    return matches;
  }
}
