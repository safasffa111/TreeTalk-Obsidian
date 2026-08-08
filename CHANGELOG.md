# TreeTalk Changelog

## 0.9.0: First community release

- Store-facing README with installation, usage, and privacy disclosure.
- MIT license, public GitHub repository, and release automation.
- Includes all changes from 0.9.0-alpha.24: continuation grounding (parent
  digest + evidence provenance), console diagnostics for silent failures,
  hot-path clone reduction, and agent-run publish throttling.

## 0.9.0-alpha.24: Continuation grounding and console diagnostics

- Follow-up turns now seed with a structural parent digest (opening conclusion
  plus tail) instead of only the parent tail, a provenance list of the previous
  answer's evidence batches, and an explicit continuation constraint.
- Silent catch sites across storage, indexing, streaming, and rendering now
  leave developer-console warnings for diagnosability.
- Agent-run hot paths drop redundant deep copies and coalesce UI publishes per
  animation frame.

## 0.9.0-alpha.23: Low-token progressive web evidence

- Reworked Progressive Pi web access into two explicit stages: `search_web` now returns only a compact result index, and `open_web_result` reads one Pi-selected page when its contents are actually needed.
- Native DeepSeek search stops at the first `pause_turn`/completion frame. TreeTalk no longer replays the full `web_search_tool_result` into a second DeepSeek summarization request, removing the largest uncached input stage seen in alpha.22.
- The model-facing tool definitions are fixed from the first request in this order: `request_context`, `search_web`, `open_web_result`. Every later Pi request remains an append-only extension of the prior message prefix, preserving the existing `treetalk-progressive-v2` cache structure.
- Search indexes contain only stable result IDs, titles, and hostnames. URLs remain internal until Pi opens a result, and only successfully opened pages are emitted as answer sources. Search-index text is not treated as factual evidence.
- Page reads are fetched locally through Obsidian, stripped of scripts/navigation/layout noise, wrapped as untrusted external evidence, and clipped to approximately 2,500 tokens per page. A run may open at most two pages and add at most 5,000 estimated web-evidence tokens.
- Web access rejects non-HTTP(S) URLs, credentials, localhost, `.local`, and literal private/loopback/link-local network targets. Duplicate result opens are blocked without another request, while failed page reads return a tool error so Pi may continue with other evidence.
- Search-query limits remain three distinct normalized queries. Search indexes do not consume the opened-page evidence budget, and the offline Progressive Pi prompt remains byte-identical to earlier releases.

## 0.9.0-alpha.22: Progressive Pi web search

- Enabling web search no longer diverts DeepSeek requests away from Progressive Pi into the legacy two-pass path. Local conversation/note context and current web evidence now participate in the same agent loop.
- Added a fixed `search_web` semantic tool beside `request_context`. Pi may alternate between local context reads and progressively refined web queries, while TreeTalk executes at most one tool per model turn.
- Every later Pi request preserves the previous request messages as an exact append-only prefix. The system prompt, fixed tool definitions, initial user message, and `treetalk-progressive-v2` cache key remain stable throughout the active run.
- Web search uses DeepSeek's native server-side search in a separate tool execution stage. Each search request allows one native search use, follows at most two `pause_turn` continuations, emits sources and usage, and prefers streaming transport without replaying a search after evidence has already been released.
- Progressive web budgets are capped at three distinct normalized queries and 10,000 estimated evidence tokens. Search stops when fewer than 128 evidence tokens remain, duplicate queries are rejected locally, and Pi is then required to answer from accumulated evidence.
- External web text is wrapped as untrusted evidence. Instructions found inside retrieved pages are not treated as executable instructions, and search failures are returned as tool errors so Pi can still answer from existing context.
- Conversation schema, persisted Markdown, runtime-only thinking behavior, local-context limits, and the DeepSeek 16,384-token final-answer ceiling remain unchanged.

## 0.9.0-alpha.18: Semantic progressive context interfaces

- Unselected Pi follow-ups now begin with the last approximately 500 tokens of the actual structural parent assistant response. Additional `current_source` reads page backward through that same response, so continuation, revision, challenge, and follow-up requests receive the immediately preceding context without keyword routing.
- The model-facing progressive tool is now `request_context` with compact semantic targets: `current_section`, `current_source`, `related_sections`, and `related_full_source`. Internal L0-L4 levels remain local diagnostics and are not exposed in prompts or tool results.
- Tool availability is rebuilt from real undelivered evidence on every turn. Convergent mode offers the current-source remainder and nearest available higher source; the new context-divergence mode may expose every available higher target, but cannot bypass related-note permission, the frozen graph, deduplication, or token/turn limits.
- Added one globally persisted `上下文发散` control shared by the settings page and every composer. The value is frozen at send time and defaults to off.
- Model-visible interface descriptions are fixed one-line statements of what each interface returns. Tool results contain only `source`, `scope`, `remaining`, and `content`; reasoning, evidence bodies, and internal level metadata are not persisted.
- Progressive diagnostics now distinguish convergence/divergence, initial structural context, requested semantic interfaces, cross-level requests, and `新增证据 Token`. The 50-expansion, 51-subrequest, 30,000-evidence-token, and DeepSeek 16,384-output-token ceilings remain unchanged.
- This release is built from alpha.17. It adds no continuation-keyword regular expressions and contains none of the rejected alpha.16 Judger/task-contract architecture.

## 0.9.0-alpha.17: Expanded progressive context limits

- This release is rebuilt directly from the accepted 0.9.0-alpha.15 source baseline. The rejected alpha.16 Judger/task-contract work is not included.
- Progressive Pi now permits up to 50 `expand_context` calls and 51 Answer-model subrequests, allowing one final forced-answer turn after the 50th expansion.
- The newly delivered progressive evidence ceiling is now 30,000 estimated tokens for both normal and explicitly comprehensive requests. Initial evidence remains part of the same 30,000-token budget, and a batch that would exceed the ceiling is rejected before delivery.
- These are hard ceilings rather than targets: simple L0 questions can still finish in one request, related notes remain permission-only and on demand, and the L0-L4 ladder, provider routing, DeepSeek 16,384-token final-answer limit, persistence schemas, and Markdown capture remain unchanged.

## 0.9.0-alpha.15: Progressive Pi context ladder

- Pi no longer forces every DeepSeek/OpenAI-compatible request through the Selector. It starts from the smallest deterministic L0–L4 context level and uses the same Answer model to request additional evidence only when missing information would materially affect the answer.
- The ladder is: L0 exact target; L1 containing Markdown section or bounded local window; L2 the target note/node delivered in bounded batches; L3 ranked ancestor and permitted related-note sections; L4 ranked full ancestor/related sources, still delivered in bounded batches.
- The related-note control is permission only. Enabling it does not load a note catalog or add tokens unless the request actually expands into related-note evidence; disabling it excludes related notes from L3/L4 entirely.
- Progressive execution exposes only one `expand_context` tool. TreeTalk chooses the next non-repeated batch, enforces monotonic levels, four expansions, five model subrequests, and an 8,000-token evidence budget (12,000 for explicit comprehensive analysis), then forces a final answer from the evidence already available.
- DeepSeek/OpenAI-compatible tool turns stay in one append-only Answer conversation and replay temporary `reasoning_content` only within the active tool cycle. Intermediate tool text, evidence bodies, and reasoning never enter the visible answer, canonical conversation, later user turns, or Markdown deposits.
- DeepSeek, OpenAI, and OpenAI-compatible routes use the progressive engine by default. Anthropic, Gemini, web-search requests, and explicit compatibility regressions retain the verified alpha.14 two-pass Selector engine.
- Agent-run diagnostics record only initial/final level, expansion counts, evidence-token totals, source IDs/titles/relationships, and whether related notes were actually used. The release also includes a 50-case benchmark schema and an offline summarizer; bundled sample measurements are synthetic fixtures, not provider quality results.
- Legacy execution, synchronized composer controls, runtime-only thinking display, DeepSeek's 16,384-token final-answer ceiling, conversation `schemaVersion: 1`, and `pi-agent-run:v1` remain compatible.

