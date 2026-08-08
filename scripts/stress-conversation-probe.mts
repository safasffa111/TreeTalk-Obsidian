import { PiExecutionEngine } from "../src/agent/pi/pi-execution-engine";
import type {
  ExecutionEvent,
  ExecutionRequest,
  PiConversationNodeSnapshot
} from "../src/execution/types";
import type { PiBufferedResponse } from "../src/agent/pi/two-pass-execution-engine";
import type { ProviderRequest } from "../src/providers/types";

const apiKey = process.env.DEEPSEEK_API_KEY?.trim() ?? "";
const fs = await import("node:fs");
if (apiKey.length === 0 && fs.existsSync("D:\\treetalk-key.txt")) {
  const raw = fs.readFileSync("D:\\treetalk-key.txt", "utf8").trim();
  if (raw.length > 0) (globalThis as Record<string, unknown>).__stressKey = raw;
}
const key =
  apiKey.length > 0
    ? apiKey
    : ((globalThis as Record<string, unknown>).__stressKey as string | undefined) ??
      "";
if (key.length === 0) {
  console.error("No API key. Set DEEPSEEK_API_KEY or write D:\\treetalk-key.txt");
  process.exit(2);
}
console.log("Key loaded (masked): " + key.slice(0, 3) + "***" + key.slice(-4));

const profile = {
  id: "deepseek",
  name: "DeepSeek",
  kind: "deepseek",
  apiKey: key,
  baseUrl: ""
} as const;
const modelId = "deepseek-v4-flash";

const NOTE = [
  "# TCP 笔记",
  "## 三次握手",
  "TCP 通过三次握手建立可靠连接：客户端发送 SYN，服务端回应 SYN-ACK，客户端再发送 ACK。三次握手确保双方收发能力正常。",
  "## 可靠传输",
  "TCP 的可靠性来自序号、确认应答（ACK）、超时重传和滑动窗口流量控制。发送方为每个字节编号，接收方确认已收到的连续字节。",
  "## 拥塞控制",
  "TCP 通过慢启动、拥塞避免、快重传和快恢复来避免网络拥塞，根据丢包和往返时间动态调整发送速率。",
  "## 四次挥手",
  "连接释放需要四次挥手：FIN、ACK、FIN、ACK，保证双方数据都发送完毕。"
].join("\n\n");

function noteContextGraph() {
  return {
    protocol: "note-context-graph:v1",
    rootNodeIds: ["n"],
    fullNoteContext: true,
    relatedNotesEnabled: false,
    perNoteBudget: "full",
    maxDepth: 0,
    builtAt: "2026-08-08T00:00:00.000Z",
    nodes: [
      {
        id: "n",
        filePath: "TCP.md",
        fileName: "TCP.md",
        content: NOTE,
        contentHash: "h",
        depth: 0,
        root: true,
        primaryChain: ["n"],
        parentIds: [],
        outgoingNodeIds: []
      }
    ],
    edges: [],
    unresolvedLinks: []
  };
}

function currentNode(): PiConversationNodeSnapshot {
  return {
    id: "cur",
    parentId: "parent",
    title: "当前",
    depth: 2,
    root: false,
    current: true,
    messages: []
  };
}

function exactSelectionRequest(question: string): ExecutionRequest {
  const quote = "三次握手";
  const offset = NOTE.indexOf(quote);
  return {
    conversationId: "c",
    nodeId: "cur",
    assistantMessageId: crypto.randomUUID(),
    contextMessages: [],
    currentQuestion: question,
    answerThinkingMode: "disabled",
    streamingOutputEnabled: false,
    contextDivergenceEnabled: false,
    piContext: {
      currentQuestion: question,
      selectedQuotes: [],
      relatedNotesAllowed: false,
      conversationNodes: [
        { id: "parent", parentId: "root", title: "根", depth: 1, root: false, current: false, messages: [] },
        currentNode()
      ],
      noteContextGraph: noteContextGraph(),
      focus: {
        interactionMode: "child",
        defaultScope: "selection_only",
        anchors: [
          {
            id: "F1",
            kind: "note-selection",
            filePath: "TCP.md",
            fileName: "TCP.md",
            quote,
            prefix: "",
            suffix: "",
            selectionStartOffset: offset,
            selectionEndOffset: offset + quote.length
          }
        ],
        targets: [
          {
            kind: "exact-selection",
            anchorId: "F1",
            text: quote,
            source: { type: "note", filePath: "TCP.md", fileName: "TCP.md" }
          }
        ]
      }
    },
    roleId: "direct",
    route: { routeId: "r", providerProfile: profile, modelId },
    webSearchEnabled: false
  };
}

