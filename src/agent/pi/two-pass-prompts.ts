import { estimateTextTokens } from "../../domain/context-engine";
import type {
  ExecutionRequest,
  PiFocusAnchor,
  PiFocusContext,
  PiFocusDecision,
  PiFocusScope,
  PiResponseTarget,
  SelectorTokenBreakdown
} from "../../execution/types";
import {
  sha256Hex,
  stableNodeSourceId,
  stableNoteSourceId
} from "./cache-identity";
import type { PiContextSelection } from "./context-selection";
import type { PiContextCatalogSnapshot } from "./context-workspace";

export interface PiBuiltPrompt {
  systemPrompt: string;
  userPrompt: string;
  stablePrefixHash: string;
  stablePrefixEstimatedTokens: number;
  dynamicTailEstimatedTokens: number;
  tokenBreakdown?: SelectorTokenBreakdown;
}

export interface PiSelectorPromptOptions {
  tokenBudget?: number;
}

const DEFAULT_SELECTOR_INPUT_TOKEN_BUDGET = 2_000;
const MAX_DETAILED_NOTE_ENTRIES = 8;

function exactSelectionBlock(selectedQuotes: string[]): string {
  if (selectedQuotes.length === 0) return "";
  return [
    "# Exact Selection",
    "",
    ...selectedQuotes.map((quote) => `> ${quote.replace(/\n/gu, "\n> ")}`)
  ].join("\n");
}

function treeSystemPrompt(request: ExecutionRequest): string {
  return request.contextMessages
    .filter((message) => message.role === "system")
    .map((message) => message.content.trim())
    .filter(Boolean)
    .join("\n\n");
}

function catalogSnapshot(
  input: PiContextCatalogSnapshot | string
): PiContextCatalogSnapshot {
  if (typeof input !== "string") return input;
  return {
    stableMarkdown: input,
    dynamicMarkdown: "# Dynamic Conversation Branch\n\nNo frozen conversation nodes are available.",
    markdown: input,
    stableHash: sha256Hex(input),
    markdownHash: sha256Hex(input)
  };
}

function builtPrompt(
  systemPrompt: string,
  stableUserPrefix: string,
  dynamicUserTail: string,
  tokenBreakdown?: SelectorTokenBreakdown
): PiBuiltPrompt {
  const userPrompt = [stableUserPrefix, dynamicUserTail]
    .filter(Boolean)
    .join("\n\n");
  const stablePrefixText = [systemPrompt, stableUserPrefix]
    .filter(Boolean)
    .join("\n\n");
  return {
    systemPrompt,
    userPrompt,
    stablePrefixHash: sha256Hex(stablePrefixText),
    stablePrefixEstimatedTokens: estimateTextTokens(stablePrefixText),
    dynamicTailEstimatedTokens: estimateTextTokens(dynamicUserTail),
    ...(tokenBreakdown === undefined ? {} : { tokenBreakdown })
  };
}

function nodeTitle(request: ExecutionRequest, nodeId: string): string {
  return request.piContext?.conversationNodes?.find((node) => node.id === nodeId)?.title ?? nodeId;
}

function localContext(anchor: Extract<PiFocusAnchor, { kind: "message-selection" | "note-selection" }>): string {
  return [anchor.prefix, anchor.quote, anchor.suffix].join("").trim();
}

function focusAnchorId(anchor: PiFocusAnchor, index: number): string {
  return anchor.id ?? `F${String(index + 1)}`;
}

function defaultScopeForAnchor(anchor: PiFocusAnchor): PiFocusScope {
  if (anchor.defaultScope !== undefined) return anchor.defaultScope;
  if (anchor.kind === "note-selection") return "selection_only";
  if (anchor.kind === "message-selection") return "source_message";
  return "latest_round";
}

