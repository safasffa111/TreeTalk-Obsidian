import { describe, expect, it } from "vitest";
import { ActiveResponseRequests } from "../../src/providers/active-response-requests";
import { ActiveConversationStore } from "../../src/tabs/active-conversation-store";
import { TabResponseRouter } from "../../src/tabs/tab-response-router";
import { conversationTabsStore } from "../helpers/tab-fixtures";

describe("ActiveResponseRequests", () => {
  it("marks a stream interrupted synchronously before aborting it", () => {
    const tabs = conversationTabsStore("one");
    const router = new TabResponseRouter(tabs);
    const ticket = router.capture("one", "child");
    router.start(ticket, {
      conversationId: "one",
      nodeId: "child",
      messageId: "stream",
      modelId: "model",
      now: "2026-07-30T00:00:00.000Z"
    });
    const requests = new ActiveResponseRequests(router);
    const handle = requests.begin("one", ticket, "stream");

    requests.interrupt("one", "2026-07-30T00:00:01.000Z");

    expect(handle.controller.signal.aborted).toBe(true);
    expect(handle.finalized).toBe(true);
    expect(
      tabs.getTab("one")?.conversation.nodes.child?.messages.at(-1)?.status
    ).toBe("interrupted");
  });
  it("forwards normalized final content on successful completion", () => {
    const tabs = conversationTabsStore("one");
    const router = new TabResponseRouter(tabs);
    const ticket = router.capture("one", "child");
    router.start(ticket, {
      conversationId: "one",
      nodeId: "child",
      messageId: "stream",
      modelId: "model",
      now: "2026-07-30T00:00:00.000Z"
    });
    router.delta(ticket, {
      conversationId: "one",
      nodeId: "child",
      messageId: "stream",
      delta: "\\[x^2\\]",
      now: "2026-07-30T00:00:00.500Z"
    });
    const requests = new ActiveResponseRequests(router);
    const handle = requests.begin("one", ticket, "stream");

    requests.finish(
      handle,
      "complete",
      "2026-07-30T00:00:01.000Z",
      "$$\nx^2\n$$"
    );

    expect(
      tabs.getTab("one")?.conversation.nodes.child?.messages.at(-1)
    ).toMatchObject({ content: "$$\nx^2\n$$", status: "complete" });
  });

  it("keeps a response routed to its ticket after graph navigation", () => {
    const tabs = conversationTabsStore("one");
    const router = new TabResponseRouter(tabs);
    const ticket = router.capture("one", "child");
    router.start(ticket, {
      conversationId: "one",
      nodeId: "child",
      messageId: "stream",
      modelId: "model",
      now: "2026-08-03T00:00:00.000Z"
    });
    const active = new ActiveConversationStore(tabs);
    active.selectNode("root");
    router.delta(ticket, {
      conversationId: "one",
      nodeId: "child",
      messageId: "stream",
      delta: "child answer",
      now: "2026-08-03T00:00:01.000Z"
    });

    expect(active.getSnapshot()?.currentNodeId).toBe("root");
    expect(
      tabs.getTab("one")?.conversation.nodes.child?.messages.at(-1)?.content
    ).toBe("child answer");
    expect(
      tabs.getTab("one")?.conversation.nodes.root?.messages
        .some((message) => message.id === "stream")
    ).toBe(false);
  });

  it("preserves an AgentRun failure reason during response finalization", () => {
    const tabs = conversationTabsStore("one");
    const router = new TabResponseRouter(tabs);
    const ticket = router.capture("one", "child");
    const now = "2026-08-04T00:00:00.000Z";
    const agentRun = {
      protocol: "pi-agent-run:v1" as const,
      executionMode: "pi" as const,
      status: "failed" as const,
      roleId: "direct",
      routeId: "default",
      providerId: "openai",
      modelId: "gpt-test",
      stages: [],
      toolExecutions: [],
      sources: [],
      startedAt: now,
      finishedAt: now,
      errorMessage: "provider failed"
    };
    router.start(ticket, {
      conversationId: "one",
      nodeId: "child",
      messageId: "stream",
      modelId: "gpt-test",
      now,
      agentRun
    });
    const requests = new ActiveResponseRequests(router);
    const handle = requests.begin("one", ticket, "stream", agentRun);

    requests.finish(handle, "failed", "2026-08-04T00:00:01.000Z");

    expect(
      tabs.getTab("one")?.conversation.nodes.child?.messages.at(-1)?.agentRun
        ?.errorMessage
    ).toBe("provider failed");
  });

  it("coalesces repeated AgentRun updates into one router publish", () => {
    const tabs = conversationTabsStore("one");
    const router = new TabResponseRouter(tabs);
    const ticket = router.capture("one", "child");
    router.start(ticket, {
      conversationId: "one",
      nodeId: "child",
      messageId: "stream",
      modelId: "gpt-test",
      now: "2026-08-04T00:00:00.000Z"
    });
    let scheduled: (() => void) | undefined;
    const requests = new ActiveResponseRequests(router, (run) => {
      scheduled = run;
    });
    const handle = requests.begin("one", ticket, "stream");
    const base = {
      protocol: "pi-agent-run:v1" as const,
      executionMode: "pi" as const,
      status: "running" as const,
      roleId: "direct",
      routeId: "default",
      providerId: "openai",
      modelId: "gpt-test",
      stages: [],
      toolExecutions: [],
      sources: [],
      startedAt: "2026-08-04T00:00:00.000Z"
    };
    requests.updateAgentRun(
      handle,
      {
        ...base,
        stages: [
          {
            stageId: "s1",
            roleId: "direct",
            routeId: "default",
            status: "running",
            startedAt: "2026-08-04T00:00:00.100Z"
          }
        ]
      },
      "2026-08-04T00:00:00.100Z"
    );
    requests.updateAgentRun(
      handle,
      {
        ...base,
        stages: [
          {
            stageId: "s1",
            roleId: "direct",
            routeId: "default",
            status: "completed",
            startedAt: "2026-08-04T00:00:00.100Z",
            finishedAt: "2026-08-04T00:00:00.200Z"
          },
          {
            stageId: "s2",
            roleId: "direct",
            routeId: "default",
            status: "running",
            startedAt: "2026-08-04T00:00:00.200Z"
          }
        ]
      },
      "2026-08-04T00:00:00.200Z"
    );

    // Nothing is published until the scheduled flush runs.
    expect(scheduled).toBeDefined();
    expect(
      tabs.getTab("one")?.conversation.nodes.child?.messages.at(-1)?.agentRun
    ).toBeUndefined();

    scheduled?.();
    const published =
      tabs.getTab("one")?.conversation.nodes.child?.messages.at(-1)?.agentRun;
    expect(published?.stages).toHaveLength(2);
    expect(published?.stages[1]).toMatchObject({ stageId: "s2" });

    // A later update schedules a fresh flush instead of being dropped.
    scheduled = undefined;
    requests.updateAgentRun(
      handle,
      {
        ...base,
        stages: [
          {
            stageId: "s1",
            roleId: "direct",
            routeId: "default",
            status: "completed",
            startedAt: "2026-08-04T00:00:00.100Z",
            finishedAt: "2026-08-04T00:00:00.200Z"
          }
        ]
      },
      "2026-08-04T00:00:00.300Z"
    );
    expect(scheduled).toBeDefined();
  });

  it("drops a pending AgentRun publish when the response finalizes first", () => {
    const tabs = conversationTabsStore("one");
    const router = new TabResponseRouter(tabs);
    const ticket = router.capture("one", "child");
    router.start(ticket, {
      conversationId: "one",
      nodeId: "child",
      messageId: "stream",
      modelId: "gpt-test",
      now: "2026-08-04T00:00:00.000Z"
    });
    let scheduled: (() => void) | undefined;
    const requests = new ActiveResponseRequests(router, (run) => {
      scheduled = run;
    });
    const handle = requests.begin("one", ticket, "stream");
    const base = {
      protocol: "pi-agent-run:v1" as const,
      executionMode: "pi" as const,
      status: "running" as const,
      roleId: "direct",
      routeId: "default",
      providerId: "openai",
      modelId: "gpt-test",
      stages: [],
      toolExecutions: [],
      sources: [],
      startedAt: "2026-08-04T00:00:00.000Z"
    };
    requests.updateAgentRun(
      handle,
      {
        ...base,
        stages: [
          {
            stageId: "s1",
            roleId: "direct",
            routeId: "default",
            status: "running",
            startedAt: "2026-08-04T00:00:00.100Z"
          }
        ]
      },
      "2026-08-04T00:00:00.100Z"
    );

    requests.finish(handle, "complete", "2026-08-04T00:00:01.000Z", "final");

    const afterFinish =
      tabs.getTab("one")?.conversation.nodes.child?.messages.at(-1);
    expect(afterFinish?.agentRun?.status).toBe("completed");
    expect(afterFinish?.agentRun?.stages).toHaveLength(1);

    // The stale flush is dropped after finalization.
    scheduled?.();
    const afterFlush =
      tabs.getTab("one")?.conversation.nodes.child?.messages.at(-1);
    expect(afterFlush?.content).toBe("final");
    expect(afterFlush?.agentRun?.status).toBe("completed");
    expect(afterFlush?.agentRun?.stages).toHaveLength(1);
  });

});
