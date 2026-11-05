# comms-graph conventions

## Test hygiene — never write into live history

Tests that call `processMessage` MUST set `COMMS_NO_HISTORY=1` (and
`COMMS_NO_LISTEN=1`) before requiring server.cjs. The flag makes tests
hermetic on conversation history: it gates BOTH `_logConversationTurn`
(`message.add` writes — stub replies render as real assistant turns in the
user's feed; observed: raw RULE_JSON echoes looked like the app authoring
rules it never committed) AND `_fetchConversationHistory` (`session.route` +
`message.list` reads — live history bleed makes verdict-call counts
environment-dependent; observed: offer-echo fired on the user's real history
mid-test). In-memory `_addTurn`/`_formatContext` stays usable for seeded
context.

## RouteDecision envelope — ONE task classification per turn

`src/route-decision.cjs` (`classifyRoute`) runs stategraph's `classifyTask`
ONCE at ingress, in parallel with `classify()`. The envelope `{taskType,
suggestedIntent, targetService, isFollowUp, planShape, …, lane}` is the
authoritative "what is this prompt" — downstream layers consume it, they do
not re-derive intent:

- **Executor lanes are vetoed by it.** intent 7 (screen) / 8 (web_search) are
  executors with context-free surfaces — a regex pin alone cannot put a
  task-shaped, follow-up, service-named, or clarification-needed prompt on
  them (observed: "search for it" → public SERP for a local-filesystem
  question).
- **The handoff carries it** via `routeDecision` → `state._taskClassification`
  — `parseIntentV2`, `gatherPlanContext`, `resolveReferencesV2` consume the
  seeded verdict. `planShape: 'single'` suppresses `no_skill_coverage`
  escalation: a single local deliverable runs the bounded planner instead of
  a named-plan grill.
- **Lexical layers are hints only.** `intentGuesser`, `classifier-fallback`,
  and guard regexes PROPOSE — a lane override on lexical evidence alone needs
  either the envelope's structural answer or a `confirmJudgment` verdict
  (sites: `keyword-veto`, `offer-echo`, `selection-veto`, `pin-escape`,
  `plan-referent`). Never add another independent intent classifier.
- **Ambiguity favors the low-blast-radius lane.** When "produce text" vs
  "act on a service" is undecidable (e.g. highlight + "reply to this"), pick
  drafting — `generalQuick`'s 0-sentinel self-corrects to handoff; a wrong
  browser takeover cannot be undone (observed: LinkedIn tab driven+closed).
- **Loop-back settle contract.** A `needs_plan`/`plan_update` task is
  pseudo-terminal — `taskJournal.settleEscalation(id, status)` moves it to a
  real terminal status when the replan resolves (run/fallback/fail/cancel);
  `/plan.replanning.end` + task-scoped `plan_replanning_end` progress clear
  the card. `updateTask` correctly refuses these statuses — only the
  loop-back may settle them.

## Turn facts — never re-derive, never match raw text

`shared/turn-facts.cjs` (`computeTurnFacts`) is the single derivation of "what
is this turn" — same pattern as stategraph's `taskFacts`
(`stategraph-module/src/nodes/preflightAgents.js`).

- Context blobs `[File:]` `[Folder:]` `[Context:]` `[Thought:]`
  `[Highlighted:]` ride INSIDE the prompt. Any matcher that runs on raw prompt
  text can fire on quoted/attached content (observed bugs: a highlighted "My
  current plan…" rerouted a vocab question to status_check; an inline exit
  phrase inside a selection printed "Planning mode isn't on right now.").
- Routing/control decisions read `facts.userText` or a computed verdict
  (`exitish`, `cancelish`, `confirmish`, `runish`, `planRef`, `logMention`,
  `isQuestion`) — NEVER `rawText` / `englishText` directly.
- `rawText` + `attachments` are for answering nodes that need the content.

## Deterministic vs semantic

- Regexes / turn-facts generate candidates and fire **anchored** control
  phrases on `userText` only.
- Any lexical match that **overrides** a lane, agent pick, or mode exit needs
  a semantic verdict: `decision.confirmJudgment({ site, question, state })`
  in `src/decision.cjs` — the single helper for YES/NO judgments. Returns
  `'YES' | 'NO' | null` (model down — the caller picks the fallback).
- Raw `askDecision` stays for multi-option picks / batches (classify intent,
  capability select, spec-completeness, memory attributes).
- `findPlans` fuzzes on any token overlap — reroute/probe callers require
  `score >= 6`.
- Guardian rules: `when` is deterministic; `semanticMatch`/`semanticExempt`
  are the frame/anti-frame exception — `whenMatches` returns false on them
  and callers run `evaluateAsync(ctx, seam, judge)` where the injected judge
  (phi4 decision.answer, two-question frame/exempt batch) decides. Det fields
  AND first as prefilters; monitorService adds the screenshot as `ctx.image`
  (d3:2b) — same module, four seams, model-free by construction.

## requestText — judgments read the ask, matchers read the turn

`facts.requestText` (turn-facts.cjs, `deriveRequestText`) is the segment of
`userText` carrying the user's actual request — the trailing ask in a
paste+question turn, or the whole text when it's short/single-sentence.

- Matchers/candidates still run on full `userText` (a pasted "if I go to…"
  SHOULD generate a rule candidate; a pasted "commit messages" SHOULD
  generate a tool candidate).
- Verdicts about intent read the ASK: `confirmJudgment` state must be
  `requestText` — or `_focusState(facts, evidenceRe)` when the matched
  evidence sentence should stay in view — never whole `userText` /
  `englishText`. Whole-text state on a paste+question turn judges the pasted
  material as intent (observed: pasted audit containing "AGENTS.md rule" +
  "what does envelope mean" → rule-author verdict YES → guardian dead end).
- Deterministic token checks that gate a lane (`logMention`, plan-ref entry)
  likewise require the token inside `requestText`.
- Content judgments are exempt — "does required info exist anywhere" sees
  the full turn (spec-completeness: a pasted address legitimately supplies a
  missing recipient).

### History turns

The same boundary applies to PAST turns. History rows persist each user
turn's ask: `metadata.requestText` on conversation-service messages (written
by `_logConversationTurn`), `requestText` on in-memory turns (`_addTurn`).

- Any consumer that feeds history to a judgment — classifyTask, clarify
  question-gen, referent resolution, web-search target derivation — reads
  `msg.requestText ?? msg.content` for user turns. Assistant turns render
  verbatim; raw `content` stays available to answer-generation nodes.
- `_historyEntry` (stategraph resolveReferencesV2) normalizes the field;
  `deriveRequestText` covers legacy rows logged before the field existed.
- Observed: a clarify asked "the YouTube notification rule, or just the
  emoji?" because history carried a pasted rule unscoped — the judgment saw
  the paste, not the ask.