function fallbackResponseTargets(focus: PiFocusContext): PiResponseTarget[] {
  if ((focus.targets?.length ?? 0) > 0) return focus.targets ?? [];
  const exactTargets = focus.anchors.flatMap((anchor, index): PiResponseTarget[] => {
    const anchorId = focusAnchorId(anchor, index);
    if (anchor.kind === "note-selection") {
      return [{
        kind: "exact-selection",
        anchorId,
        text: anchor.quote,
        source: {
          type: "note",
          filePath: anchor.filePath,
          fileName: anchor.fileName
        }
      }];
    }
    if (anchor.kind === "message-selection") {
      return [{
        kind: "exact-selection",
        anchorId,
        text: anchor.quote,
        source: {
          type: "conversation-message",
          nodeId: anchor.sourceNodeId,
          messageId: anchor.sourceMessageId,
          role: anchor.sourceRole
        }
      }];
    }
    return [];
  });
  if (exactTargets.length > 0) return exactTargets;
  const structural = focus.anchors.find(
    (anchor): anchor is Extract<PiFocusAnchor, { kind: "conversation-round" }> =>
      anchor.kind === "conversation-round"
  );
  if (structural === undefined) return [];
  const index = focus.anchors.indexOf(structural);
  return [{
    kind: "conversation-round",
    anchorId: focusAnchorId(structural, index),
    sourceNodeId: structural.sourceNodeId,
    ...(structural.sourceMessageId === undefined
      ? {}
      : { sourceMessageId: structural.sourceMessageId }),
    reason: structural.reason
  }];
}

function targetSourceContainer(
  request: ExecutionRequest,
  target: PiResponseTarget
): string {
  if (target.kind === "conversation-round") {
    return `conversation node “${nodeTitle(request, target.sourceNodeId)}”`;
  }
  if (target.source.type === "note") {
    return `note “${target.source.fileName}” (${target.source.filePath})`;
  }
  return `conversation node “${nodeTitle(request, target.source.nodeId)}”`;
}

function primaryResponseTargetBlock(request: ExecutionRequest): string {
  const focus = request.piContext?.focus;
  if (focus === undefined) return "";
  const targets = fallbackResponseTargets(focus);
  if (targets.length === 0) return "";
  return [
    "# Primary Response Target",
    "",
    "The target identity is fixed by the user's interaction. Scope decisions may change how much context is read, but must not change the primary response target.",
    "",
    ...targets.flatMap((target, index) => {
      if (target.kind === "exact-selection") {
        return [
          `## Target ${String(index + 1)} · ${target.anchorId}`,
          "",
          "- Target type: exact user selection",
          `- Target text: “${target.text}”`,
          `- Source container: ${targetSourceContainer(request, target)} (context only)`,
          "- Omitted subjects, pronouns, and phrases such as “这个概念”, “它”, or “这里” refer to this exact selection unless the current request explicitly names another object.",
          ""
        ];
      }
      return [
        `## Target ${String(index + 1)} · ${target.anchorId}`,
        "",
        "- Target type: direct parent or previous conversation round",
        `- Primary source: ${targetSourceContainer(request, target)}`,
        `- Relationship: ${target.reason}`,
        ""
      ];
    })
  ].join("\n").trim();
}

