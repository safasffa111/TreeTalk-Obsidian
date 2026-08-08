import type { PiToolDefinition } from "../context-workspace";

export interface OpenWebResultArguments {
  resultId: string;
  reason: string;
}

export interface CompactOpenWebResultToolResult {
  source: "Web";
  scope: "web-page";
  resultId: string;
  title: string;
  url: string;
  remaining: boolean;
  content: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function buildOpenWebResultTool(): PiToolDefinition {
  return {
    name: "open_web_result",
    description:
      "读取 search_web 返回的单个结果。只有打开后的网页正文才可作为事实证据或参考来源；每次只能读取一个 resultId。",
    parameters: {
      type: "object",
      properties: {
        resultId: {
          type: "string",
          minLength: 1,
          description: "search_web 结果索引中的 resultId。"
        },
        reason: {
          type: "string",
          minLength: 1,
          description: "说明需要从该网页确认哪项证据。"
        }
      },
      required: ["resultId", "reason"],
      additionalProperties: false
    }
  };
}

export function parseOpenWebResultArguments(
  value: unknown
): OpenWebResultArguments {
  if (!isRecord(value)) {
    throw new TypeError("open_web_result arguments must be an object");
  }
  const resultId = value.resultId;
  if (typeof resultId !== "string" || resultId.trim().length === 0) {
    throw new TypeError("open_web_result resultId must be a non-empty string");
  }
  const reason = value.reason;
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new TypeError("open_web_result reason must be a non-empty string");
  }
  return { resultId: resultId.trim(), reason: reason.trim() };
}

export function buildCompactOpenWebResultToolResult(input: {
  resultId: string;
  title: string;
  url: string;
  content: string;
  remaining: boolean;
}): CompactOpenWebResultToolResult {
  return {
    source: "Web",
    scope: "web-page",
    resultId: input.resultId,
    title: input.title,
    url: input.url,
    remaining: input.remaining,
    content: input.content
  };
}
