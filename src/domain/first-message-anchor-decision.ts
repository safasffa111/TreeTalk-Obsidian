import {
  verifiedFirstMessageAnchor,
  type VerifiedFirstMessageAnchor,
  type VerifiedFirstMessageAnchorInput
} from "./verified-first-message-anchor";

export interface FirstMessageAnchorDecisionInput
  extends VerifiedFirstMessageAnchorInput {
  explicitPending: boolean;
}

export type FirstMessageAnchorDecision =
  | { kind: "proceed"; anchor: VerifiedFirstMessageAnchor | undefined }
  | { kind: "reject"; notice: string };

/** Explicit user-selected anchors fail closed; implicit active-file fallback may be omitted. */
export function decideFirstMessageAnchor(
  input: FirstMessageAnchorDecisionInput
): FirstMessageAnchorDecision {
  const anchor = verifiedFirstMessageAnchor(input);
  if (input.explicitPending && anchor === undefined) {
    return {
      kind: "reject",
      notice: "无法验证显式锚定笔记的 Vault 身份或 ctime，本次消息未发送"
    };
  }
  return { kind: "proceed", anchor };
}