function focusAnchorLines(
  request: ExecutionRequest,
  anchor: PiFocusAnchor,
  index: number,
  targetAnchorIds: ReadonlySet<string>
): string[] {
  const label = `## Context Source ${String(index + 1)}`;
  const id = focusAnchorId(anchor, index);
  const isPrimaryTarget = targetAnchorIds.has(id);
  const common = [
    `- Focus ID: ${id}`,
    `- Safe fallback scope: ${defaultScopeForAnchor(anchor)}`,
    `- Role: ${isPrimaryTarget ? "primary-target source" : "context only"}`
  ];
  if (anchor.kind === "note-selection") {
    const compactId = stableNoteSourceId(anchor.filePath);
    return [
      label,
      "",
      ...common,
      "- Type: exact note selection",
      `- Source container: ${compactId} · ${anchor.fileName} (${anchor.filePath})`,
      "- The source title identifies where the target came from; it is not a competing answer target.",
      "- Allowed scopes: selection_only | containing_section | full_source.",
      "",
      `> ${anchor.quote.replace(/\n/gu, "\n> ")}`,
      ...(localContext(anchor) === anchor.quote
        ? []
        : ["", `Local context: ${localContext(anchor)}`])
    ];
  }
  const compactId = stableNodeSourceId(anchor.sourceNodeId);
  const title = nodeTitle(request, anchor.sourceNodeId);
  if (anchor.kind === "message-selection") {
    return [
      label,
      "",
      ...common,
      "- Type: exact conversation-message selection",
      `- Source container: ${compactId} · ${title} (context only)`,
      `- Source message: ${anchor.sourceMessageId}`,
      `- Source role: ${anchor.sourceRole}`,
      "- The node title is container metadata, not the selected concept.",
      "- Allowed scopes: selection_only | source_message | latest_round | full_source.",
      "",
      `> ${anchor.quote.replace(/\n/gu, "\n> ")}`,
      ...(localContext(anchor) === anchor.quote
        ? []
        : ["", `Local context: ${localContext(anchor)}`])
    ];
  }
  return [
    label,
    "",
    ...common,
    "- Type: focused conversation round",
    `- Source container: ${compactId} · ${title}`,
    `- Relationship: ${anchor.reason}`,
    ...(anchor.sourceMessageId === undefined
      ? []
      : [`- Anchor message: ${anchor.sourceMessageId}`]),
    isPrimaryTarget
      ? "- This round is the primary target because no exact selection was supplied."
      : "- This round supplies structural context only and must not replace an exact selection target.",
    "- Allowed scopes: latest_round | full_source."
  ];
}

function localFocusBlock(request: ExecutionRequest): string {
  const focus = request.piContext?.focus;
  if (focus === undefined || focus.anchors.length === 0) {
    return exactSelectionBlock(request.piContext?.selectedQuotes ?? []);
  }
  const targets = fallbackResponseTargets(focus);
  const targetAnchorIds = new Set(targets.map((target) => target.anchorId));
  return [
    primaryResponseTargetBlock(request),
    "# Local Focus",
    "",
    `- Interaction: ${focus.interactionMode}`,
    `- Legacy safe fallback scope: ${focus.defaultScope}`,
    "- Choose a separate scope for every Focus ID. Do not force all focus sources to use the same range.",
    "- Scope selection controls context breadth only. It cannot promote a source container title into the answer target.",
    "- Another node or note becomes the response target only when the current request explicitly names another target.",
    "",
    "# Context Sources",
    "",
    ...focus.anchors.flatMap((anchor, index) =>
      focusAnchorLines(request, anchor, index, targetAnchorIds)
    )
  ].filter(Boolean).join("\n");
}

function selectorSystemPrompt(request: ExecutionRequest): string {
  return [
    treeSystemPrompt(request),
    [
      "You are TreeTalk's context router.",
      "The Primary Response Target is fixed by the user's interaction. Resolve omitted subjects, pronouns, and continuation questions against it first.",
      "Scope decisions may change how much context is read, but must not change the primary response target.",
      "A source container title, catalog item, parent round, or linked note may supplement, compare, verify, or provide prerequisites, but prominence must not replace an exact selection target.",
      "Root focus notes are the notes directly selected by the user. Linked notes are candidates only. Do not select a linked note merely because a Markdown link exists; select it only when its content is necessary for the current answer.",
      "Only treat another item as the main target when the current request explicitly names another target. If two targets remain genuinely equally plausible inside the local focus, preserve the ambiguity instead of silently switching topics.",
      "Choose the smallest sufficient scope independently for every Focus ID, then choose every additional note section and conversation-node part needed to solve the current request from the frozen Markdown index.",
      "There is no item-count limit. Be broad when the problem genuinely requires many short sources, but avoid irrelevant sources.",
      "Prefer exact note sections over whole notes. Use sections: [] only when the whole note is necessary.",
      "Use priority essential for indispensable evidence, supporting for useful evidence, and optional for low-value corroboration.",
      "Return one JSON object only. Do not include prose or Markdown fences.",
      "Compact IDs must come from the index. Unknown IDs are invalid."
    ].join("\n")
  ]
    .filter(Boolean)
    .join("\n\n");
}

