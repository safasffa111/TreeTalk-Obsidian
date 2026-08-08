import type { ProviderKind } from "../providers/types";

export type AnswerThinkingMode = "auto" | "disabled" | "enabled";
export type ResolvedAnswerThinkingMode = Exclude<AnswerThinkingMode, "auto">;

export interface AnswerThinkingResolution {
  requestedMode: AnswerThinkingMode;
  resolvedMode: ResolvedAnswerThinkingMode;
  enabled: boolean;
  reason: string;
}


export interface AnswerTaskSignals {
  transformation: boolean;
  localReference: boolean;
  currentSourceRequested: boolean;
  externalContextRequested: boolean;
  ancestorContextRequested: boolean;
  relatedNotesRequested: boolean;
  comprehensiveAnalysis: boolean;
}

export function detectAnswerTaskSignals(question: string): AnswerTaskSignals {
  const value = question.trim();
  const relatedNotesRequested = /(关联笔记|相关笔记|其他笔记|联系.*笔记|根据我的(?:其他)?资料)/iu.test(value);
  const ancestorContextRequested = /(祖先节点|父节点|上级节点|前面的节点|沿着.*节点|问题链)/iu.test(value);
  const currentSourceRequested = /(这篇笔记|当前笔记|整篇笔记|全文|当前节点|整个回答|完整回答|全文逻辑)/iu.test(value);
  const localReference = /(这里|这一句|这句话|这一段|这一步|上面|下面|前面|后面|在此处|为什么这样写|它在.*(?:句|段|步骤))/iu.test(value);
  const externalContextRequested = relatedNotesRequested || ancestorContextRequested || /(比较这些概念|比较这些节点|综合相关内容|结合其他资料)/iu.test(value);
  const comprehensiveAnalysis = /(全面|完整|系统|深入|综合分析|详尽|所有相关|全局|逐一)/iu.test(value) && /(分析|比较|总结|梳理|研究|解释)/iu.test(value);
  return {
    transformation: TRANSFORMATION_PATTERN.test(value),
    localReference,
    currentSourceRequested,
    externalContextRequested,
    ancestorContextRequested,
    relatedNotesRequested,
    comprehensiveAnalysis
  };
}

export interface AnswerThinkingInput {
  mode: AnswerThinkingMode;
  currentQuestion: string;
  selectionCount?: number;
  sourceCount?: number;
}

const TRANSFORMATION_PATTERN =
  /(重排|重新排列|排序|改写|润色|翻译|提取|摘取|整理格式|格式化|转换(?:为|成)?\s*(?:markdown|表格|列表|大纲)?|生成目录|列出要点|压缩表达|精简|换一种说法|纠正错别字|续写格式)/iu;
const COMPLEX_REASONING_PATTERN =
  /(严格证明|证明|推导|演绎|根因|诊断|为什么.*成立|逐步分析|多步|综合分析|权衡|评估方案|设计架构|矛盾证据|法律适用|满足.*约束|比较.*(?:优缺点|差异|联系)|反例)/iu;
const SIMPLE_EXPLANATION_PATTERN =
  /^(?:请)?(?:解释|说明|介绍)?\s*(?:一下)?(?:这个|该|它)?(?:概念|词|术语|句子)?(?:是什么|是什么意思|怎么理解)[？?。.]?$/iu;

export function supportsAnswerThinkingControl(provider: ProviderKind): boolean {
  return provider === "deepseek";
}

export function resolveAnswerThinkingMode(
  input: AnswerThinkingInput
): AnswerThinkingResolution {
  if (input.mode === "enabled") {
    return {
      requestedMode: input.mode,
      resolvedMode: "enabled",
      enabled: true,
      reason: "用户手动开启"
    };
  }
  if (input.mode === "disabled") {
    return {
      requestedMode: input.mode,
      resolvedMode: "disabled",
      enabled: false,
      reason: "用户手动关闭"
    };
  }

  const question = input.currentQuestion.trim();
  if (TRANSFORMATION_PATTERN.test(question)) {
    return {
      requestedMode: "auto",
      resolvedMode: "disabled",
      enabled: false,
      reason: "自动识别为重排、改写或格式转换任务"
    };
  }
  if (
    SIMPLE_EXPLANATION_PATTERN.test(question) ||
    ((input.selectionCount ?? 0) > 0 && /(?:是什么|什么意思|怎么理解)/u.test(question))
  ) {
    return {
      requestedMode: "auto",
      resolvedMode: "disabled",
      enabled: false,
      reason: "自动识别为局部概念解释任务"
    };
  }
  if (COMPLEX_REASONING_PATTERN.test(question)) {
    return {
      requestedMode: "auto",
      resolvedMode: "enabled",
      enabled: true,
      reason: "自动识别为证明、推导或复杂分析任务"
    };
  }
  if ((input.sourceCount ?? 0) >= 5 && question.length >= 28) {
    return {
      requestedMode: "auto",
      resolvedMode: "enabled",
      enabled: true,
      reason: "自动识别为多来源综合任务"
    };
  }
  return {
    requestedMode: "auto",
    resolvedMode: "disabled",
    enabled: false,
    reason: "自动模式默认使用直接回答"
  };
}
