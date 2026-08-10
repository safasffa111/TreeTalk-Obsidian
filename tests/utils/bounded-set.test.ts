import { describe, expect, it } from "vitest";
import { rememberBounded } from "../../src/utils/bounded-set";

describe("bounded set memory", () => {
  it("reports duplicates without growing the set", () => {
    const values = new Set<string>();

    expect(rememberBounded(values, "one", 2)).toBe(true);
    expect(rememberBounded(values, "one", 2)).toBe(false);
    expect([...values]).toEqual(["one"]);
  });

  it("evicts the oldest value before exceeding its limit", () => {
    const values = new Set<string>();

    rememberBounded(values, "one", 2);
    rememberBounded(values, "two", 2);

    expect(rememberBounded(values, "three", 2)).toBe(true);
    expect([...values]).toEqual(["two", "three"]);
  });
});
