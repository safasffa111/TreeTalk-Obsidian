import { describe, expect, it } from "vitest";
import { assertSafeWebUrl } from "../../../src/agent/pi/progressive/web-page-reader";

describe("assertSafeWebUrl", () => {
  it.each([
    "http://[::ffff:127.0.0.1]/private",
    "http://[::ffff:7f00:1]/private",
    "http://[::ffff:a00:1]/private",
    "http://[::ffff:c0a8:101]/private",
    "http://[::ffff:a9fe:1]/private"
  ])("rejects mapped private address %s", (url) => {
    expect(() => assertSafeWebUrl(url)).toThrow("不安全");
  });

  it("keeps public HTTPS pages available", () => {
    expect(assertSafeWebUrl("https://example.com/article").href).toBe(
      "https://example.com/article"
    );
  });
});