## 0.9.0-alpha.14: Synchronized composer execution controls

- The composer now exposes three global controls before web search and send: execution engine (`Pi Agent`/`Legacy`), related-note context, and answer thinking (`自动`/`关闭`/`开启`).
- Composer controls and the settings page now read and write the same persisted `TreeTalkSettings` values. Changes made in either place update every open TreeTalk view and an already-open settings tab immediately; node or tab switching no longer creates a second control state.
- Answer thinking no longer reads or writes `draft.answerThinkingModeOverride`. The legacy field remains schema-compatible for old conversations but is ignored at runtime.
- Each send snapshots execution engine, answer thinking mode, related-note enabled state, and related-note depth before conversation mutation and note freezing. Later UI changes cannot alter an in-flight request.
- The related-note composer button only controls the global enable switch; link traversal depth remains in settings. All three controls are disabled during active generation.
- Provider behavior, prompts, Pi selector budgets, final-answer limits, runtime-only thinking display, knowledge capture, conversation schema version 1, and `pi-agent-run:v1` remain unchanged.

## 0.9.0-alpha.13: Runtime-only answer thinking transparency

- DeepSeek final-answer requests now allow 16,384 output tokens in both Legacy and Pi. Pi initial and supplementary Selectors remain capped at 1,024 tokens, and other providers retain their previous answer limits.
- DeepSeek `reasoning_content` and Anthropic-style `thinking_delta` are normalized into a separate runtime-only thinking stream. Answer reasoning is displayed as a collapsible plain-text panel on the active streaming assistant message; Pi Selector reasoning and control envelopes are never shown.
- Thinking text lives only in `TransientThinkingStore`. It is deleted immediately when the answer completes, fails, or is aborted, and is also cleared when the workspace view closes or the plugin unloads. It never enters `ChatMessage`, `ConversationFile`, saved JSON, future model context, search indexes, relationship graphs, or Markdown deposits.
- Provider-reported `completion_tokens_details.reasoning_tokens` is retained as numeric diagnostics and shown as `其中推理` in token details without retaining the reasoning text.
- Answer prompts, Pi evidence budgets, thinking-mode classification, one-time no-thinking length recovery, conversation schema version 1, and `pi-agent-run:v1` remain compatible.

## 0.9.0-alpha.12: Unified answer thinking control

- Added one shared `回答思考模式` setting with `自动`, `关闭`, and `开启` options. It controls the final answer in both Legacy and Pi execution; Pi initial and supplementary Selectors remain permanently non-thinking.
- Added a composer brain control beside web search and send. It can override the setting for the current draft, works in both Legacy and Pi, survives node switching and failed sends, and resets to the configured default after a successful send.
- Auto mode is resolved locally without another model call. Direct transformations such as reordering, rewriting, translation, extraction, and simple selected-concept explanations use non-thinking answers; proofs, derivations, diagnosis, and complex multi-source analysis can enable thinking. Manual enable/disable always wins.
- DeepSeek answer requests now receive an explicit thinking mode. Providers that do not expose compatible thinking controls keep their existing behavior and show the composer control as unavailable.
- Streaming finish reasons now preserve token-limit termination. If a thinking-enabled Legacy or Pi answer reaches the model length limit before any visible answer is released, TreeTalk retries the same prepared context once with thinking disabled. Pi reuses the already selected evidence and does not rerun the Selector.
- Answer prompts, evidence budgets, 8,192-token answer ceiling, streaming text protocol, conversation schema version 1, and `pi-agent-run:v1` remain compatible.

## 0.9.0-alpha.11: Selector-only routing output control

- Initial and supplementary Pi Selector calls now use a 1,024-token generation ceiling instead of 4,096 tokens. Final Answer calls keep their existing 8,192-token budget, prompts, reasoning behavior, streaming behavior, and evidence budgets.
- DeepSeek Selector requests explicitly send `thinking: { type: "disabled" }`. Providers without an equivalent explicit control remain compatible and still receive the reduced Selector output ceiling.
- Malformed or token-truncated Selector JSON now falls back to the protected local focus with no optional external evidence, allowing the Answer stage to continue instead of failing the whole turn. The same fallback applies to the one optional supplementary Selector pass.
- The existing Selector JSON contract remains unchanged. This release adds no new limits on reason length, selected candidate count, or repeated selections.
- Conversation schema version 1, `pi-agent-run:v1`, alpha.10's 2,000-token Selector input catalog budget, response-target locking, and all Answer-stage behavior remain compatible.

## 0.9.0-alpha.10: Budgeted Pi selector catalog

- Replaced conclusion-heavy Pi selector indexes with a layered candidate catalog. Detailed note entries contain a stable path-derived ID, title, graph depth, relationship to the selected focus, and at most six level-1/level-2 Markdown headings.
- Removed note conclusion bodies, historical answer conclusions, and the global relationship-edge dump from the first selector request. The model reads note sections or full notes only after explicitly selecting them.
- Added a 2,000-token selector input budget. TreeTalk first preserves compact IDs for every candidate that fits, then upgrades up to eight root/high-relevance notes to detailed entries. The protected response target, exact selections, local focus, and current question are never removed to satisfy the catalog budget.
- Candidate ordering is deterministic and focus-aware: selected root notes come first, followed by nearer notes and title/heading matches. Stable compact IDs continue to resolve independently of insertion order.
- Added execution diagnostics for selector system, note catalog, conversation branch, local focus, current request, and output-contract tokens, together with detailed/compact/omitted candidate counts.
- The two-pass Selector → Answer architecture, one supplementary selection pass, per-focus note scopes, response-target locking, streaming control, schema version 1, and `pi-agent-run:v1` remain compatible.

## 0.9.0-alpha.9: Streaming control, execution progress, and graph polish

- Added a persistent `流式输出` setting, enabled by default. Legacy and Pi final-answer passes now use genuine provider streaming when enabled and buffered delivery when disabled. Pi selector and supplementary-control JSON remain buffered and never appear in the visible answer.
- Pi final-answer streaming uses a small `TT_MODE` transport envelope so final prose can be released incrementally while `need_more_context` control output stays hidden. Providers that cannot establish a stream may safely fall back before any visible text is emitted.
- Replaced the single generic waiting label with execution-backed progress such as focus identification, context selection, selected node/note counts, context reading, supplementary retrieval, web search, and final-answer generation. The status disappears on the first visible answer delta.
- Relationship-graph hover nodes, edges, and labels now follow Obsidian's live `--interactive-accent`/`--color-accent` theme values. Theme or light/dark changes rebuild only color geometry and do not restart layout or the Worker.
- Graph labels now fade in smoothly as zoom moves from `0.78` to `1.18`. Below that range, hovering reveals only the hovered label; it no longer causes every connected label to appear. At readable zoom levels, visible labels are prioritized by hover, active/focused state, and node importance.
- Conversation schema version 1, `pi-agent-run:v1`, note-context protocol, target locking, per-focus routing, stable-prefix caching, and Legacy/Pi selection remain compatible.

## 0.9.0-alpha.8: Exact response-target locking

- Exact message and note selections now become explicit execution-only `Primary Response Target` records. The selected text is the answer object; its node title, note title, parent round, and expanded source text are context containers only.
- Selector scope decisions control how much of each source is read, but cannot change target identity. A source title that is longer, repeated more often, or topically prominent cannot silently replace the user's exact selection.
- The answer request repeats a `Target Lock` after the current question. Omitted subjects, demonstratives, and pronouns such as “这个概念”, “它”, and “这里” resolve to the exact selection unless the user explicitly names another object.
- Protected evidence is separated into `Primary Target Evidence`, `Structural Context`, and `Target Context`. Tight token budgets preserve exact selected text and the direct parent round before large source expansions.
- Multiple exact selections remain a target set for comparison or plural follow-ups. When no exact selection exists, the direct parent or previous completed round remains the structural default target.
- The two-pass Selector → Answer architecture, per-focus note scopes, one optional supplementary cycle, stable-prefix caching, schema version 1, `pi-agent-run:v1`, and Legacy mode remain compatible.

