import { validConversation } from "../fixtures";
import { ConversationTabsStore } from "../../src/tabs/conversation-tabs-store";
import type {
  ConversationTab,
  TabMode
} from "../../src/tabs/types";

export function conversationTab(
  id: string,
  title = id,
  mode: TabMode = "active"
): ConversationTab {
  const conversation = structuredClone(validConversation());
  conversation.id = id;
  conversation.title = title;
  conversation.status = mode === "active" ? "active" : "archived";
  return {
    id,
    conversationId: id,
    folder: `TreeTalk/${mode === "active" ? "活动对话" : "历史对话"}/${id}`,
    title,
    mode,
    lifecycle: "idle",
    unread: false,
    requestEpoch: 0,
    conversation
  };
}

export function conversationTabsStore(...ids: string[]): ConversationTabsStore {
  const store = new ConversationTabsStore();
  for (const id of ids) store.open(conversationTab(id));
  if (ids[0] !== undefined) store.select(ids[0]);
  return store;
}
