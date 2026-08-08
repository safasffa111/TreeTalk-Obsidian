import type { ExecutionRequest } from "../../../execution/types";
import { detectAnswerTaskSignals } from "../../../execution/answer-thinking";
import type {
  ProgressiveContextLevel,
  ProgressiveStartPlan
} from "./types";

function reasonFor(level: ProgressiveContextLevel): string {
  if (level === 0) return "精确目标或自包含任务";
  if (level === 1) return "请求依赖所在章节或局部语境";
  if (level === 2) return "请求明确要求当前笔记或节点";
  if (level === 3) return "请求明确要求祖先或关联资料章节";
  return "请求需要外部完整来源";
}

export function resolveProgressiveStartPlan(
  request: ExecutionRequest
): ProgressiveStartPlan {
  const question =
    request.currentQuestion ?? request.piContext?.currentQuestion ?? "";
  const signals = detectAnswerTaskSignals(question);
  const exactSelection = (request.piContext?.focus?.targets ?? []).some(
    (target) => target.kind === "exact-selection"
  );
  const relatedNotesAllowed =
    request.piContext?.relatedNotesAllowed ??
    request.piContext?.noteContextGraph !== undefined;

  let initialLevel: ProgressiveContextLevel = exactSelection ? 0 : 2;
  if (signals.transformation && exactSelection) initialLevel = 0;
  if (signals.localReference) initialLevel = Math.max(initialLevel, 1) as ProgressiveContextLevel;
  if (signals.currentSourceRequested) initialLevel = 2;
  if (signals.ancestorContextRequested) initialLevel = 3;
  if (signals.relatedNotesRequested) initialLevel = relatedNotesAllowed ? 3 : 2;
  if (signals.externalContextRequested && !signals.relatedNotesRequested) {
    initialLevel = Math.max(initialLevel, 3) as ProgressiveContextLevel;
  }

  return {
    initialLevel,
    reason: reasonFor(initialLevel),
    maximumEvidenceTokens: 30_000
  };
}