## 0.9.0-alpha.7: Per-focus note routing and selective related evidence

- Exact Obsidian note selections are now first-class protected Pi focus anchors with stable IDs and frozen source offsets. The selected text remains the response target even when the relationship graph exposes many related notes.
- Pi chooses a scope independently for every focus source. A selected note may use only the exact selection, its containing Markdown section, or the full note while the direct parent can independently remain at its latest question-answer round.
- The containing section is resolved from the frozen selection offset and Markdown heading structure, with quote-based fallback when offsets are unavailable or stale. Failure to expand one note no longer removes valid parent or selection focus.
- Relationship mode marks the selected root note separately from linked-note candidates. Links expose possible evidence only; Pi must explicitly justify and select a related note instead of loading every connected note by default.
- A protected selection no longer excludes its entire source note from later evidence selection. TreeTalk deduplicates concrete evidence blocks, allowing Pi to keep the exact quote and additionally read another section from the same note when needed.
- Selector parsing remains compatible with the alpha.6 single-scope response, while the preferred response assigns `selection_only`, `containing_section`, `source_message`, `latest_round`, or `full_source` per focus ID.
- The two-pass Selector → Answer design, one optional supplementary cycle, stable-prefix caching, conversation schema version 1, `pi-agent-run:v1`, and Legacy execution path remain unchanged.

## 0.9.0-alpha.6: Parent-anchored Pi local focus

- Every Pi turn now carries a transient `Local Focus` derived from the actual TreeTalk interaction: a child turn anchors to its direct parent, a continued turn anchors to the previous completed assistant response, and exact message/note selections retain their real source identity.
- Exact selections, their source context, and the structural parent are materialized as protected focus evidence before ordinary note or node evidence. Ordinary selections cannot displace the current response target when the evidence budget is tight.
- The selector now chooses how much of the focused source is required: exact selection, source message, latest question-answer round, or full source. It still uses the existing two-pass architecture and does not add another provider request.
- Other branch nodes and Obsidian notes remain available as supplementary context, but stronger prompt rules prevent a prominent catalog title or a related ancestor from silently replacing the local subject of an omitted-subject or pronoun-based follow-up.
- The final answer prompt includes an explicit `Response Target` and labels all non-focus evidence as supplementary. Explicitly named targets may override the default focus; genuine ambiguity must be surfaced instead of guessed.
- The stable note-catalog prefix, `pi-agent-run:v1`, conversation schema version 1, Legacy execution path, and existing evidence budgets remain compatible.

## 0.9.0-alpha.5: Cache-aligned two-pass context router

- Keeps the alpha.4 two-pass selector/answer architecture, but reorganizes every provider request around stable prefix caching: immutable instructions and reusable note/evidence content appear before dynamic branch, selection, and question text.
- The selector prompt now starts with a stable note catalog and stable note relationships, followed by the changing conversation branch, exact selection, and current request. The answer prompt starts with canonical evidence and places the current question at the end.
- Replaces positional `P1…Pn` / `N1…Nn` identities with path/UUID-derived stable short IDs such as `P-a31f92c840` and `N-69113f4a20`. Adding or reordering another source no longer renumbers every later source. Legacy positional aliases remain readable inside the request workspace.
- Context catalog Markdown and materialized evidence are deterministically ordered and hashed. Equivalent source sets now generate byte-identical stable prefixes regardless of Pi's output-array order.
- Initial and supplementary selector calls share one byte-identical system prompt and the same cached note-catalog prefix. Initial and final answer calls share one byte-identical answer prompt; supplement controls live only in the dynamic tail.
- `pi-agent-run:v1` remains compatible and now stores optional per-stage usage plus stable-prefix hash, estimated stable-prefix tokens, and estimated dynamic-tail tokens. The execution panel shows hit/miss statistics separately for selector, answer, supplementary selector, and supplementary answer stages.
- DeepSeek continues using automatic prefix caching; OpenAI-compatible routes may additionally receive a stable-prefix-derived explicit prompt cache key. No note body, node transcript, API key, raw provider response, or cache content is persisted.

## 0.9.0-alpha.4: Two-pass Pi context router

- Pi no longer carries a growing tool transcript across repeated model turns. A selector pass sees only the current request, exact selections, and the compact Markdown context index, then returns note/node IDs as strict JSON.
- TreeTalk materializes the chosen note sections, full notes, and conversation-node parts locally. Selection is limited by a total evidence-token budget, not by a fixed source count, so many short sources may be read when they fit.
- The default balanced budget is 12,000 estimated tokens for initial evidence plus one optional 6,000-token supplement. Priority ordering, deduplication, and paragraph-aware clipping keep the final evidence inside the budget.
- The answer pass is a fresh request containing only the current question, exact selections, and selected evidence. It excludes the full candidate index, selector transcript, tool schemas, unselected sources, and precompiled historical context.
- One structured `need_more_context` response is allowed. Additional evidence is materialized once and a final clean answer is generated; an endless retrieval loop is impossible.
- Compact `P1…Pn` and `N1…Nn` IDs reduce repeated path/UUID tokens. Agent execution details now show candidate, selected, and actually materialized source counts, evidence Token use, supplementary status, and budget clipping.
- Existing `note-context-graph:v1`, `pi-agent-run:v1`, conversations, settings, and Legacy execution remain compatible.

## 0.9.0-alpha.3: Index-first Pi context

- Pi mode now builds one Markdown `TreeTalk Context Index` from the frozen current conversation branch and frozen note graph instead of forwarding compiled historical messages.
- The first provider turn contains only the system prompt, current request, exact selected quotes, node/note names, explicit conclusion sections, and relationship edges. Full historical answers and note bodies are absent.
- Notes without a `结论`/`总结`/`摘要`/`要点`/`Conclusion`/`Summary`-style section expose only their name and path. Indexed conclusion text is capped at 1,600 characters.
- Conversation nodes use the same rule: title and explicit conclusion only. Full node transcripts are available through the new `read_context_node` tool.
- Added `list_context_nodes` and `read_context_note_section`; section reads stop at the next heading of the same or higher level.
- Pi mode bypasses the full/balanced provider-context compiler, preventing large historical branches from being pre-sent or rejected before the agent can choose sources. Legacy mode keeps the existing compiler unchanged.
- Agent execution traces now record the exact TreeTalk node IDs as well as note paths actually read. Old `pi-agent-run:v1` records remain compatible.
- The index keeps real Markdown edge direction while giving forward links and backlinks equal selection priority.

## 0.9.0-alpha.2: Real Pi selected-context agent loop

- Replaced the alpha.1 compatibility delegate with an independent Pi Agent execution loop. Pi mode no longer invokes `LegacyExecutionEngine`; Legacy remains only as an explicit fallback mode.
- Pi receives TreeTalk's current branch, exact selections, and a catalog of the frozen note-context graph. Full note bodies in the current request are withheld from the first model turn.
- Added four read-only context tools: `list_context_notes`, `read_context_note`, `search_context_notes`, and `get_context_links`. Every tool is hard-limited to the immutable note graph frozen on the submitted user message.
- The model can perform up to eight model turns and twenty-four tool calls, deciding which selected notes to inspect before producing one final answer. Forward links and backlinks have equal exploration status.
- Added native function-call transports for OpenAI, DeepSeek/OpenAI-compatible endpoints, Anthropic, and Gemini. Tool calls and tool results are converted to each provider's native message format.
- `pi-agent-run:v1` now persists tool name, arguments, completion state, summaries, and the exact frozen note paths actually read. Execution records remain local to the assistant message and are excluded from deposited Markdown.
- Pi is now the default for new settings; explicit Legacy selections remain preserved. Old conversations and alpha.1 execution records remain readable.
- The embedded runtime is an Obsidian-safe adaptation of the Pi Agent Core v0.82.1 turn/tool/result loop. It avoids the terminal, shell, unrestricted filesystem, session, and Node-runtime dependencies of the full npm package while retaining the agent behavior required by TreeTalk.
- This alpha is intentionally read-only: Skills, note-writing tools, role pipelines, multi-key routing, MCP, Bash, and web-search tools are not yet enabled.

