// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createSelectionAnchor } from "../../src/domain/selection-anchor";
import {
  addSelectionToDraft,
  prepareChildDraft,
  submitChildDraft,
  toggleBranchDraft
} from "../../src/domain/tree-commands";
import { SourceHighlightStore } from "../../src/navigation/source-highlight-store";
import { TransientUsageStore } from "../../src/providers/transient-usage-store";
import { TransientResponseStatusStore } from "../../src/providers/transient-response-status-store";
import { ConversationSessionStore } from "../../src/state/conversation-session-store";
import type { ConversationStorePort } from "../../src/tabs/active-conversation-store";
import {
  attachSelectionContext,
  renderConversationPanel,
  selectionTracesForMessage
} from "../../src/views/conversation-view";
import type { MessageRendererFactory } from "../../src/views/message-renderer";
import {
  parseExcerptPayload,
  TREETALK_EXCERPT_MIME
} from "../../src/knowledge/excerpt-drag";
import type { NoteSelectionContext } from "../../src/domain/types";
import { validConversation } from "../fixtures";

function appendMessage(
  conversation: ReturnType<typeof validConversation>,
  id: string,
  role: "user" | "assistant",
  content: string
): void {
  conversation.nodes.child?.messages.push({
    id,
    role,
    content,
    status: "complete",
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt
  });
}

