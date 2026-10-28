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

// Stub the decision model — the tool-pin context gate calls confirmJudgment
// before a lexical hit may override planner-chosen agents. 'YES' | 'NO' | null.
const decision = require('../src/decision.cjs');
let DECISION = null;
decision.confirmJudgment = async () => DECISION;

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

  // ── Scenario 4: hallucinated watch?v= URL never survives plan_update ──────
  // The observed failure: model wrote a memorized dQw4w9WgXcQ URL into a cast
  // task without ever calling media.resolve — the executor silently casts the
  // wrong video. Ungrounded URLs must be stripped from persisted prompts.
  const CAST_UPDATE = `<plan_update>
## Task 1 — Cast the show
- **Prompt**: Cast the YouTube video at https://www.youtube.com/watch?v=dQw4w9WgXcQ (Goof Troop S2E1) to the user's Chromecast using catt.
- **Agents**: catt.agent
- **Depends on**: —
- **Mode**: sequential
</plan_update>`;
  SCRIPT = [CAST_UPDATE];
  calls.length = 0;
  const r4 = await planning.execute({
    englishText: 'cast the show',
    systemPrompt: '',
    sessionId: 'test-gate-media',
    planning: { active: true },
  });
  const disk4 = r4.metadata.planFile ? fs.readFileSync(r4.metadata.planFile, 'utf8') : '';
  check('ungrounded watch?v= stripped from persisted task', !/dQw4w9WgXcQ/.test(disk4),
    disk4.slice(0, 300));
  check('resolve-at-runtime note appended', /resolve the video URL at run time/i.test(disk4),
    disk4.slice(0, 300));

  // ── Scenario 5: confirm-shaped user text on an empty plan ────────────────
  // Observed failure: user says "sounds good do it", the model replies in
  // prose with NO <plan_run/> marker, and the turn dead-ends on "The plan is
  // empty". The confirm is run intent — the empty-plan corrective must fire.
  SCRIPT = [
    'Starting the update now.',
    UPDATE + '\n<plan_run/>',
  ];
  calls.length = 0;
  const r5 = await planning.execute({
    englishText: 'sounds good do it',
    systemPrompt: '',
    sessionId: 'test-gate-confirm',
    planning: { active: true },
  });
  check('confirm on empty plan → corrective fed back', calls.some(msgs =>
    msgs.some(m => /plan_run → REJECTED/.test(m.content || ''))));
  check('confirm on empty plan → runPlan true after recovery', r5.metadata.runPlan === true,
    `taskCount=${r5.metadata.taskCount}`);
  check('confirm on empty plan → taskCount 1', r5.metadata.taskCount === 1);

  // ── Scenario 6: plan described in prose, no <plan_update> ────────────────
  // Observed failure: "I have everything I need. I'll advance each child to
  // Exodus 7 and assign new songs…" — plan stayed empty, user's "do it"
  // dead-ended. The prose-plan claim must get the same corrective.
  SCRIPT = [
    "I have everything I need. I'll advance each child to the next chapter and update the file.",
    UPDATE,
  ];
  calls.length = 0;
  const r6 = await planning.execute({
    englishText: 'update the kids memory verse file to the next chapter',
    systemPrompt: '',
    sessionId: 'test-gate-prose',
    planning: { active: true },
  });
  check('prose-plan claim → corrective fed back', calls.some(msgs =>
    msgs.some(m => /plan_run → REJECTED/.test(m.content || ''))));
  check('prose-plan claim → tasks landed', r6.metadata.taskCount === 1,
    `taskCount=${r6.metadata.taskCount}`);

  // ── Scenario 7: lexical tool pin vetoed by context ───────────────────────
  // The reported bug: a file-edit task pinned messages.app.agent because the
  // prompt said "text". Bare "nylas" in an editing prompt is a weak lexical
  // hit that disagrees with the planner's edit.agent — a NO verdict must win.
  const WEAK_HIT_UPDATE = `<plan_update>
## Task 1 — Update the doc
- **Prompt**: Update the project doc to mention nylas sync metrics in the summary.
- **Agents**: edit.agent
- **Depends on**: —
- **Mode**: sequential
</plan_update>`;
  DECISION = 'NO';
  SCRIPT = [WEAK_HIT_UPDATE];
  calls.length = 0;
  const r7 = await planning.execute({
    englishText: 'update the doc',
    systemPrompt: '',
    sessionId: 'test-gate-veto',
    planning: { active: true },
  });
  const disk7 = r7.metadata.planFile ? fs.readFileSync(r7.metadata.planFile, 'utf8') : '';
  check('vetoed weak pin → planner agent kept', /Agents\*{0,2}:\s*edit\.agent/.test(disk7) && !/Agents\*{0,2}:\s*nylas\.agent/.test(disk7),
    disk7.slice(0, 400));

  // ── Scenario 8: context-confirmed strong pin still binds ─────────────────
  const STRONG_HIT_UPDATE = `<plan_update>
## Task 1 — Send the file
- **Prompt**: Use nylas to send the file to the team.
- **Agents**: edit.agent
- **Depends on**: —
- **Mode**: sequential
</plan_update>`;
  DECISION = 'YES';
  SCRIPT = [STRONG_HIT_UPDATE];
  calls.length = 0;
  const r8 = await planning.execute({
    englishText: 'use nylas to send the file',
    systemPrompt: '',
    sessionId: 'test-gate-confirm-pin',
    planning: { active: true },
  });
  const disk8 = r8.metadata.planFile ? fs.readFileSync(r8.metadata.planFile, 'utf8') : '';
  check('confirmed strong pin → nylas.agent bound', /Agents\*{0,2}:\s*nylas\.agent/.test(disk8),
    disk8.slice(0, 400));

  // ── Scenario 9: decision model down — weak hit defers to planner ─────────
  DECISION = null;
  SCRIPT = [WEAK_HIT_UPDATE];
  calls.length = 0;
  const r9 = await planning.execute({
    englishText: 'update the doc',
    systemPrompt: '',
    sessionId: 'test-gate-down',
    planning: { active: true },
  });
  const disk9 = r9.metadata.planFile ? fs.readFileSync(r9.metadata.planFile, 'utf8') : '';
  check('model-down weak pin → planner agent kept', /Agents\*{0,2}:\s*edit\.agent/.test(disk9),
    disk9.slice(0, 400));

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('failures:', failures.join('; ')); process.exit(1); }
  process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
