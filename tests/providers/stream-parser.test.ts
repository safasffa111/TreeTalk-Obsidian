import { describe, expect, it } from "vitest";
import {
  createAnthropicMessageParser,
  createSseParser,
  decodeAnthropicEvent,
  decodeGeminiEvent,
  decodeOpenAiEvent
} from "../../src/providers/stream-parser";

describe("stream parsing", () => {
  it("parses split SSE chunks without losing Unicode text", () => {
    const parser = createSseParser(decodeOpenAiEvent);
    expect(parser.push('data: {"choices":[{"delta":{"content":"你')).toEqual([]);
    expect(parser.push('好"}}]}\n\n')).toContainEqual({ type: "delta", text: "你好" });
  });

  it("recognizes an OpenAI done sentinel", () => {
    const parser = createSseParser(decodeOpenAiEvent);
    expect(parser.push("data: [DONE]\n\n")).toEqual([{ type: "done" }]);
  });


  it("normalizes OpenAI cached-token usage", () => {
    const parser = createSseParser(decodeOpenAiEvent);
    expect(
      parser.push(
        'data: {"choices":[],"usage":{"prompt_tokens":2000,"completion_tokens":300,"prompt_tokens_details":{"cached_tokens":1400}}}\n\n'
      )
    ).toEqual([
      {
        type: "usage",
        usage: {
          promptTokens: 2000,
          completionTokens: 300,
          cacheHitTokens: 1400,
          cacheMissTokens: 600,
          providerReported: true
        }
      }
    ]);
  });

  it("normalizes DeepSeek cache hit and miss usage", () => {
    const parser = createSseParser(decodeOpenAiEvent);
    expect(
      parser.push(
        'data: {"choices":[],"usage":{"prompt_tokens":1800,"completion_tokens":200,"prompt_cache_hit_tokens":1500,"prompt_cache_miss_tokens":300}}\n\n'
      )
    ).toEqual([
      {
        type: "usage",
        usage: {
          promptTokens: 1800,
          completionTokens: 200,
          cacheHitTokens: 1500,
          cacheMissTokens: 300,
          providerReported: true
        }
      }
    ]);
  });

  it("waits for the DONE sentinel so a trailing usage chunk is not lost", () => {
    const parser = createSseParser(decodeOpenAiEvent);
    expect(
      parser.push(
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
      )
    ).toEqual([{ type: "finish" }]);
  });

  it("normalizes Anthropic content block deltas", () => {
    const parser = createSseParser(decodeAnthropicEvent);
    expect(
      parser.push(
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"answer"}}\n\n'
      )
    ).toEqual([{ type: "delta", text: "answer" }]);
  });

  it("parses DeepSeek Anthropic web-search status, sources, usage, and pause turns", () => {
    const parser = createAnthropicMessageParser();
    const events = [
      ...parser.push(
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":120,"cache_read_input_tokens":80}}}\n\n'
      ),
      ...parser.push(
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"server_tool_use","id":"srv_1","name":"web_search","input":{"query":"TreeTalk"}}}\n\n'
      ),
      ...parser.push(
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"web_search_tool_result","tool_use_id":"srv_1","content":[{"type":"web_search_result","url":"https://example.com","title":"Example"}]}}\n\n'
      ),
      ...parser.push(
        'event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"text","text":""}}\n\n'
      ),
      ...parser.push(
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"联网回答"}}\n\n'
      ),
      ...parser.push(
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"pause_turn"},"usage":{"output_tokens":30}}\n\n'
      ),
      ...parser.push(
        'event: message_stop\ndata: {"type":"message_stop"}\n\n'
      )
    ];

    expect(events).toContainEqual({ type: "search-status", status: "searching" });
    expect(events).toContainEqual({ type: "search-status", status: "complete" });
    expect(events).toContainEqual({
      type: "sources",
      sources: [{ title: "Example", url: "https://example.com" }]
    });
    expect(events).toContainEqual({ type: "delta", text: "联网回答" });
    expect(events).toContainEqual({
      type: "usage",
      usage: {
        promptTokens: 200,
        cacheHitTokens: 80,
        cacheMissTokens: 120,
        providerReported: true
      }
    });
    expect(events.some((event) => event.type === "pause")).toBe(true);
  });

  it("surfaces Anthropic SSE error frames", () => {
    const parser = createSseParser(decodeAnthropicEvent);
    expect(
      parser.push(
        'event: error\ndata: {"type":"error","error":{"message":"rate limited"}}\n\n'
      )
    ).toEqual([{ type: "error", message: "rate limited" }]);
  });

  it("treats malformed provider JSON as a stream error", () => {
    const parser = createSseParser(decodeOpenAiEvent);
    expect(parser.push("data: {broken}\n\n")).toEqual([
      { type: "error", message: "无法解析模型流式响应" }
    ]);
  });

  it("recognizes Gemini finish reasons as completion", () => {
    const parser = createSseParser(decodeGeminiEvent);
    expect(
      parser.push(
        'data: {"candidates":[{"content":{"parts":[{"text":"完成"}]},"finishReason":"STOP"}]}\n\n'
      )
    ).toEqual([
      { type: "delta", text: "完成" },
      { type: "done" }
    ]);
  });

  it("flushes the last event without a trailing blank line", () => {
    const parser = createSseParser(decodeOpenAiEvent);
    parser.push('data: {"choices":[{"delta":{"content":"last"}}]}');
    expect(parser.finish()).toEqual([{ type: "delta", text: "last" }]);
  });
});
