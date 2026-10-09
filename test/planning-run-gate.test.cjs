'use strict';

// planning.cjs run-gate tests — the observed failure was a planner replying
// "I've set up the task — press Run all" with NO <plan_update>, then
// `<plan_run/>` on the empty plan being silently swallowed (metadata.runPlan
// false → main.js dead-ends → fallback lied "Working on the plan now.").
//
// Invariants under test:
//   1. <plan_run/> on an empty plan → metadata.runPlan falsy, reply must not
//      claim work is underway.
//   2. <plan_update> riding beside <tool> calls is applied THAT round (not
//      dropped), so a later <plan_run/> sees the tasks.
//   3. <plan_run/> with tasks → metadata.runPlan true + plan persisted.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate plan writes BEFORE requiring planning.cjs.
const PLANS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'td-plans-test-'));
process.env.THINKDROP_PLANS_DIR = PLANS_DIR;

// Stub the LLM — planning.cjs destructures ask/askStream at require time.
const providers = require('../src/llm-providers.cjs');
let SCRIPT = [];
const calls = [];
providers.ask = async () => ({ text: '[]' });
providers.askStream = async (messages) => {
  calls.push(messages);
  return { text: SCRIPT.length ? SCRIPT.shift() : '' };
};

const planning = require('../src/nodes/planning.cjs');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name} ${extra}`); }
}

const UPDATE = `<plan_update>
## Task 1 — Send the email
- Prompt: Send an email to cakers5559@gmail.com saying hi via the nylas CLI
- Agents: nylas.agent
- Mode: sequential
- Depends on: none
</plan_update>`;

(async () => {
  // ── Scenario 1: bare <plan_run/> on an empty plan ──────────────────────────
  // Round 0 emits <plan_run/> → corrective rejection injected → round 1 emits
  // <plan_run/> again (stubborn model) → loop exits, runPlan must stay falsy.
  SCRIPT = ['<plan_run/>', '<plan_run/>', '<plan_run/>'];
  const r1 = await planning.execute({
    englishText: 'run all',
    systemPrompt: '',
    sessionId: 'test-gate-empty',
    planning: { active: true },
  });
  check('empty-plan run → metadata.runPlan falsy', !r1.metadata.runPlan);
  check('empty-plan run → taskCount 0', r1.metadata.taskCount === 0);
  check('empty-plan run → reply does not claim work underway',
    !/working on|set up|underway|queued|running/i.test(r1.text),
    `got: ${r1.text}`);
  check('empty-plan run → reply states the plan is empty',
    /empty|no tasks|tell me/i.test(r1.text), `got: ${r1.text}`);
  // The corrective rejection must have been fed back to the model.
  const sawRejection = calls.some(msgs =>
    msgs.some(m => /plan_run → REJECTED/.test(m.content || '')));
  check('empty-plan run → rejection fed back into history', sawRejection);

  // ── Scenario 2: <plan_update> + <plan_run/> same round ─────────────────────
  SCRIPT = [UPDATE + '\n<plan_run/>'];
  calls.length = 0;
  const r2 = await planning.execute({
    englishText: 'run all',
    systemPrompt: '',
    sessionId: 'test-gate-tasks',
    planning: { active: true },
  });
  check('tasks + run → metadata.runPlan true', r2.metadata.runPlan === true);
  check('tasks + run → taskCount 1', r2.metadata.taskCount === 1);
  check('tasks + run → planFile present', !!r2.metadata.planFile && fs.existsSync(r2.metadata.planFile));
  const disk = r2.metadata.planFile ? fs.readFileSync(r2.metadata.planFile, 'utf8') : '';
  check('tasks persisted to plan file', /Task 1 — Send the email/.test(disk));

  // ── Scenario 3: update mid-loop, run next round ────────────────────────────
  // Round 0: plan_update + a tool call → markers applied BEFORE continue.
  // Round 1: <plan_run/> must see the tasks.
  SCRIPT = [
    UPDATE + '\n<tool>memory.search("anything")</tool>',
    '<plan_run/>',
  ];
  calls.length = 0;
  const r3 = await planning.execute({
    englishText: 'run all',
    systemPrompt: '',
    sessionId: 'test-gate-midloop',
    planning: { active: true },
  });
  check('mid-loop update applied → runPlan true', r3.metadata.runPlan === true,
    `taskCount=${r3.metadata.taskCount}`);
  check('mid-loop update applied → taskCount 1', r3.metadata.taskCount === 1);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('failures:', failures.join('; ')); process.exit(1); }
  process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