## 0.9.0-alpha.1: Pi execution foundation

- Added a TreeTalk-owned execution protocol so Legacy and future Pi-backed runs use the same request, event, completion, abort, failure, source, and usage lifecycle.
- Extracted the former provider streaming state machine into `LegacyExecutionEngine`, preserving DeepSeek web-search continuation, buffered fallback, sources, usage, cancellation, and notices.
- Added `SendCoordinator` as the single engine-neutral execution lifecycle owner and `ExecutionRouter` for reversible Legacy/Pi mode selection.
- Added persisted `pi-agent-run:v1` metadata to assistant messages, including engine mode, role, route, provider/model, stages, sources, usage, terminal status, and failure reason. API keys are not part of this protocol.
- Added a collapsed per-message execution detail and a settings switch between `Legacy（稳定）` and `Pi Direct（兼容层）`. Existing settings migrate to Legacy.
- This alpha intentionally does **not** bundle the official Pi npm runtime yet. `PiExecutionEngine` is the stable replacement boundary; Direct mode currently reuses TreeTalk's proven provider transport while validating the final conversation, persistence, abort, and UI architecture.
- Tools, Skills, multi-key routing, role pipelines, MCP, Bash, and note-write actions remain outside alpha.1.

## 0.8.47: Backlink freeze and relationship-graph recovery

- Fixed send-time note-context freezing whenever a discovered backlink points toward the selected root note.
- `primaryParentId` now validates against the first-discovery `primaryChain`, while `parentIds` and `outgoingNodeIds` remain the real Markdown edge direction. This distinction is required for reverse traversal.
- Incoming and outgoing notes continue to have identical traversal depth, content rendering, deduplication, and token-budget behavior.
- Once freezing succeeds, every traversed forward/backlink note is attached to the message snapshot and appears in the TreeTalk relationship graph instead of leaving only the originally selected note.
- The persistence protocol remains `note-context-graph:v1`; existing conversations and frozen graphs require no migration.

## 0.8.46: Equal forward-link and backlink note context

- Related-note context now traverses both outgoing internal links and incoming backlinks with identical depth, deduplication, body rendering, and model-wide token-budget behavior.
- Forward and reverse neighbors are merged before traversal and sorted by one direction-neutral rule, so outgoing links do not receive priority merely because they were discovered first.
- The frozen `note-context-graph:v1` still records every edge in its real Markdown direction. A backlink discovered from the current note therefore appears as `source note → current note`, while both endpoint note bodies receive the same TreeTalk context treatment.
- Obsidian's resolved-link cache is inverted once per send-time resolver into a target-to-sources index. Recursive backlink lookup is therefore indexed rather than repeatedly scanning the full vault link map.
- Cycles, converging paths, bidirectional links, repeated link labels, finite depth, and unlimited depth continue to use one path-deduplicated graph. Existing frozen graphs remain compatible and require no migration.

## 0.8.45: Relationship graph lifecycle restoration

- Closing and reopening the relationship graph now reuses one window controller, preserving the per-conversation camera instead of constructing a blank lifecycle from scratch.
- The latest SharedArrayBuffer coordinates are synchronized and checkpointed before close. Persisted coordinates are marked as restored when the Worker topology is rebuilt.
- A fully restored topology starts in an idle state and ignores only the first viewport synchronization, so reopening no longer immediately pulls the graph back toward a newly calculated radial layout.
- Fresh graphs and topologies containing new nodes still run the normal center-out radial force simulation. Dragging or a later real resize reheats the graph as before.
- The title-bar minimize button is now a true toggle: clicking it while minimized restores the graph window and resumes rendering.
- Closing clears transient hover/focus state while retaining the camera and persisted layout. SharedArrayBuffer, unified RAF, radial hierarchy constraints, and GPU node/edge meshes are unchanged.

## 0.8.44: Center-out radial tree relationship layout

- The relationship graph now treats the conversation as a hierarchy rather than a free network: the root stays at the viewport center, depth determines the outward ring, and first-level branches own stable non-overlapping angular sectors.
- Sector width is allocated by subtree footprint and recursively inherited, so a large branch receives more room while descendants remain inside the same branch region instead of crossing into neighboring subtrees.
- Crowded sibling groups automatically expand their shared radial ring to preserve minimum target spacing. Dense note attachments are distributed over multiple satellite rings, preventing large first layers or note clusters from collapsing into one circle.
- The Worker uses hierarchy-constrained forces: strong radial depth and softer angular targets preserve the tree, while collision, repulsion, and weak typed springs keep dragging and local motion natural.
- Source and related note nodes no longer participate in the main conversation tree. They orbit outside their primary host node, with related notes farther out and weaker links so they cannot pull the conversation structure apart.
- Missing positions seed directly from the deterministic radial planner. Existing `deposit-graph:v1` positions remain compatible and become animation starting points that settle into the new layout.
- Parent-child edges are visually stronger than source-note and related-note edges while remaining inside the single GPU edge mesh. SharedArrayBuffer, unified RAF, and Shader-expanded geometry from 0.8.43 remain unchanged.

## 0.8.43: Shared-memory GPU relationship graph runtime

- The relationship graph now uses a display-frame-driven runtime. A single `requestAnimationFrame` loop owns camera, interaction, shared physics presentation, labels, and the final PixiJS render submission.
- D3 force simulation writes positions into a triple-page `SharedArrayBuffer`. Reader locks plus odd/even publish seqlocks prevent the Worker from overwriting an uploading page or exposing a half-switched frame.
- Node dragging writes directly into a separately seqlocked shared interaction buffer instead of sending coordinate snapshots through the Worker queue. A one-shot wake/activity control message restarts cooled physics and a stopped display RAF without carrying positions.
- Worker position snapshots are removed from the primary path. The main thread reads the newest complete shared page every display frame without the former 20/30 Hz publication ceiling or 33 ms look-back interpolation delay.
- Nodes are rendered by one custom PixiJS `Mesh`, and all dynamic edges are rendered by one custom `Mesh`. Vertex shaders sample the shared position texture and expand node quads and line segments on the GPU, eliminating per-edge JavaScript length/rotation updates.
- Text remains a bounded, reusable layer of at most 250 labels. CPU position synchronization and spatial-index updates are deferred until labels, hit testing, topology changes, or position checkpoints actually need them.
- The force simulation now cools to a true idle state. The continuous display loop stops after physics and camera motion settle, and resumes for drag, zoom, topology changes, retry, or visibility restoration.
- Runtimes without SharedArrayBuffer or vertex texture support retain the 0.8.42 transferable-buffer and persistent-sprite compatibility path.

## 0.8.42: Low-latency relationship graph frame pipeline

- Node dragging now updates the visible node immediately under the pointer, then hands the position back to the Worker smoothly instead of waiting for a physics frame.
- Pointer-centered wheel zoom uses a damped display camera, so zoom and panning remain responsive while the force simulation continues independently.
- PixiJS keeps persistent sprite batches for nodes and edges. Position and camera frames update existing GPU objects instead of clearing and rebuilding all graph geometry.
- The complete point/line topology stays GPU-resident, so a long pan cannot reveal a blank strip or force a full geometry rebuild when the pointer is released.
- Moving-node hit testing updates only nodes that cross spatial cells, and long edges are indexed by the cells their segment traverses instead of every cell in a bounding rectangle.
- The Worker sends node IDs only when topology changes and streams positions through two reusable transferable buffers at 30 Hz while active and 20 Hz while ambient; the browser interpolates these samples at display refresh rate.
- Full, position-only, camera-only, and bounded label-only render paths prevent typing, AI streaming, dragging, panning, and zooming from triggering unrelated graph rebuilds. Pan/zoom completion updates at most 250 visible labels without touching topology or hit-test indexes.
- Coalesced display work keeps every dirty channel: a Worker position sample cannot discard a pending label refresh, and the bounded label frame runs before the retained position frame.
- Minimizing the graph or hiding Obsidian cancels pending display frames as well as pausing the Worker; restoring it starts with one fresh full frame.
- A 500-update AI streaming regression proves that content deltas do not reconcile the Worker or submit new Pixi graph frames.
- Existing graph behavior remains intact: Obsidian-style hover focus, right-click node/edge deposit controls, conversation navigation, note opening, labels, and saved layout state.

