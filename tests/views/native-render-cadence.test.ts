import { describe, expect, it } from "vitest";
import { nativeMarkdownRenderIntervalMs } from "../../src/views/native-render-cadence";

describe("native Markdown render cadence", () => {
  it.each([
    [0, 120],
    [2_000, 120],
    [2_001, 220],
    [8_000, 220],
    [8_001, 360],
    [50_000, 360]
  ])("uses the length band for %i characters", (length, expected) => {
    expect(nativeMarkdownRenderIntervalMs(length)).toBe(expected);
  });
});
