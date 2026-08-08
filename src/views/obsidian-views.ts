import { ItemView, type WorkspaceLeaf } from "obsidian";
import type { SourceHighlightPort } from "../navigation/source-highlight-store";
import type { TransientUsagePort } from "../providers/transient-usage-store";
import type { TransientResponseStatusPort } from "../providers/transient-response-status-store";
import type { TransientThinkingPort } from "../providers/transient-thinking-store";
import type { ConversationStorePort } from "../tabs/active-conversation-store";
import type { ConversationTabsStore } from "../tabs/conversation-tabs-store";
import {
  renderConversationPanel,
  type AnswerThinkingControlPort,
  type ConversationPanelActions,
  type ContextDivergenceControlPort,
  type RelatedNoteControlPort,
  type WebSearchControlPort
} from "./conversation-view";
import {
  renderConversationSwitcher,
  type ConversationSwitcherActions
} from "./conversation-switcher";
import { TREETALK_WORKSPACE_VIEW_TYPE } from "./sidebar-workspace-coordinator";
import { renderTreePanel } from "./tree-view";
import { installResizableSplit } from "./resizable-split";
import {
  ObsidianMessageRendererFactory,
  type MessageRendererFactory
} from "./message-renderer";

export interface TreeTalkWorkspaceLayout {
  initialTreeWidth: number;
  onTreeWidthChange(width: number): void;
}

const DEFAULT_LAYOUT: TreeTalkWorkspaceLayout = {
  initialTreeWidth: 220,
  onTreeWidthChange: () => undefined
};

export class TreeTalkWorkspaceView extends ItemView {
  private cleanups: Array<() => void> = [];

  constructor(
    leaf: WorkspaceLeaf,
    private readonly store: ConversationStorePort,
    private readonly actions: ConversationPanelActions,
    private readonly layout: TreeTalkWorkspaceLayout = DEFAULT_LAYOUT,
    private readonly tabs?: ConversationTabsStore,
    private readonly spaceActions?: ConversationSwitcherActions,
    private readonly messageRendererFactory?: MessageRendererFactory,
    private readonly sourceHighlights?: SourceHighlightPort,
    private readonly isObsidianMarkdownCompatibilityEnabled?: () => boolean,
    private readonly transientUsage?: TransientUsagePort,
    private readonly transientResponseStatus?: TransientResponseStatusPort,
    private readonly transientThinking?: TransientThinkingPort,
    private readonly webSearch?: WebSearchControlPort,
    private readonly relatedNotes?: RelatedNoteControlPort,
    private readonly contextDivergence?: ContextDivergenceControlPort,
    private readonly answerThinking?: AnswerThinkingControlPort
  ) {
    super(leaf);
  }

  getViewType(): string {
    return TREETALK_WORKSPACE_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "TreeTalk";
  }

  getIcon(): string {
    return "messages-square";
  }

  onOpen(): Promise<void> {
    this.contentEl.classList.add("treetalk-view-content");
    this.contentEl.replaceChildren();
    const shell = document.createElement("div");
    shell.className = "treetalk-workspace";
    const tree = document.createElement("section");
    tree.className = "treetalk-workspace-tree";
    const switcherMount = document.createElement("div");
    const treeMount = document.createElement("div");
    tree.append(switcherMount, treeMount);
    const conversation = document.createElement("section");
    conversation.className = "treetalk-workspace-conversation";
    const conversationMount = document.createElement("div");
    conversationMount.className = "treetalk-conversation-mount";
    const conversationPanel = document.createElement("div");
    conversationMount.append(conversationPanel);
    conversation.append(conversationMount);
    const separator = document.createElement("div");
    separator.className = "treetalk-resizer";
    shell.append(tree, separator, conversation);
    this.contentEl.append(shell);
    const cleanups = [
      renderTreePanel(treeMount, this.store, this.sourceHighlights),
      renderConversationPanel(
        conversationPanel,
        this.store,
        this.actions,
        this.messageRendererFactory ??
          new ObsidianMessageRendererFactory(this.app, this),
        this.sourceHighlights,
        {
          isObsidianMarkdownCompatibilityEnabled:
            this.isObsidianMarkdownCompatibilityEnabled,
          transientUsage: this.transientUsage,
          transientResponseStatus: this.transientResponseStatus,
          transientThinking: this.transientThinking,
          webSearch: this.webSearch,
          relatedNotes: this.relatedNotes,
          contextDivergence: this.contextDivergence,
          answerThinking: this.answerThinking
        }
      ),
      installResizableSplit(
        shell,
        separator,
        this.layout.initialTreeWidth,
        (width) => this.layout.onTreeWidthChange(width)
      )
    ];
    if (this.tabs !== undefined && this.spaceActions !== undefined) {
      cleanups.push(
        renderConversationSwitcher(
          switcherMount,
          this.tabs,
          this.spaceActions
        ),
        () => switcherMount.remove()
      );
    } else {
      switcherMount.remove();
    }
    this.cleanups = cleanups;
    return Promise.resolve();
  }

  onClose(): Promise<void> {
    this.transientUsage?.clear();
    this.transientResponseStatus?.clear();
    this.transientThinking?.clear();
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups = [];
    this.contentEl.classList.remove("treetalk-view-content");
    return Promise.resolve();
  }
}
