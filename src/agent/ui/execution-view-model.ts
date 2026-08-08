import type { AgentRunRecord, AgentStageRecord } from "../../domain/agent-run";

export interface AgentExecutionViewModel {
  title: string;
  rows: Array<[string, string]>;
}

function statusLabel(status: AgentRunRecord["status"]): string {
  switch (status) {
    case "running":
      return "执行中";
    case "completed":
      return "已完成";
    case "aborted":
      return "已中断";
    case "failed":
      return "失败";
  }
}

function stageLabel(stage: AgentStageRecord): string {
  switch (stage.stageId) {
    case "pi-context-selector":
      return "上下文选择";
    case "pi-evidence-answer":
      return "证据回答";
    case "pi-supplementary-selector":
      return "补充上下文选择";
    case "pi-supplementary-answer":
      return "补充证据回答";
    default:
      if (stage.stageId.includes("-thinking-recovery-")) {
        return stage.roleId === "direct"
          ? "Direct（无思考恢复）"
          : `${stage.roleId}（无思考恢复）`;
      }
      if (stage.stageId.includes("-buffered-fallback-")) {
        return stage.roleId === "direct"
          ? "Direct（缓冲恢复）"
          : `${stage.roleId}（缓冲恢复）`;
      }
      return stage.roleId === "direct" ? "Direct" : stage.stageId;
  }
}

function count(value: number): string {
  return value.toLocaleString("zh-CN");
}

function progressiveLevelLabel(level: 0 | 1 | 2 | 3 | 4): string {
  switch (level) {
    case 0:
      return "精确目标";
    case 1:
      return "所在章节";
    case 2:
      return "所在来源";
    case 3:
      return "外部相关章节";
    case 4:
      return "外部完整来源";
  }
}

