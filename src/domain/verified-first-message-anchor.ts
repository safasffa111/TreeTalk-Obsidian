import { isVaultRelativeMarkdownPath } from "./anchor-path";

export interface VerifiedFirstMessageAnchorInput {
  filePath: string | undefined;
  vaultId: string | undefined;
  fileCtime: number | undefined;
}

export interface VerifiedFirstMessageAnchor {
  anchorFilePath: string;
  anchorVaultId: string;
  anchorFileCtime: number;
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)
  );
}

/**
 * First-message anchors are all-or-nothing. Returning undefined prevents the
 * UI integration from writing a new path-only legacy anchor when identity
 * metadata cannot be read.
 */
export function verifiedFirstMessageAnchor(
  input: VerifiedFirstMessageAnchorInput
): VerifiedFirstMessageAnchor | undefined {
  if (
    !isVaultRelativeMarkdownPath(input.filePath) ||
    !isUuid(input.vaultId) ||
    typeof input.fileCtime !== "number" ||
    !Number.isFinite(input.fileCtime) ||
    !Number.isInteger(input.fileCtime) ||
    input.fileCtime < 0
  ) {
    return undefined;
  }
  return {
    anchorFilePath: input.filePath!,
    anchorVaultId: input.vaultId,
    anchorFileCtime: input.fileCtime
  };
}
