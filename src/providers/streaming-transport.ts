import type {
  ProviderAdapter,
  ProviderEvent,
  ProviderRequest
} from "./types";
import {
  createRequestDeadline,
  DEFAULT_REQUEST_TIMEOUT_MS,
  RequestTimeoutError
} from "./request-control";

export interface StreamingFetchResponse {
  ok: boolean;
  status: number;
  body: ReadableStream<Uint8Array> | null;
}

export type StreamingFetch = (
  url: string,
  init: RequestInit
) => Promise<StreamingFetchResponse>;

export class StreamingUnavailableError extends Error {
  constructor(message = "Streaming response has no readable body") {
    super(message);
    this.name = "StreamingUnavailableError";
  }
}

export function canUseBufferedFallback(
  error: unknown
): error is StreamingUnavailableError {
  return error instanceof StreamingUnavailableError;
}

export function assertStreamCompleted(
  receivedText: boolean,
  receivedDone: boolean
): void {
  if (!receivedText) throw new Error("Empty streaming response");
  if (!receivedDone) throw new Error("Streaming response ended without a completion frame");
}

export class StreamingProviderTransport {
  constructor(
    private readonly fetcher: StreamingFetch = (url, init) =>
      fetch(url, init),
    private readonly timeoutMilliseconds = DEFAULT_REQUEST_TIMEOUT_MS
  ) {}

  async *stream(
    adapter: ProviderAdapter,
    request: ProviderRequest,
    signal: AbortSignal
  ): AsyncGenerator<ProviderEvent> {
    const deadline = createRequestDeadline(signal, this.timeoutMilliseconds);
    try {
      const response = await deadline.wait(
        this.fetcher(request.url, {
          method: request.method,
          headers: request.headers,
          body: JSON.stringify(request.body),
          signal: deadline.signal
        })
      );
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
      if (response.body === null) throw new StreamingUnavailableError();

      const parser = adapter.createStreamParser(request);
      const decoder = new TextDecoder();
      const reader = response.body.getReader();
      try {
        let chunk = await deadline.wait(reader.read());
        while (!chunk.done) {
          const text = decoder.decode(chunk.value, { stream: true });
          for (const event of parser.push(text)) yield event;
          chunk = await deadline.wait(reader.read());
        }
        const tail = decoder.decode();
        if (tail.length > 0) {
          for (const event of parser.push(tail)) yield event;
        }
        for (const event of parser.finish()) yield event;
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      if (deadline.timedOut) throw new RequestTimeoutError();
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      throw error;
    } finally {
      deadline.dispose();
    }
  }
}
