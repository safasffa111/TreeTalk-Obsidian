import { isVaultRelativeMarkdownPath } from "./anchor-path";

/**
 * 锚点状态判定与路径重映射（纯领域，不依赖 obsidian）。
 *
 * 锚点状态用于沉淀前的预检：
 * - `none` / `verified`：允许沉淀，`verified` 使用最新路径。
 * - 其他状态（`foreign-vault` / `legacy-unverified` / `missing` / `ambiguous`）：
 *   拒绝写入并在领域层抛出带 code 的错误，由 main 映射到中文 Notice。
 */

export type AnchorStatus =
  | { kind: "none" }
  | {
      kind: "verified";
      vaultId: string;
      filePath: string;
      fileCtime: number;
    }
  | { kind: "foreign-vault" }
  | { kind: "legacy-unverified" }
  | { kind: "missing" }
  | { kind: "ambiguous" };

export interface AnchorSnapshot {
  anchorFilePath?: string;
  anchorVaultId?: string;
  anchorFileCtime?: number;
}

export interface ClassifyAnchorOptions {
  currentVaultId: string;
  /**
   * 解析当前路径下文件是否存在；返回最新规范化路径或 undefined。
   * 适配器负责把 obsidian TFile 查询注入到领域层。
   */
  resolveCurrentPath?: (filePath: string) => string | undefined;
  /** 读取指定当前路径下的 ctime。 */
  resolveCtime?: (filePath: string) => number | undefined;
  /**
   * 当前 Vault 内按 ctime 查找候选 Markdown 文件路径。
   * 用于插件未运行期间 rename 后的恢复。
   */
  findCandidatesByCtime?: (ctime: number) => string[];
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      value
    )
  );
}

function isPositiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
  );
}

export function classifyAnchor(options: {
  conversation: AnchorSnapshot;
  currentVaultId: string;
  resolveCurrentPath?: (filePath: string) => string | undefined;
  resolveCtime?: (filePath: string) => number | undefined;
  findCandidatesByCtime?: (ctime: number) => string[];
}): AnchorStatus {
  const { conversation, currentVaultId } = options;
  const { anchorFilePath, anchorVaultId, anchorFileCtime } = conversation;
  // 没有任何锚点字段：未锚定对话保持旧行为。
  if (
    anchorFilePath === undefined &&
    anchorVaultId === undefined &&
    anchorFileCtime === undefined
  ) {
    return { kind: "none" };
  }
  // 只有路径：旧数据，不可自动归属当前 Vault。
  if (anchorFilePath !== undefined && anchorVaultId === undefined) {
    return { kind: "legacy-unverified" };
  }
  // 三元组齐全且 Vault 匹配：进入解析流程。
  if (
    anchorFilePath !== undefined &&
    isUuid(anchorVaultId) &&
    isPositiveInteger(anchorFileCtime)
  ) {
    if (!isVaultRelativeMarkdownPath(anchorFilePath)) {
      return { kind: "missing" };
    }
    if (anchorVaultId !== currentVaultId) {
      return { kind: "foreign-vault" };
    }
    return resolveVerifiedAnchor({
      vaultId: anchorVaultId,
      anchorFilePath,
      anchorFileCtime,
      ...(options.resolveCurrentPath === undefined
        ? {}
        : { resolveCurrentPath: options.resolveCurrentPath }),
      ...(options.resolveCtime === undefined
        ? {}
        : { resolveCtime: options.resolveCtime }),
      ...(options.findCandidatesByCtime === undefined
        ? {}
        : { findCandidatesByCtime: options.findCandidatesByCtime })
    });
  }
  // 部分三元组 / 字段非法：视为缺失，不能静默回退。
  return { kind: "missing" };
}

