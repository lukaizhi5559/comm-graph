'use strict';
/**
 * plan-resume-guard.test.cjs — semantic-every-time resume verdicts
 *
 * Regression: "Answer the questions base upon the resume" hit \bresume\b and
 * blind-pinned intent=planning onto a stale unrelated open plan → the same
 * prompt produced a conversational answer AND a plan that ended in
 * "fill + submit the job application". No lexical path may pin planning
 * intent — every candidate must resolve through decision.confirmJudgment,
 * and a NO/null verdict must fall through to normal classification.
 */
const assert = require('assert');
const { classify } = require('../src/classify.cjs');
const decision = require('../src/decision.cjs');
const providers = require('../src/llm-providers.cjs');

const realConfirm = decision.confirmJudgment;
const realAsk = providers.ask;
let tests = 0, passed = 0;

const OPEN_PLAN = {
  planId: 'plan_stale_eci',
  title: 'ECI opportunity analysis for a startup',
  pendingCount: 2,
  totalTasks: 3,
  taskTitles: ['Research ECI candidates', 'Draft outreach email'],
};

async function withStubs({ verdict, askText = '1' }, fn) {
  const calls = [];
  decision.confirmJudgment = async (o) => { calls.push(o); return verdict; };
  providers.ask = async () => ({ text: askText, provider: 'mock' });
  try { return await fn(calls); }
  finally { decision.confirmJudgment = realConfirm; providers.ask = realAsk; }
}
function check(name, cond) { tests++; if (cond) { passed++; console.log(`  PASS: ${name}`); } else { console.error(`  FAIL: ${name}`); } }

(async () => {
  console.log('\nplan-resume guard tests');

  // The observed misroute — résumé/CV noun must NOT pin planning
  await withStubs({ verdict: 'NO' }, async (calls) => {
    const r = await classify('answer the questions base upon the resume', null, { openPlan: OPEN_PLAN });
    check('résumé noun → not planning', r.intent !== 6);
    check('no resumePlanId', !r.resumePlanId);
    check('semantic gate ran', calls.some(c => c.site === 'plan-resume'));
    const gate = calls.find(c => c.site === 'plan-resume');
    check('gate question names the résumé/CV ambiguity', /résumé|CV|resume/i.test(gate.question));
    check('gate state carries the paused plan', /ECI opportunity/.test(gate.state));
  });

  // Genuine continuation — model says YES → planning
  await withStubs({ verdict: 'YES' }, async (calls) => {
    const r = await classify('resume the plan', null, { openPlan: OPEN_PLAN });
    check('resume-the-plan + YES → planning', r.intent === 6);
    check('resumePlanId pinned', r.resumePlanId === 'plan_stale_eci');
    check('gate ran for the resume verb too', calls.some(c => c.site === 'plan-resume'));
  });

  // Model down (null) → fail-open to normal classify, never a blind pin
  await withStubs({ verdict: null }, async () => {
    const r = await classify('pick up where we left off', null, { openPlan: OPEN_PLAN });
    check('null verdict → no blind planning pin', r.intent !== 6 && !r.resumePlanId);
  });

  // No lexical candidate at all → gate never fires
  await withStubs({ verdict: 'YES' }, async (calls) => {
    const r = await classify('what is the capital of France', null, { openPlan: OPEN_PLAN });
    check('unrelated prompt → gate not consulted', !calls.some(c => c.site === 'plan-resume'));
    check('unrelated prompt → not planning', r.intent !== 6);
  });

  // "install it"-style probe with entity in plan → candidate → gate decides
  await withStubs({ verdict: 'NO' }, async (calls) => {
    const r = await classify('try the outreach email again', null, { openPlan: OPEN_PLAN });
    check('non-resume retry phrasing resolves via gate or falls through', r.intent !== 6 || !r.resumePlanId);
  });

  // No open plan → gate never fires even for resume phrasing
  await withStubs({ verdict: 'YES' }, async (calls) => {
    const r = await classify('resume the plan', null, {});
    check('no open plan → no gate', !calls.some(c => c.site === 'plan-resume'));
    check('no open plan → no resumePlanId', !r.resumePlanId);
  });

  console.log(`\n${passed}/${tests} passed\n`);
  process.exit(passed === tests ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
