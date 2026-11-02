'use strict';

// planning.cjs phantom-agent correction tests — the observed failure was a
// planner drafting "Agents: <invented-name>", the plan-check card blocking on
// "not a registered agent", and the reply still claiming "ready to run"
// because the planner was never told the name was rejected.
//
// Invariants under test:
//   1. A plan_update naming an unregistered agent is REJECTED back to the
//      model in the same turn (corrective <tool_results> round).
//   2. When the model re-pins a registered surface, unknownAgents empties and
//      metadata.runPlan can still fire this turn.
//   3. When the model stays stubborn, the reply itself names the blocker —
//      "ready to run" prose never stands over a plan that cannot start.
//   4. A clarifying-question turn surfaces metadata.needsInfo so the feed can
//      mark it "awaiting your reply" instead of looking like work in flight.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate plan writes BEFORE requiring planning.cjs.
const PLANS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'td-plans-phantom-'));
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

const decision = require('../src/decision.cjs');
decision.confirmJudgment = async () => null;

// Count phantom corrective rounds directly via the warn channel — history
// carries injected correctives forward, so counting occurrences in later
// calls can't tell an inherited entry from a fresh injection.
const logger = require('../src/logger.cjs');
const _warn = logger.warn.bind(logger);
let phantomRounds = 0;
logger.warn = (msg, meta) => {
  if (/Phantom agent names/.test(String(msg))) phantomRounds++;
  return _warn(msg, meta);
};

const planning = require('../src/nodes/planning.cjs');

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
}

// Scenario isolation — an earlier turn's plan stays open on disk and a later
// session binds to it (needsInfo clears once a plan has tasks). Reset the
// plans dir between scenarios so each starts from a clean slate.
function resetPlans() {
  fs.rmSync(PLANS_DIR, { recursive: true, force: true });
  fs.mkdirSync(PLANS_DIR, { recursive: true });
}

const BOGUS_UPDATE = `<plan_update>
## Task 1 — Compress the video
- **Prompt**: Compress the last video in ~/Movies with a video CLI
- **Agents**: bogusvid.agent
- **Mode**: sequential
- **Depends on**: none
</plan_update>`;

const FIXED_UPDATE = `<plan_update>
## Task 1 — Compress the video
- **Prompt**: Compress the last video in ~/Movies with a video CLI
- **Agents**: shell
- **Mode**: sequential
- **Depends on**: none
</plan_update>`;

(async () => {
  // ── Scenario 0: clarifying question → needsInfo in metadata ───────────────
  resetPlans();
  SCRIPT = ['What name should I use for the agent?'];
  const r3 = await planning.execute({
    englishText: 'set something up for me',
    systemPrompt: '',
    sessionId: 'test-needsinfo',
    planning: { active: true },
  });
  check('clarify → metadata.needsInfo set', r3.metadata.needsInfo === 'clarify', `got: ${r3.metadata.needsInfo}`);

  // ── Scenario 1: phantom agent → corrective → same-turn self-heal ─────────
  resetPlans();
  calls.length = 0;
  SCRIPT = [BOGUS_UPDATE, FIXED_UPDATE + '\n<plan_run/>'];
  const r1 = await planning.execute({
    englishText: 'compress my last video',
    systemPrompt: '',
    sessionId: 'test-phantom-heal',
    planning: { active: true },
  });
  const sawRejection = calls.some(msgs =>
    msgs.some(m => /plan_update → REJECTED AGENTS/.test(m.content || '') && /bogusvid\.agent/.test(m.content || '')));
  check('phantom → REJECTED AGENTS fed back to the model', sawRejection);
  check('healed turn → metadata.unknownAgents empty', (r1.metadata.unknownAgents || []).length === 0);
  check('healed turn → runPlan fires', r1.metadata.runPlan === true);
  check('healed turn → taskCount 1', r1.metadata.taskCount === 1);
  check('healed turn → no blocker annotation needed', !/isn't a registered agent/.test(r1.text), `got: ${r1.text}`);

  // ── Scenario 2: stubborn phantom → reply names the blocker ────────────────
  resetPlans();
  calls.length = 0;
  phantomRounds = 0;
  SCRIPT = [BOGUS_UPDATE, BOGUS_UPDATE, BOGUS_UPDATE];
  const r2 = await planning.execute({
    englishText: 'compress my last video',
    systemPrompt: '',
    sessionId: 'test-phantom-stubborn',
    planning: { active: true },
  });
  check('stubborn → corrective bounded to one round', phantomRounds === 1, `got ${phantomRounds}`);
  check('stubborn → metadata.unknownAgents non-empty', (r2.metadata.unknownAgents || []).length > 0);
  check('stubborn → reply names the unregistered agent', /bogusvid\.agent isn't a registered agent/.test(r2.text), `got: ${r2.text}`);
  check('stubborn → runPlan stays false', !r2.metadata.runPlan);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