## 0.8.41: Relationship graph interaction performance

- Worker frames use a compact numeric position buffer and reuse the parsed position map, avoiding a full object graph clone at 60Hz.
- Content-only conversation updates keep the existing topology, positions, force simulation, and render topology cache; typing and AI streaming no longer reheat or rebuild the graph.
- Node and edge hit testing use spatial grids. Pointer movement checks nodes only; edge checks are reserved for context-menu actions.
- Off-viewport edges are culled before Pixi drawing, and large-graph regression coverage exercises 5,000 nodes and 10,000 edges.

## 0.8.40：原生图谱动态与可逆沉淀过滤

- 关系图谱的 Worker 以低强度环境目标持续运行，节点不会在初始动画结束后突然僵硬；主线程将 Worker、缩放、平移、悬停和窗口尺寸更新合并到浏览器帧，减少输入与缩放卡顿。
- 力导布局采用 Obsidian Graph View 的中心力、排斥力、连接力和连接距离模型，并根据实际视口更新中心；新节点从邻居附近加入，节点尺寸在 8–30px 范围内缓慢收敛，避免突变和抖动。
- 颜色优先读取 Obsidian 的 `--graph-node`、`--graph-line`、`--graph-text` 与 `--graph-node-focused`。当前对话节点不再自动高亮；只有鼠标悬停节点及其直接连线高亮，其他无关元素变暗，直接相邻节点保持原亮度。
- 右键节点或连线可切换沉淀状态。变暗节点仍留在图谱中但不会进入树沉淀；变暗连线不会生成对应的父子、来源或关联知识链接；再次右键可恢复。父节点变暗时仍会级联其子节点。
- `deposit-graph:v1` 持久化协议保持兼容，现有节点位置、状态和连线覆盖无需迁移。

## 0.8.39：关系图谱会话切换与空白恢复

- 修复切换对话空间或关闭后重新打开图谱时，窗口保留旧会话生命周期状态，导致画布没有节点、空间索引为空、拖动和缩放失效的问题。
- 会话替换现在先保存并销毁旧会话，再安装新会话的快照、位置、Pixi 视图和 Worker；旧 Worker 的迟到帧不会覆盖当前会话。
- 首帧不再依赖 Worker 的第一帧：缺少历史位置的节点会使用稳定、可见的初始坐标立即绘制，Worker 随后继续进行动态力导布局。
- 新增会话切换、关闭重开、初始坐标和节点拖动回归测试。

## 0.8.38：关系图谱 PixiJS + Worker 全量重做

- 删除旧关系图谱的窗口、DOM/SVG 输入层、渲染器和旧 Worker，改为独立的 `src/relationship-graph` 子系统。
- PixiJS 负责批量绘制点、线和标签；Worker 持续运行 Obsidian 风格的 D3 力导模拟，拓扑变化时重新加热，稳定后自然冷却，不因输入或 AI 流式输出重建图谱。
- 保留 0.8.34 的交互语义：左键对话节点切换当前分支，左键笔记节点在普通 Obsidian Markdown 标签页打开，节点拖动、空白平移、指针中心滚轮缩放、悬停聚焦、右键切换和键盘缩放/复位均由画布直接处理。
- 图谱状态继续兼容 `deposit-graph:v1`，因此升级不会丢失已有节点位置、节点选择或连线覆盖设置；旧实现文件不再参与构建。

## 0.8.37：恢复完整图谱交互与会话隔离

- 在 PixiJS 画布上方加入独立透明交互层，恢复鼠标滚轮中心缩放、空白区域平移、节点悬停、左键打开、节点拖动、右键切换和键盘导航；Pixi 继续只负责高性能绘制。
- 节点拖动不再受对话写入锁影响。即使 AI 正在输出或对话暂时只读，仍可移动节点；超过严格 `5px` 阈值才进入拖动，松开后清除临时固定并让 D3 力导自然重新平衡。
- 图谱位置保存、相机和渲染器生命周期按对话空间严格隔离。切换空间不会把旧坐标写入新对话，也不会发生同步回调导致的新渲染器被错误销毁；返回空间时恢复自己的视角。
- 首次打开或切换到尚未操作过的空间时，根据已有坐标或 Worker 首个完整坐标帧自动适配视口一次；之后尊重用户的缩放和平移。窗口尺寸变化由 `ResizeObserver` 同步，保持视口中心不跳动。
- 保留 Obsidian 风格的 D3 自然冷却和按需重新加热。新节点从已定位的相邻节点附近以确定性小偏移出现，旧节点保留位置和速度；输入文字与 AI 流式输出不重建拓扑、不重新加热，因此不会剧烈抖动。
- 销毁、暂停、错误和指针取消路径会完整结束拖动并释放指针捕获、观察器、动画帧、定时器、Worker、Pixi 对象和文字池，继续满足大图生命周期约束。

## 0.8.36：修复首次打开图谱空白

- 修复 PixiJS 图谱首次打开时只有窗口标题栏、中央画布完全空白的问题：现在会接纳 Worker 为当前图谱节点计算的首批坐标，不再错误要求节点必须已经保存过历史坐标。
- 空坐标与部分历史坐标两种情况都会正确补齐节点并绘制连线；旧布局坐标仍作为 Worker 的初始值使用。
- Worker 坐标进入渲染前会同时校验当前拓扑、修订号和有限数值，过期帧、未知节点、`NaN` 与正负无穷不会污染空间索引、画布或位置存档。
- 保留 0.8.35 的 PixiJS 单画布、Worker 力导、大图裁剪、悬停聚焦、拖动、缩放、键盘导航、右键点暗、对话节点定位和普通 Obsidian 笔记标签页打开行为。

## 0.8.35：PixiJS + Worker 原生图谱重写

- 关系图谱改用 PixiJS/WebGL 单画布渲染，不再为每个节点或连线创建 DOM/SVG 元素；加入视口裁剪、屏幕空间索引、类型化数组和最多 250 个复用文字对象，面向 5,000 节点、10,000 连线的大图。
- 力导计算移入 Worker，并按 Obsidian 原生图谱接近的 D3 模型自然冷却：中心力、排斥力、链接力和碰撞力共同作用，不再使用持续呼吸、硬边界反弹或永久固定节点。
- 优先通过 SharedArrayBuffer 双槽交换位置；不支持时使用严格复用的两个可转移缓冲区。修订号过滤过期帧，连续结构更新合并为最后一次。
- 输入文字与 AI 流式输出等纯内容变化只更新可见内容，不重建图结构、不重新加热力导，从根源上避免当前节点剧烈抖动。
- 节点大小按连接度平滑映射；缩放后标签连续显隐；悬停关系聚焦、无关节点压暗和主题色高亮保持不变。
- 左键单击对话节点会定位 TreeTalk 对话分支；单击笔记节点会在普通 Obsidian Markdown 标签页中打开对应笔记，而不是在 TreeTalk 对话界面中打开。
- 拖动采用超过 5px 的严格阈值，只在拖动期间临时固定；鼠标中心缩放、键盘导航、右键点暗等既有交互继续保留。

## 0.8.34：持续有机力导与流式稳定图谱

- 图谱在可见且存在未固定节点时保持低能量力导计算，不再冷却到完全静止；中心力、排斥力、链接弹簧、碰撞、阻尼和画布边界继续共同约束布局。
- 新加入的节点在按节点 ID 确定的 `8–12` 秒内逐渐获得完整力导影响；稳定阶段以 `132px` 目标链接距离为中心进行不超过 `±1.8%` 的确定性缓慢呼吸，不使用逐帧随机噪声。
- 输入文字、草稿更新和 AI 流式输出只增量更新现有画布，不再销毁节点、清空速度或以高能量重新启动，因此当前节点不会因每个流式增量剧烈抖动。
- 图谱物理以最高 `30Hz` 步进，单帧时间最多按 `32ms` 计算；位置变化达到 `0.25px` 后最多每 `2` 秒保存一次，拖动、切换对话和关闭时立即刷新位置。
- 最小化图谱或页面进入后台时暂停动画，恢复后沿用原有画布、相机、节点坐标和速度；系统启用“减少动态效果”时关闭稳定阶段的呼吸运动。
- 保留悬停关系聚焦、无关节点与连线压暗、右键点暗、鼠标中心缩放、标签阈值、拖动固定、窗口状态和 `deposit-graph:v1` 数据兼容。

