import { describe, expect, it } from "vitest";
import {
  AnchorCaptureError,
  mapAnchorCaptureErrorToNotice
} from "../../src/knowledge/capture-service";

describe("mapAnchorCaptureErrorToNotice", () => {
  it("returns a localized message for anchor-foreign-vault", () => {
    const error = new AnchorCaptureError(
      "anchor-foreign-vault",
      "会话锚定文件不在当前 Vault，已阻止本次沉淀"
    );
    expect(mapAnchorCaptureErrorToNotice(error)).toBe(
      "会话锚定文件不在当前 Vault，请右键目标笔记重新绑定"
    );
  });

  it("returns a localized message for anchor-legacy-unverified", () => {
    const error = new AnchorCaptureError(
      "anchor-legacy-unverified",
      "锚点为旧数据未验证"
    );
    expect(mapAnchorCaptureErrorToNotice(error)).toBe(
      "当前锚点为旧数据未验证，请在笔记上右键重新绑定后再沉淀"
    );
  });

  it("returns a localized message for anchor-missing", () => {
    const error = new AnchorCaptureError(
      "anchor-missing",
      "锚定文件不存在或已删除"
    );
    expect(mapAnchorCaptureErrorToNotice(error)).toBe(
      "锚定文件不存在或已删除，请右键目标笔记重新绑定"
    );
  });

  it("returns a localized message for anchor-ambiguous", () => {
    const error = new AnchorCaptureError(
      "anchor-ambiguous",
      "歧义候选"
    );
    expect(mapAnchorCaptureErrorToNotice(error)).toBe(
      "当前 Vault 中存在多个同 ctime 的候选文件，请右键目标笔记重新绑定"
    );
  });

  it("falls back to the error message for unknown codes", () => {
    const error = new Error("unexpected");
    expect(mapAnchorCaptureErrorToNotice(error)).toBe(
      "知识沉淀失败，对话内容未受影响"
    );
  });
});