const SELECTION_SCHEMA =
  '{"focus":[{"id":"F1","scope":"selection_only|containing_section|source_message|latest_round|full_source","reason":"short reason"}],"notes":[{"id":"P-0123456789","priority":"essential|supporting|optional","sections":["heading"],"reason":"short reason"}],"nodes":[{"id":"N-0123456789","priority":"essential|supporting|optional","parts":["question|answer|selection|all"],"reason":"short reason"}]}';

interface SelectorPromptSections {
  localFocus: string;
  currentRequest: string;
  outputContract: string;
}

function fitSelectorCatalog(
  systemPrompt: string,
  catalog: PiContextCatalogSnapshot,
  sections: SelectorPromptSections,
  tokenBudget: number
): {
  stableMarkdown: string;
  dynamicBranchMarkdown: string;
  dynamicTail: string;
  breakdown: SelectorTokenBreakdown;
} {
  const budget = Math.max(512, Math.trunc(tokenBudget));
  const stableHeader = catalog.stableHeaderMarkdown ?? "# Stable Note Catalog";
  const dynamicHeader = catalog.dynamicHeaderMarkdown ?? "# Dynamic Conversation Branch";
  const noteBlocks = catalog.noteBlocks;
  const nodeBlocks = catalog.nodeBlocks;

  if (noteBlocks === undefined || nodeBlocks === undefined) {
    const dynamicTail = [
      catalog.dynamicMarkdown,
      sections.localFocus,
      sections.currentRequest,
      sections.outputContract
    ].filter(Boolean).join("\n\n");
    const total = estimateTextTokens([systemPrompt, catalog.stableMarkdown, dynamicTail].filter(Boolean).join("\n\n"));
    return {
      stableMarkdown: catalog.stableMarkdown,
      dynamicBranchMarkdown: catalog.dynamicMarkdown,
      dynamicTail,
      breakdown: {
        systemPrompt: estimateTextTokens(systemPrompt),
        noteCatalog: estimateTextTokens(catalog.stableMarkdown),
        conversationBranch: estimateTextTokens(catalog.dynamicMarkdown),
        localFocus: estimateTextTokens(sections.localFocus),
        currentRequest: estimateTextTokens(sections.currentRequest),
        outputContract: estimateTextTokens(sections.outputContract),
        total,
        budget,
        detailedNoteCount: catalog.diagnostics?.availableDetailedNoteCount ?? 0,
        compactNoteCount: 0,
        omittedNoteCount: 0
      }
    };
  }

  const selectedNotes: Array<{ block: (typeof noteBlocks)[number]; markdown: string; detailed: boolean }> = [];
  const selectedNodes: Array<{ block: (typeof nodeBlocks)[number]; markdown: string; detailed: boolean }> = [];

  const renderStable = (): string => [
    stableHeader,
    ...selectedNotes.map((entry) => entry.markdown)
  ].filter(Boolean).join("\n\n");
  const renderBranch = (): string => [
    dynamicHeader,
    ...selectedNodes.map((entry) => entry.markdown)
  ].filter(Boolean).join("\n\n");
  const renderTail = (): string => [
    renderBranch(),
    sections.localFocus,
    sections.currentRequest,
    sections.outputContract
  ].filter(Boolean).join("\n\n");
  const totalTokens = (): number => estimateTextTokens(
    [systemPrompt, renderStable(), renderTail()].filter(Boolean).join("\n\n")
  );

  for (const block of nodeBlocks) {
    selectedNodes.push({ block, markdown: block.compactMarkdown, detailed: false });
    if (totalTokens() > budget) selectedNodes.pop();
  }

  let omittedNoteCount = 0;
  for (const block of noteBlocks) {
    selectedNotes.push({ block, markdown: block.compactMarkdown, detailed: false });
    if (totalTokens() > budget) {
      selectedNotes.pop();
      omittedNoteCount += 1;
    }
  }

  let upgrades = 0;
  for (const entry of selectedNotes) {
    if (upgrades >= MAX_DETAILED_NOTE_ENTRIES) break;
    const previous = entry.markdown;
    entry.markdown = entry.block.detailedMarkdown;
    entry.detailed = true;
    if (totalTokens() > budget) {
      entry.markdown = previous;
      entry.detailed = false;
      continue;
    }
    upgrades += 1;
  }

  const orderedNodeEntries = [...selectedNodes].sort((left, right) => {
    if (left.block.current !== right.block.current) return left.block.current ? -1 : 1;
    return right.block.depth - left.block.depth;
  });
  for (const entry of orderedNodeEntries) {
    const previous = entry.markdown;
    entry.markdown = entry.block.detailedMarkdown;
    entry.detailed = true;
    if (totalTokens() > budget) {
      entry.markdown = previous;
      entry.detailed = false;
    }
  }

  const stableMarkdown = renderStable();
  const dynamicBranchMarkdown = renderBranch();
  const dynamicTail = renderTail();
  const detailedNoteCount = selectedNotes.filter((entry) => entry.detailed).length;
  const compactNoteCount = selectedNotes.length - detailedNoteCount;
  const total = estimateTextTokens(
    [systemPrompt, stableMarkdown, dynamicTail].filter(Boolean).join("\n\n")
  );
  return {
    stableMarkdown,
    dynamicBranchMarkdown,
    dynamicTail,
    breakdown: {
      systemPrompt: estimateTextTokens(systemPrompt),
      noteCatalog: estimateTextTokens(stableMarkdown),
      conversationBranch: estimateTextTokens(dynamicBranchMarkdown),
      localFocus: estimateTextTokens(sections.localFocus),
      currentRequest: estimateTextTokens(sections.currentRequest),
      outputContract: estimateTextTokens(sections.outputContract),
      total,
      budget,
      detailedNoteCount,
      compactNoteCount,
      omittedNoteCount
    }
  };
}