export function agentExecutionViewModel(
  record: AgentRunRecord
): AgentExecutionViewModel {
  const engine = record.executionMode === "pi" ? "Pi Agent" : "Legacy";
  const role = record.roleId === "direct" ? "Direct" : record.roleId;
  const rows: Array<[string, string]> = [
    ["执行引擎", engine],
    ["角色", role],
    ["模型", `${record.providerId} / ${record.modelId}`],
    ["状态", statusLabel(record.status)]
  ];
  if (record.stages.length > 0) {
    rows.push(["阶段", record.stages.map(stageLabel).join(" → ")]);
    for (const stage of record.stages) {
      const label = stageLabel(stage);
      const usage = stage.usage;
      if (usage !== undefined) {
        const details: string[] = [];
        if (usage.promptTokens !== undefined) {
          details.push(`输入 ${count(usage.promptTokens)}`);
        }
        if (usage.reasoningTokens !== undefined) {
          details.push(`推理 ${count(usage.reasoningTokens)}`);
        }
        if (usage.cacheHitTokens !== undefined) {
          details.push(`命中 ${count(usage.cacheHitTokens)}`);
        }
        if (usage.cacheMissTokens !== undefined) {
          details.push(`未命中 ${count(usage.cacheMissTokens)}`);
        }
        if (details.length > 0) {
          rows.push([`缓存 · ${label}`, details.join(" / ")]);
        }
      }
      if (
        stage.stablePrefixEstimatedTokens !== undefined ||
        stage.dynamicTailEstimatedTokens !== undefined
      ) {
        const stable = stage.stablePrefixEstimatedTokens ?? 0;
        const dynamic = stage.dynamicTailEstimatedTokens ?? 0;
        rows.push([
          `前缀 · ${label}`,
          `稳定 ${count(stable)} / 动态 ${count(dynamic)}`
        ]);
      }
      const selector = stage.selectorTokenBreakdown;
      if (selector !== undefined) {
        rows.push(
          [
            `索引 · ${label}`,
            `目录 ${count(selector.noteCatalog)} / 分支 ${count(selector.conversationBranch)} / 焦点 ${count(selector.localFocus)} / 问题 ${count(selector.currentRequest)} / 协议 ${count(selector.outputContract)}`
          ],
          [
            `预算 · ${label}`,
            `${count(selector.total)} / ${count(selector.budget)}（详细 ${count(selector.detailedNoteCount)} / 紧凑 ${count(selector.compactNoteCount)} / 省略 ${count(selector.omittedNoteCount)}）`
          ]
        );
      }
    }
  }

  const progressive = record.progressiveContext;
  if (progressive !== undefined) {
    rows.push(
      [
        "上下文起点",
        `L${String(progressive.initialLevel)} · ${progressiveLevelLabel(progressive.initialLevel)}`
      ],
      ["最终层级", `L${String(progressive.finalLevel)}`],
      [
        "上下文扩展",
        `${count(progressive.expansionCount)} / ${count(progressive.maximumExpansions)}`
      ],
      [
        "新增证据 Token",
        `${count(progressive.deliveredEvidenceTokens)} / ${count(progressive.maximumEvidenceTokens)}`
      ],
      [
        "关联笔记",
        !progressive.relatedNotesAllowed
          ? "未允许"
          : progressive.relatedNotesUsed
            ? "已使用"
            : "允许，但未使用"
      ]
    );
    if (progressive.contextMode !== undefined) {
      rows.push([
        "上下文模式",
        progressive.contextMode === "divergent" ? "发散" : "收敛"
      ]);
    }
    if (progressive.initialContextKind !== undefined) {
      const initialContextLabels = {
        "exact-selection": "精确框选",
        "structural-parent-digest": "父回答摘要",
        "structural-parent-tail": "父文本尾部",
        "external-fallback": "外部材料",
        "request-only": "仅当前问题"
      } as const;
      rows.push(["初始语境", initialContextLabels[progressive.initialContextKind]]);
    }
    const requestedTargets = progressive.batches
      .filter((batch) => batch.requestedTarget !== undefined)
      .map((batch) =>
        batch.crossedLevel
          ? `${batch.requestedTarget ?? ""}（跨级）`
          : batch.requestedTarget ?? ""
      );
    if (requestedTargets.length > 0) {
      rows.push(["请求接口", requestedTargets.join(" → ")]);
    }
  }

  const routing = record.contextRouting;
  if (routing !== undefined) {
    if (routing.candidateNoteCount !== undefined) {
      rows.push(["候选笔记", count(routing.candidateNoteCount)]);
    }
    if (routing.candidateNodeCount !== undefined) {
      rows.push(["候选节点", count(routing.candidateNodeCount)]);
    }
    rows.push(
      ["Pi 选择笔记", count(routing.selectedNoteCount)],
      ["Pi 选择节点", count(routing.selectedNodeCount)],
      ["实际读取笔记", count(routing.materializedNotePaths.length)],
      ["实际读取节点", count(routing.materializedNodeIds.length)],
      [
        "证据 Token",
        `${count(routing.evidenceEstimatedTokens)} / ${count(routing.evidenceTokenBudget)}`
      ],
      ["补充读取", routing.supplementaryUsed ? "已使用" : "未使用"]
    );
    if (routing.materializedNotePaths.length > 0) {
      rows.push(["读取笔记", routing.materializedNotePaths.join("、")]);
    }
    if (routing.materializedNodeIds.length > 0) {
      rows.push(["读取节点", routing.materializedNodeIds.join("、")]);
    }
    if (routing.omittedSourceCount > 0) {
      rows.push(["预算省略", count(routing.omittedSourceCount)]);
    }
    if (routing.truncated) {
      rows.push(["证据裁剪", "已按 Token 预算裁剪"]);
    }
  }

  const toolExecutions = record.toolExecutions ?? [];
  if (toolExecutions.length > 0) {
    const successful = toolExecutions.filter(
      (entry) => entry.status === "completed"
    );
    const readPaths = new Set(successful.flatMap((entry) => entry.notePaths));
    const readNodeIds = new Set(
      successful.flatMap((entry) => entry.nodeIds ?? [])
    );
    rows.push(["工具调用", String(toolExecutions.length)]);
    if (routing === undefined && readPaths.size > 0) {
      rows.push(["实际读取笔记", [...readPaths].join("、")]);
    }
    if (routing === undefined && readNodeIds.size > 0) {
      rows.push(["实际读取节点", [...readNodeIds].join("、")]);
    }
  }
  if (record.sources.length > 0) {
    rows.push(["网页来源", String(record.sources.length)]);
  }
  if (record.errorMessage !== undefined) {
    rows.push(["错误", record.errorMessage]);
  }
  return {
    title: `${engine} · ${role} · ${statusLabel(record.status)}`,
    rows
  };
}
