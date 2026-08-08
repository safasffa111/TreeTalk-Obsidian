import { describe, expect, it } from "vitest";
import { ResponseEpoch } from "../../src/domain/response-epoch";

describe("ResponseEpoch", () => {
  it("invalidates replies captured before a conversation lifecycle change", () => {
    const epoch = new ResponseEpoch();
    const request = epoch.capture();

    epoch.invalidate();

    expect(epoch.isCurrent(request)).toBe(false);
    expect(epoch.isCurrent(epoch.capture())).toBe(true);
  });
});