export function buildPiSelectorPrompt(
  request: ExecutionRequest,
  catalogInput: PiContextCatalogSnapshot | string,
  options: PiSelectorPromptOptions = {}
): PiBuiltPrompt {
  const catalog = catalogSnapshot(catalogInput);
  const currentQuestion =
    request.piContext?.currentQuestion.trim() || "No current question was supplied.";
  const localFocus = localFocusBlock(request);
  const currentRequest = ["# Current Request", "", currentQuestion].join("\n");
  const outputContract = [
    "# Output Contract",
    "",
    `Return exactly this JSON shape: ${SELECTION_SCHEMA}`
  ].join("\n");
  const systemPrompt = selectorSystemPrompt(request);
  const fitted = fitSelectorCatalog(
    systemPrompt,
    catalog,
    { localFocus, currentRequest, outputContract },
    options.tokenBudget ?? DEFAULT_SELECTOR_INPUT_TOKEN_BUDGET
  );
  return builtPrompt(
    systemPrompt,
    fitted.stableMarkdown,
    fitted.dynamicTail,
    fitted.breakdown
  );
}

function selectedIds(selection: PiContextSelection): string {
  const noteIds = selection.notes.map((entry) => entry.id).sort();
  const nodeIds = selection.nodes.map((entry) => entry.id).sort();
  return [...noteIds, ...nodeIds].join(", ") || "none";
}

