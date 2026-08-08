import type { PiToolDefinition } from "../context-workspace";

export interface SearchWebArguments {
  query: string;
  reason: string;
}

export interface WebSearchIndexEntry {
  id: string;
  title: string;
  site: string;
}

export interface CompactWebSearchToolResult {
  source: "Web";
  scope: "search-index";
  query: string;
  remaining: boolean;
  results: WebSearchIndexEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function buildSearchWebTool(): PiToolDefinition {
  return {
    name: "search_web",
    description:
      "联网搜索索引接口。仅在问题依赖最新事实、外部资料或当前上下文无法提供的可核查信息时调用。每次提交一个明确查询；返回的标题索引不能作为事实依据，必须再调用 open_web_result 读取选中的结果。",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 1,
          description: "用于本轮联网检索的独立、具体查询。"
        },
        reason: {
          type: "string",
          minLength: 1,
          description: "说明缺少哪项实时或外部证据。"
        }
      },
      required: ["query", "reason"],
      additionalProperties: false
    }
  };
}

export function parseSearchWebArguments(value: unknown): SearchWebArguments {
  if (!isRecord(value)) {
    throw new TypeError("search_web arguments must be an object");
  }
  const query = value.query;
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new TypeError("search_web query must be a non-empty string");
  }
  const reason = value.reason;
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new TypeError("search_web reason must be a non-empty string");
  }
  return { query: query.trim(), reason: reason.trim() };
}

export function normalizeWebSearchQuery(query: string): string {
  return query.trim().replace(/\s+/gu, " ").toLowerCase();
}

export function buildCompactWebSearchToolResult(input: {
  query: string;
  results: WebSearchIndexEntry[];
  remaining: boolean;
}): CompactWebSearchToolResult {
  return {
    source: "Web",
    scope: "search-index",
    query: input.query,
    remaining: input.remaining,
    results: input.results.map((result) => ({ ...result }))
  };
}
