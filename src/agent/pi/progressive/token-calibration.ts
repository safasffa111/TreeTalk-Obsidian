export interface TokenCalibrationSnapshot {
  estimatedInputTokens: number;
  actualInputTokens: number;
  samples: number;
}

/**
 * Runtime calibration between the local token estimate and the provider's
 * reported input tokens.
 *
 * The plugin budgets evidence with `estimateTextTokens`, which can drift from
 * the provider tokenizer (measured roughly 6-11% low on DeepSeek in practice).
 * Each completed Pi turn records the estimated request size versus the actual
 * `prompt_tokens`, and the rolling ratio is used to adjust budget checks so
 * cached/missed input accounting stays close to real usage.
 */
export class TokenCalibrator {
  private estimatedInputTokens = 0;
  private actualInputTokens = 0;
  private samples = 0;

  record(estimated: number, actual: number): void {
    if (
      !Number.isFinite(estimated) ||
      !Number.isFinite(actual) ||
      estimated <= 0 ||
      actual < 0
    ) {
      return;
    }
    this.estimatedInputTokens += estimated;
    this.actualInputTokens += actual;
    this.samples += 1;
  }

  /** Actual / estimated ratio; 1 until at least one sample is recorded. */
  ratio(): number {
    if (this.samples === 0 || this.estimatedInputTokens <= 0) return 1;
    return Math.min(
      3,
      Math.max(0.5, this.actualInputTokens / this.estimatedInputTokens)
    );
  }

  adjust(estimated: number): number {
    return Math.max(0, Math.ceil(estimated * this.ratio()));
  }

  snapshot(): TokenCalibrationSnapshot {
    return {
      estimatedInputTokens: this.estimatedInputTokens,
      actualInputTokens: this.actualInputTokens,
      samples: this.samples
    };
  }

  static restore(
    snapshot: TokenCalibrationSnapshot | undefined
  ): TokenCalibrator {
    const calibrator = new TokenCalibrator();
    if (
      snapshot !== undefined &&
      Number.isFinite(snapshot.estimatedInputTokens) &&
      Number.isFinite(snapshot.actualInputTokens) &&
      Number.isInteger(snapshot.samples) &&
      snapshot.samples >= 0
    ) {
      calibrator.estimatedInputTokens = Math.max(0, snapshot.estimatedInputTokens);
      calibrator.actualInputTokens = Math.max(0, snapshot.actualInputTokens);
      calibrator.samples = snapshot.samples;
    }
    return calibrator;
  }
}