## 0.8.33：悬停聚焦与响应式力导图谱

- 悬停节点时，当前节点继续使用 Obsidian 主题色，直接相连的连线同步高亮，直接相邻节点保持原样；其余无关节点和连线整体压暗，以突出当前关系范围。
- 悬停焦点只覆盖一跳直接关系，不会把更远层级节点误判为相关节点；离开节点后立即恢复完整图谱亮度。
- 力导布局改为可重新加热的动态模拟，采用中心力、节点排斥、链接弹簧、目标链接距离、碰撞分离、阻尼和边界约束。
- 图谱首次打开、结构更新和窗口重绘时自动演化到平衡；拖动节点期间保持模拟活跃，让其他未固定节点实时避让并重新组织。
- 拖动结束后逐步冷却并批量保存最终位置，不持续抖动，也不会因保存坐标而重新聚焦或重建画布。

## 0.8.32：关系图谱标签、悬停与力导优化

- 修正节点标签缩放逻辑：缩小图谱时隐藏，放大到 `1.08×` 及以上时显示在节点下方；无论当前缩放级别，悬停节点都会临时显示自己的名称。
- 悬停节点时，仅当前节点及其直接相连的线切换为 Obsidian 主题色并增强可见度；相邻节点保持原样，避免整片图谱同时变色。
- 提高以鼠标为中心的滚轮缩放灵敏度，仍保证缩放前位于指针下方的图谱坐标在缩放后保持在同一位置。
- 未固定节点加入持续的力导模拟：节点之间相互排斥，父子/引用连线提供弹簧拉力，并带有中心约束、阻尼和画布边界。
- 手动拖动后的节点继续固定并保存位置；其他节点会围绕固定节点重新平衡，最终布局批量持久化且不会触发画布反复重建。

## 0.8.31：关系图谱交互与缩放修复

- 节点拖动完成后只持久化该节点坐标，不再重建整个图谱画布；当前平移、缩放和视觉焦点保持不变。
- 图谱相机按对话空间保留在当前窗口会话中，节点亮灭或外部对话更新导致重绘时仍恢复原来的平移与缩放。
- 节点改为统一中心坐标的小圆点，标签独立定位在圆点下方，不再用大宽度按钮参与布局，连线端点与圆点中心完全一致。
- 标签按缩放阈值显示：默认及放大状态隐藏，缩小到 `0.85×` 及以下时显示在节点下方。
- 滚轮缩放改为以鼠标所在位置为中心，缩放前位于指针下方的图谱坐标在缩放后仍停留于该位置。
- 修复节点层覆盖 SVG 导致连线无法右键的问题；透明宽命中线置于可见线之上，右键可稳定切换灰线/亮线，且切换时不重建画布。

## 0.8.30：原生关系图式沉淀图谱

- 沉淀关系图谱改为接近 Obsidian 原生关系图谱的纯点线画布：对话节点和引用笔记均显示为圆点与独立标签，不再使用卡片、胶囊节点或白板式内容检查区域。
- 图谱只控制“沉淀哪些节点笔记”和“哪些笔记之间建立 WikiLink”。右键对话节点切换点亮/变灰，右键关系线切换是否保留对应链接；引用笔记节点始终点亮。
- 取消用户问题、AI 回答、框选原文、附件等内容细分选择。节点点亮时按现有规则完整沉淀该节点，旧 0.8.29 内容选择字段继续兼容读取但不再影响结果。
- 关系图谱入口移入输入框底部操作行左侧，使用图谱图标；不再占用“沉淀对话树”上方操作栏空间。
- 保留父节点排除级联、后代单独恢复、手动连线覆盖、节点拖动固定、画布缩放平移、按对话保存布局，以及非模态窗口的拖动、缩放、最小化、最大化和关闭。

## 0.8.29：可视化沉淀关系图谱

- “沉淀对话树”旁新增“关系图谱”入口，打开全局唯一的非模态悬浮窗口；窗口可拖动、缩放、调整尺寸、最小化、最大化和关闭，点击 Obsidian 其他区域不会消失，也不会阻塞笔记或对话操作。
- 图谱自动跟随当前活动对话空间，显示完整对话树的全部分支，以及本次对话实际使用过的来源笔记和关联笔记；引用笔记不会继续向外展开。
- 右键对话节点可切换点亮/变灰。父节点变灰时后代自动变灰，后代仍可单独重新点亮；断开祖先关系的点亮节点会作为独立根笔记沉淀。
- 父子边和笔记引用边采用“端点自动点亮、手动覆盖优先”。右键连线可决定沉淀后是否保留对应 WikiLink；引用笔记节点始终保留且不可变灰。
- 左键对话节点可分别控制用户问题、AI 回答、框选原文、来源笔记引用、关联笔记引用和附件信息。即使全部内容关闭，点亮节点仍会生成只含标题和启用关系的最小笔记。
- 节点位置、节点亮灭、内容选择和连线覆盖按对话空间保存；窗口位置、大小和最小化/最大化状态全局保存。旧对话升级后默认全部保留。
- 启用的笔记引用会建立双向 WikiLink：来源笔记新增指向沉淀节点的链接，沉淀节点底部新增“来源”区块；关闭连线不会删除来源笔记原本已有的链接。

## 0.8.28：可控笔记上下文与关联笔记图

- 设置新增“完整笔记上下文”开关。开启时发送当前笔记及关联笔记的完整冻结正文；关闭时完整保留框选原文，并按单篇 Token 上限压缩其他内容。
- “单篇笔记上下文上限”支持“最小限度”、常用 Token 档位、自定义正整数和“完整”；最小限度保留标题、路径、关联关系以及一到两个确定性关键词。
- 新增“关联笔记上下文”与深度控制，只沿原始 Markdown 中的正向内部链接递归；支持任意有限深度和“无限”，不读取反向链接。
- 链接发现先于内容压缩执行。循环、汇合链路和重复文件会合并为去重关联图，每个实际笔记正文最多发送一次，同时保留完整边关系和最短主链路。
- 关联图和节点内容在发送前冻结并先持久化；历史请求不会因源笔记后来修改或设置变化而重写。完整正文超过模型总预算时按节点整篇省略并明确标记，不会暗中截断半篇。
- 完整模式与 `balanced:v3` 使用相同的关联图、框选保护和总预算策略；旧设置升级后仍默认发送完整当前笔记，关联笔记默认关闭。

## 0.8.27：扁平输入区与右侧操作组

- 输入面板进一步扁平化：移除卡片阴影和聚焦光晕，圆角收紧为 8px，仅通过主题边框与低透明度背景表达状态。
- 联网与发送/停止按钮进入同一个固定右侧操作组，在普通模式、子分支模式、窄侧栏及生成状态下保持顺序和位置一致。
- 联网与发送按钮统一为 28px 点击尺寸和 6px 圆角；空输入禁用、联网启用及停止状态继续使用 Obsidian 主题变量。
- 子分支标识取消胶囊底色，引用条同步收紧圆角并去除立体感，保留来源、摘要、删除及键盘焦点行为。
- 右键分支、框选引用、发送、停止、联网、草稿、模型请求和上下文逻辑保持不变。

## 0.8.26：紧凑输入工作区

- 输入区升级为紧凑的柔和浮层卡片，使用 Obsidian 主题边框、圆角、阴影和聚焦反馈，兼容深色、浅色及自定义强调色主题。
- 引用内容改为浅强调色圆角卡片，来源与正文层级更清楚；删除按钮保持轻量外观并扩大实际点击区域。
- 联网、发送与停止按钮统一为 Obsidian 原生图标和紧凑圆角尺寸，补充一致的悬停、键盘聚焦、启用及禁用状态。
- 子分支模式新增紧凑状态标识和轻微强调色背景；输入为空时发送按钮自动弱化并禁用，输入有效内容后即时恢复。
- 发送、停止、联网、草稿、框选引用、右键切换分支、模型请求和上下文逻辑保持不变。

