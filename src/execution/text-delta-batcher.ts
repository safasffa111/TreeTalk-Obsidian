export interface TextDeltaBatcherOptions {
  intervalMs?: number;
  schedule?(run: () => void, delayMs: number): unknown;
  cancel?(handle: unknown): void;
}

const DEFAULT_INTERVAL_MS = 100;

export class TextDeltaBatcher {
  private readonly fragments: string[] = [];
  private readonly intervalMs: number;
  private readonly schedule: (run: () => void, delayMs: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  private pendingHandle: unknown | undefined;
  private disposed = false;

  constructor(
    private readonly deliver: (text: string) => void,
    options: TextDeltaBatcherOptions = {}
  ) {
    this.intervalMs = Math.max(0, options.intervalMs ?? DEFAULT_INTERVAL_MS);
    this.schedule =
      options.schedule ?? ((run, delayMs) => setTimeout(run, delayMs));
    this.cancel =
      options.cancel ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  append(text: string): void {
    if (this.disposed || text.length === 0) return;
    this.fragments.push(text);
    if (this.pendingHandle !== undefined) return;
    this.pendingHandle = this.schedule(() => {
      this.pendingHandle = undefined;
      this.deliverPending();
    }, this.intervalMs);
  }

  flush(): void {
    if (this.pendingHandle !== undefined) {
      this.cancel(this.pendingHandle);
      this.pendingHandle = undefined;
    }
    this.deliverPending();
  }

  dispose(): void {
    if (this.disposed) return;
    this.flush();
    this.disposed = true;
  }

  private deliverPending(): void {
    if (this.fragments.length === 0) return;
    const text = this.fragments.join("");
    this.fragments.length = 0;
    this.deliver(text);
  }
}