function resolveVerifiedAnchor(args: {
  vaultId: string;
  anchorFilePath: string;
  anchorFileCtime: number;
  resolveCurrentPath?: (path: string) => string | undefined;
  resolveCtime?: (path: string) => number | undefined;
  findCandidatesByCtime?: (ctime: number) => string[];
}): AnchorStatus {
  const { vaultId, anchorFilePath, anchorFileCtime } = args;
  // 无任何 resolver：保守信任存储的三元组，由调用方在沉淀前再校验。
  if (
    args.resolveCurrentPath === undefined &&
    args.resolveCtime === undefined &&
    args.findCandidatesByCtime === undefined
  ) {
    return {
      kind: "verified",
      vaultId,
      filePath: anchorFilePath,
      fileCtime: anchorFileCtime
    };
  }
  const currentPath = args.resolveCurrentPath?.(anchorFilePath);
  if (currentPath !== undefined && isVaultRelativeMarkdownPath(currentPath)) {
    const ctime = args.resolveCtime?.(currentPath);
    if (ctime === anchorFileCtime) {
      return {
        kind: "verified",
        vaultId,
        filePath: currentPath,
        fileCtime: anchorFileCtime
      };
    }
    // 当前路径 ctime 不匹配：fall through 到 ctime 候选扫描。
  }
  const candidates = (args.findCandidatesByCtime?.(anchorFileCtime) ?? []).filter(
    isVaultRelativeMarkdownPath
  );
  if (candidates.length === 1) {
    const only = candidates[0];
    if (only !== undefined) {
      return {
        kind: "verified",
        vaultId,
        filePath: only,
        fileCtime: anchorFileCtime
      };
    }
  }
  if (candidates.length > 1) return { kind: "ambiguous" };
  return { kind: "missing" };
}

/**
 * 将 verified 锚点的最新路径回写到 conversation 字段。
 * 任何字段缺失或与 resolved 路径一致时返回 null，调用方不写回。
 */
export interface ApplyAnchorPathRemapInput {
  anchorFilePath?: string;
  anchorVaultId?: string;
  anchorFileCtime?: number;
  resolvedPath?: string;
}

export interface ApplyAnchorPathRemapResult {
  anchorFilePath: string;
  anchorVaultId: string;
  anchorFileCtime: number;
}

export function applyAnchorPathRemap(
  input: ApplyAnchorPathRemapInput
): ApplyAnchorPathRemapResult | null {
  const { anchorFilePath, anchorVaultId, anchorFileCtime, resolvedPath } = input;
  if (
    anchorFilePath === undefined ||
    anchorVaultId === undefined ||
    anchorFileCtime === undefined
  ) {
    return null;
  }
  if (resolvedPath === undefined) return null;
  if (resolvedPath === anchorFilePath) {
    return { anchorFilePath, anchorVaultId, anchorFileCtime };
  }
  return {
    anchorFilePath: resolvedPath,
    anchorVaultId,
    anchorFileCtime
  };
}

export interface AnchorPrefixRemapInput {
  oldPrefix: string;
  newPrefix: string;
}

export interface AnchorPrefixRemap {
  pending?: { filePath: string };
  stored?: { filePath: string; vaultId: string; ctime: number };
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/gu, "/");
}

function rewritePrefix(value: string, remap: AnchorPrefixRemapInput): string | undefined {
  const normalized = normalizeSlashes(value);
  const oldPrefix = normalizeSlashes(remap.oldPrefix).replace(/\/+$/u, "");
  const newPrefix = normalizeSlashes(remap.newPrefix).replace(/\/+$/u, "");
  if (normalized === oldPrefix) {
    return newPrefix;
  }
  const withSlash = `${oldPrefix}/`;
  if (normalized.startsWith(withSlash)) {
    return `${newPrefix}/${normalized.slice(withSlash.length)}`;
  }
  return undefined;
}

export function remapAnchorPath(
  input: AnchorPrefixRemap,
  remap: AnchorPrefixRemapInput
): AnchorPrefixRemap {
  const next: AnchorPrefixRemap = {};
  if (input.pending !== undefined) {
    const filePath = rewritePrefix(input.pending.filePath, remap);
    if (filePath !== undefined) next.pending = { filePath };
  }
  if (input.stored !== undefined) {
    const filePath = rewritePrefix(input.stored.filePath, remap);
    if (filePath !== undefined) {
      next.stored = {
        filePath,
        vaultId: input.stored.vaultId,
        ctime: input.stored.ctime
      };
    }
  }
  return next;
}
