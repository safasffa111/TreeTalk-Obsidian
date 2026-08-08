import { describe, expect, it, vi } from "vitest";
import { createWarnOnce, logWarning } from "../../src/utils/error-log";

describe("logWarning", () => {
  it("prefixes formatted Error messages", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logWarning("读取会话失败", new Error("boom"));
    expect(spy).toHaveBeenCalledWith("[TreeTalk] 读取会话失败: boom");
    spy.mockRestore();
  });

  it("keeps string errors as-is and omits the suffix when absent", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logWarning("解析失败", "raw");
    logWarning("布局解析失败");
    expect(spy).toHaveBeenNthCalledWith(1, "[TreeTalk] 解析失败: raw");
    expect(spy).toHaveBeenNthCalledWith(2, "[TreeTalk] 布局解析失败");
    spy.mockRestore();
  });

  it("never throws for unknown error values", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => logWarning("未知错误", { weird: true })).not.toThrow();
    spy.mockRestore();
  });
});

describe("createWarnOnce", () => {
  it("warns only on the first call", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const warnOnce = createWarnOnce();
    warnOnce("渲染失败", new Error("first"));
    warnOnce("渲染失败", new Error("second"));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("[TreeTalk] 渲染失败: first");
    spy.mockRestore();
  });
});
