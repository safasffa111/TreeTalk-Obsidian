import type { AgentRunRecord } from "../domain/agent-run";
import type { ExecutionEventRecorder } from "./event-recorder";
import type { ProgressiveRunCheckpoint } from "../agent/pi/progressive/types";
import type {
  ExecutionEngine,
  ExecutionRequest,
  ExecutionResponseProgress,
  ExecutionSource
} from "./types";

export type SendExecutionStatus = "completed" | "aborted" | "failed";

export interface SendCoordinatorHooks {
  onTextDelta(text: string): void | Promise<void>;
  onThinkingDelta(text: string): void | Promise<void>;
  onResponseStatus(progress: ExecutionResponseProgress): void | Promise<void>;
  onAgentRun(record: AgentRunRecord): void | Promise<void>;
  onProgressiveRunCheckpoint?(
    checkpoint: ProgressiveRunCheckpoint
  ): void | Promise<void>;
}

export interface SendCoordinatorInput {
  engine: ExecutionEngine;
  request: ExecutionRequest;
  signal: AbortSignal;
  recorder: ExecutionEventRecorder;
  hooks: SendCoordinatorHooks;
}

export interface SendCoordinatorResult {
  status: SendExecutionStatus;
  receivedText: boolean;
  sources: ExecutionSource[];
  agentRun: AgentRunRecord;
  errorMessage?: string;
}

export interface SendCoordinatorDependencies {
  now?(): string;
}

/**
 * Owns one engine-neutral execution lifecycle.
 *
 * TreeTalk UI and persistence are injected as hooks so Legacy, Pi Direct and
 * future role pipelines all share the same completion, abort and failure rules.
 */
export class SendCoordinator {
  private readonly now: () => string;

  constructor(dependencies: SendCoordinatorDependencies = {}) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  async execute(input: SendCoordinatorInput): Promise<SendCoordinatorResult> {
    const sourceMap = new Map<string, ExecutionSource>();
    let receivedText = false;

    const publishRecord = async (record: AgentRunRecord): Promise<void> => {
      await input.hooks.onAgentRun(record);
    };
    const finish = async (
      status: SendExecutionStatus,
      errorMessage?: string
    ): Promise<SendCoordinatorResult> => {
      const agentRun = input.recorder.finish(
        status === "completed"
          ? "completed"
          : status === "aborted"
            ? "aborted"
            : "failed",
        this.now(),
        errorMessage
      );
      await publishRecord(agentRun);
      return {
        status,
        receivedText,
        sources: [...sourceMap.values()],
        agentRun,
        ...(errorMessage === undefined ? {} : { errorMessage })
      };
    };

    try {
      for await (const event of input.engine.execute(
        input.request,
        input.signal
      )) {
        if (input.signal.aborted) return await finish("aborted");

        if (event.type === "text-delta") {
          if (event.text.length === 0) continue;
          receivedText = true;
          await input.hooks.onTextDelta(event.text);
          continue;
        }
        if (event.type === "thinking-delta") {
          if (event.text.length > 0) {
            await input.hooks.onThinkingDelta(event.text);
          }
          continue;
        }
        if (event.type === "response-status") {
          const progress = event.progress ??
            (event.status === undefined ? undefined : { status: event.status });
          if (progress !== undefined) {
            await input.hooks.onResponseStatus(progress);
          }
          continue;
        }
        if (event.type === "finish") {
          if (event.reason === "aborted") return await finish("aborted");
          if (!receivedText) {
            return await finish(
              "failed",
              "Agent execution ended without a complete response"
            );
          }
          return await finish("completed");
        }
        if (event.type === "progressive-run-checkpoint") {
          if (input.hooks.onProgressiveRunCheckpoint !== undefined) {
            await input.hooks.onProgressiveRunCheckpoint(event.checkpoint);
          }
          continue;
        }

        const record = input.recorder.apply(event);
        await publishRecord(record);
        if (event.type === "sources") {
          for (const source of event.sources) {
            sourceMap.set(source.url, { ...source });
          }
          continue;
        }
        if (event.type === "error") {
          return await finish("failed", event.message);
        }
      }

      if (input.signal.aborted) return await finish("aborted");
      return await finish(
        "failed",
        "Agent execution ended without a complete response"
      );
    } catch (error) {
      if (input.signal.aborted) return await finish("aborted");
      return await finish(
        "failed",
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}
