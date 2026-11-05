// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  Modal: class {
    readonly contentEl = document.createElement("div");

    constructor() {
      document.body.append(this.contentEl);
    }

    open(): void {
      (this as { onOpen?: () => void }).onOpen?.();
    }

    close(): void {
      (this as { onClose?: () => void }).onClose?.();
      this.contentEl.remove();
    }
  }
}));

import type { App } from "obsidian";
import {
  promptForName,
  promptForNameWithAction
} from "../../src/views/name-input-modal";

function submitForm(): void {
  document
    .querySelector("form.treetalk-name-form")
    ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

describe("name input modal", () => {
  it("returns the edited name and enforces a non-empty value", async () => {
    const result = promptForName({} as App, {
      title: "沉淀回答",
      value: "旧名称",
      confirmLabel: "沉淀"
    });
    const input = document.querySelector<HTMLInputElement>(
      ".treetalk-name-input"
    );
    if (input === null) throw new Error("Name input is missing");
    expect(input.value).toBe("旧名称");

    input.value = "   ";
    submitForm();
    expect(
      document.querySelector<HTMLElement>(".treetalk-name-error")?.textContent
    ).toBe("名称不能为空");

    input.value = " 新名称 ";
    submitForm();
    await expect(result).resolves.toBe("新名称");
  });

  it("returns the secondary action without submitting the form", async () => {
    const result = promptForNameWithAction({} as App, {
      title: "沉淀回答",
      value: "ACL 机制",
      confirmLabel: "沉淀",
      secondaryActionLabel: "确定并插入"
    });
    const secondary = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "确定并插入"
    );
    secondary?.click();

    await expect(result).resolves.toEqual({
      value: "ACL 机制",
      action: "secondary"
    });
  });

  it("keeps Enter on the primary action", async () => {
    const result = promptForNameWithAction({} as App, {
      title: "沉淀回答",
      value: "ACK 机制",
      secondaryActionLabel: "确定并插入"
    });
    submitForm();

    await expect(result).resolves.toEqual({
      value: "ACK 机制",
      action: "primary"
    });
  });

  it("returns undefined when the dialog is cancelled", async () => {
    const result = promptForName({} as App, {
      title: "重命名历史对话",
      value: "旧名称"
    });
    const cancel = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "取消"
    );
    cancel?.click();

    await expect(result).resolves.toBeUndefined();
  });

  it("runs the custom validator before accepting the value", async () => {
    const result = promptForName({} as App, {
      title: "沉淀回答",
      value: "bad/name",
      validate: (value) => (value.includes("/") ? "不能包含斜杠" : undefined)
    });
    const input = document.querySelector<HTMLInputElement>(
      ".treetalk-name-input"
    );
    if (input === null) throw new Error("Name input is missing");

    submitForm();
    expect(
      document.querySelector<HTMLElement>(".treetalk-name-error")?.textContent
    ).toBe("不能包含斜杠");

    input.value = "good name";
    submitForm();
    await expect(result).resolves.toBe("good name");
  });
});