## 0.8.25：右键范围与框选亮度优化

- 右键切换分支不再依赖输入框焦点；在活动 TreeTalk 对话视图的输入区域或消息区空白处均可切换“继续当前节点 / 创建子分支”。
- 普通消息正文右键也可切换分支；按钮、链接、选择芯片以及已有文本选区继续使用原生右键菜单，避免复制、导航或操作控件时误触。
- 框选留痕明显加深，并继续使用 Obsidian `interactive-accent` 主题变量；普通文字、行内公式、块级公式和 LaTeX 源预览在深色、浅色及自定义主题下保持一致。

## 0.8.24：右键分支交互与框选留痕优化

- 移除 `Alt + F` 分支快捷键；在 TreeTalk 输入区域单击鼠标右键即可切换“继续当前节点 / 创建子分支”，发送和联网按钮仍保留原有右键行为。
- 新增 Obsidian 原生命令“TreeTalk：创建或关闭当前分支”，可从命令面板调用，也可在 Obsidian 快捷键设置中自行绑定按键。
- 框选 TreeTalk 问题或回答仍会自动进入子分支模式；删除最后一个 TreeTalk 框选后，会恢复首次框选前的提问模式。用户中途手动切换分支时，以手动状态为准。
- 框选留痕改为跟随 Obsidian 强调色的浅紫色半透明底色，去除较重的下划线和阴影；浅色、深色及自定义主题下都会继承主题色。
- 块级公式只高亮实际公式区域，不再给整条可滚动容器铺色；公式原始 LaTeX 在框选期间也使用更轻的浅紫色标识。

## 0.8.23：特殊 Markdown 块链接与节点列表命名

- 框选列表、引用、表格、围栏代码块、块级公式中的文本后沉淀对话树，节点链接会写在整个结构块之后，不再插入块语法内部。
- 行内代码和行内公式中的框选链接会写在包含它们的完整段落之后，避免破坏反引号或公式定界符。
- 同一结构块中关联多个子节点时，会在块后合并为一行普通 `[[WikiLink]]`，重复沉淀不会重复插入已有链接。
- 上述行为同时适用于 TreeTalk 节点正文和作为框选来源的 Obsidian 笔记。
- 沉淀对话树生成的索引笔记固定命名为 `节点列表.md`，正文一级标题固定为“节点列表”；导出文件夹仍使用时间和对话名称区分。

## 0.8.22：纯 Markdown 知识沉淀

- “沉淀回答”只写入标题和回答正文，不再写入 TreeTalk YAML、来源 ID 或快照标记。
- “沉淀对话树”只生成一篇目录笔记和每个节点对应的普通 Markdown 笔记，不再生成隐藏 `.treetalk-archive.md`。
- 沉淀笔记不再支持回到 TreeTalk、只读查看、恢复对话或修复档案；TreeTalk 私有历史对话恢复保持不变。
- 框选追问的链接留痕继续保留：导出的节点正文和来源 Obsidian 笔记都会在可可靠定位的选区后插入普通 `[[WikiLink]]`。
- 来源笔记不会新增 `treetalk_note_id`，链接失败时直接跳过，不保存隐藏维护状态。
- TreeTalk 摘录中的“返回 TreeTalk 来源”只查找当前活动对话和私有历史对话。

## 0.8.21：回溯索引提要与简化笔记命名

- 新节点提要升级为 `node-summary:v3`，优先生成适合树状列表回溯的短索引：中文目标 4～10 个汉字，必要时最多 12 个字符；英文目标 2～6 个单词。
- 提要强调“核心对象＋关键关系”，保持简短、直观并能区分相邻节点；父节点只用于理解语境，不再机械拼接到标题中。
- 新保存的知识库笔记文件名和正文一级标题只使用当前节点最终名称，不再采用“子节点提要 - 父节点提要”。
- 同名笔记继续只给实际文件名追加数字，节点名称与正文标题不追加数字。
- 旧节点提要和旧知识库笔记不会批量重写；自动提要生命周期、人工名称优先、根标签同步、`balanced:v3` 冻结裁剪、缓存和 Token 统计保持不变。

## 0.8.20：节点提要显示修复

- 修复 DeepSeek V4 节点提要请求默认进入思考模式、在极小输出预算内无法返回最终标题的问题；提要请求现在明确关闭思考模式，并将输出上限调整为 64 Token。
- 提要成功后仍通过同一节点数据字段同步刷新树状列表；根节点同时更新对话标签页和历史对话名称。
- `node-summary:v2` 会对 0.8.19 中已经失败或停留在 pending 的节点进行一次自动修复，启动后按树顺序逐个更新，不重复修复成功节点。
- 自动修复只处理带有 0.8.19 名称元数据的节点，不批量改名更早的旧节点；未配置 API Key 时不会消耗修复机会。
- 主回答、完整模式、`balanced:v3` 冻结裁剪、缓存和知识库命名规则保持不变。

## 0.8.19：AI 节点提要与统一笔记命名

- 新节点第一次成功获得 AI 回复后，会复用当前服务商和模型进行一次轻量提要请求，并把结果永久作为节点名称；请求失败时保留原问题名称且不自动重试。
- 提要请求仅发送父节点名称、框选原文、当前问题和回答节选，强制关闭联网、使用非流式请求并限制最多 32 个输出 Token；不会进入主对话上下文、缓存或主回答 Token 统计。
- 根节点提要会同步更新对话标签页和历史对话名称；子节点只更新树状节点。提要只生成一次，继续追问或重新生成回答不会改名，人工名称始终优先。
- 新保存的知识库笔记统一使用节点最终名称。子节点的文件名与正文标题采用“节点提要 - 父节点提要”，同名时仅给实际文件名追加数字。
- 旧节点和旧知识库文件不会批量改名；完整模式请求与 `balanced:v3` 冻结裁剪、缓存前缀保持不变。

## 0.8.18：平衡模式冻结裁剪 v3

- 平衡模式只完整保留当前问题之前最近一个已完成问答轮次；更早的用户问题保持原文，更早的 AI 回复按长度删除约 40%～60%。
- 笔记背景优先于旧 AI 回复，按长度删除约 40%～50%；完整 AI 回复和完整笔记快照仍保存在本地，不会被裁剪数据覆盖。
- 标准裁剪结果会作为 `balanced:v3` 不可变工件永久保存，重启或继续对话后复用相同文本，避免旧上下文反复变化破坏缓存前缀。
- 标准冻结仍超出 30,000 Token 时，按最早旧 AI 回复、后续旧 AI 回复、最早笔记、后续笔记的顺序生成仅在当前分支后代继承的紧凑版本。
- 后续框选到已裁掉的 AI 回复或笔记内容时，从本地完整原文创建恢复引用补丁，不改写旧冻结内容；历史 AI 回复框选会从来源节点建立新分支。
- 平衡模式缓存路由键升级为 `balanced:v3`；完整模式、联网模式和永久引用笔记名称保持原有行为。

## 0.8.17：永久记录引用笔记名称

- 每个完成的 AI 回答会永久保存生成该回答时实际进入上下文的笔记文件名。
- 原有 Token 详情新增“引用笔记”一行，多篇笔记按首次进入当前分支的顺序显示，同一份未修改快照只显示一次。
- 没有笔记上下文时固定显示“引用笔记：无”；重新加载 Obsidian 后仍可查看该记录。
- 只保存文件名，不保存或展示路径、单篇 Token、裁剪状态，也不改变 0.8.16 的笔记快照、裁剪与继承逻辑。

## 0.8.16：笔记全文快照上下文

