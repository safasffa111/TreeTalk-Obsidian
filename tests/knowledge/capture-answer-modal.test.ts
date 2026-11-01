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
import { promptCaptureFileName } from "../../src/knowledge/capture-answer-modal";

function clickButton(label: string): void {
  const button = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label
  );
  button?.click();
}

function submitForm(): void {
  document
    .querySelector("form.treetalk-name-form")
    ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

describe("capture answer modal", () => {
  it("returns the edited file name for a normal capture", async () => {
    const result = promptCaptureFileName(
      {} as App,
      "ACK 机制",
      "TreeTalk 知识"
    );
    const input = document.querySelector<HTMLInputElement>(
      ".treetalk-name-input"
    );
    if (input === null) throw new Error("Name input is missing");
    expect(
      document.querySelector<HTMLElement>(".treetalk-name-description")
        ?.textContent
    ).toContain("TreeTalk 知识");

    input.value = "ACK 总结";
    submitForm();

    await expect(result).resolves.toEqual({
      fileName: "ACK 总结",
      insertAtReference: false
    });
  });

  it("marks the capture for insertion from the secondary action", async () => {
    const result = promptCaptureFileName(
      {} as App,
      "ACK 机制",
      "TreeTalk 知识"
    );
    clickButton("确定并插入");

    await expect(result).resolves.toEqual({
      fileName: "ACK 机制",
      insertAtReference: true
    });
  });
});
