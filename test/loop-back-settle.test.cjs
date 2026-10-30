'use strict';
/**
 * loop-back-settle.test.cjs — _handleLoopBack settle contract
 *
 * Regression (2026-10-30): a plan task pinned to edit.agent escalated
 * needs_plan (agent_not_onboarded — the skill-vs-agent confusion fixed in
 * Phase A). The loop-back replan completed with a scrubbed reply — no
 * metadata.runPlan, no metadata.planFile — and the .then() callback silently
 * no-op'd. The run stayed 'running' and the queue card spun "Generating
 * skill plan…" for 40min. _handleLoopBack now guarantees every outcome
 * settles: runnable plan → /plan.run; anything else → /plan.fail; two
 * needs_plan replans per plan → cap → /plan.fail.
 *
 * Run: node comms-graph/test/loop-back-settle.test.cjs
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loopback-'));

// Isolate the task journal + keep the real :3015 service unbound in tests.
process.env.TASK_JOURNAL_PATH = path.join(tmpDir, 'tasks.json');
process.env.COMMS_NO_LISTEN = '1';

// Capture _postMain calls on a scratch port.
const posts = [];
const mainSrv = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    posts.push({ url: req.url, body: JSON.parse(body || '{}') });
    res.writeHead(200).end('{}');
  });
});

let tests = 0, passed = 0;
function check(name, cond, extra = '') {
  tests++;
  if (cond) { passed++; console.log(`  PASS: ${name}`); }
  else { console.error(`  FAIL: ${name}${extra ? ' — ' + extra : ''}`); }
}

async function main() {
  await new Promise(r => mainSrv.listen(0, '127.0.0.1', r));
  process.env.THINKDROP_MAIN_PORT = String(mainSrv.address().port);

  const planningNode = require('../src/nodes/planning.cjs');
  const taskJournal = require('../src/taskJournal.cjs');
  const { _handleLoopBack, _loopBackAttempts } = require('../src/server.cjs');

  const realExecute = planningNode.execute;
  let execArgs = null, execCalls = 0, execImpl = async () => ({ metadata: {} });
  planningNode.execute = (args) => { execCalls++; execArgs = args; return execImpl(args); };

  const flush = async () => { await new Promise(r => setTimeout(r, 30)); };
  const escResult = (o) => JSON.stringify(o);

  // ── Plan-bound needs_plan revises the SAME plan ─────────────────────────
  const planTask = taskJournal.createTask({
    prompt: 'Update the RTF file', sessionId: 'sess_x',
    planMeta: { planId: 'plan_held', planTaskNum: 1, planTask: true },
  });
  execImpl = async () => ({ metadata: { runPlan: true, planId: 'plan_held', planFile: '/tmp/plan_held.md' } });
  await _handleLoopBack({ taskId: planTask, status: 'needs_plan', result: escResult({ reason: 'agent_not_onboarded' }) });
  await flush();
  check('plan-bound needs_plan revises same plan (planning.planId)', execArgs?.planning?.planId === 'plan_held' && execArgs?.planning?.revise === true, JSON.stringify(execArgs?.planning));
  check('revise text carries failing-task context', /could not run as written/i.test(execArgs?.englishText || ''), execArgs?.englishText);
  check('no forceNewPlan on plan-bound escalation', !execArgs?.planning?.forceNewPlan);
  check('runnable metadata → /plan.run', posts.some(p => p.url === '/plan.run' && p.body.planId === 'plan_held'), JSON.stringify(posts));

  // ── Scrubbed turn (no metadata) → /plan.fail ────────────────────────────
  posts.length = 0;
  const planTask2 = taskJournal.createTask({
    prompt: 'Update the RTF file', sessionId: 'sess_x',
    planMeta: { planId: 'plan_scrub', planTaskNum: 1, planTask: true },
  });
  execImpl = async () => ({ metadata: { planId: 'plan_orphan_stub' } }); // turn completed, nothing runnable
  await _handleLoopBack({ taskId: planTask2, status: 'needs_plan', result: escResult({ reason: 'agent_not_onboarded' }) });
  await flush();
  const failPost = posts.find(p => p.url === '/plan.fail');
  check('no runnable metadata → /plan.fail', !!failPost && failPost.body.planId === 'plan_scrub', JSON.stringify(posts));
  check('/plan.fail carries reason', /no runnable plan/i.test(failPost?.body?.reason || ''), failPost?.body?.reason);
  check('no /plan.run posted', !posts.some(p => p.url === '/plan.run'));

  // ── planningNode.execute throws → /plan.fail ────────────────────────────
  posts.length = 0;
  const planTask3 = taskJournal.createTask({
    prompt: 'x', sessionId: 'sess_x', planMeta: { planId: 'plan_throws', planTaskNum: 1, planTask: true },
  });
  execImpl = async () => { throw new Error('provider exploded'); };
  await _handleLoopBack({ taskId: planTask3, status: 'needs_plan', result: escResult({ reason: 'agent_not_onboarded' }) });
  await flush();
  const failPost3 = posts.find(p => p.url === '/plan.fail');
  check('execute throw → /plan.fail', !!failPost3 && failPost3.body.planId === 'plan_throws', JSON.stringify(posts));
  check('throw reason surfaced', /provider exploded/.test(failPost3?.body?.reason || ''), failPost3?.body?.reason);

  // ── Escalation cap: 3rd needs_plan on same plan fails without execute ───
  posts.length = 0; execCalls = 0;
  const planTask4 = taskJournal.createTask({
    prompt: 'x', sessionId: 'sess_x', planMeta: { planId: 'plan_loopy', planTaskNum: 1, planTask: true },
  });
  _loopBackAttempts.set('plan_loopy', 2); // two replans already burned
  execImpl = async () => ({ metadata: { runPlan: true, planId: 'plan_loopy', planFile: '/tmp/x.md' } });
  await _handleLoopBack({ taskId: planTask4, status: 'needs_plan', result: escResult({ reason: 'agent_not_onboarded' }) });
  await flush();
  check('cap reached → /plan.fail without calling execute', execCalls === 0 && posts.some(p => p.url === '/plan.fail' && p.body.planId === 'plan_loopy'), `calls=${execCalls}`);
  check('cap reason names attempts', /attempt/i.test(posts.find(p => p.url === '/plan.fail')?.body?.reason || ''));

  // ── Bare (non-plan) needs_plan → forceNewPlan path ──────────────────────
  posts.length = 0; execArgs = null;
  const bareTask = taskJournal.createTask({ prompt: 'sweep three files', sessionId: 'sess_x' });
  execImpl = async () => ({ metadata: { runPlan: true, planId: 'plan_new', planFile: '/tmp/plan_new.md' } });
  await _handleLoopBack({ taskId: bareTask, status: 'needs_plan', result: escResult({ reason: 'local_multi_entity', seedPrompt: 'sweep three files' }) });
  await flush();
  check('bare needs_plan → forceNewPlan', execArgs?.planning?.forceNewPlan === true);
  check('bare needs_plan runnable → /plan.run for new plan', posts.some(p => p.url === '/plan.run' && p.body.planId === 'plan_new'));

  // ── plan_update still revises same plan (regression guard) ──────────────
  posts.length = 0; execArgs = null;
  const updTask = taskJournal.createTask({
    prompt: 'x', sessionId: 'sess_x', planMeta: { planId: 'plan_upd', planTaskNum: 2, planTask: true },
  });
  execImpl = async () => ({ metadata: { runPlan: true, planId: 'plan_upd', planFile: '/tmp/plan_upd.md' } });
  await _handleLoopBack({ taskId: updTask, status: 'plan_update', result: escResult({ reason: 'found extra files', proposal: 'add task 3' }) });
  await flush();
  check('plan_update revises same plan', execArgs?.planning?.planId === 'plan_upd' && execArgs?.planning?.revise === true);
  check('plan_update runnable → /plan.run', posts.some(p => p.url === '/plan.run' && p.body.planId === 'plan_upd'));

  // ── Timeout → /plan.fail ────────────────────────────────────────────────
  posts.length = 0;
  const planTask5 = taskJournal.createTask({
    prompt: 'x', sessionId: 'sess_x', planMeta: { planId: 'plan_slow', planTaskNum: 1, planTask: true },
  });
  // Shrink the module-level timeout? It's a const — instead prove the race
  // contract with a never-resolving execute and a shortened real timer isn't
  // possible; assert the throw path equivalent: a rejected promise settles.
  execImpl = () => new Promise((_, rej) => setTimeout(() => rej(new Error('loop-back planning timeout (240000ms)')), 10));
  await _handleLoopBack({ taskId: planTask5, status: 'needs_plan', result: escResult({ reason: 'agent_not_onboarded' }) });
  await flush();
  check('timeout-shaped rejection → /plan.fail', posts.some(p => p.url === '/plan.fail' && p.body.planId === 'plan_slow'), JSON.stringify(posts));

  planningNode.execute = realExecute;
  mainSrv.close();
  console.log(`\n${passed}/${tests} passed`);
  process.exit(passed === tests ? 0 : 1);
}

main().catch(e => { console.error(e); mainSrv.close(); process.exit(1); });
