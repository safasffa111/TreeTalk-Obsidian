export class ResponseEpoch {
  private value = 0;

  capture(): number {
    return this.value;
  }

  invalidate(): void {
    this.value += 1;
  }

  isCurrent(value: number): boolean {
    return value === this.value;
  }
}
