import type { ExecutionEngine, ExecutionMode } from "./types";

export interface ExecutionRouterEngines {
  legacy: ExecutionEngine;
  pi: ExecutionEngine;
}

export class ExecutionRouter {
  constructor(private readonly engines: ExecutionRouterEngines) {}

  resolve(mode: ExecutionMode): ExecutionEngine {
    return mode === "pi" ? this.engines.pi : this.engines.legacy;
  }
}
