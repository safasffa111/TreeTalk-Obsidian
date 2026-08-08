import { describe, expect, it, vi } from "vitest";
import { OpenAiProvider } from "../../src/providers/openai-provider";
import {
  assertStreamCompleted,
  canUseBufferedFallback,
  StreamingUnavailableError,
  StreamingProviderTransport,
  type StreamingFetch
} from "../../src/providers/streaming-transport";

describe("StreamingProviderTransport", () => {
  it("decodes split UTF-8 SSE chunks as provider events", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"choices":[{"delta":{"content":"你')
        );
        controller.enqueue(encoder.encode('好"}}]}\n\ndata: [DONE]\n\n'));
        controller.close();
      }
    });
    const fetcher: StreamingFetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        body
      })
    );
    const transport = new StreamingProviderTransport(fetcher);
    const events = [];

    for await (const event of transport.stream(
      new OpenAiProvider(),
      {
        url: "https://example.test",
        method: "POST",
        headers: {},
        body: {}
      },
      new AbortController().signal
    )) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "delta", text: "你好" },
      { type: "done" }
    ]);
  });

  it("reports an HTTP failure before any content is committed", async () => {
    const fetcher: StreamingFetch = vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 429,
          body: null
        })
      );
    const transport = new StreamingProviderTransport(fetcher);

    const consume = async (): Promise<void> => {
      for await (const event of transport.stream(
        new OpenAiProvider(),
        {
          url: "https://example.test",
          method: "POST",
          headers: {},
          body: {}
        },
        new AbortController().signal
      )) {
        void event;
      }
    };

    await expect(consume()).rejects.toThrow("HTTP 429");
  });

  it("allows buffered fallback only when the response has no readable body", async () => {
    const fetcher: StreamingFetch = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        body: null
      })
    );
    const transport = new StreamingProviderTransport(fetcher);
    let failure: unknown;
    try {
      for await (const event of transport.stream(
        new OpenAiProvider(),
        {
          url: "https://example.test",
          method: "POST",
          headers: {},
          body: {}
        },
        new AbortController().signal
      )) {
        void event;
      }
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(StreamingUnavailableError);
    expect(canUseBufferedFallback(failure)).toBe(true);
    expect(canUseBufferedFallback(new Error("network failed"))).toBe(false);
  });

  it("rejects a truncated stream that never sent its completion frame", () => {
    expect(() => assertStreamCompleted(true, false)).toThrow(
      "completion frame"
    );
    expect(() => assertStreamCompleted(true, true)).not.toThrow();
  });
});
