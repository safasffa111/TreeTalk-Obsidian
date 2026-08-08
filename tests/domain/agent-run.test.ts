import { describe, expect, it } from "vitest";
import {
  applyAgentRunEvent,
  createAgentRunRecord,
  finishAgentRunRecord
} from "../../src/domain/agent-run";

describe("AgentRunRecord", () => {
  it("records one direct execution without storing credentials", () => {
    let record = createAgentRunRecord({
      executionMode: "pi",
      roleId: "direct",
      routeId: "default",
      providerId: "openai",
      modelId: "gpt-test",
      startedAt: "2026-08-04T00:00:00.000Z"
    });
    record = applyAgentRunEvent(record, {
      type: "stage-start",
      stageId: "direct",
      roleId: "direct",
      routeId: "default",
      startedAt: "2026-08-04T00:00:00.000Z"
    });
    record = applyAgentRunEvent(record, {
      type: "usage",
      usage: {
        promptTokens: 10,
        completionTokens: 4,
        cacheHitTokens: 2,
        providerReported: true
      }
    });
    record = finishAgentRunRecord(record, {
      status: "completed",
      finishedAt: "2026-08-04T00:00:01.000Z"
    });

    expect(record).toMatchObject({
      protocol: "pi-agent-run:v1",
      executionMode: "pi",
      status: "completed",
      roleId: "direct",
      routeId: "default",
      providerId: "openai",
      modelId: "gpt-test",
      usage: {
        promptTokens: 10,
        completionTokens: 4,
        cacheHitTokens: 2,
        providerReported: true
      }
    });
    expect(JSON.stringify(record)).not.toContain("apiKey");
    expect(JSON.stringify(record)).not.toContain("secret");
  });

  it("records aborted and failed outcomes without changing the protocol", () => {
    const base = createAgentRunRecord({
      executionMode: "legacy",
      roleId: "direct",
      routeId: "default",
      providerId: "anthropic",
      modelId: "claude-test",
      startedAt: "2026-08-04T00:00:00.000Z"
    });

    expect(
      finishAgentRunRecord(base, {
        status: "aborted",
        finishedAt: "2026-08-04T00:00:01.000Z"
      }).status
    ).toBe("aborted");
    expect(
      finishAgentRunRecord(base, {
        status: "failed",
        finishedAt: "2026-08-04T00:00:01.000Z",
        errorMessage: "network failed"
      })
    ).toMatchObject({ status: "failed", errorMessage: "network failed" });
  });
});
