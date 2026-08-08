import type { ExecutionEngine, ExecutionEvent, ExecutionRequest } from "../../execution/types";
import { ProgressivePiExecutionEngine } from "./progressive/progressive-execution-engine";
import {
  TwoPassPiExecutionEngine,
  type TwoPassPiExecutionEngineDependencies
} from "./two-pass-execution-engine";

export { ProgressivePiExecutionEngine } from "./progressive/progressive-execution-engine";
export {
  TwoPassPiExecutionEngine,
  type PiBufferedResponse,
  type TwoPassPiExecutionEngineDependencies
} from "./two-pass-execution-engine";

export type PiExecutionStrategy = "progressive" | "two-pass";

export interface PiExecutionEngineDependencies
  extends TwoPassPiExecutionEngineDependencies {
  strategy?: PiExecutionStrategy;
}

function supportsProgressiveProvider(
  kind: ExecutionRequest["route"]["providerProfile"]["kind"]
): boolean {
  return (
    kind === "deepseek" ||
    kind === "openai" ||
    kind === "openai-compatible"
  );
}

/** Selects the progressive ladder only where the provider protocol is verified. */
export class PiExecutionEngine implements ExecutionEngine {
  private readonly progressive: ProgressivePiExecutionEngine;
  private readonly twoPass: TwoPassPiExecutionEngine;
  private readonly explicitStrategy: PiExecutionStrategy | undefined;

  constructor(dependencies: PiExecutionEngineDependencies) {
    this.progressive = new ProgressivePiExecutionEngine(dependencies);
    this.twoPass = new TwoPassPiExecutionEngine(dependencies);
    this.explicitStrategy = dependencies.strategy;
  }

  execute(
    request: ExecutionRequest,
    signal: AbortSignal
  ): AsyncIterable<ExecutionEvent> {
    const strategy =
      this.explicitStrategy ??
      (supportsProgressiveProvider(request.route.providerProfile.kind)
        ? "progressive"
        : "two-pass");
    return strategy === "progressive"
      ? this.progressive.execute(request, signal)
      : this.twoPass.execute(request, signal);
  }
}
