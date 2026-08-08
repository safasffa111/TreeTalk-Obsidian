export class BatchedPersistenceScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly persist: () => void,
    private readonly delayMilliseconds = 100
  ) {}

  schedule(): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.persist();
    }, this.delayMilliseconds);
  }

  flush(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.persist();
  }
}