describe("conversation panel", () => {
  it("does not render a composer when no conversation tab is open", () => {
    const store: ConversationStorePort = {
      getSnapshot: () => undefined,
      subscribe: () => () => undefined,
      update: () => {
        throw new Error("not available");
      },
      selectNode: () => {
        throw new Error("not available");
      }
    };
    const container = document.createElement("div");
    const createConversation = vi.fn(() => Promise.resolve());
    const openHistory = vi.fn(() => Promise.resolve());

    renderConversationPanel(container, store, {
      send: vi.fn(() => Promise.resolve()),
      createConversation,
      openHistory
    });

    expect(container.querySelector("textarea")).toBeNull();
    const buttons = container.querySelectorAll("button");
    buttons[0]?.click();
    buttons[1]?.click();
    expect(createConversation).toHaveBeenCalledOnce();
    expect(openHistory).toHaveBeenCalledOnce();
    expect(container.querySelector(".treetalk-empty-actions")).not.toBeNull();
    expect(container.querySelectorAll(".treetalk-empty-action")).toHaveLength(2);
  });

  it("renders user questions and assistant answers through the injected native renderer", async () => {
    const conversation = validConversation();
    appendMessage(conversation, "question", "user", "**bold question**");
    appendMessage(conversation, "answer", "assistant", "$$x^2$$");
    const render = vi.fn((markdown: string, element: HTMLElement) => {
      element.textContent = `native:${markdown}`;
      return Promise.resolve();
    });
    const rendererFactory: MessageRendererFactory = {
      create: () => ({ render, dispose: vi.fn() })
    };
    const container = document.createElement("div");

    renderConversationPanel(
      container,
      new ConversationSessionStore(conversation),
      undefined,
      rendererFactory
    );

    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(2));
    expect(container.textContent).toContain("native:**bold question**");
    expect(container.textContent).toContain("native:$$x^2$$");
  });

  it("falls back to plain text when one native render fails", async () => {
    const conversation = validConversation();
    appendMessage(conversation, "answer", "assistant", "raw fallback");
    const rendererFactory: MessageRendererFactory = {
      create: () => ({
        render: () => Promise.reject(new Error("render failed")),
        dispose: vi.fn()
      })
    };
    const container = document.createElement("div");

    renderConversationPanel(
      container,
      new ConversationSessionStore(conversation),
      undefined,
      rendererFactory
    );

    await vi.waitFor(() =>
      expect(container.textContent).toContain("raw fallback")
    );
  });

  it("right-clicks blank or unfocused input areas without taking native menus from interactive content or selections", () => {
    const conversation = validConversation();
    appendMessage(conversation, "answer", "assistant", "Keep the native menu here");
    const container = document.createElement("div");
    document.body.append(container);
    const store = new ConversationSessionStore(conversation);
    const toggleBranch = vi.fn(() => {
      store.update((current) =>
        toggleBranchDraft(
          current,
          current.currentNodeId,
          new Date().toISOString()
        )
      );
    });
    const cleanup = renderConversationPanel(container, store, {
      send: vi.fn(() => Promise.resolve()),
      toggleBranch
    });
    const input = container.querySelector<HTMLTextAreaElement>("textarea");
    if (input === null) throw new Error("Composer is missing");
    input.focus();
    input.blur();
    expect(document.activeElement).not.toBe(input);
    input.value = "keep this";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));

    const tabEvent = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true
    });
    input.dispatchEvent(tabEvent);
    expect(tabEvent.defaultPrevented).toBe(false);
    expect(store.getSnapshot().nodes.child?.draft.mode).toBe("continue");

    const messages = container.querySelector<HTMLElement>(".treetalk-messages");
    if (messages === null) throw new Error("Message area is missing");
    const blankEvent = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true
    });
    messages.dispatchEvent(blankEvent);
    expect(blankEvent.defaultPrevented).toBe(true);
    expect(toggleBranch).toHaveBeenCalledOnce();
    expect(store.getSnapshot().nodes.child?.draft).toMatchObject({
      mode: "child",
      text: "keep this"
    });

    const inputEvent = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true
    });
    input.dispatchEvent(inputEvent);
    expect(inputEvent.defaultPrevented).toBe(true);
    expect(toggleBranch).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().nodes.child?.draft.mode).toBe("continue");

    const altF = new KeyboardEvent("keydown", {
      key: "F",
      altKey: true,
      bubbles: true,
      cancelable: true
    });
    input.dispatchEvent(altF);
    expect(altF.defaultPrevented).toBe(false);
    expect(store.getSnapshot().nodes.child?.draft.mode).toBe("continue");

    const send = container.querySelector<HTMLButtonElement>(".treetalk-send");
    if (send === null) throw new Error("Send button is missing");
    const buttonEvent = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true
    });
    send.dispatchEvent(buttonEvent);
    expect(buttonEvent.defaultPrevented).toBe(false);
    expect(toggleBranch).toHaveBeenCalledTimes(2);
    expect(Object.keys(store.getSnapshot().nodes)).toHaveLength(2);

    const messageText = container.querySelector<HTMLElement>(
      ".treetalk-message-content"
    );
    if (messageText === null) throw new Error("Message text is missing");
    const messageEvent = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true
    });
    messageText.dispatchEvent(messageEvent);
    expect(messageEvent.defaultPrevented).toBe(true);
    expect(toggleBranch).toHaveBeenCalledTimes(3);

    const link = Object.assign(document.createElement("a"), {
      href: "https://example.com"
    });
    messageText.append(link);
    const linkEvent = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true
    });
    link.dispatchEvent(linkEvent);
    expect(linkEvent.defaultPrevented).toBe(false);
    expect(toggleBranch).toHaveBeenCalledTimes(3);

    input.value = "selected draft";
    input.setSelectionRange(0, 8);
    const textareaSelectionEvent = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true
    });
    input.dispatchEvent(textareaSelectionEvent);
    expect(textareaSelectionEvent.defaultPrevented).toBe(false);
    expect(toggleBranch).toHaveBeenCalledTimes(3);

    const selectedText = document.createElement("span");
    selectedText.textContent = "selected blank-area text";
    messageText.append(selectedText);
    const selectedRange = document.createRange();
    selectedRange.selectNodeContents(selectedText);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(selectedRange);
    const domSelectionEvent = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true
    });
    selectedText.dispatchEvent(domSelectionEvent);
    expect(domSelectionEvent.defaultPrevented).toBe(false);
    expect(toggleBranch).toHaveBeenCalledTimes(3);
    window.getSelection()?.removeAllRanges();

    const outsideText = document.createElement("span");
    outsideText.textContent = "selection in another Obsidian pane";
    document.body.append(outsideText);
    const outsideRange = document.createRange();
    outsideRange.selectNodeContents(outsideText);
    window.getSelection()?.addRange(outsideRange);
    const outsideSelectionEvent = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true
    });
    messages.dispatchEvent(outsideSelectionEvent);
    expect(outsideSelectionEvent.defaultPrevented).toBe(true);
    expect(toggleBranch).toHaveBeenCalledTimes(4);
    window.getSelection()?.removeAllRanges();
    outsideText.remove();

    cleanup();
    container.remove();
  });


  it("removes mutation controls while the active tab is closing", () => {
    const conversation = validConversation();
    const store: ConversationStorePort = {
      canMutate: () => false,
      getSnapshot: () => conversation,
      subscribe: () => () => undefined,
      update: () => {
        throw new Error("read-only");
      },
      selectNode: () => {
        throw new Error("read-only");
      }
    };
    const container = document.createElement("div");

    renderConversationPanel(container, store);

    expect(container.querySelector("textarea")).toBeNull();
  });

  it("attaches a precise selection and prepares a child branch without creating it", async () => {
    const conversation = validConversation();
    appendMessage(
      conversation,
      "answer",
      "assistant",
      "TCP uses acknowledgements"
    );
    const store = new ConversationSessionStore(conversation);

    await attachSelectionContext(
      store,
      "answer",
      "TCP uses acknowledgements",
      9,
      25
    );

    expect(
      store.getSnapshot().nodes.child?.draft.selectionContexts[0]?.quote
    ).toBe("acknowledgements");
    expect(store.getSnapshot().nodes.child?.draft.mode).toBe("child");
    expect(Object.keys(store.getSnapshot().nodes)).toHaveLength(2);
  });



  it("deduplicates the same selection in the current draft", async () => {
    const conversation = validConversation();
    appendMessage(conversation, "answer", "assistant", "repeat selection");
    const store = new ConversationSessionStore(conversation);

    await attachSelectionContext(store, "answer", "repeat selection", 0, 6);
    await attachSelectionContext(store, "answer", "repeat selection", 0, 6);

    expect(
      store.getSnapshot().nodes.child?.draft.selectionContexts
    ).toHaveLength(1);
  });

  it("discards a selection if another conversation becomes active while its anchor is hashing", async () => {
    const first = validConversation();
    appendMessage(first, "answer", "assistant", "context from first");
    const second = validConversation();
    second.id = "second-conversation";
    let current = first;
    const store: ConversationStorePort = {
      getSnapshot: () => current,
      subscribe: () => () => undefined,
      update: (updater) => {
        current = updater(current);
      },
      selectNode: () => undefined
    };

    const attaching = attachSelectionContext(
      store,
      "answer",
      "context from first",
      0,
      7
    );
    current = second;
    await attaching;

    expect(current.id).toBe("second-conversation");
    expect(
      current.nodes[current.currentNodeId]?.draft.selectionContexts
    ).toEqual([]);
  });

  it("makes every context chip draggable as an excerpt payload", async () => {
    const conversation = validConversation();
    appendMessage(conversation, "answer", "assistant", "drag this excerpt");
    const store = new ConversationSessionStore(conversation);
    await attachSelectionContext(
      store,
      "answer",
      "drag this excerpt",
      0,
      9
    );
    const container = document.createElement("div");
    renderConversationPanel(container, store);
    const chip = container.querySelector<HTMLElement>(
      ".treetalk-selection-chip"
    );
    if (chip === null) throw new Error("Selection chip is missing");
    const setData = vi.fn();
    const event = new Event("dragstart", { bubbles: true });
    Object.defineProperty(event, "dataTransfer", {
      value: { setData }
    });

    chip.dispatchEvent(event);

    expect(chip.draggable).toBe(true);
    const serialized = setData.mock.calls.find(
      ([type]) => type === TREETALK_EXCERPT_MIME
    )?.[1] as string | undefined;
    const payload = serialized === undefined
      ? undefined
      : parseExcerptPayload(serialized);
    expect(payload?.version).toBe(2);
    if (payload?.version !== 2) {
      throw new Error("Exact excerpt payload is missing");
    }
    expect(payload.quote).toBe("drag this");
    expect(payload.anchor.startOffset).toBe(0);
    expect(payload.anchor.endOffset).toBe(9);
    expect(setData).toHaveBeenCalledWith("text/plain", "drag this");
  });

  it("renders note contexts with their file source and without message drag metadata", () => {
    const conversation = validConversation();
    const noteContext: NoteSelectionContext = {
      sourceType: "note",
      filePath: "课程/网络分层.md",
      fileName: "网络分层.md",
      basis: "note-source-v1",
      startOffset: 4,
      endOffset: 7,
      quote: "网络层",
      prefix: "第一段",
      suffix: "负责寻址",
      contentHash: "note-hash"
    };
    conversation.nodes.child?.draft.selectionContexts.push(noteContext);
    const store = new ConversationSessionStore(conversation);
    const container = document.createElement("div");

    renderConversationPanel(container, store);

    const chip = container.querySelector<HTMLElement>(
      ".treetalk-selection-chip"
    );
    expect(chip?.draggable).toBe(false);
    expect(
      chip?.querySelector(".treetalk-selection-chip-source")?.textContent
    ).toBe("网络分层.md");
    expect(chip?.textContent).toContain("网络层");
    chip
      ?.querySelector<HTMLButtonElement>(".treetalk-selection-chip-remove")
      ?.click();
    expect(store.getSnapshot().nodes.child?.draft.selectionContexts).toEqual([]);
  });

  it("ignores note contexts when resolving message selection traces", () => {
    const conversation = validConversation();
    conversation.nodes.child?.messages.push({
      id: "question-with-note",
      role: "user",
      content: "Explain this note",
      status: "complete",
      selectionContexts: [{
        sourceType: "note",
        filePath: "课程/网络分层.md",
        fileName: "网络分层.md",
        basis: "note-source-v1",
        startOffset: 0,
        endOffset: 3,
        quote: "网络层",
        prefix: "",
        suffix: "",
        contentHash: "note-hash"
      }],
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt
    });

    expect(selectionTracesForMessage(conversation, "answer")).toEqual([]);
  });


  it("renders traces from every sent user message and navigates to the target node", async () => {
    const conversation = validConversation();
    appendMessage(
      conversation,
      "answer",
      "assistant",
      "TCP uses acknowledgements"
    );
    const anchor = await createSelectionAnchor({
      messageId: "answer",
      sourceNodeId: "child",
      sourceRole: "assistant",
      visibleText: "TCP uses acknowledgements",
      startOffset: 9,
      endOffset: 25
    });
    const selected = addSelectionToDraft(
      conversation,
      "child",
      anchor,
      conversation.updatedAt
    );
    const prepared = prepareChildDraft(selected, {
      nodeId: "child",
      now: conversation.updatedAt
    });
    const created = submitChildDraft(prepared, {
      text: "How do acknowledgements work?",
      childId: "grandchild",
      messageId: "question",
      now: conversation.updatedAt
    }).state;
    const parentVisible = structuredClone(created);
    parentVisible.currentNodeId = "child";
    const store = new ConversationSessionStore(parentVisible);

    expect(selectionTracesForMessage(parentVisible, "answer")).toMatchObject([
      { targetNodeId: "grandchild", anchor: { quote: "acknowledgements" } }
    ]);
    const container = document.createElement("div");
    renderConversationPanel(container, store);
    await vi.waitFor(() =>
      expect(
        container.querySelector(".treetalk-selection-trace")?.textContent
      ).toBe("acknowledgements")
    );
    container
      .querySelector<HTMLElement>(".treetalk-selection-trace")
      ?.click();
    expect(store.getSnapshot().currentNodeId).toBe("grandchild");
  });

  it("offers distinct target choices for repeated trace ranges without nesting traces", async () => {
    const conversation = validConversation();
    appendMessage(conversation, "answer", "assistant", "same selected words");
    const anchor = await createSelectionAnchor({
      messageId: "answer",
      sourceNodeId: "child",
      sourceRole: "assistant",
      visibleText: "same selected words",
      startOffset: 5,
      endOffset: 13
    });
    const firstPrepared = prepareChildDraft(
      addSelectionToDraft(
        conversation,
        "child",
        anchor,
        conversation.updatedAt
      ),
      { nodeId: "child", now: conversation.updatedAt }
    );
    const firstBranch = submitChildDraft(firstPrepared, {
      text: "First branch?",
      childId: "branch-one",
      messageId: "question-one",
      now: conversation.updatedAt
    }).state;
    const secondPrepared = prepareChildDraft(
      addSelectionToDraft(
        firstBranch,
        "child",
        anchor,
        conversation.updatedAt
      ),
      { nodeId: "child", now: conversation.updatedAt }
    );
    const withTwoBranches = structuredClone(submitChildDraft(secondPrepared, {
      text: "Second branch?",
      childId: "branch-two",
      messageId: "question-two",
      now: conversation.updatedAt
    }).state);
    withTwoBranches.currentNodeId = "child";
    const selectNode = vi.fn();
    const store: ConversationStorePort = {
      getSnapshot: () => withTwoBranches,
      subscribe: () => () => undefined,
      update: () => undefined,
      selectNode
    };
    const container = document.createElement("div");

    renderConversationPanel(container, store);
    await vi.waitFor(() =>
      expect(container.querySelector(".treetalk-selection-trace")).not.toBeNull()
    );
    expect(
      container.querySelector(
        ".treetalk-selection-trace .treetalk-selection-trace"
      )
    ).toBeNull();

    container
      .querySelector<HTMLElement>(".treetalk-selection-trace")
      ?.click();
    const choices = container.querySelectorAll<HTMLButtonElement>(
      ".treetalk-trace-targets button"
    );
    expect(choices).toHaveLength(2);
    choices[0]?.click();
    choices[1]?.click();
    expect(selectNode.mock.calls).toEqual([
      ["branch-one"],
      ["branch-two"]
    ]);
  });

  it("offers tree capture and places answer capture after each completed answer", async () => {
    const conversation = validConversation();
    appendMessage(conversation, "answer", "assistant", "A fixed answer");
    const captureTree = vi.fn(() => Promise.resolve());
    const captureAnswer = vi.fn(() => Promise.resolve());
    const container = document.createElement("div");

    renderConversationPanel(
      container,
      new ConversationSessionStore(conversation),
      { send: vi.fn(() => Promise.resolve()), captureTree, captureAnswer }
    );
    await vi.waitFor(() =>
      expect(
        container.querySelector("[data-message-id='answer'] .treetalk-message-content.is-rendered")
      ).not.toBeNull()
    );
    container.querySelector<HTMLButtonElement>(".treetalk-capture-tree")?.click();
    const answer = container.querySelector<HTMLElement>(
      "[data-message-id='answer']"
    );
    const capture = answer?.querySelector<HTMLButtonElement>(
      ".treetalk-capture-answer"
    );
    capture?.click();

    expect(captureTree).toHaveBeenCalledOnce();
    expect(captureAnswer).toHaveBeenCalledWith("answer");
    expect(answer?.querySelector(".treetalk-capture-answer")).toBe(capture);
    expect(container.querySelector(".treetalk-selection-capture")).toBeNull();
  });

  it("does not render answer capture while an answer is streaming", () => {
    const conversation = validConversation();
    conversation.nodes.child?.messages.push({
      id: "stream-answer",
      role: "assistant",
      content: "partial",
      status: "streaming",
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt
    });
    const container = document.createElement("div");

    renderConversationPanel(container, new ConversationSessionStore(conversation), {
      send: vi.fn(() => Promise.resolve()),
      captureAnswer: vi.fn(() => Promise.resolve())
    });

    expect(
      container.querySelector(
        "[data-message-id='stream-answer'] .treetalk-capture-answer"
      )
    ).toBeNull();
  });

  it("shows partial streaming text and a stop action", () => {
    const conversation = validConversation();
    conversation.nodes.child?.messages.push({
      id: "stream",
      role: "assistant",
      content: "streaming",
      status: "streaming",
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt
    });
    const stop = vi.fn(() => Promise.resolve());
    const container = document.createElement("div");
    renderConversationPanel(
      container,
      new ConversationSessionStore(conversation),
      { send: vi.fn(() => Promise.resolve()), stop }
    );

    const button = container.querySelector<HTMLButtonElement>(".treetalk-stop");
    button?.click();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("sizes user bubbles to their text with an 80 percent maximum", () => {
    const css = readFileSync("styles.css", "utf8");
    const rule = css.match(/\.treetalk-message\.is-user\s*\{([^}]*)\}/su)?.[1];
    expect(rule).toContain("width: fit-content");
    expect(rule).toContain("max-width: 80%");
  });

  it("keeps rendered chat text selectable and answer capture in normal flow", () => {
    const css = readFileSync("styles.css", "utf8");
    const contentRule = css.match(
      /\.treetalk-message-content\s*\{([^}]*)\}/su
    )?.[1];
    const captureRule = css.match(
      /button\.treetalk-capture-answer\s*\{([^}]*)\}/su
    )?.[1];
    expect(contentRule).toContain("user-select: text");
    expect(contentRule).toContain("pointer-events: auto");
    expect(contentRule).toContain("cursor: text");
    expect(captureRule).not.toContain("position: absolute");
    expect(captureRule).not.toContain("right:");
    expect(captureRule).not.toContain("opacity: 0");
  });

  it("keeps archived conversations read-only while preserving restore", async () => {
    const conversation = validConversation();
    conversation.status = "archived";
    appendMessage(conversation, "answer", "assistant", "fixed history");
    const store = new ConversationSessionStore(conversation);
    const restore = vi.fn(() => Promise.resolve());
    const container = document.createElement("div");
    renderConversationPanel(container, store, {
      send: vi.fn(() => Promise.resolve()),
      restore
    });

    expect(container.querySelector("textarea")).toBeNull();
    container.querySelector<HTMLButtonElement>(".treetalk-restore")?.click();
    expect(restore).toHaveBeenCalledOnce();
    await expect(
      attachSelectionContext(store, "answer", "fixed history", 0, 5)
    ).rejects.toThrow("read-only");
  });

  it("keeps the message scroller and existing article stable across streaming chunks", async () => {
    const conversation = validConversation();
    appendMessage(conversation, "question", "user", "question");
    conversation.nodes.child?.messages.push({
      id: "stream",
      role: "assistant",
      content: "first",
      status: "streaming",
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt
    });
    const store = new ConversationSessionStore(conversation);
    const container = document.createElement("div");
    renderConversationPanel(container, store);
    const scroller = container.querySelector<HTMLElement>(".treetalk-messages");
    const question = container.querySelector<HTMLElement>(
      "[data-message-id='question']"
    );
    const stream = container.querySelector<HTMLElement>(
      "[data-message-id='stream']"
    );
    if (scroller === null || question === null || stream === null) {
      throw new Error("Initial message DOM is missing");
    }

    store.update((current) => {
      const next = structuredClone(current);
      const message = next.nodes.child?.messages.find(
        (entry) => entry.id === "stream"
      );
      if (message !== undefined) {
        message.content = "first second";
        message.updatedAt = new Date().toISOString();
      }
      next.revision += 1;
      return next;
    });

    expect(container.querySelector(".treetalk-messages")).toBe(scroller);
    expect(container.querySelector("[data-message-id='question']")).toBe(question);
    expect(container.querySelector("[data-message-id='stream']")).toBe(stream);
    await vi.waitFor(() =>
      expect(stream.textContent).toContain("first second")
    );
  });

  it("does not restore the removed manual formula source mode during streaming rerenders", async () => {
    const conversation = validConversation();
    conversation.nodes.child?.messages.push({
      id: "stream",
      role: "assistant",
      content: "$$x^2$$",
      status: "streaming",
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt
    });
    const rendererFactory: MessageRendererFactory = {
      create: () => ({
        render: (markdown, element) => {
          element.innerHTML =
            '<div class="math-block">x²</div>' +
            (markdown.includes("tail") ? "<p>tail</p>" : "");
          return Promise.resolve();
        },
        dispose: vi.fn()
      })
    };
    const store = new ConversationSessionStore(conversation);
    const container = document.createElement("div");
    renderConversationPanel(container, store, undefined, rendererFactory);
    await vi.waitFor(() =>
      expect(container.querySelector(".treetalk-formula-block")).not.toBeNull()
    );
    expect(container.querySelector(".treetalk-formula-source-toggle")).toBeNull();

    store.update((current) => {
      const next = structuredClone(current);
      const message = next.nodes.child?.messages.find(
        (entry) => entry.id === "stream"
      );
      if (message !== undefined) message.content = "$$x^2$$\ntail";
      next.revision += 1;
      return next;
    });

    await vi.waitFor(() =>
      expect(container.querySelector(".treetalk-message-content")?.textContent).toContain(
        "tail"
      )
    );
    expect(container.querySelector(".treetalk-formula-source-toggle")).toBeNull();
    expect(
      container.querySelector(".treetalk-formula-rendered")?.getAttribute("aria-hidden")
    ).toBe("false");
  });

  it("does not detach and reinsert existing message articles during a streaming update", async () => {
    const conversation = validConversation();
    appendMessage(conversation, "question", "user", "question");
    conversation.nodes.child?.messages.push({
      id: "stream",
      role: "assistant",
      content: "first",
      status: "streaming",
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt
    });
    const store = new ConversationSessionStore(conversation);
    const container = document.createElement("div");
    renderConversationPanel(container, store);
    const scroller = container.querySelector<HTMLElement>(".treetalk-messages");
    if (scroller === null) throw new Error("Message scroller is missing");
    const directChildMutations: MutationRecord[] = [];
    const observer = new MutationObserver((records) => {
      directChildMutations.push(
        ...records.filter(
          (record) =>
            record.target === scroller &&
            (record.addedNodes.length > 0 || record.removedNodes.length > 0)
        )
      );
    });
    observer.observe(scroller, { childList: true });

    store.update((current) => {
      const next = structuredClone(current);
      const message = next.nodes.child?.messages.find(
        (entry) => entry.id === "stream"
      );
      if (message !== undefined) message.content = "first second";
      next.revision += 1;
      return next;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    observer.disconnect();

    expect(directChildMutations).toHaveLength(0);
  });

  it("does not force the scroll position down after the user scrolls upward", async () => {
    const conversation = validConversation();
    conversation.nodes.child?.messages.push({
      id: "stream",
      role: "assistant",
      content: "first",
      status: "streaming",
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt
    });
    const store = new ConversationSessionStore(conversation);
    const container = document.createElement("div");
    renderConversationPanel(container, store);
    const scroller = container.querySelector<HTMLElement>(".treetalk-messages");
    if (scroller === null) throw new Error("Message scroller is missing");
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, get: () => 1000 }
    });
    scroller.scrollTop = 120;
    scroller.dispatchEvent(new Event("scroll"));

    store.update((current) => {
      const next = structuredClone(current);
      const message = next.nodes.child?.messages[0];
      if (message !== undefined) message.content = "second";
      next.revision += 1;
      return next;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(scroller.scrollTop).toBe(120);
  });

  it("stores source Markdown from rendered selections and still anchors by visible text", async () => {
    const conversation = validConversation();
    appendMessage(conversation, "answer", "assistant", "$x^2$");
    const rendererFactory: MessageRendererFactory = {
      create: () => ({
        render: (_markdown, element) => {
          element.innerHTML =
            '<span class="math-inline" data-treetalk-source-text="$x^2$">x²</span>';
          return Promise.resolve();
        },
        dispose: vi.fn()
      })
    };
    const store = new ConversationSessionStore(conversation);
    const container = document.createElement("div");
    document.body.append(container);
    renderConversationPanel(container, store, undefined, rendererFactory);
    const content = container.querySelector<HTMLElement>(
      "[data-message-id='answer'] .treetalk-message-content"
    );
    await vi.waitFor(() =>
      expect(content?.classList.contains("is-rendered")).toBe(true)
    );
    const text = content?.querySelector(".math-inline")?.firstChild;
    if (content === null || text === null || text === undefined) {
      throw new Error("Rendered formula is missing");
    }
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 2);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    content.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

    await vi.waitFor(() =>
      expect(store.getSnapshot().nodes.child?.draft.selectionContexts).toHaveLength(1)
    );
    expect(store.getSnapshot().nodes.child?.draft.selectionContexts[0]).toMatchObject({
      quote: "$x^2$",
      visibleQuote: "x²"
    });
    container.remove();
  });

  it("does not let a stale asynchronous render overwrite a newer conversation render", async () => {
    const conversation = validConversation();
    appendMessage(conversation, "answer", "assistant", "old");
    const pending: Array<() => void> = [];
    const rendererFactory: MessageRendererFactory = {
      create: () => ({
        render: (markdown, element) =>
          new Promise<void>((resolve) => {
            pending.push(() => {
              element.textContent = markdown;
              resolve();
            });
          }),
        dispose: vi.fn()
      })
    };
    const store = new ConversationSessionStore(conversation);
    const container = document.createElement("div");
    renderConversationPanel(container, store, undefined, rendererFactory);
    await vi.waitFor(() => expect(pending).toHaveLength(1));

    store.update((current) => {
      const next = structuredClone(current);
      const message = next.nodes.child?.messages[0];
      if (message !== undefined) message.content = "new";
      next.revision += 1;
      return next;
    });
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1]?.();
    await Promise.resolve();
    pending[0]?.();
    await Promise.resolve();

    expect(container.textContent).toContain("new");
    expect(container.textContent).not.toContain("old");
  });
  it("falls back to flashing the whole message when the character anchor is unresolved", async () => {
    const conversation = validConversation();
    appendMessage(conversation, "answer", "assistant", "current answer");
    const highlights = new SourceHighlightStore();
    const container = document.createElement("div");
    renderConversationPanel(
      container,
      new ConversationSessionStore(conversation),
      undefined,
      undefined,
      highlights
    );
    await vi.waitFor(() =>
      expect(container.querySelector('[data-message-id="answer"]')).not.toBeNull()
    );
    const article = container.querySelector<HTMLElement>(
      '[data-message-id="answer"]'
    );
    if (article === null) throw new Error("Target message is missing");
    article.scrollIntoView = vi.fn();

    highlights.publish({
      conversationId: "conversation-1",
      nodeId: "child",
      messageId: "answer",
      anchor: {
        messageId: "answer",
        sourceNodeId: "child",
        sourceRole: "assistant",
        basis: "rendered-text-v1",
        startOffset: 100,
        endOffset: 110,
        quote: "deleted quote",
        prefix: "",
        suffix: "",
        contentHash: "old-hash"
      }
    });

    await vi.waitFor(() =>
      expect(article.classList.contains("treetalk-source-message-flash")).toBe(
        true
      )
    );
    expect(container.querySelector(".treetalk-source-range-flash")).toBeNull();
  });

  it("flashes the exact anchored character range after source navigation", async () => {
    const conversation = validConversation();
    appendMessage(conversation, "answer", "assistant", "before **target** after");
    const rendererFactory: MessageRendererFactory = {
      create: () => ({
        render: (_markdown, element) => {
          element.innerHTML = "<p>before <strong>target</strong> after</p>";
          return Promise.resolve();
        },
        dispose: vi.fn()
      })
    };
    const highlights = new SourceHighlightStore();
    const container = document.createElement("div");
    renderConversationPanel(
      container,
      new ConversationSessionStore(conversation),
      undefined,
      rendererFactory,
      highlights
    );
    await vi.waitFor(() =>
      expect(container.querySelector('[data-message-id="answer"] strong')).not.toBeNull()
    );
    const article = container.querySelector<HTMLElement>(
      '[data-message-id="answer"]'
    );
    if (article === null) throw new Error("Target message is missing");
    const scrollIntoView = vi.fn();
    article.scrollIntoView = scrollIntoView;

    highlights.publish({
      conversationId: "conversation-1",
      nodeId: "child",
      messageId: "answer",
      anchor: {
        messageId: "answer",
        sourceNodeId: "child",
        sourceRole: "assistant",
        basis: "rendered-text-v1",
        startOffset: 7,
        endOffset: 13,
        quote: "**target**",
        visibleQuote: "target",
        prefix: "before ",
        suffix: " after",
        contentHash: "hash"
      }
    });

    await vi.waitFor(() =>
      expect(
        container.querySelector(".treetalk-source-range-flash")?.textContent
      ).toBe("target")
    );
    expect(article.classList.contains("treetalk-source-message-flash")).toBe(
      true
    );
    expect(scrollIntoView).toHaveBeenCalledWith({
      block: "center",
      behavior: "smooth"
    });
  });


  it("renders only the stable Markdown and exposes an incomplete formula as source", async () => {
    const conversation = validConversation();
    conversation.nodes.child?.messages.push({
      id: "stream-compatible",
      role: "assistant",
      content: "before\n\n$$\nx^2",
      status: "streaming",
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt
    });
    const render = vi.fn((markdown: string, element: HTMLElement) => {
      element.textContent = `rendered:${markdown}`;
      return Promise.resolve();
    });
    const rendererFactory: MessageRendererFactory = {
      create: () => ({ render, dispose: vi.fn() })
    };
    const container = document.createElement("div");

    renderConversationPanel(
      container,
      new ConversationSessionStore(conversation),
      undefined,
      rendererFactory,
      undefined,
      { isObsidianMarkdownCompatibilityEnabled: () => true }
    );

    await vi.waitFor(() => expect(render).toHaveBeenCalledWith("before\n\n", expect.any(HTMLElement)));
    expect(container.querySelector(".treetalk-streaming-source-tail")?.textContent).toBe("$$\nx^2");
  });

  it("bypasses streaming syntax protection when compatibility mode is disabled", async () => {
    const conversation = validConversation();
    conversation.nodes.child?.messages.push({
      id: "stream-raw",
      role: "assistant",
      content: "before\n\n$$\nx^2",
      status: "streaming",
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt
    });
    const render = vi.fn((markdown: string, element: HTMLElement) => {
      element.textContent = markdown;
      return Promise.resolve();
    });
    const rendererFactory: MessageRendererFactory = {
      create: () => ({ render, dispose: vi.fn() })
    };
    const container = document.createElement("div");

    renderConversationPanel(
      container,
      new ConversationSessionStore(conversation),
      undefined,
      rendererFactory,
      undefined,
      { isObsidianMarkdownCompatibilityEnabled: () => false }
    );

    await vi.waitFor(() => expect(render).toHaveBeenCalledWith("before\n\n$$\nx^2", expect.any(HTMLElement)));
    expect(container.querySelector(".treetalk-streaming-source-tail")).toBeNull();
  });


  it("shows progress inside the matching assistant response and removes it when text starts", async () => {
    const conversation = validConversation();
    conversation.nodes.child?.messages.push({
      id: "streaming-status",
      role: "assistant",
      content: "",
      status: "streaming",
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt
    });
    const store = new ConversationSessionStore(conversation);
    const statuses = new TransientResponseStatusStore();
    statuses.set("streaming-status", "thinking");
    const container = document.createElement("div");

    renderConversationPanel(
      container,
      store,
      undefined,
      undefined,
      undefined,
      { transientResponseStatus: statuses }
    );

    const article = container.querySelector<HTMLElement>(
      '[data-message-id="streaming-status"]'
    );
    expect(article?.querySelector(".treetalk-response-progress")?.textContent)
      .toBe("正在准备对话上下文…");
    expect(container.querySelectorAll(".treetalk-response-progress")).toHaveLength(1);

    statuses.set("streaming-status", "searching-web");
    await vi.waitFor(() =>
      expect(article?.querySelector(".treetalk-response-progress")?.textContent)
        .toBe("正在搜索网页…")
    );

    store.update((current) => {
      const next = structuredClone(current);
      const message = next.nodes.child?.messages.find(
        (entry) => entry.id === "streaming-status"
      );
      if (message !== undefined) message.content = "正文开始";
      return next;
    });
    await vi.waitFor(() =>
      expect(article?.querySelector(".treetalk-response-progress")).toBeNull()
    );
  });


  it("shows whether note context was complete or trimmed", async () => {
    const conversation = validConversation();
    appendMessage(conversation, "answer-note", "assistant", "answer");
    const usage = new TransientUsageStore();
    usage.set("answer-note", {
      mode: "full",
      fullEstimatedTokens: 9000,
      sentEstimatedTokens: 4200,
      reducedTokens: 4800,
      reductionRatio: 4800 / 9000,
      noteContextOriginalEstimatedTokens: 7000,
      noteContextSentEstimatedTokens: 2200,
      noteContextTrimmed: true
    });
    const container = document.createElement("div");

    renderConversationPanel(
      container,
      new ConversationSessionStore(conversation),
      undefined,
      undefined,
      undefined,
      { transientUsage: usage }
    );

    await vi.waitFor(() =>
      expect(container.querySelector(".treetalk-token-stats")).not.toBeNull()
    );
    expect(container.textContent).toContain("笔记上下文已裁剪");
    expect(container.textContent).toContain("笔记原始估算7,000");
    expect(container.textContent).toContain("笔记实际发送2,200");
  });


  it("synchronizes the composer web-search button through one global control", async () => {
    const conversation = validConversation();
    const container = document.createElement("div");
    let enabled = false;
    let available = true;
    const listeners = new Set<() => void>();
    const control = {
      isEnabled: () => enabled,
      isAvailable: () => available,
      setEnabled: (next: boolean) => {
        enabled = next;
        for (const listener of listeners) listener();
      },
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }
    };

    renderConversationPanel(
      container,
      new ConversationSessionStore(conversation),
      undefined,
      undefined,
      undefined,
      { webSearch: control }
    );

    const button = container.querySelector<HTMLButtonElement>(
      ".treetalk-web-search-toggle"
    );
    expect(button?.getAttribute("aria-pressed")).toBe("false");
    button?.click();
    await vi.waitFor(() =>
      expect(button?.getAttribute("aria-pressed")).toBe("true")
    );

    available = false;
    for (const listener of listeners) listener();
    await vi.waitFor(() => expect(button?.disabled).toBe(true));
    expect(button?.title).toBe("当前服务商暂不支持联网模式");
  });


});
