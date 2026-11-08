'use strict';
/**
 * draft-guard.test.cjs — produce-text verbs never reach a service agent.
 *
 * Observed (2026-11-05 e2e): "draft a short linkedin post about shipping
 * software faster" → envelope taskType=messaging targetService=linkedin →
 * handoff → linkedin.agent composed AND PUBLISHED the post. A wrong publish
 * cannot be undone; per AGENTS.md ambiguity favors the low-blast-radius
 * lane. "Draft" is produce-text — the deliverable is text, not a service
 * action. Only an explicit transmit verb (send/publish/post-to/email-to)
 * legitimizes the service dispatch; "post" in "linkedin post" is a noun —
 * the drafted artifact, not an action.
 *
 * Fix (server.cjs): intent 0 + service-typed envelope (SERVICE_TASK_TYPES
 * or targetService) + anchored produce verb (draft/compose/write/craft/
 * type) + no transmit verb → demote the turn to general_quick, which
 * composes the text inline; its 0-sentinel still self-corrects to handoff.
 *
 * Mocks: llm-providers.ask serves BOTH remote legs — classify's
 * (maxTokens≤8 → bare intent digit) and classifyTask's (taskType JSON).
 * decision.askDecision/confirmJudgment stay null → gates inert.
 * THINKDROP_MAIN_PORT points at a dead port so a kept handoff pick never
 * reaches a live main (hermetic per AGENTS.md).
 *
 * Run: node comms-graph/test/draft-guard.test.cjs
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'td-draftguard-'));
process.env.COMMS_NO_LISTEN = '1';
process.env.COMMS_NO_HISTORY = '1';
process.env.TASK_JOURNAL_PATH = path.join(TMP, 'journal.json');
process.env.THINKDROP_RULES_PATH = path.join(TMP, 'rules.json');
process.env.THINKDROP_PLANS_DIR = path.join(TMP, 'plans');
process.env.MEMORY_SERVICE_PORT = '39997';
process.env.THINKDROP_MAIN_PORT = '39998'; // dead — handoff posts can't reach a live main
fs.mkdirSync(process.env.THINKDROP_PLANS_DIR, { recursive: true });

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  PASS: ${name}`); }
  else { failed++; console.error(`  FAIL: ${name}${extra ? ' — ' + extra : ''}`); }
}

(async () => {
  console.log('\ndraft-guard tests');

  const llmProviders = require('../src/llm-providers.cjs');
  const decision = require('../src/decision.cjs');
  const realAsk = llmProviders.ask;
  const realAskDecision = decision.askDecision;
  const realConfirm = decision.confirmJudgment;
  decision.askDecision = async () => null;
  decision.confirmJudgment = async () => null;

  // Envelope the test wants classifyTask to return; swapped per case.
  let envelope = { taskType: 'messaging', suggestedIntent: 'command_automate', targetService: 'linkedin' };

  llmProviders.ask = async (messages, opts = {}) => {
    // classifyTask (route-decision leg): returns the taskType JSON envelope.
    if ((opts.maxTokens || 0) > 8) return { text: JSON.stringify(envelope), provider: 'stub' };
    // classify force-prompt leg: remote always picks handoff — the pick
    // under arbitration.
    return { text: '0', provider: 'stub' };
  };

  const { processMessage } = require('../src/server.cjs');

  // ── 1. The logged repro: draft + linkedin envelope → NOT handoff ─────────
  const r1 = await processMessage({ text: 'draft a short linkedin post about shipping software faster' });
  check('draft + linkedin service envelope → NOT handoff',
    r1.intent !== 0 && r1.intentName !== 'handoff',
    `got intent=${r1.intent} ${r1.intentName}`);
  check('draft + linkedin service envelope → general_quick lane',
    r1.intent === 1 && r1.intentName === 'general_quick',
    `got intent=${r1.intent} ${r1.intentName}`);

  // ── 2. Transmit-verb opener stays a task-capable lane ──────────────────
  // "post" is a transmit verb — the guard must not demote to the compose
  // lane. Handoff or planning are both service-capable (complexity may
  // promote the pick); the harm path is general_quick producing mere text.
  const r2 = await processMessage({ text: 'post a linkedin update about shipping software faster' });
  check('post opener + linkedin envelope → NOT general_quick',
    r2.intent !== 1 && r2.intentName !== 'general_quick',
    `got intent=${r2.intent} ${r2.intentName}`);

  // ── 3. Draft + transmit co-verb stays a task-capable lane ──────────────
  // "send it" is a transmit verb — the draft guard must NOT demote to
  // general_quick. The complexity scorer may promote draft+send to
  // planning (multi-step draft→send orchestration) — either task lane is
  // fine; the assertion is that the produce-verb anchor did not win.
  const r3 = await processMessage({ text: 'draft an email to Jake and send it' });
  check('draft + send co-verb → NOT general_quick',
    r3.intent !== 1 && r3.intentName !== 'general_quick',
    `got intent=${r3.intent} ${r3.intentName}`);

  // ── 4. Draft-reply on a social surface → no direct service dispatch ─────
  // The guard fires on intent 0 arriving at the server. The complexity
  // scorer may promote "draft a response to X" to planning inside classify
  // first — planning drafts conversationally and can't publish either, so
  // the assertion is the harm path (intent 0 → service agent), not a lane.
  envelope = { taskType: 'messaging', suggestedIntent: 'command_automate', targetService: 'twitter' };
  const r4 = await processMessage({ text: 'draft a response to this tweet' });
  check('draft response + twitter envelope → NOT handoff',
    r4.intent !== 0 && r4.intentName !== 'handoff',
    `got intent=${r4.intent} ${r4.intentName}`);

  // ── 5. Produce verb, no transmit → quick compose lane ──────────────────
  // Under the planning-leg extension the guard fires on ANY lane pick for
  // an anchored produce verb without a transmit verb — "write a report"
  // is a text deliverable; general_quick composes it and the 0-sentinel
  // self-corrects to handoff if tools turn out to be needed.
  envelope = { taskType: 'local_file', suggestedIntent: null };
  const r5 = await processMessage({ text: 'write a report about our q3 metrics' });
  check('write + no transmit → general_quick lane',
    r5.intent === 1 && r5.intentName === 'general_quick',
    `got intent=${r5.intent} ${r5.intentName}`);

  // ── 6. Envelope unavailable → guard inert, handoff kept ──────────────────
  llmProviders.ask = async (messages, opts = {}) => {
    if ((opts.maxTokens || 0) > 8) return { text: null, provider: 'stub' };
    return { text: '0', provider: 'stub' };
  };
  const r6 = await processMessage({ text: 'draft a short linkedin post about launches' });
  check('envelope down → guard inert, handoff kept',
    r6.intent === 0 && r6.intentName === 'handoff',
    `got intent=${r6.intent} ${r6.intentName}`);

  // ── 7. Planning-leg guard — remote picks 6 for a produce-text ask ───────
  // Live repro (2026-11-05 e2e): "draft a short tweet announcing our v2.0
  // launch" → remote picked planning directly, the lane grilled "what's
  // the product?" instead of drafting. Produce anchor + no transmit +
  // non-plan artifact → general_quick composes inline.
  llmProviders.ask = async (messages, opts = {}) => {
    if ((opts.maxTokens || 0) > 8) return { text: JSON.stringify(envelope), provider: 'stub' };
    return { text: '6', provider: 'stub' };
  };
  envelope = { taskType: 'query', suggestedIntent: null };
  const r7 = await processMessage({ text: 'draft a short tweet announcing our v2.0 launch' });
  check('planning pick on a draft → general_quick lane',
    r7.intent === 1 && r7.intentName === 'general_quick',
    `got intent=${r7.intent} ${r7.intentName}`);

  // ── 8. Plan-as-artifact keeps the planning lane ──────────────────────────
  const r8 = await processMessage({ text: 'draft a plan for the v2.0 launch' });
  check('draft a plan → planning kept',
    r8.intent === 6 && r8.intentName === 'planning',
    `got intent=${r8.intent} ${r8.intentName}`);

  llmProviders.ask = realAsk;
  decision.askDecision = realAskDecision;
  decision.confirmJudgment = realConfirm;

  console.log(`\n${passed + failed} tests, ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('test crashed:', e); process.exit(1); });
