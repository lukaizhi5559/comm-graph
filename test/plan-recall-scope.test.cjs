'use strict';
/**
 * plan-recall-scope.test.cjs — scoped plan recall + plan-offer gate.
 *
 * Two contracts under test (server.cjs / turn-facts / system-map):
 *   1. Plan recall is SCOPED — a prompt mentioning "plan" is never fuzzy
 *      matched against saved plans. Recall fires only on a definite name
 *      referent ("the nylas plan"), a time-scoped question ("what plans did
 *      I do last week"), or an explicit existence ask ("do we have a plan
 *      for X" → probe answers, never binds the lane).
 *   2. Implicit planning picks ASK FIRST — deliverable/complexity/LLM-6
 *      picks emit a plan_offer (yes/no) instead of silently entering the
 *      lane; consent replays the ORIGINAL prompt into planning, decline
 *      answers it as chat. Explicit vocabulary ("let's plan", "plan mode",
 *      named referents) still enters directly.
 *
 * Mocks: llm-providers.ask serves the remote legs (maxTokens>8 → taskType
 * envelope, else the intent pick). planningNode.execute/generalQuick.execute
 * are captured stubs — the lanes themselves are not under test. statusCheck
 * runs REAL so the disk probe answers from THINKDROP_PLANS_DIR fixtures.
 *
 * Run: node comms-graph/test/plan-recall-scope.test.cjs
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'td-planrecall-'));
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

const DAY = 24 * 60 * 60 * 1000;
function planFile(planId, { name, title, created, status = 'ready', prompt = '' }) {
  const file = path.join(process.env.THINKDROP_PLANS_DIR, `${planId}.md`);
  fs.writeFileSync(file, `---
id: ${planId}
name: ${name}
created: ${created}
kind: task_plan
status: ${status}
original_prompt: "${prompt}"
---
# Plan: ${title}

## Tasks

## Task 1 — ${title} task one
- **Prompt**: do the thing
- **Status**: ⬜ pending
`);
  // Backdate mtime to the created stamp — plansInWindow honors created OR
  // mtime, and a freshly-written fixture file must not leak into windows.
  const ms = Date.parse(created);
  fs.utimesSync(file, new Date(ms), new Date(ms));
  return file;
}

(async () => {
  console.log('\nplan-recall-scope tests');

  const llmProviders = require('../src/llm-providers.cjs');
  const decision = require('../src/decision.cjs');
  const planningNode = require('../src/nodes/planning.cjs');
  const generalQuickNode = require('../src/nodes/generalQuick.cjs');
  const sysMap = require('../../shared/system-map.cjs');
  const realAsk = llmProviders.ask;
  const realAskDecision = decision.askDecision;
  const realConfirm = decision.confirmJudgment;
  const realPlanExecute = planningNode.execute;
  const realGq = generalQuickNode.execute;
  const realFindPlans = sysMap.findPlans;
  const realFindByName = sysMap.findPlansByName;

  // Fixture plans — distinct ages so the time-window probe discriminates.
  const created = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();
  planFile('plan_nylas_aaa', {
    name: 'nylas.setup', title: 'Nylas setup', status: 'paused',
    created: created(3), prompt: 'set up nylas email integration',
  });
  planFile('plan_weekly_bbb', {
    name: 'weekly.report', title: 'Weekly report', status: 'ready',
    created: created(5), prompt: 'build a weekly reporting workflow',
  });
  planFile('plan_old_ccc', {
    name: 'old.stuff', title: 'Old stuff', status: 'ready',
    created: created(40), prompt: 'something ancient',
  });

  let envelope = null;
  let forcePick = '1';
  let verdict = null;
  let planCalls = [];
  let gqCalls = [];
  let findPlansCalls = 0;
  let findByNameCalls = 0;

  decision.askDecision = async () => null;
  decision.confirmJudgment = async () => verdict;
  planningNode.execute = async (args) => {
    planCalls.push(args);
    return { text: 'plan stub', fullText: 'plan stub', metadata: {} };
  };
  generalQuickNode.execute = async (...a) => {
    gqCalls.push(a);
    return { text: 'chat stub', fullText: 'chat stub', metadata: {} };
  };
  sysMap.findPlans = (...a) => { findPlansCalls++; return realFindPlans(...a); };
  sysMap.findPlansByName = (...a) => { findByNameCalls++; return realFindByName(...a); };
  llmProviders.ask = async (messages, opts = {}) => {
    const blob = JSON.stringify(messages);
    if ((opts.maxTokens || 0) > 8 && /taskType/i.test(blob)) {
      return { text: envelope ? JSON.stringify(envelope) : null, provider: 'stub' };
    }
    if (/single number/i.test(blob) || (opts.maxTokens || 0) <= 8) {
      return { text: forcePick, provider: 'stub' };
    }
    return { text: 'chat stub', provider: 'stub' };
  };

  const { processMessage } = require('../src/server.cjs');

  // ── 1. A stray "plan" word never consults plan storage ────────────────────
  // The logged hijack: ordinary text containing "plan" fuzzy-matched a saved
  // plan and hijacked the lane. findPlans/findPlansByName must not run.
  forcePick = '1';
  findPlansCalls = 0; findByNameCalls = 0; planCalls = [];
  const r1 = await processMessage({ text: "what's the difference between a plan and a strategy", sessionId: 'sess-scope-1' });
  check('stray "plan" word → no fuzzy findPlans consult', findPlansCalls === 0, `calls=${findPlansCalls}`);
  check('stray "plan" word → no name lookup either', findByNameCalls === 0, `calls=${findByNameCalls}`);
  check('stray "plan" word → planning never dispatched', planCalls.length === 0);
  check('stray "plan" word → answered as chat (or offered once)',
    r1.intent === 1 || r1.metadata?.source === 'plan_offer', `got intent=${r1.intent} src=${r1.metadata?.source}`);

  // "forgot that plan" — non-meaningful referent, same guarantee.
  const r1b = await processMessage({ text: 'i want to discuss the idea i brought up, forgot that plan though', sessionId: 'sess-scope-1' });
  check('"forgot that plan" → still no name lookup', findByNameCalls === 0, `calls=${findByNameCalls}`);
  check('"forgot that plan" → planning never dispatched', planCalls.length === 0);

  // ── 2. Definite name referent resolves by NAME and binds ─────────────────
  // "continue the nylas plan" — name hit → planning with resumePlanId.
  // Resume guard verdict null → falls through to classify → forcePick '0' →
  // the server-level referent reroute does the name-scoped bind.
  forcePick = '0'; verdict = null; planCalls = []; findByNameCalls = 0;
  const r2 = await processMessage({ text: 'continue the nylas plan', sessionId: 'sess-scope-2' });
  check('named referent → planning lane', r2.intent === 6, `got intent=${r2.intent} src=${r2.metadata?.source}`);
  check('named referent → bound planId', planCalls.length === 1 && planCalls[0].planning.planId === 'plan_nylas_aaa',
    `planId=${planCalls[0] && planCalls[0].planning.planId}`);
  check('named referent used the name-scoped lookup', findByNameCalls > 0);

  // ── 3. "do we have a plan for X" probes — never binds the lane ───────────
  forcePick = '0'; verdict = null; planCalls = [];
  const r3 = await processMessage({ text: 'do we have a plan for the picnic', sessionId: 'sess-scope-3' });
  check('existence ask → status_check', r3.intent === 3, `got intent=${r3.intent} src=${r3.metadata?.source}`);
  check('existence ask → honest no-named-plan answer', /don'?t have a saved plan/i.test(r3.text || ''), `text=${(r3.text || '').slice(0, 80)}`);
  check('existence ask → planning never dispatched', planCalls.length === 0);

  // ── 4. Time-scoped recall lists ONLY window matches ──────────────────────
  forcePick = '0'; planCalls = [];
  const r4 = await processMessage({ text: 'what plans did i do last week', sessionId: 'sess-scope-4' });
  check('time-scoped query → status_check', r4.intent === 3, `got intent=${r4.intent}`);
  check('window lists recent plans', /nylas|weekly/i.test(r4.text || ''), `text=${(r4.text || '').slice(0, 120)}`);
  check('window excludes the 40-day-old plan', !/old\.stuff/i.test(r4.text || ''), `text=${(r4.text || '').slice(0, 120)}`);

  // ── 5. Implicit planning pick → OFFER, not the lane ──────────────────────
  // "build me an app" hits deliverable_guard → intent 6 with NO explicit
  // plan vocabulary → the gate emits a yes/no offer first.
  forcePick = '1'; planCalls = [];
  const r5 = await processMessage({ text: 'build me an app for tracking recipes', sessionId: 'sess-offer-1' });
  check('implicit 6 → plan_offer emitted', r5.metadata?.source === 'plan_offer', `src=${r5.metadata?.source} intent=${r5.intent}`);
  check('offer carries yes/no choices', Array.isArray(r5.metadata?.choices?.options) && r5.metadata.choices.options.length === 2);
  check('offer → planning never dispatched', planCalls.length === 0);

  // Consent replays the ORIGINAL prompt into the lane.
  const r5b = await processMessage({ text: 'yes', sessionId: 'sess-offer-1' });
  check('consent → planning dispatched', planCalls.length === 1);
  check('consent replays the original prompt',
    planCalls.length === 1 && planCalls[0].englishText === 'build me an app for tracking recipes',
    `got=${planCalls[0] && planCalls[0].englishText}`);
  check('consent → fresh plan (no stale binding)',
    planCalls.length === 1 && planCalls[0].planning.planId === null && planCalls[0].planning.forceNewPlan === true);
  check('consent → intent 6', r5b.intent === 6, `got ${r5b.intent}`);

  // ── 6. Decline answers the ORIGINAL prompt as chat ───────────────────────
  planCalls = []; gqCalls = [];
  await processMessage({ text: 'build me a website for my bakery', sessionId: 'sess-offer-2' });
  const r6 = await processMessage({ text: 'no thanks', sessionId: 'sess-offer-2' });
  check('decline → planning never dispatched', planCalls.length === 0);
  check('decline → generalQuick on the stored prompt',
    gqCalls.length === 1 && gqCalls[0][0] === 'build me a website for my bakery',
    `got=${gqCalls[0] && gqCalls[0][0]}`);
  check('decline → chat answer returned', r6.text === 'chat stub');

  // ── 7. Ideation opener → offer even on a chat pick ───────────────────────
  forcePick = '1'; planCalls = [];
  const r7 = await processMessage({ text: 'i have an idea for a side project', sessionId: 'sess-offer-3' });
  check('"i have an idea" → plan_offer', r7.metadata?.source === 'plan_offer', `src=${r7.metadata?.source} intent=${r7.intent}`);
  check('"i have an idea" → planning never dispatched', planCalls.length === 0);

  // A non-reply abandons the offer — the next turn routes normally.
  gqCalls = [];
  await processMessage({ text: 'what is the weather like anyway', sessionId: 'sess-offer-3' });
  const r7b = await processMessage({ text: 'yes', sessionId: 'sess-offer-3' });
  check('abandoned offer → "yes" is not replayed into planning', planCalls.length === 0);

  // ── 8. Explicit planning vocabulary still enters directly ────────────────
  planCalls = [];
  const r8 = await processMessage({ text: "let's do a plan for the weekend picnic", sessionId: 'sess-explicit-1' });
  check('"let\'s do a plan" → direct planning', planCalls.length === 1 && r8.intent === 6, `intent=${r8.intent} calls=${planCalls.length}`);
  check('explicit entry → no offer emitted', r8.metadata?.source !== 'plan_offer');

  planCalls = [];
  const r9 = await processMessage({ text: 'bring up plan mode', sessionId: 'sess-explicit-2' });
  check('"bring up plan mode" → direct planning', planCalls.length === 1 && r9.intent === 6, `intent=${r9.intent} calls=${planCalls.length}`);

  // ── 9. Informational name question → probe, not the lane ─────────────────
  // "what was the nylas plan about" — name hit + question → status_check
  // answers from disk (verdict null → fail-open keeps the reroute).
  verdict = null; planCalls = [];
  const r10 = await processMessage({ text: 'what was the nylas plan about', sessionId: 'sess-scope-9' });
  check('informational name question → status_check', r10.intent === 3, `got intent=${r10.intent}`);
  check('informational name question → found the named plan', /found the.*plan|nylas/i.test(r10.text || ''), `text=${(r10.text || '').slice(0, 100)}`);
  check('informational name question → planning never dispatched', planCalls.length === 0);

  llmProviders.ask = realAsk;
  decision.askDecision = realAskDecision;
  decision.confirmJudgment = realConfirm;
  planningNode.execute = realPlanExecute;
  generalQuickNode.execute = realGq;
  sysMap.findPlans = realFindPlans;
  sysMap.findPlansByName = realFindByName;

  console.log(`\n${passed + failed} tests, ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('test crashed:', e); process.exit(1); });
