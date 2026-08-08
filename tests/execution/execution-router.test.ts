import { describe, expect, it } from "vitest";
import { ExecutionRouter } from "../../src/execution/execution-router";
import type {
  ExecutionEngine,
  ExecutionEvent,
  ExecutionRequest
} from "../../src/execution/types";

class NamedEngine implements ExecutionEngine {
  constructor(readonly name: string) {}
  async *execute(
    _request: ExecutionRequest,
    _signal: AbortSignal
  ): AsyncIterable<ExecutionEvent> {
    yield { type: "finish", reason: "stop" };
  }
}

describe("ExecutionRouter", () => {
  it("selects legacy by migration default and Pi only when explicitly enabled", () => {
    const legacy = new NamedEngine("legacy");
    const pi = new NamedEngine("pi");
    const router = new ExecutionRouter({ legacy, pi });

    expect(router.resolve("legacy")).toBe(legacy);
    expect(router.resolve("pi")).toBe(pi);
  });
});
