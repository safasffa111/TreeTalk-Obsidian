// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({
  Modal: class {
    readonly contentEl = document.createElement("div");
    open(): void {}
    close(): void {}
  },
  setIcon: (element: HTMLElement, icon: string) => {
    element.dataset.icon = icon;
  }
}));

import {
  renderHistoryManager,
  type HistoryManagerActions
} from "../../src/history/history-manager-modal";
import type { HistoryEntry } from "../../src/history/history-index";

const entries: HistoryEntry[] = [
  {
    id: "one",
    title: "TCP reliability",
    folder: "history/one",
    updatedAt: "2026-07-30T01:00:00.000Z"
  },
  {
    id: "two",
    title: "Stack overflow",
    folder: "history/two",
    updatedAt: "2026-07-29T01:00:00.000Z"
  }
];

function actions(
  overrides: Partial<HistoryManagerActions> = {}
): HistoryManagerActions {
  return {
    open: vi.fn(() => Promise.resolve()),
    confirmDelete: vi.fn(() => Promise.resolve(true)),
    delete: vi.fn((entry: HistoryEntry) =>
      Promise.resolve(entries.filter((candidate) => candidate.id !== entry.id))
    ),
    reportError: vi.fn(),
    ...overrides
  };
}

describe("history manager", () => {
  it("filters by title and opens the selected history conversation", () => {
    const container = document.createElement("div");
    const open = vi.fn(() => Promise.resolve());
    const managerActions = actions({ open });
    renderHistoryManager(container, entries, managerActions);
    const search = container.querySelector<HTMLInputElement>(
      ".treetalk-history-search"
    );
    if (search === null) throw new Error("Search is missing");

    search.value = "stack";
    search.dispatchEvent(new InputEvent("input", { bubbles: true }));

    expect(container.querySelectorAll(".treetalk-history-row")).toHaveLength(1);
    container
      .querySelector<HTMLButtonElement>(".treetalk-history-open")
      ?.click();
    expect(open).toHaveBeenCalledWith(entries[1]);
  });

  it("requires confirmation and removes only the successfully deleted row", async () => {
    const container = document.createElement("div");
    const confirmDelete = vi.fn(() => Promise.resolve(true));
    const remove = vi.fn((entry: HistoryEntry) =>
      Promise.resolve(
        entries.filter((candidate) => candidate.id !== entry.id)
      )
    );
    const managerActions = actions({
      confirmDelete,
      delete: remove
    });
    renderHistoryManager(container, entries, managerActions);
    const firstDelete = container.querySelector<HTMLButtonElement>(
      "[data-conversation-id='one'] .treetalk-history-delete"
    );

    firstDelete?.click();

    await vi.waitFor(() =>
      expect(container.querySelectorAll(".treetalk-history-row")).toHaveLength(
        1
      )
    );
    expect(confirmDelete).toHaveBeenCalledWith(entries[0]);
    expect(remove).toHaveBeenCalledWith(entries[0]);
    expect(container.textContent).toContain("Stack overflow");
  });

  it("reserves a dedicated grid column for the delete control", () => {
    const container = document.createElement("div");
    renderHistoryManager(container, entries, actions());
    const row = container.querySelector<HTMLElement>(".treetalk-history-row");
    expect(row?.getAttribute("role")).toBe("group");

    const css = readFileSync("styles.css", "utf8");
    const rowRule = css.match(/\.treetalk-history-row\s*\{([^}]*)\}/su)?.[1];
    expect(rowRule).toContain("display: grid");
    expect(rowRule).toContain("grid-template-columns: minmax(0, 1fr) 30px");
  });

  it("keeps the row when deletion is cancelled or storage fails", async () => {
    const cancelledContainer = document.createElement("div");
    const cancelledDelete = vi.fn((entry: HistoryEntry) =>
      Promise.resolve(
        entries.filter((candidate) => candidate.id !== entry.id)
      )
    );
    const cancelActions = actions({
      confirmDelete: vi.fn(() => Promise.resolve(false)),
      delete: cancelledDelete
    });
    renderHistoryManager(cancelledContainer, entries, cancelActions);
    cancelledContainer
      .querySelector<HTMLButtonElement>(".treetalk-history-delete")
      ?.click();
    await Promise.resolve();
    expect(cancelledDelete).not.toHaveBeenCalled();
    expect(
      cancelledContainer.querySelectorAll(".treetalk-history-row")
    ).toHaveLength(2);

    const failedContainer = document.createElement("div");
    const error = new Error("disk failure");
    const reportError = vi.fn();
    const failureActions = actions({
      delete: vi.fn(() => Promise.reject(error)),
      reportError
    });
    renderHistoryManager(failedContainer, entries, failureActions);
    failedContainer
      .querySelector<HTMLButtonElement>(".treetalk-history-delete")
      ?.click();
    await vi.waitFor(() =>
      expect(reportError).toHaveBeenCalledWith(error)
    );
    expect(
      failedContainer.querySelectorAll(".treetalk-history-row")
    ).toHaveLength(2);
  });
});
