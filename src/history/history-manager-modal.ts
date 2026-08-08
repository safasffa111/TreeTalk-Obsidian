import {
  Modal,
  setIcon,
  type App
} from "obsidian";
import type { HistoryEntry } from "./history-index";

export interface HistoryManagerActions {
  open(entry: HistoryEntry): Promise<void>;
  confirmDelete(entry: HistoryEntry): Promise<boolean>;
  delete(entry: HistoryEntry): Promise<HistoryEntry[]>;
  reportError(error: unknown): void;
}

export function renderHistoryManager(
  container: HTMLElement,
  initialEntries: HistoryEntry[],
  actions: HistoryManagerActions
): () => void {
  let entries = initialEntries.map((entry) => ({ ...entry }));
  let query = "";
  let disposed = false;

  const search = document.createElement("input");
  search.type = "search";
  search.className = "treetalk-history-search";
  search.placeholder = "搜索历史对话…";
  const list = document.createElement("div");
  list.className = "treetalk-history-list";

  const renderRows = (): void => {
    if (disposed) return;
    list.replaceChildren();
    const normalized = query.trim().toLocaleLowerCase();
    const visible = entries.filter(
      (entry) =>
        normalized.length === 0 ||
        entry.title.toLocaleLowerCase().includes(normalized)
    );
    for (const entry of visible) {
      const row = document.createElement("div");
      row.className = "treetalk-history-row";
      row.dataset.conversationId = entry.id;
      row.setAttribute("role", "group");
      row.setAttribute("aria-label", entry.title);
      const open = document.createElement("button");
      open.type = "button";
      open.className = "treetalk-history-open";
      open.textContent = entry.title;
      open.addEventListener("click", () => {
        void actions.open(entry);
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "treetalk-history-delete";
      remove.setAttribute("aria-label", `删除历史对话 ${entry.title}`);
      setIcon(remove, "trash-2");
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        void (async () => {
          if (!(await actions.confirmDelete(entry))) return;
          remove.disabled = true;
          try {
            entries = await actions.delete(entry);
            renderRows();
          } catch (error) {
            remove.disabled = false;
            actions.reportError(error);
          }
        })();
      });
      row.append(open, remove);
      list.append(row);
    }
    if (visible.length === 0) {
      const empty = document.createElement("div");
      empty.className = "treetalk-history-empty";
      empty.textContent = "没有匹配的历史对话";
      list.append(empty);
    }
  };

  const onSearch = (): void => {
    query = search.value;
    renderRows();
  };
  search.addEventListener("input", onSearch);
  container.replaceChildren(search, list);
  renderRows();

  return () => {
    disposed = true;
    search.removeEventListener("input", onSearch);
  };
}

export class HistoryManagerModal extends Modal {
  private cleanup: (() => void) | undefined;

  constructor(
    app: App,
    private readonly entries: HistoryEntry[],
    private readonly actions: HistoryManagerActions
  ) {
    super(app);
  }

  onOpen(): void {
    this.cleanup = renderHistoryManager(
      this.contentEl,
      this.entries,
      this.actions
    );
  }

  onClose(): void {
    this.cleanup?.();
    this.cleanup = undefined;
    this.contentEl.replaceChildren();
  }
}

class HistoryDeleteConfirmModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly entry: HistoryEntry,
    private readonly settle: (confirmed: boolean) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const title = document.createElement("h3");
    title.textContent = "永久删除历史对话？";
    const description = document.createElement("p");
    description.textContent = `“${this.entry.title}”删除后无法恢复。`;
    const actions = document.createElement("div");
    actions.className = "treetalk-history-confirm-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "取消";
    cancel.addEventListener("click", () => this.finish(false));
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "mod-warning";
    confirm.textContent = "永久删除";
    confirm.addEventListener("click", () => this.finish(true));
    actions.append(cancel, confirm);
    this.contentEl.replaceChildren(title, description, actions);
  }

  onClose(): void {
    if (!this.settled) this.finish(false, false);
    this.contentEl.replaceChildren();
  }

  private finish(confirmed: boolean, close = true): void {
    if (this.settled) return;
    this.settled = true;
    this.settle(confirmed);
    if (close) this.close();
  }
}

export function confirmHistoryDeletion(
  app: App,
  entry: HistoryEntry
): Promise<boolean> {
  return new Promise((resolve) => {
    new HistoryDeleteConfirmModal(app, entry, resolve).open();
  });
}