export function buildPiSupplementarySelectorPrompt(
  request: ExecutionRequest,
  catalogInput: PiContextCatalogSnapshot | string,
  initialSelection: PiContextSelection,
  missing: string,
  options: PiSelectorPromptOptions = {}
): PiBuiltPrompt {
  const catalog = catalogSnapshot(catalogInput);
  const currentQuestion =
    request.piContext?.currentQuestion.trim() || "No current question was supplied.";
  const localFocus = localFocusBlock(request);
  const currentRequest = [
    "# Supplementary Selection",
    "",
    "This is the one allowed supplementary selection pass. The local focus and its chosen scope are fixed. Select only new supplementary evidence that was not already materialized.",
    "",
    "## Missing Evidence",
    "",
    missing,
    "",
    "## Already Selected IDs",
    "",
    selectedIds(initialSelection),
    "",
    "# Current Request",
    "",
    currentQuestion
  ].join("\n");
  const outputContract = [
    "# Output Contract",
    "",
    `Return exactly this JSON shape: ${SELECTION_SCHEMA}`
  ].join("\n");
  const systemPrompt = selectorSystemPrompt(request);
  const fitted = fitSelectorCatalog(
    systemPrompt,
    catalog,
    { localFocus, currentRequest, outputContract },
    options.tokenBudget ?? DEFAULT_SELECTOR_INPUT_TOKEN_BUDGET
  );
  return builtPrompt(
    systemPrompt,
    fitted.stableMarkdown,
    fitted.dynamicTail,
    fitted.breakdown
  );
}

function answerSystemPrompt(request: ExecutionRequest): string {
  return [
    treeSystemPrompt(request),
    [
      "You are the TreeTalk answer agent.",
      "Answer the current request against the Primary Response Target and protected Local Focus Evidence first.",
      "An exact user selection is the answer object. Its node title, note title, parent round, and expanded source text are containers or context only.",
      "Other Selected Evidence is supplementary: use it for prerequisites, comparison, verification, or support, but do not let it silently replace the primary target.",
      "The user's explicit naming of another target overrides the exact-selection default. Mere topical similarity, repetition, source length, or a more prominent title does not.",
      "If the protected focus itself leaves two equally plausible targets, state the ambiguity rather than choosing a different branch item without notice.",
      "The candidate index and selector transcript have deliberately been removed to reduce repeated tokens.",
      "Distinguish source evidence from your own inference. Preserve the user's language.",
      "The final Pass Control section states whether one supplementary context request is still permitted."
    ].join("\n")
  ]
    .filter(Boolean)
    .join("\n\n");
}

function responseTargetLines(
  request: ExecutionRequest,
  decisions: readonly PiFocusDecision[] | PiFocusScope
): string[] {
  const focus = request.piContext?.focus;
  if (focus === undefined || focus.anchors.length === 0) {
    return ["- No structured local focus was supplied."];
  }
  const targets = fallbackResponseTargets(focus);
  const scopeFor = (anchorId: string): PiFocusScope => {
    if (typeof decisions === "string") return decisions;
    const anchor = focus.anchors.find(
      (entry, index) => focusAnchorId(entry, index) === anchorId
    );
    return decisions.find((decision) => decision.anchorId === anchorId)?.scope ??
      (anchor === undefined ? focus.defaultScope : defaultScopeForAnchor(anchor));
  };
  const targetLines = targets.map((target, index) => {
    const scope = scopeFor(target.anchorId);
    if (target.kind === "exact-selection") {
      return `- Target ${String(index + 1)} / ${target.anchorId}: exact selection “${target.text}”; source container: ${targetSourceContainer(request, target)} (context only); chosen scope: ${scope}`;
    }
    return `- Target ${String(index + 1)} / ${target.anchorId}: ${targetSourceContainer(request, target)}, ${target.reason}; chosen scope: ${scope}`;
  });
  return targetLines.concat([
    "- Scope controls context breadth only; it never changes target identity.",
    "- Treat all source titles and all other evidence as contextual unless the current request explicitly names another target."
  ]);
}

