'use strict';
/**
 * memory-store-veto.test.cjs — RouteDecision envelope arbitrates the
 * memory_store lane pick.
 *
 * Observed (2026-11-05): previous turn drafted a template; the follow-up
 *   "don't add claude or cursor I used Devin, Warp, DuckDB, Electron, etc."
 * was classified intent=5 by the remote leg while route-decision reported
 * taskType=query lane=handoff. Intent 5 was the ONLY lane with no envelope
 * arbitration (intentGuesser had no match → _vetoQuickGated skipped) → the
 * revision directive was stored verbatim → "Got it — I'll remember that."
 * and the draft was never revised.
 *
 * Fix (server.cjs): an intent-5 pick needs corroboration — the anchored
 * store-directive guesser ("remember that…", "note: …") or an envelope
 * naming the memory family (suggestedIntent memory_store|memory_retrieve).
 * Uncorroborated + any positive non-memory signal (isFollowUp,
 * planShape=complex, targetService, needsClarification, explicit non-memory
 * suggestedIntent) → demoted to the envelope's lane. Bare statements with
 * an ambiguous envelope fail open. taskType is deliberately NOT a signal —
 * stored content legitimately looks like a task ("standup at 9:15" →
 * scheduling). Live repro 2: "add the ship date October 12" → remote
 * picked 5, envelope said planShape=complex → stored verbatim, draft
 * untouched.
 *
 * Mocks: llm-providers.ask serves BOTH remote legs — classify's
 * (maxTokens≤8 → bare intent digit) and classifyTask's (taskType JSON).
 * decision.askDecision/confirmJudgment stay null → gates inert.
 * MEMORY_SERVICE_PORT points at a dead port so a kept pick never writes
 * into the live memory service (hermetic per AGENTS.md).
 *
 * Run: node comms-graph/test/memory-store-veto.test.cjs
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'td-memveto-'));
process.env.COMMS_NO_LISTEN = '1';
process.env.COMMS_NO_HISTORY = '1';
process.env.TASK_JOURNAL_PATH = path.join(TMP, 'journal.json');
process.env.THINKDROP_RULES_PATH = path.join(TMP, 'rules.json');
process.env.THINKDROP_PLANS_DIR = path.join(TMP, 'plans');
process.env.MEMORY_SERVICE_PORT = '39997'; // dead — a kept pick fails honestly, never writes live memory
process.env.THINKDROP_MAIN_PORT = '39998'; // dead — handoff posts can't reach a live main
fs.mkdirSync(process.env.THINKDROP_PLANS_DIR, { recursive: true });

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  PASS: ${name}`); }
  else { failed++; console.error(`  FAIL: ${name}${extra ? ' — ' + extra : ''}`); }
}

(async () => {
  console.log('\nmemory-store-veto tests');

  const llmProviders = require('../src/llm-providers.cjs');
  const decision = require('../src/decision.cjs');
  const realAsk = llmProviders.ask;
  const realAskDecision = decision.askDecision;
  const realConfirm = decision.confirmJudgment;
  decision.askDecision = async () => null;
  decision.confirmJudgment = async () => null;

  // Envelope the test wants classifyTask to return; swapped per case.
  let envelope = { taskType: 'query', suggestedIntent: null, isFollowUp: true, followUpTarget: 'the draft' };

  llmProviders.ask = async (messages, opts = {}) => {
    // classifyTask (route-decision leg): returns the taskType JSON envelope.
    if ((opts.maxTokens || 0) > 8) return { text: JSON.stringify(envelope), provider: 'stub' };
    // classify force-prompt leg: remote always picks memory_store — the pick
    // under arbitration.
    return { text: '5', provider: 'stub' };
  };

  const { processMessage } = require('../src/server.cjs');

  // ── 1. The logged repro: revision directive + handoff envelope → demoted ──
  const r1 = await processMessage({
    text: "don't add claude or cursor I used Devin, Warp, DuckDB, Electron, etc.",
  });
  check('revision directive + handoff envelope → NOT memory_store',
    r1.intent !== 5 && r1.intentName !== 'memory_store',
    `got intent=${r1.intent} ${r1.intentName}`);
  // No targetService in the envelope → revision directives demote to
  // general_quick (the in-conversation artifact revision lane), not handoff.
  check('revision directive demotes to general_quick lane',
    r1.intentName === 'general_quick' || r1.intent === 1,
    `got intent=${r1.intent} ${r1.intentName}`);
  check('revision directive did NOT produce the memory ack',
    !/remember that/i.test(r1.text || '') && !/remember that/i.test(r1.fullText || ''),
    `text=${(r1.text || '').slice(0, 80)}`);

  // ── 2. Control: envelope AGREES it is a memory op → lane kept ─────────────
  envelope = { taskType: 'query', suggestedIntent: 'memory_store', isFollowUp: false };
  const r2 = await processMessage({ text: 'remember that my favorite editor theme is solarized dark' });
  check('envelope memory_store keeps the lane (pick stays 5)',
    r2.intent === 5 && r2.intentName === 'memory_store',
    `got intent=${r2.intent} ${r2.intentName}`);

  // ── 3. Envelope down (null) → fail-open, pick kept ────────────────────────
  // A null text makes classifyTask resolve _routeDecision to null — the same
  // shape as a dead model, which is the fail-open contract.
  llmProviders.ask = async (messages, opts = {}) => {
    if ((opts.maxTokens || 0) > 8) return { text: null, provider: 'stub' };
    return { text: '5', provider: 'stub' };
  };
  const r3 = await processMessage({ text: 'note: buy milk tomorrow morning' });
  check('envelope unavailable → fail-open keeps memory_store',
    r3.intent === 5 && r3.intentName === 'memory_store',
    `got intent=${r3.intent} ${r3.intentName}`);

  // ── 4. Action-shaped memory content → pick kept ───────────────────────────
  // Live repro (2026-11-05 e2e): "remember that my daily standup meeting is
  // at 9:15am" typed taskType=scheduling (surface misread — the remembered
  // fact looks like an event). Demoting ran an automation and the fact was
  // never stored. taskType alone must not veto.
  envelope = { taskType: 'scheduling', suggestedIntent: null, isFollowUp: false };
  llmProviders.ask = async (messages, opts = {}) => {
    if ((opts.maxTokens || 0) > 8) return { text: JSON.stringify(envelope), provider: 'stub' };
    return { text: '5', provider: 'stub' };
  };
  const r4 = await processMessage({ text: 'remember that my daily standup meeting is at 9:15am' });
  check('scheduling-shaped memory content keeps memory_store',
    r4.intent === 5 && r4.intentName === 'memory_store',
    `got intent=${r4.intent} ${r4.intentName}`);

  // ── 5. Action-shaped non-follow-up → pick kept ────────────────────────────
  // A service-shaped prompt that ISN'T a follow-up keeps the memory pick —
  // content-shaped envelope fields can't distinguish "store this fact" from
  // "do this task" on a non-continuation, and a junk store is lower blast
  // radius than a wrong automation run.
  envelope = { taskType: 'local_system', suggestedIntent: 'command_automate', isFollowUp: false };
  const r5 = await processMessage({ text: "remember that my car's license plate is zqk 4417" });
  check('non-follow-up action shape keeps memory_store',
    r5.intent === 5 && r5.intentName === 'memory_store',
    `got intent=${r5.intent} ${r5.intentName}`);

  // ── 6. Follow-up BUT envelope says memory → pick kept ─────────────────────
  // "also remember that X" is both a continuation AND a real memory op —
  // the envelope's explicit memory call wins over isFollowUp.
  envelope = { taskType: 'query', suggestedIntent: 'memory_store', isFollowUp: true };
  const r6 = await processMessage({ text: 'also remember that the deploy window is friday 2am' });
  check('isFollowUp + envelope memory_store keeps the lane',
    r6.intent === 5 && r6.intentName === 'memory_store',
    `got intent=${r6.intent} ${r6.intentName}`);

  // ── 7. Ambiguous degraded envelope, no signals → pick kept ────────────────
  envelope = { taskType: 'ambiguous', suggestedIntent: null, isFollowUp: false };
  const r7 = await processMessage({ text: 'note: buy milk tomorrow morning' });
  check('ambiguous envelope without signals keeps memory_store',
    r7.intent === 5 && r7.intentName === 'memory_store',
    `got intent=${r7.intent} ${r7.intentName}`);

  // ── 8. Unanchored revision + planShape=complex → demoted ─────────────────
  // Live repro (2026-11-05 e2e): "add the ship date October 12" after a
  // draft turn — remote picked 5, envelope reported planShape=complex. No
  // store anchor + complex plan structure = a bare edit directive stored
  // verbatim; the draft was never revised. planShape derives from the
  // envelope's flags — isRecurring exercises the derivation itself.
  envelope = { taskType: 'ambiguous', suggestedIntent: null, isFollowUp: false, isRecurring: true };
  const r8 = await processMessage({ text: 'add the ship date October 12' });
  check('unanchored directive + complex planShape → NOT memory_store',
    r8.intent !== 5 && r8.intentName !== 'memory_store',
    `got intent=${r8.intent} ${r8.intentName}`);
  check('unanchored directive + complex planShape → general_quick lane',
    r8.intentName === 'general_quick' || r8.intent === 1,
    `got intent=${r8.intent} ${r8.intentName}`);

  // ── 8b. Imperative with a named service → envelope lane kept ────────────
  // "add the meeting to my calendar" is a real service imperative — the
  // envelope's targetService overrides the general_quick demotion.
  envelope = { taskType: 'scheduling', suggestedIntent: null, isFollowUp: false, targetService: 'calendar' };
  const r8b = await processMessage({ text: 'add the team sync to my calendar friday at 3pm' });
  check('service-named imperative → NOT memory_store',
    r8b.intent !== 5 && r8b.intentName !== 'memory_store',
    `got intent=${r8b.intent} ${r8b.intentName}`);
  check('service-named imperative keeps envelope lane (handoff)',
    r8b.intentName === 'handoff' || r8b.intent === 0,
    `got intent=${r8b.intent} ${r8b.intentName}`);

  // ── 8.5 Retrieval question + memory_retrieve envelope → demoted ──────────
  // Live repro (2026-11-05 e2e): "when is my standup meeting" → remote
  // picked 5, envelope said suggestedIntent=memory_retrieve. Storing a
  // retrieval question verbatim corrupts memory forever ("I'll remember
  // that your standup meeting is when."). memory_retrieve is a RETRIEVAL
  // verdict — it contradicts the store lane, so it counts as a positive
  // non-store signal, not corroboration.
  envelope = { taskType: 'query', suggestedIntent: 'memory_retrieve', isFollowUp: false };
  const r85 = await processMessage({ text: 'when is my standup meeting' });
  check('retrieval question + memory_retrieve envelope → NOT memory_store',
    r85.intent !== 5 && r85.intentName !== 'memory_store',
    `got intent=${r85.intent} ${r85.intentName}`);

  // ── 9. Bare statement store + ambiguous envelope → fail-open kept ─────────
  // "my library card number is 223045" has no anchor but also no positive
  // non-memory signal — the express store lane must stay (a junk store is
  // cheaper to undo than a wrong automation run).
  envelope = { taskType: 'ambiguous', suggestedIntent: null, isFollowUp: false };
  const r9 = await processMessage({ text: 'my library card number is 223045' });
  check('bare statement + ambiguous envelope keeps memory_store',
    r9.intent === 5 && r9.intentName === 'memory_store',
    `got intent=${r9.intent} ${r9.intentName}`);

  // ── 10. Imperative fragment + silent envelope → demoted anyway ──────────
  // Live repro (2026-11-05 e2e run): "don't add claude or cursor…" — remote
  // picked 5 AND the envelope came back with no signals this run → the
  // corroboration veto failed open and stored the directive verbatim. An
  // imperative fragment is never a fact statement — the grammar alone
  // demotes, envelope or no envelope.
  envelope = { taskType: 'ambiguous', suggestedIntent: null, isFollowUp: false };
  const r10 = await processMessage({ text: 'change the title to say quarterly results' });
  check('imperative fragment + silent envelope → NOT memory_store',
    r10.intent !== 5 && r10.intentName !== 'memory_store',
    `got intent=${r10.intent} ${r10.intentName}`);

  llmProviders.ask = realAsk;
  decision.askDecision = realAskDecision;
  decision.confirmJudgment = realConfirm;

  console.log(`\n${passed + failed} tests, ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('test crashed:', e); process.exit(1); });
