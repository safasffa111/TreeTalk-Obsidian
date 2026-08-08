import { describe, expect, it } from "vitest";
import { PiExecutionEngine } from "../../src/agent/pi/pi-execution-engine";
import type { ExecutionEvent, ExecutionRequest } from "../../src/execution/types";

const REQUEST: ExecutionRequest = {
  conversationId: "conversation",
  nodeId: "gauss",
  assistantMessageId: "assistant",
  contextMessages: [{ role: "user", content: "它为什么成立" }],
  piContext: {
    currentQuestion: "它为什么成立",
    selectedQuotes: [],
    conversationNodes: [
      {
        id: "green",
        parentId: null,
        title: "格林公式",
        depth: 0,
        root: true,
        current: false,
        messages: [
          {
            id: "green-answer",
            role: "assistant",
            content: "格林公式内容",
            status: "complete",
            selectionQuotes: []
          }
        ]
      },
      {
        id: "gauss",
        parentId: "green",
        title: "高斯公式",
        depth: 1,
        root: false,
        current: true,
        messages: [
          {
            id: "gauss-question",
            role: "user",
            content: "什么是高斯公式",
            status: "complete",
            selectionQuotes: []
          },
          {
            id: "gauss-answer",
            role: "assistant",
            content: "高斯公式父节点回答",
            status: "complete",
            selectionQuotes: []
          }
        ]
      }
    ],
    focus: {
      interactionMode: "continue",
      defaultScope: "latest_round",
      anchors: [
        {
          kind: "conversation-round",
          sourceNodeId: "gauss",
          sourceMessageId: "gauss-answer",
          reason: "previous-turn"
        }
      ]
    }
  },
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

describe("PiExecutionEngine", () => {
  it("protects local focus before producing the final Pi answer", async () => {
    const requests: unknown[] = [];
    const replies = [
      {
        status: 200,
        json: {
          choices: [{
            message: {
              content: JSON.stringify({
                focus: {
                  scope: "latest_round",
                  reason: "the question continues the current node"
                },
                notes: [],
                nodes: []
              })
            },
            finish_reason: "stop"
          }],
          usage: { prompt_tokens: 3, completion_tokens: 1 }
        }
      },
      {
        status: 200,
        json: {
          choices: [{
            message: { content: "answer" },
            finish_reason: "stop"
          }],
          usage: { prompt_tokens: 4, completion_tokens: 1 }
        }
      }
    ];
    const engine = new PiExecutionEngine({
    strategy: "two-pass",
      bufferedRequest: async (request) => {
        requests.push(request);
        const reply = replies.shift();
        if (reply === undefined) throw new Error("Unexpected Pi request");
        return reply;
      },
      now: () => "2026-08-04T00:00:00.000Z"
    });
    const events: ExecutionEvent[] = [];
    for await (const event of engine.execute(
      REQUEST,
      new AbortController().signal
    )) {
      events.push(event);
    }

    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1])).toContain("Local Focus Evidence");
    expect(JSON.stringify(requests[1])).toContain("高斯公式父节点回答");
    expect(JSON.stringify(requests[1])).toContain("Response Target");
    expect(events[0]).toEqual({
      type: "agent-start",
      runtime: "pi-agent-core-v0.82.1-vendored",
      roleId: "direct"
    });
    expect(events.filter((event) => event.type === "text-delta")).toEqual([
      { type: "text-delta", text: "answer" }
    ]);
    expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" });
  });
});
