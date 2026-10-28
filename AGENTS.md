# comms-graph conventions

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
