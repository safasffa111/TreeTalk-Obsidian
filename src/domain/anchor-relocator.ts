import { parseConversation } from "./schema";
import type { ConversationFile } from "./types";
import { isVaultRelativeMarkdownPath } from "./anchor-path";

export interface AnchorRelocatorPort {
  resolveCurrentPath: (filePath: string) => string | undefined | Promise<string | undefined>;
  getCtime: (filePath: string) => number | undefined | Promise<number | undefined>;
  findCandidatesByCtime: (ctime: number) => string[] | Promise<string[]>;
}

export type AnchorRelocationResult =
  | { kind: "unchanged"; conversation: ConversationFile }
  | { kind: "relocated"; conversation: ConversationFile; previousPath: string }
  | { kind: "ambiguous"; conversation: ConversationFile; candidates: string[] }
  | { kind: "missing"; conversation: ConversationFile }
  | { kind: "skipped"; conversation: ConversationFile };

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

function bumpRevision(conversation: ConversationFile, now: string): ConversationFile {
  const cloned = structuredClone(conversation) as ConversationFile;
  cloned.revision += 1;
  cloned.updatedAt = now;
  return cloned;
}

/**
 * 在启动/沉淀前对 verified 锚点进行安全重定位。
 *
 * - 路径解析成功且 ctime 匹配 → 保持原状（unchanged）。
 * - 路径解析失败 / ctime 不匹配 → 在同一 Vault 内扫描 ctime 唯一候选。
 * - 唯一候选存在 → 原子更新 `anchorFilePath` 并增加一次 revision（relocated）。
 * - 0 候选 → 标记为 missing（不修改 conversation，避免误写）。
 * - 多候选 → 标记为 ambiguous（不修改 conversation）。
 * - 旧 path-only / 部分三元组锚点 → 跳过（skipped），不猜测归属。
 */
export async function relocateVerifiedAnchor(
  conversation: ConversationFile,
  port: AnchorRelocatorPort,
  now: string = new Date().toISOString()
): Promise<AnchorRelocationResult> {
  const { anchorVaultId, anchorFilePath, anchorFileCtime } = conversation;
  if (
    anchorFilePath === undefined ||
    !isVaultRelativeMarkdownPath(anchorFilePath) ||
    !isUuid(anchorVaultId) ||
    !isPositiveInteger(anchorFileCtime)
  ) {
    return { kind: "skipped", conversation };
  }

  const currentPath = await port.resolveCurrentPath(anchorFilePath);
  if (currentPath !== undefined && isVaultRelativeMarkdownPath(currentPath)) {
    const ctime = await port.getCtime(currentPath);
    if (ctime === anchorFileCtime) {
      return { kind: "unchanged", conversation };
    }
    // 路径存在但 ctime 不匹配：可能是外部工具在原地重建，需要 ctime 扫描重定位。
  }

  const candidates = (await port.findCandidatesByCtime(anchorFileCtime)).filter(
    isVaultRelativeMarkdownPath
  );
  if (candidates.length === 1) {
    const resolved = candidates[0];
    if (resolved === undefined || resolved === anchorFilePath) {
      // resolved 与原路径一致：仍需 bump revision，保证持久化扫描到一次更新。
      return {
        kind: "unchanged",
        conversation: parseConversation(bumpRevision(conversation, now))
      };
    }
    const updated = bumpRevision(conversation, now);
    updated.anchorFilePath = resolved;
    return {
      kind: "relocated",
      conversation: parseConversation(updated),
      previousPath: anchorFilePath
    };
  }
  if (candidates.length > 1) {
    return { kind: "ambiguous", conversation, candidates };
  }
  return { kind: "missing", conversation };
}