function continueRequest(
  question: string,
  parent: PiConversationNodeSnapshot,
  divergence: boolean
): ExecutionRequest {
  return {
    conversationId: "c",
    nodeId: "cur",
    assistantMessageId: crypto.randomUUID(),
    contextMessages: [],
    currentQuestion: question,
    answerThinkingMode: "disabled",
    streamingOutputEnabled: false,
    contextDivergenceEnabled: divergence,
    piContext: {
      currentQuestion: question,
      selectedQuotes: [],
      relatedNotesAllowed: false,
      conversationNodes: [
        { id: "root", parentId: null, title: "根", depth: 0, root: true, current: false, messages: [] },
        parent,
        currentNode()
      ],
      noteContextGraph: noteContextGraph(),
      focus: {
        interactionMode: "continue",
        defaultScope: "latest_round",
        anchors: [
          {
            id: "F1",
            kind: "conversation-round",
            sourceNodeId: "parent",
            sourceMessageId: "a1",
            reason: "previous-turn"
          }
        ],
        targets: [
          {
            kind: "conversation-round",
            anchorId: "F1",
            sourceNodeId: "parent",
            sourceMessageId: "a1",
            reason: "previous-turn"
          }
        ]
      }
    },
    roleId: "direct",
    route: { routeId: "r", providerProfile: profile, modelId },
    webSearchEnabled: false
  };
}

function directRequest(question: string): ExecutionRequest {
  return {
    conversationId: "c",
    nodeId: "cur",
    assistantMessageId: crypto.randomUUID(),
    contextMessages: [],
    currentQuestion: question,
    answerThinkingMode: "disabled",
    streamingOutputEnabled: false,
    contextDivergenceEnabled: false,
    piContext: {
      currentQuestion: question,
      selectedQuotes: [],
      relatedNotesAllowed: false,
      conversationNodes: [
        { id: "root", parentId: null, title: "根", depth: 0, root: true, current: true, messages: [] }
      ],
      focus: {
        interactionMode: "continue",
        defaultScope: "latest_round",
        anchors: [],
        targets: []
      }
    },
    roleId: "direct",
    route: { routeId: "r", providerProfile: profile, modelId },
    webSearchEnabled: false
  };
}

interface RecordedRequest {
  label: string;
  body: string;
  status: number;
  usage: Record<string, unknown>;
  ms: number;
}

const requestLog: RecordedRequest[] = [];

