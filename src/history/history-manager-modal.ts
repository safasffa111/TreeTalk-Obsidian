import {
  Modal,
  setIcon,
  type App
} from "obsidian";
import type { HistoryEntry } from "./history-index";
import { promptForName } from "../views/name-input-modal";

export interface HistoryManagerActions {
  open(entry: HistoryEntry): Promise<void>;
  askRename(entry: HistoryEntry): Promise<string | undefined>;
  rename(entry: HistoryEntry, title: string): Promise<HistoryEntry[]>;
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
      const rename = document.createElement("button");
      rename.type = "button";
      rename.className = "treetalk-history-rename";
      rename.setAttribute("aria-label", `重命名历史对话 ${entry.title}`);
      setIcon(rename, "pencil");
      rename.addEventListener("click", (event) => {
        event.stopPropagation();
        void (async () => {
          rename.disabled = true;
          try {
            const title = await actions.askRename(entry);
            if (title === undefined) return;
            entries = await actions.rename(entry, title);
            renderRows();
          } catch (error) {
            actions.reportError(error);
          } finally {
            rename.disabled = false;
          }
        })();
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
      row.append(open, rename, remove);
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

export function promptHistoryRename(
  app: App,
  entry: HistoryEntry
): Promise<string | undefined> {
  return promptForName(app, {
    title: "重命名历史对话",
    description: `为「${entry.title}」设置新的对话名称。`,
    label: "对话名称",
    value: entry.title,
    placeholder: entry.title,
    confirmLabel: "重命名",
    maxLength: 120,
    validate: (value) => (value.trim().length === 0 ? "名称不能为空" : undefined)
  });
}
