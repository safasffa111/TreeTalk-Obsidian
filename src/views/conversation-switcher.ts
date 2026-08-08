import type { ConversationTabsStore } from "../tabs/conversation-tabs-store";

export interface ConversationSwitcherActions {
  create(): Promise<void> | void;
  close(conversationId: string): Promise<void> | void;
  reorder(conversationId: string, targetIndex: number): void;
}

export function renderConversationSwitcher(
  container: HTMLElement,
  store: ConversationTabsStore,
  actions: ConversationSwitcherActions
): () => void {
  let expanded = false;
  let draggedConversationId: string | undefined;

  const render = (): void => {
    const state = store.getSnapshot();
    const active = store.getActiveTab();
    container.replaceChildren();
    container.className = "treetalk-space-switcher";
    if (active === undefined) return;

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "treetalk-space-trigger";
    trigger.setAttribute("aria-expanded", String(expanded));
    trigger.title = "对话列表";
    const direction = document.createElement("span");
    direction.className = "treetalk-space-direction";
    direction.setAttribute("aria-hidden", "true");
    direction.textContent = "›";
    const triggerLabel = document.createElement("span");
    triggerLabel.className = "treetalk-space-label";
    triggerLabel.textContent = "对话列表";
    trigger.append(direction, triggerLabel);
    trigger.addEventListener("click", () => {
      expanded = !expanded;
      render();
    });
    container.append(trigger);

    if (!expanded) return;
    const list = document.createElement("div");
    list.className = "treetalk-space-list";
    for (const [index, tabId] of state.orderedTabIds.entries()) {
      const tab = state.tabs[tabId];
      if (tab === undefined) continue;
      const row = document.createElement("div");
      row.className = "treetalk-space-row";
      row.dataset.conversationId = tab.id;
      row.draggable = tab.lifecycle === "idle";
      if (state.activeTabId === tab.id) row.classList.add("is-active");
      if (tab.unread) row.classList.add("has-unread");
      if (tab.lifecycle !== "idle") {
        row.classList.add(`is-${tab.lifecycle}`);
      }

      const select = document.createElement("button");
      select.type = "button";
      select.className = "treetalk-space-select";
      select.title = tab.title;
      select.setAttribute(
        "aria-current",
        state.activeTabId === tab.id ? "page" : "false"
      );
      const dot = document.createElement("span");
      dot.className = "treetalk-space-dot";
      dot.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.className = "treetalk-space-label";
      label.textContent = tab.title;
      select.append(dot, label);
      select.addEventListener("click", () => {
        store.select(tab.id);
      });

      const close = document.createElement("button");
      close.type = "button";
      close.className = "treetalk-space-close";
      close.setAttribute("aria-label", `关闭 ${tab.title}`);
      close.textContent = "×";
      close.disabled = tab.lifecycle !== "idle";
      close.addEventListener("click", (event) => {
        event.stopPropagation();
        void actions.close(tab.id);
      });

      row.addEventListener("dragstart", () => {
        draggedConversationId = tab.id;
      });
      row.addEventListener("dragover", (event) => event.preventDefault());
      row.addEventListener("drop", (event) => {
        event.preventDefault();
        if (
          draggedConversationId !== undefined &&
          draggedConversationId !== tab.id
        ) {
          actions.reorder(draggedConversationId, index);
        }
        draggedConversationId = undefined;
      });
      row.addEventListener("dragend", () => {
        draggedConversationId = undefined;
      });
      row.append(select, close);
      list.append(row);
    }
    const create = document.createElement("button");
    create.type = "button";
    create.className = "treetalk-space-create";
    create.textContent = "新建对话";
    create.addEventListener("click", () => {
      void actions.create();
    });
    list.append(create);
    container.append(list);
  };

  const unsubscribe = store.subscribe(render);
  render();
  return unsubscribe;
}
