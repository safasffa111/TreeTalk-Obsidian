import { describe, expect, it } from "vitest";
import { ProviderRegistry } from "../../src/providers/provider-registry";
import { NodeSummaryCoordinator } from "../../src/providers/node-summary-coordinator";
import { ConversationTabsStore } from "../../src/tabs/conversation-tabs-store";
import { validConversation } from "../fixtures";

const NOW = "2026-08-01T08:00:00.000Z";

function setup() {
  const conversation = validConversation();
  conversation.currentNodeId = "root";
  const root = conversation.nodes.root;
  if (root === undefined) throw new Error("Missing root");
  root.titleSource = "question";
  root.messages = [
    {
      id: "q",
      role: "user",
      content: "这是什么意思",
      status: "complete",
      createdAt: NOW,
      updatedAt: NOW
    },
    {
      id: "a",
      role: "assistant",
      content: "传输层通过端口号区分不同应用进程。",
      status: "complete",
      createdAt: NOW,
      updatedAt: NOW
    }
  ];
  const tabs = new ConversationTabsStore();
  tabs.open({
    id: conversation.id,
    conversationId: conversation.id,
    folder: "active/conversation-1",
    title: conversation.title,
    mode: "active",
    lifecycle: "idle",
    unread: false,
    requestEpoch: 0,
    conversation
  });
  return { conversation, tabs };
}

describe("NodeSummaryCoordinator", () => {
  it("persists pending before one background request and updates the root tab title", async () => {
    const { conversation, tabs } = setup();
    const requests: Array<{ body: Record<string, unknown> }> = [];
    const order: string[] = [];
    const coordinator = new NodeSummaryCoordinator(
      tabs,
      new ProviderRegistry(),
      {
        request: async (request) => {
          order.push("request");
          requests.push(request);
          return { choices: [{ message: { content: "端口号与进程寻址" } }] };
        }
      },
      {
        getProfile: () => ({
          id: "default",
          name: "OpenAI",
          kind: "openai",
          apiKey: "secret",
          baseUrl: ""
        }),
        getModel: () => "gpt-test",
        now: () => NOW,
        persistPending: async () => {
          order.push("persist");
        }
      }
    );

    await Promise.all([
      coordinator.trigger({
        tabId: conversation.id,
        conversationId: conversation.id,
        nodeId: "root",
        answerMessageId: "a"
      }),
      coordinator.trigger({
        tabId: conversation.id,
        conversationId: conversation.id,
        nodeId: "root",
        answerMessageId: "a"
      })
    ]);

    expect(order).toEqual(["persist", "request"]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toMatchObject({
      stream: false,
      max_tokens: 64
    });
    expect(requests[0]?.body).not.toHaveProperty("prompt_cache_key");
    expect(tabs.getTab(conversation.id)?.title).toBe("端口号与进程寻址");

    await coordinator.trigger({
      tabId: conversation.id,
      conversationId: conversation.id,
      nodeId: "root",
      answerMessageId: "a"
    });
    expect(requests).toHaveLength(1);
    coordinator.dispose();
  });

  it("records a failed request once and does not retry automatically", async () => {
    const { conversation, tabs } = setup();
    let requests = 0;
    const coordinator = new NodeSummaryCoordinator(
      tabs,
      new ProviderRegistry(),
      {
        request: async () => {
          requests += 1;
          throw new Error("offline");
        }
      },
      {
        getProfile: () => ({
          id: "default",
          name: "OpenAI",
          kind: "openai",
          apiKey: "secret",
          baseUrl: ""
        }),
        getModel: () => "gpt-test",
        now: () => NOW
      }
    );
    const input = {
      tabId: conversation.id,
      conversationId: conversation.id,
      nodeId: "root",
      answerMessageId: "a"
    };

    await coordinator.trigger(input);
    expect(requests).toBe(1);
    expect(
      tabs.getTab(conversation.id)?.conversation.nodes.root?.summary?.status
    ).toBe("failed");
    await coordinator.trigger(input);
    expect(requests).toBe(1);
    coordinator.dispose();
  });

  it("marks failure once and never overwrites a manual name", async () => {
    const { conversation, tabs } = setup();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const coordinator = new NodeSummaryCoordinator(
      tabs,
      new ProviderRegistry(),
      {
        request: async () => {
          await gate;
          return { choices: [{ message: { content: "自动名称" } }] };
        }
      },
      {
        getProfile: () => ({
          id: "default",
          name: "OpenAI",
          kind: "openai",
          apiKey: "secret",
          baseUrl: ""
        }),
        getModel: () => "gpt-test",
        now: () => NOW
      }
    );

    const pending = coordinator.trigger({
      tabId: conversation.id,
      conversationId: conversation.id,
      nodeId: "root",
      answerMessageId: "a"
    });
    tabs.updateConversation(conversation.id, (current) => {
      const next = structuredClone(current);
      const root = next.nodes.root;
      if (root === undefined) throw new Error("Missing root");
      root.title = "人工名称";
      root.titleSource = "manual";
      return next;
    });
    release?.();
    await pending;

    expect(tabs.getTab(conversation.id)?.conversation.nodes.root?.title).toBe(
      "人工名称"
    );
    expect(
      tabs.getTab(conversation.id)?.conversation.nodes.root?.summary?.generatedTitle
    ).toBe("自动名称");
    coordinator.dispose();
  });
});
