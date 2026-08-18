import { describe, expect, it } from "vitest";
import {
  buildPiProviderRequest,
  parsePiProviderResponse
} from "../../../src/agent/pi/pi-provider-transport";
import type { PiProviderTurnInput } from "../../../src/agent/pi/pi-provider-transport";

function turnInput(
  kind: PiProviderTurnInput["profile"]["kind"],
  baseUrl = ""
): PiProviderTurnInput {
  return {
    profile: {
      id: kind,
      name: kind,
      kind,
      apiKey: "secret",
      baseUrl
    },
    modelId: kind === "deepseek" ? "deepseek-v4-flash" : "MiniMax-M3",
    systemPrompt: "Be precise",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    thinkingEnabled: true
  };
}

describe("Pi provider transport", () => {
  it("routes DeepSeek through Chat Completions with OpenAI tool semantics", () => {
    const request = buildPiProviderRequest({
      ...turnInput("deepseek", "https://api.deepseek.com"),
      messages: [
        {
          role: "assistant",
          content: "",
          reasoningContent: "reasoning",
          toolCalls: [{ id: "call-1", name: "expand_context", arguments: { level: 1 } }]
        }
      ],
      tools: [
        {
          name: "expand_context",
          description: "Expand context",
          parameters: { type: "object", properties: { level: { type: "number" } } }
        }
      ],
      toolChoice: "auto"
    });

    expect(request.url).toBe("https://api.deepseek.com/chat/completions");
    expect(request.responseFormat).toBe("openai");
    expect(request.body).toMatchObject({
      thinking: { type: "enabled" },
      tool_choice: "auto",
      messages: [
        { role: "system", content: "Be precise" },
        {
          role: "assistant",
          content: null,
          reasoning_content: "reasoning",
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "expand_context", arguments: '{"level":1}' }
            }
          ]
        }
      ]
    });
  });

  it("parses a DeepSeek Chat Completions response including reasoning", () => {
    expect(
      parsePiProviderResponse(turnInput("deepseek").profile, {
        choices: [
          {
            message: { content: "answer", reasoning_content: "reasoning" },
            finish_reason: "stop"
          }
        ]
      })
    ).toMatchObject({ text: "answer", thinking: "reasoning", stopReason: "stop" });
  });

  it("keeps MiniMax on its Anthropic endpoint without duplicating the path", () => {
    const request = buildPiProviderRequest(
      turnInput("anthropic", "https://api.minimaxi.com/anthropic")
    );
    expect(request.url).toBe("https://api.minimaxi.com/anthropic/v1/messages");
    expect(request.body).toMatchObject({ thinking: { type: "adaptive" } });
  });
});
