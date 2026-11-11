'use strict';
/**
 * plan-inherit-veto.test.cjs — the RouteDecision envelope arbitrates the
 * planning lane pick, and a FOREIGN (other-session) open plan can neither
 * bias the classify prompt nor be silently bound at dispatch.
 *
 * Observed (2026-11-11 e2e): the user asked "In layman's terms explain to
 * me SQL inner, outer, etc. joins" (intent 1, fine answer), then followed
 * with "show me examples side-by-side". IntentGuesser had no match, the
 * force prompt picked intent=6 — the ONLY privileged lane with no envelope
 * arbitration — and dispatch treated the 4-word prompt as resume-shaped,
 * binding a PAUSED FOREIGN career plan (plan_session_id of another
 * conversation). The planner ran that plan's stale task-2 web.search
 * ("LangGraph vs CrewAI vs LlamaIndex") and replied "I updated the plan —
 * take a look." Two prior links in the same chain: the classify prompt's
 * "Open plan: …" line advertised the foreign plan as resume bait, and
 * `_activePlanId` was set merely by _loadPlanFromDisk reading the file.
 *
 * Fixes under test (server.cjs / classify.cjs / planReply.cjs):
 *   1. intent-6 picks die on envelope follow-up/non-task evidence unless
 *      plan vocabulary, a definite referent, resume phrasing, a resume-
 *      guard hit, or a session-bound awaiting-input plan corroborates —
 *      demoted to the envelope's own lane (same contract as the intent-5/7/8
 *      vetoes; envelope down → fail-open keeps the pick).
 *   2. The classify prompt's "Open plan:" hint is emitted only for a plan
 *      boundToSession — foreign plans stop biasing the pick.
 *   3. canInheritOpenPlan governs dispatch: foreign plans bind on explicit
 *      resume vocabulary only; otherwise planId=null + preferFresh +
 *      forceNewPlan so the _activePlanId fallback can't re-bind either.
 *
 * Mocks: llm-providers.ask serves BOTH remote legs — classify's
 * (maxTokens≤8 → bare intent digit) and classifyTask's (taskType JSON).
 * decision.askDecision/confirmJudgment stay null → gates inert.
 * planningNode.execute is wrapped to capture dispatch args — the lane
 * itself is not under test. THINKDROP_MAIN_PORT points at a dead port so
 * a kept handoff pick never reaches a live main (hermetic per AGENTS.md).
 *
 * Run: node comms-graph/test/plan-inherit-veto.test.cjs
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'td-planveto-'));
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

// A paused plan from ANOTHER conversation session — mirrors the live repro's
// career plan (paused, pending comparison task, foreign plan_session_id).
const FOREIGN_PLAN_ID = 'plan_testforeign_aa1';
const FOREIGN_PLAN_FILE = path.join(process.env.THINKDROP_PLANS_DIR, `${FOREIGN_PLAN_ID}.md`);
const FOREIGN_PLAN = `---
id: ${FOREIGN_PLAN_ID}
created: 2026-11-10T17:00:00.000Z
kind: task_plan
status: paused
original_prompt: "build me a career transition plan"
plan_session_id: sess-foreign-xyz
auth_bypass: []
refs: []
---

# Plan: Career Transition Roadmap

Research and execute a career transition into AI engineering.

## Tasks

## Task 1 — Compile Agent Framework Roadmap
- **Prompt**: Compare LangGraph vs CrewAI vs LlamaIndex for the roadmap
- **Agents**: —
- **Depends on**: —
- **Mode**: sequential
- **Auth**: unknown
- **Status**: ⬜ pending
- **Result**: —

## Risks
`;

(async () => {
  console.log('\nplan-inherit-veto tests');

  const llmProviders = require('../src/llm-providers.cjs');
  const decision = require('../src/decision.cjs');
  const planningNode = require('../src/nodes/planning.cjs');
  const realAsk = llmProviders.ask;
  const realAskDecision = decision.askDecision;
  const realConfirm = decision.confirmJudgment;
  const realPlanExecute = planningNode.execute;
  decision.askDecision = async () => null;
  decision.confirmJudgment = async () => null;

  fs.writeFileSync(FOREIGN_PLAN_FILE, FOREIGN_PLAN);
  const foreignBytes = fs.readFileSync(FOREIGN_PLAN_FILE, 'utf8');

  // Envelope the test wants classifyTask to return; swapped per case.
  // The logged repro typed the follow-up query+isFollowUp, lane → handoff.
  let envelope = { taskType: 'query', suggestedIntent: null, isFollowUp: true };
  let forcePick = '6';
  // classify-style prompts seen by the remote leg — the foreign-plan bait
  // check reads these.
  let classifyPrompts = [];
  let planCalls = [];
  planningNode.execute = async (args) => {
    planCalls.push(args);
    return { text: 'plan stub', fullText: 'plan stub', metadata: {} };
  };

  llmProviders.ask = async (messages, opts = {}) => {
    const blob = JSON.stringify(messages);
    if (/single number/i.test(blob)) classifyPrompts.push(blob);
    // classifyTask (route-decision leg): returns the taskType JSON envelope.
    if ((opts.maxTokens || 0) > 8) {
      return { text: envelope ? JSON.stringify(envelope) : null, provider: 'stub' };
    }
    // classify force-prompt leg: the pick under arbitration.
    return { text: forcePick, provider: 'stub' };
  };

  const { processMessage, _addTurn } = require('../src/server.cjs');

  // Seed the prior turn exactly as the live conversation had it.
  _addTurn(
    "In layman's terms explain to me SQL inner, outer, etc. joins",
    'An inner join keeps only rows that match in both tables. A left outer join keeps every left-table row…',
    1
  );

  // ── 1. The logged repro: follow-up + force-prompt 6 → NOT planning ───────
  const r1 = await processMessage({ text: 'show me examples side-by-side' });
  check('follow-up + query envelope → NOT planning',
    r1.intent !== 6 && r1.intentName !== 'planning',
    `got intent=${r1.intent} ${r1.intentName}`);
  check('follow-up demotes to the envelope lane (handoff)',
    r1.intent === 0 && r1.intentName === 'handoff',
    `got intent=${r1.intent} ${r1.intentName}`);
  check('planning lane never dispatched',
    planCalls.length === 0,
    `planCalls=${planCalls.length}`);
  check('foreign plan file not mutated',
    fs.readFileSync(FOREIGN_PLAN_FILE, 'utf8') === foreignBytes);

  // ── 2. The classify prompt carried no foreign-plan bait ───────────────────
  // Root-cause guard: "Open plan: …" for a foreign session was the stimulus
  // that made "examples side-by-side" look like a plan continuation.
  const lastPrompt = classifyPrompts[classifyPrompts.length - 1] || '';
  check('foreign open plan not injected into classify prompt',
    !/Open plan:/.test(lastPrompt) && !/Career Transition Roadmap/.test(lastPrompt),
    lastPrompt.slice(0, 120));

  // ── 3. Envelope down → fail-open keeps planning, but NO foreign binding ──
  // The dispatch guard is the last line: even when the pick survives, a
  // foreign plan must not be inherited on short-prompt shape alone.
  envelope = null;
  planCalls = [];
  const r3 = await processMessage({ text: 'show me examples side-by-side' });
  check('envelope unavailable → fail-open keeps planning',
    r3.intent === 6 && r3.intentName === 'planning',
    `got intent=${r3.intent} ${r3.intentName}`);
  check('dispatch sent planId=null (no foreign inheritance)',
    planCalls.length === 1 && planCalls[0].planning.planId === null,
    `planId=${planCalls[0] && planCalls[0].planning.planId}`);
  check('dispatch forced a fresh plan (preferFresh + forceNewPlan)',
    planCalls.length === 1
      && planCalls[0].planning.preferFresh === true
      && planCalls[0].planning.forceNewPlan === true);
  check('foreign plan file still not mutated',
    fs.readFileSync(FOREIGN_PLAN_FILE, 'utf8') === foreignBytes);

  // ── 4. Explicit resume vocabulary legitimately binds the foreign plan ────
  // Cross-session resumes are real usage — "continue the plan" is explicit
  // evidence, so the veto must not fire and dispatch must pass the planId.
  envelope = { taskType: 'query', suggestedIntent: null, isFollowUp: true };
  planCalls = [];
  const r4 = await processMessage({ text: 'continue the plan' });
  check('explicit resume keeps planning even under a follow-up envelope',
    r4.intent === 6 && r4.intentName === 'planning',
    `got intent=${r4.intent} ${r4.intentName}`);
  check('explicit resume inherits the foreign plan id',
    planCalls.length === 1 && planCalls[0].planning.planId === FOREIGN_PLAN_ID,
    `planId=${planCalls[0] && planCalls[0].planning.planId}`);

  // ── 5. Contrast: a SESSION-BOUND open plan is still advertised ────────────
  // Runs last — _loadPlanFromDisk sets _activePlanId, so loading the bound
  // plan earlier would make it (not the foreign fixture) the open-plan hit.
  const BOUND_PLAN_ID = 'plan_testbound_bb2';
  fs.writeFileSync(path.join(process.env.THINKDROP_PLANS_DIR, `${BOUND_PLAN_ID}.md`),
    FOREIGN_PLAN.replaceAll(FOREIGN_PLAN_ID, BOUND_PLAN_ID).replace('sess-foreign-xyz', 'sess-bound-1'));
  // getPlanSession → _loadPlanFromDisk — populates _sessionToPlan for
  // 'sess-bound-1' deterministically (findOpenPlan's disk scan stops at the
  // first open hit and could leave the bound file unread).
  planningNode.getPlanSession(BOUND_PLAN_ID);
  const r5 = await processMessage({ text: 'show me examples side-by-side', sessionId: 'sess-bound-1' });
  const boundPrompt = classifyPrompts[classifyPrompts.length - 1] || '';
  check('session-bound open plan still injected into classify prompt',
    /Open plan:/.test(boundPrompt) && /Career Transition Roadmap/.test(boundPrompt));
  check('bound plan + follow-up envelope without resume vocabulary still demotes',
    r5.intent === 0 && r5.intentName === 'handoff',
    `got intent=${r5.intent} ${r5.intentName}`);

  llmProviders.ask = realAsk;
  decision.askDecision = realAskDecision;
  decision.confirmJudgment = realConfirm;
  planningNode.execute = realPlanExecute;

  console.log(`\n${passed + failed} tests, ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('test crashed:', e); process.exit(1); });
