import { describe, expect, it } from "vitest";
import { LegacyExecutionEngine } from "../../src/execution/legacy-execution-engine";
import type { ExecutionEvent, ExecutionRequest } from "../../src/execution/types";
import { OpenAiProvider } from "../../src/providers/openai-provider";
import type { ProviderEvent, ProviderRequest } from "../../src/providers/types";

function request(): ExecutionRequest {
  return {
    conversationId: "conversation",
    nodeId: "node",
    assistantMessageId: "assistant",
    contextMessages: [{ role: "user", content: "hello" }],
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
    webSearchEnabled: false
  };
}

async function collect(engine: LegacyExecutionEngine): Promise<ExecutionEvent[]> {
  const events: ExecutionEvent[] = [];
  for await (const event of engine.execute(
    request(),
    new AbortController().signal
  )) {
    events.push(event);
  }
  return events;
}

describe("LegacyExecutionEngine", () => {
  it("normalizes provider streaming events into the engine-neutral protocol", async () => {
    const providerEvents: ProviderEvent[] = [
      { type: "delta", text: "你" },
      {
        type: "usage",
        usage: {
          promptTokens: 3,
          completionTokens: 1,
          providerReported: true
        }
      },
      { type: "delta", text: "好" },
      { type: "done" }
    ];
    const engine = new LegacyExecutionEngine({
      resolveAdapter: () => new OpenAiProvider(),
      stream: async function* () {
        yield* providerEvents;
      },
      bufferedRequest: async (_request: ProviderRequest) => ({
        status: 200,
        json: {}
      })
    });

    expect(await collect(engine)).toEqual([
      {
        type: "stage-start",
        stageId: "direct",
        roleId: "direct",
        routeId: "default",
        startedAt: expect.any(String)
      },
      {
        type: "response-status",
        progress: { status: "preparing-context" }
      },
      {
        type: "response-status",
        progress: { status: "generating-final-answer" }
      },
      { type: "text-delta", text: "你" },
      { type: "text-delta", text: "好" },
      {
        type: "usage",
        usage: {
          promptTokens: 3,
          completionTokens: 1,
          providerReported: true
        }
      },
      { type: "finish", reason: "stop" }
    ]);
  });

  it("uses buffered fallback only when streaming is explicitly unavailable", async () => {
    const adapter = new OpenAiProvider();
    adapter.parseBuffered = () => [
      { type: "delta", text: "fallback" },
      { type: "done" }
    ];
    const engine = new LegacyExecutionEngine({
      resolveAdapter: () => adapter,
      stream: async function* () {
        yield* [];
        const error = new Error("unavailable");
        error.name = "StreamingUnavailableError";
        throw error;
      },
      canUseBufferedFallback: (error) =>
        error instanceof Error && error.name === "StreamingUnavailableError",
      bufferedRequest: async () => ({ status: 200, json: {} })
    });

    const events = await collect(engine);
    expect(events).toContainEqual({ type: "text-delta", text: "fallback" });
    expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" });
  });
});