function targetLockBlock(request: ExecutionRequest): string {
  const focus = request.piContext?.focus;
  if (focus === undefined) return "";
  const targets = fallbackResponseTargets(focus);
  if (targets.length === 0) return "";
  const exactTargets = targets.filter(
    (target): target is Extract<PiResponseTarget, { kind: "exact-selection" }> =>
      target.kind === "exact-selection"
  );
  if (exactTargets.length === 0) {
    return [
      "# Target Lock",
      "",
      `Primary target: ${targets.map((target) => targetSourceContainer(request, target)).join(", ")}.`,
      "Answer that conversation round unless the current request explicitly names another object."
    ].join("\n");
  }
  const lines = [
    "# Target Lock",
    "",
    ...exactTargets.map((target) => `- Primary target: “${target.text}”`),
    ""
  ];
  if (exactTargets.length === 1) {
    const target = exactTargets[0];
    if (target === undefined) return "";
    lines.push(
      `- Any omitted subject, demonstrative, or pronoun in the Current Request—including “这个概念”, “它”, or “这里”—refers to the exact selection “${target.text}” unless the current request explicitly names another object.`
    );
    const container = targetSourceContainer(request, target);
    const match = /conversation node “([^”]+)”/u.exec(container);
    if (match?.[1] !== undefined) {
      lines.push(`- “${match[1]}” is only the source container and must not replace the selected target.`);
    } else {
      lines.push(`- ${container} is only the source container and must not replace the selected target.`);
    }
  } else {
    lines.push(
      "- Plural references such as “它们” refer to the exact selections above unless the current request explicitly names another object."
    );
  }
  lines.push(
    "- Expanded source text and supplementary evidence may explain the target, but cannot become the answer subject merely because they are longer or repeated more often."
  );
  return lines.join("\n");
}

export function buildPiAnswerPrompt(
  request: ExecutionRequest,
  evidenceMarkdown: string,
  allowSupplementarySelection: boolean,
  focusDecisions: readonly PiFocusDecision[] | PiFocusScope =
    request.piContext?.focus?.defaultScope ?? "latest_round"
): PiBuiltPrompt {
  const currentQuestion =
    request.piContext?.currentQuestion.trim() || "No current question was supplied.";
  const outputProtocol = [
    "# Answer Transport Contract",
    "",
    "The first output line must be exactly one of:",
    "TT_MODE: FINAL",
    "TT_MODE: NEED_MORE_CONTEXT",
    "For TT_MODE: FINAL, write only the user-visible answer after the first line.",
    "For TT_MODE: NEED_MORE_CONTEXT, write only the need_more_context JSON object after the first line.",
    "Never include the TT_MODE line inside the user-visible answer."
  ].join("\n");
  const passControl = allowSupplementarySelection
    ? [
        "# Pass Control",
        "",
        "Supplementary context is allowed once.",
        "If and only if the supplied evidence is genuinely insufficient, return one JSON object instead of an answer:",
        '{"status":"need_more_context","missing":"briefly describe the evidence or concept that is still missing"}',
        "Do not name compact source IDs because the candidate index is intentionally absent from this pass. Otherwise answer normally."
      ].join("\n")
    : [
        "# Pass Control",
        "",
        "Supplementary context is not allowed. This is the final pass. Answer with prose and do not request more context."
      ].join("\n");
  const dynamicTail = [
    "# Response Target",
    "",
    ...responseTargetLines(request, focusDecisions),
    "",
    ...(request.piContext?.focus === undefined
      ? [exactSelectionBlock(request.piContext?.selectedQuotes ?? [])]
      : []),
    "# Current Request",
    "",
    currentQuestion,
    targetLockBlock(request),
    outputProtocol,
    passControl
  ]
    .filter(Boolean)
    .join("\n\n");
  return builtPrompt(
    answerSystemPrompt(request),
    evidenceMarkdown,
    dynamicTail
  );
}
