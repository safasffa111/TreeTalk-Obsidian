import type { ConversationNode } from "../domain/types";
import type { SourceHighlightPort } from "../navigation/source-highlight-store";
import type { ConversationStorePort } from "../tabs/active-conversation-store";

function requiredNode(
  store: ConversationStorePort,
  nodeId: string
): ConversationNode {
  const node = store.getSnapshot()?.nodes[nodeId];
  if (node === undefined) throw new Error(`Node not found: ${nodeId}`);
  return node;
}

export function renderTreePanel(
  container: HTMLElement,
  store: ConversationStorePort,
  highlights?: SourceHighlightPort
): () => void {
  const render = (): void => {
    const conversation = store.getSnapshot();
    container.replaceChildren();
    container.className = "treetalk-tree";
    if (conversation === undefined) return;
    const list = document.createElement("div");
    list.className = "treetalk-tree-list";

    const appendNode = (nodeId: string, depth: number): void => {
      const node = requiredNode(store, nodeId);
      const row = document.createElement("button");
      row.type = "button";
      row.className = "treetalk-tree-row";
      if (node.id === conversation.currentNodeId) {
        row.classList.add("is-active");
      }
      row.dataset.nodeId = node.id;
      row.dataset.depth = String(depth);
      row.style.setProperty("--treetalk-depth", String(depth));
      row.setAttribute("aria-current", node.id === conversation.currentNodeId ? "true" : "false");

      const dot = document.createElement("span");
      dot.className = "treetalk-node-dot";
      dot.setAttribute("aria-hidden", "true");
      const title = document.createElement("span");
      title.className = "treetalk-node-label";
      title.textContent = node.title;
      row.append(dot, title);
      row.addEventListener("click", () => store.selectNode(node.id));
      list.append(row);

      for (const childId of node.childIds) appendNode(childId, depth + 1);
    };

    appendNode(conversation.rootNodeId, 0);
    container.append(list);
  };

  let removeFlash: (() => void) | undefined;
  const unsubscribeHighlight = highlights?.subscribe((source) => {
    const conversation = store.getSnapshot();
    if (
      conversation === undefined ||
      conversation.id !== source.conversationId ||
      conversation.nodes[source.nodeId] === undefined
    ) {
      return;
    }
    removeFlash?.();
    const row = [...container.querySelectorAll<HTMLElement>(
      "[data-node-id]"
    )].find((candidate) => candidate.dataset.nodeId === source.nodeId);
    if (row === undefined) return;
    row.classList.add("treetalk-source-node-flash");
    if (typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ block: "nearest" });
    }
    const view = container.ownerDocument.defaultView;
    const timer = (view ?? globalThis).setTimeout(
      () => row.classList.remove("treetalk-source-node-flash"),
      1800
    );
    removeFlash = () => {
      (view ?? globalThis).clearTimeout(timer);
      row.classList.remove("treetalk-source-node-flash");
    };
  });

  const unsubscribe = store.subscribe(render);
  render();
  return () => {
    unsubscribe();
    unsubscribeHighlight?.();
    removeFlash?.();
  };
}