- 在 Obsidian 笔记中框选追问时，TreeTalk 会把去除 YAML 属性区后的整篇笔记正文保存为不可变快照，并把框选原文作为本轮重点。
- 沿当前对话分支继续追问时会继承这份快照；兄弟分支不会携带，后来修改原笔记也不会改变旧对话的上下文。
- 同一路径、同一内容指纹的笔记快照在模型请求中只发送一次，多次框选仍分别保留重点。
- 当总上下文接近预算时，只裁剪距离框选位置较远的笔记正文，优先保留框选所在标题章节及相邻章节，并插入明确的省略标记。框选原文、用户问题和对话历史不会因此被裁剪。
- 回答下方的临时 Token 详情会显示笔记上下文是“完整”还是“已裁剪”，以及笔记原始估算与实际发送 Token；这些统计重启后清空。

## 0.8.15：DeepSeek 非联网会话稳定性修复

- 修复官方 DeepSeek 在关闭联网模式时仍可能显示“回复失败”的问题。
- 官方 DeepSeek 现在始终使用同一套已验证可用的 Anthropic 兼容消息接口；联网开关只负责添加或移除网页搜索工具，不再切换整套接口协议。
- 关闭联网模式后，请求中不会包含 `tools` 或 `tool_choice`，因此模型无法调用网页搜索，但普通对话、完整模式协议和 Token 临时统计继续生效。
- 用户填写的第三方 OpenAI 兼容代理地址仍保持原来的 `chat/completions` 请求方式，避免破坏已有中转配置。

## 0.8.14：完整模式规范化协议

- 完整模式始终使用稳定的 `TreeTalk Full Context Protocol v1` 系统前缀，减少无意义复述，明确区分事实、推断和建议，并在信息不足时主动说明缺失内容。
- 完整模式和平衡模式现在统一由上下文编译器生成请求；完整模式仍逐字保留当前活动分支，不压缩、不总结、不删除历史内容，也不发送兄弟分支。
- 框选引用采用固定边界和固定顺序，引用原文、代码、公式、空格和当前问题保持原样。
- 完整模式增加版本化缓存路由键 `full:v1`；DeepSeek 等依赖前缀缓存的服务商继续使用确定性的消息顺序。
- Obsidian Markdown 开关只控制附加格式规则，关闭后仍保留基础回答规范。Token、联网状态、消息 ID 和运行状态不会进入模型上下文。

## 0.8.13：联网关闭后普通会话修复

- 修复 DeepSeek 开启联网模式后再关闭时，普通会话可能请求到错误地址并显示“回复失败”的问题。
- DeepSeek 现在会把用户填写的官方 Anthropic 地址或完整接口地址统一还原为 API 根地址，再根据当前联网状态选择 `/anthropic/v1/messages` 或 `/chat/completions`。
- 联网开关关闭后，下一轮立即恢复普通 DeepSeek Chat Completions 请求，不需要重启插件或手动修改 API 地址。

## 0.8.12：回复内状态显示

- “正在思考”“正在判断是否需要联网”“正在搜索网页”“正在整理搜索结果”等过程状态现在显示在对应的 AI 回复位置。
- 状态按消息 ID 隔离，多标签页后台生成时不会串到当前对话。
- AI 正文开始输出后过程状态立即消失；完成、停止、失败或关闭视图后也不会残留。
- 状态只保存在运行内存中，不写入对话历史、节点笔记或沉淀档案。

## 0.8.11：DeepSeek 联网与完整模式 Token 统计

- 设置页新增“联网模式”，输入框旁新增地球按钮；两处共享同一个持久状态，切换后影响所有标签页的后续对话。
- 当前仅 DeepSeek 支持联网。开启后改用 DeepSeek 官方 Anthropic 兼容接口，由模型自动判断是否调用网页搜索；搜索过程显示状态，回答末尾附加可提取到的参考来源。
- 非 DeepSeek 服务下联网按钮自动置灰，原有 OpenAI、Anthropic、Gemini 和 OpenAI 兼容接口请求行为不变。
- 旧 DeepSeek 模型名 `deepseek-chat`、`deepseek-reasoner` 会迁移为 `deepseek-v4-flash`。
- 完整模式现在也在回答下方显示本轮输入、输出、合计、缓存和上下文估算 Token；统计仅保存在当前运行内存中，重新加载插件后清空。

## 0.8.10：用户气泡选择器修复

- 根据实际 Markdown 渲染 DOM 修复单段用户消息的上下外边距，确保紧凑气泡样式稳定生效。


## 0.8.9：用户气泡高度修复

- 覆盖 Obsidian Markdown 渲染器和主题为单段文字附加的上下外边距。
- 单行“我”消息改为更紧凑的胶囊高度，长文本仍按原宽度正常换行。

## 0.8.8：模式入口与消息气泡优化

- 设置中只保留一个“平衡模式”开关：开启使用平衡模式，关闭使用完整模式。
- 模式说明只描述用户可感知的效果，不再展示内部裁剪与缓存实现细节。
- “我”的消息气泡缩小内边距、圆角与行高，更贴合实际文字尺寸。

## 0.8.7：平衡模式结构化压缩

- 模式切换与完整模式保持 0.8.6 原有行为。
- 平衡模式始终原样保留当前轮、最近两个完整问答轮次和所有用户消息。
- 第三个及更早的完整轮次中，旧 AI 回答会立即按 Obsidian Markdown 结构进行确定性压缩。
- 精确框选过的字符、所在 Markdown 块和标题链会被反向定位并保护；无法唯一定位时保留整条源回答。
- 标题、列表、Callout、表格、代码围栏和块级公式保持合法结构，硬预算只进一步压缩久远且未受保护的回答。
- 平衡模式缓存路由版本更新为 `balanced:v2`，避免与旧压缩结果混用。

## 0.8.6：缓存感知型树状上下文优化

- 设置中新增“树状上下文优化（实验）”，默认关闭；模式只能在设置中统一选择，不在输入框、树节点或消息工具栏增加切换入口。
- 平衡模式只编译当前根到当前节点的活动分支，排除兄弟分支；根据本轮输入预算动态完整保留最近 2～6 轮（默认尽量保留 4 轮），并在安全 Markdown 块边界裁剪较早的 AI 回答。
- 较早且未被继续引用的超长代码会保留围栏、语言、导入／依赖、函数或类型签名、首尾区域，并插入明确的 TreeTalk 省略标记；原始对话内容不会被改写。
- 完整模式发送当前分支的全部原始历史，不进行 TreeTalk 裁剪，也不发送兄弟分支。
- OpenAI 专用适配器会请求流式 usage，并在平衡模式使用稳定的缓存路由键；DeepSeek 专用适配器使用官方 Chat Completions 地址和前缀缓存统计；自定义 OpenAI 兼容接口不会假设供应商支持专有缓存参数。
- API 返回可靠 usage 后，只有减少输入至少 256 Token、减少比例至少 5%，或缓存命中大于 0 时，才在对应回答底部显示默认折叠的临时统计。统计只显示 Token 数字，关闭或重新加载 TreeTalk 后消失，不写入对话树、节点笔记或沉淀档案。

## 0.8.4：Obsidian Markdown 兼容模式

- 设置中新增单一开关“Obsidian Markdown 兼容模式”，默认开启。
- 开启后，TreeTalk 会在模型请求内部追加不可见的 Obsidian Markdown 格式约束；该内容不会出现在输入框、消息、历史或沉淀笔记中。
- 流式回复会把已闭合的稳定 Markdown 交给 Obsidian 原生渲染器，未闭合的公式、代码围栏、HTML 块或表格尾部暂时按源码显示；语法闭合后自动切换为渲染结果。
- 回复完成后执行保守规范化：转换 `\(...\)` / `\[...\]`、补齐明确未闭合的公式或代码围栏、补充明显缺失的表格分隔行，并避免修改代码块内部内容。
- 最终只保存规范化后的消息内容，框选、高亮、历史、节点笔记与对话树档案均以该内容为准。
- 关闭兼容模式后，隐藏格式约束、流式语法保护和最终规范化会一并关闭。

TreeTalk 是一个以 Obsidian 为载体的树状 AI 对话插件。一次对话是一个独立空间，可以继续当前节点，也可以从任意节点创建分支，并把有价值的回答、选段和完整对话树沉淀到笔记中。