async function bufferedRequest(input: ProviderRequest): Promise<PiBufferedResponse> {
  const body = JSON.stringify(input.body);
  const label = `req${String(requestLog.length + 1)}`;
  const started = Date.now();
  let response = await fetch(input.url, {
    method: input.method,
    headers: input.headers,
    body,
    signal: AbortSignal.timeout(120000)
  });
  if (response.status === 429 || response.status >= 500) {
    console.log(`  [${label}] transient ${String(response.status)}, retrying once after 3s`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    response = await fetch(input.url, {
      method: input.method,
      headers: input.headers,
      body,
      signal: AbortSignal.timeout(120000)
    });
  }
  const json = (await response.json()) as Record<string, unknown>;
  requestLog.push({
    label,
    body,
    status: response.status,
    usage: (json.usage ?? {}) as Record<string, unknown>,
    ms: Date.now() - started
  });
  return { status: response.status, json };
}

interface ScenarioResult {
  events: ExecutionEvent[];
  error: unknown;
  ms: number;
  requests: RecordedRequest[];
}

async function runScenario(request: ExecutionRequest): Promise<ScenarioResult> {
  const before = requestLog.length;
  const engine = new PiExecutionEngine({
    strategy: "progressive",
    bufferedRequest
  });
  const events: ExecutionEvent[] = [];
  let error: unknown;
  const started = Date.now();
  try {
    for await (const event of engine.execute(request, new AbortController().signal)) {
      events.push(event);
    }
  } catch (caught) {
    error = caught;
  }
  return {
    events,
    error,
    ms: Date.now() - started,
    requests: requestLog.slice(before)
  };
}

function answerText(events: ExecutionEvent[]): string {
  return events
    .filter((event): event is Extract<ExecutionEvent, { type: "text-delta" }> =>
      event.type === "text-delta"
    )
    .map((event) => event.text)
    .join("");
}

function progressiveBatches(events: ExecutionEvent[]) {
  return events
    .filter((event): event is Extract<ExecutionEvent, { type: "progressive-context-batch" }> =>
      event.type === "progressive-context-batch"
    )
    .map((event) => ({
      level: event.level,
      evidenceId: event.evidenceId,
      sourceKind: event.sourceKind,
      sourceId: event.sourceId,
      title: event.title,
      relationship: event.relationship,
      estimatedTokens: event.estimatedTokens,
      notePaths: event.notePaths,
      nodeIds: event.nodeIds,
      expansionReason: event.expansionReason
    }));
}

function reportRequests(requests: RecordedRequest[]): void {
  for (const record of requests) {
    const usage = record.usage;
    const prompt = Number(usage.prompt_tokens ?? 0);
    const hit = Number(usage.prompt_cache_hit_tokens ?? 0);
    const miss = Number(usage.prompt_cache_miss_tokens ?? 0);
    const ratio = prompt === 0 ? 0 : (hit / prompt) * 100;
    console.log(
      `  [${record.label}] status=${record.status} ${record.ms}ms input=${prompt} hit=${hit} miss=${miss} hit%=${ratio.toFixed(1)} bodyBytes=${record.body.length}`
    );
  }
}

function summarize(name: string, result: ScenarioResult, answer: string): void {
  console.log(`\n=== ${name} ===`);
  console.log(`  engine=${result.error === undefined ? "ok" : "ERROR"} elapsed=${result.ms}ms requests=${result.requests.length}`);
  if (result.error !== undefined) {
    console.log(`  ERROR: ${result.error instanceof Error ? result.error.message : String(result.error)}`);
  }
  reportRequests(result.requests);
  const prefixChecks = result.events.filter(
    (event): event is Extract<ExecutionEvent, { type: "progressive-prefix-check" }> =>
      event.type === "progressive-prefix-check"
  );
  const preserved = prefixChecks.filter((event) => event.preserved).length;
  console.log(`  prefix-checks=${prefixChecks.length} preserved=${preserved}/${prefixChecks.length}`);
  const toolStarts = result.events.filter((event) => event.type === "tool-start").length;
  console.log(`  tool-starts=${toolStarts} answerChars=${answer.length}`);
  if (answer.length > 0) console.log(`  answer-head: ${answer.slice(0, 100).replaceAll("\n", " ")}`);
}

function maskKey(value: string): string {
  return value.replaceAll(key, "sk-***");
}

const continuityKeywords = ["确认", "重传", "握手", "ACK", "可靠"];

console.log("\n########## S1 续问链（无框选，3 轮） ##########");
const s1t1 = await runScenario(
  exactSelectionRequest("请基于笔记内容，解释 TCP 为什么可靠，重点讲三次握手。")
);
const s1t1Answer = answerText(s1t1.events);
summarize("S1-T1 框选提问（基于笔记）", s1t1, s1t1Answer);

const batches = progressiveBatches(s1t1.events);
const parentSnapshot: PiConversationNodeSnapshot = {
  id: "parent",
  parentId: "root",
  title: "父节点",
  depth: 1,
  root: false,
  current: false,
  messages: [
    {
      id: "a1",
      role: "assistant",
      content: s1t1Answer,
      status: "complete",
      selectionQuotes: [],
      provenance: batches.map((batch) => ({
        level: batch.level,
        title: batch.title,
        relationship: batch.relationship,
        notePaths: batch.notePaths,
        nodeIds: batch.nodeIds
      }))
    }
  ]
};
console.log(`  parent provenance batches=${batches.length}`);
for (const batch of batches) {
  console.log(`    - L${String(batch.level)} ${batch.title} (${batch.relationship})`);
}

const s1t2 = await runScenario(
  continueRequest("继续深入解释你刚才提到的可靠传输机制。", parentSnapshot, false)
);
const s1t2Answer = answerText(s1t2.events);
summarize("S1-T2 续问（digest + 溯源结转）", s1t2, s1t2Answer);
const s1t2Initial = s1t2.requests[0]?.body ?? "";
console.log(
  `  continue-initial-message: hasDigest=${s1t2Initial.includes("已提供上一轮回答的开头结论与结尾")} hasProvenance=${s1t2Initial.includes("上一轮回答依据")} hasConstraint=${s1t2Initial.includes("这是对上一轮回答的延续")}`
);
if (s1t2.requests[0] !== undefined) {
  const messages = JSON.parse(s1t2.requests[0].body).messages as Array<{ role: string; content: string }>;
  const firstUser = messages.find((message) => message.role === "user")?.content ?? "";
  console.log(`  continue-user-message (first 500 chars):\n${maskKey(firstUser.slice(0, 500))}`);
}
const t2Hits = continuityKeywords.filter((word) => s1t2Answer.includes(word));
console.log(`  continuity-keywords-hit: ${t2Hits.length === 0 ? "NONE" : t2Hits.join("、")}`);

const parent2Snapshot: PiConversationNodeSnapshot = {
  ...parentSnapshot,
  messages: [
    {
      ...parentSnapshot.messages[0],
      content: s1t2Answer,
      provenance: progressiveBatches(s1t2.events).map((batch) => ({
        level: batch.level,
        title: batch.title,
        relationship: batch.relationship,
        notePaths: batch.notePaths,
        nodeIds: batch.nodeIds
      }))
    }
  ]
};
const s1t3 = await runScenario(
  continueRequest("那拥塞控制和可靠传输是什么关系？继续用刚才的思路讲。", parent2Snapshot, false)
);
const s1t3Answer = answerText(s1t3.events);
summarize("S1-T3 第二轮续问", s1t3, s1t3Answer);
const t3Hits = continuityKeywords.filter((word) => s1t3Answer.includes(word));
console.log(`  continuity-keywords-hit: ${t3Hits.length === 0 ? "NONE" : t3Hits.join("、")}`);

console.log("\n########## S2 框选精确目标（单轮） ##########");
const s2 = await runScenario(
  exactSelectionRequest("TCP 的拥塞控制算法具体有哪些？基于笔记回答。")
);
const s2Answer = answerText(s2.events);
summarize("S2 框选提问（拥塞控制）", s2, s2Answer);

console.log("\n########## S3 发散模式续问 ##########");
const s3 = await runScenario(
  continueRequest("发散一下：三次握手如果丢了一个报文会发生什么？", parentSnapshot, true)
);
const s3Answer = answerText(s3.events);
summarize("S3 发散续问", s3, s3Answer);
const s3Initial = s3.requests[0]?.body ?? "";
console.log(
  `  continue-initial-message: hasDigest=${s3Initial.includes("已提供上一轮回答的开头结论与结尾")} hasProvenance=${s3Initial.includes("上一轮回答依据")} hasConstraint=${s3Initial.includes("这是对上一轮回答的延续")}`
);

console.log("\n########## S4 纯知识问答（无取证） ##########");
const s4 = await runScenario(directRequest("简要解释 TCP 为什么可靠。"));
const s4Answer = answerText(s4.events);
summarize("S4 纯知识问答", s4, s4Answer);

console.log("\n########## 汇总 ##########");
const all = requestLog;
const totalPrompt = all.reduce((sum, record) => sum + Number(record.usage.prompt_tokens ?? 0), 0);
const totalHit = all.reduce((sum, record) => sum + Number(record.usage.prompt_cache_hit_tokens ?? 0), 0);
const totalMiss = all.reduce((sum, record) => sum + Number(record.usage.prompt_cache_miss_tokens ?? 0), 0);
const totalCompletion = all.reduce((sum, record) => sum + Number(record.usage.completion_tokens ?? 0), 0);
console.log(`total-requests=${all.length} input=${totalPrompt} cacheHit=${totalHit} cacheMiss=${totalMiss} completion=${totalCompletion}`);
console.log(`overall-cache-hit%=${totalPrompt === 0 ? 0 : ((totalHit / totalPrompt) * 100).toFixed(1)}`);
const failed = all.filter((record) => record.status >= 400).length;
console.log(`failed-requests=${failed}`);
