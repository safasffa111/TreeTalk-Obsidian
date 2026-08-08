import { describe, expect, it } from "vitest";
import { ExecutionEventRecorder } from "../../src/execution/event-recorder";
import { SendCoordinator } from "../../src/execution/send-coordinator";
import type {
  ExecutionEngine,
  ExecutionEvent,
  ExecutionRequest
} from "../../src/execution/types";

const request = {
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
} satisfies ExecutionRequest;

function engine(events: ExecutionEvent[]): ExecutionEngine {
  return {
    async *execute() {
      for (const event of events) yield event;
    }
  };
}

describe("SendCoordinator", () => {
  it("records one shared completed execution lifecycle", async () => {
    const deltas: string[] = [];
    const records: string[] = [];
    const result = await new SendCoordinator({
      now: () => "2026-08-04T00:00:01.000Z"
    }).execute({
      engine: engine([
        {
          type: "agent-start",
          runtime: "pi-agent-core-compatible",
          roleId: "direct"
        },
        {
          type: "stage-start",
          stageId: "direct",
          roleId: "direct",
          routeId: "default",
          startedAt: "2026-08-04T00:00:00.000Z"
        },
        { type: "text-delta", text: "answer" },
        {
          type: "sources",
          sources: [{ title: "Source", url: "https://example.test" }]
        },
        {
          type: "usage",
          usage: {
            promptTokens: 7,
            completionTokens: 2,
            providerReported: true
          }
        },
        { type: "finish", reason: "stop" }
      ]),
      request,
      signal: new AbortController().signal,
      recorder: new ExecutionEventRecorder({
        executionMode: "pi",
        roleId: "direct",
        routeId: "default",
        providerId: "openai",
        modelId: "gpt-test",
        startedAt: "2026-08-04T00:00:00.000Z"
      }),
      hooks: {
        onTextDelta: (text) => {
          deltas.push(text);
        },
        onThinkingDelta: () => {},
        onResponseStatus: () => {},
        onAgentRun: (record) => {
          records.push(record.status);
        }
      }
    });

    expect(result.status).toBe("completed");
    expect(result.agentRun.usage?.promptTokens).toBe(7);
    expect(result.sources).toEqual([
      { title: "Source", url: "https://example.test" }
    ]);
    expect(deltas).toEqual(["answer"]);
    expect(records).toContain("completed");
  });

  it("finishes failed when the engine emits an error", async () => {
    const result = await new SendCoordinator({
      now: () => "2026-08-04T00:00:01.000Z"
    }).execute({
      engine: engine([
        { type: "error", message: "provider failed", retryable: true }
      ]),
      request,
      signal: new AbortController().signal,
      recorder: new ExecutionEventRecorder({
        executionMode: "pi",
        roleId: "direct",
        routeId: "default",
        providerId: "openai",
        modelId: "gpt-test",
        startedAt: "2026-08-04T00:00:00.000Z"
      }),
      hooks: {
        onTextDelta: () => {},
        onThinkingDelta: () => {},
        onResponseStatus: () => {},
        onAgentRun: () => {}
      }
    });

    expect(result).toMatchObject({
      status: "failed",
      errorMessage: "provider failed",
      agentRun: { status: "failed", errorMessage: "provider failed" }
    });
  });
});
