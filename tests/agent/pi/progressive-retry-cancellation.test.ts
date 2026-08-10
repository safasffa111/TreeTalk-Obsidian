import { afterEach, describe, expect, it, vi } from "vitest";
import { runProgressiveProviderTurn } from "../../../src/agent/pi/progressive/provider-turn-runner";
import type { ExecutionRequest } from "../../../src/execution/types";

const REQUEST: ExecutionRequest = {
  conversationId: "conversation",
  nodeId: "node",
  assistantMessageId: "assistant",
  contextMessages: [{ role: "user", content: "question" }],
  roleId: "direct",
  route: {
    routeId: "default",
    providerProfile: {
      id: "default",
      name: "Default",
      kind: "openai",
      apiKey: "secret",
      baseUrl: ""
    },
    modelId: "gpt-test"
  },
  webSearchEnabled: false,
  streamingOutputEnabled: false
};

describe("Progressive provider retry cancellation", () => {
  afterEach(() => vi.useRealTimers());

  it("does not start a second buffered request after cancellation", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    let requests = 0;
    const events = runProgressiveProviderTurn({
      dependencies: {
        bufferedRequest: () => {
          requests += 1;
          return Promise.resolve({
            status: 503,
            json: { error: { message: "busy" } }
          });
        }
      },
      request: REQUEST,
      signal: caller.signal,
      systemPrompt: "Answer directly.",
      messages: [{ role: "user", content: "question" }],
      tools: [],
      maxOutputTokens: 512,
      thinkingEnabled: false
    });
    const pending = (async () => {
      for await (const event of events) void event;
    })();
    const outcome = pending.then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error })
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toBe(1);

    caller.abort();
    await vi.advanceTimersByTimeAsync(250);

    const { error } = await outcome;
    expect(error).toMatchObject({ name: "AbortError" });
    expect(requests).toBe(1);
  });
});
