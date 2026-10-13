'use strict';
/**
 * planning-route.test.cjs — planning-vs-handoff routing contract
 *
 * The lane should only open when a user decision is needed before
 * execution: explicit draft-intent phrasing, plan lifecycle, a genuine
 * route/setup choice, or multi-service work. Regressions covered:
 *
 *   - "let's plan X" (plan-as-verb) and ideation phrasing ("work out an
 *     idea", "think it through") must hit the deterministic phrase guard,
 *     not the flaky LLM path.
 *   - _complexityPlanningScore is multi-service only — prompt length and
 *     single-service sequences are NOT routing signals (logged misroutes:
 *     long single-service browse commands upgraded to planning).
 *   - open_plan_reply capture is answer-shaped only — "goto john 1" and
 *     "exodus 4 show on my screen" were absorbed by an awaiting-input plan.
 *   - capability gate pin — exact+ready selector verdicts must pin+handoff
 *     (the gate's pin branch was dead code; every service prompt got an
 *     options card).
 */
const assert = require('assert');
const { classify, _complexityPlanningScore } = require('../src/classify.cjs');
const { isPlanAnswerShape, shouldPinGate, PLAN_REPLY_VERB_RE } = require('../src/planReply.cjs');
const providers = require('../src/llm-providers.cjs');

const realAsk = providers.ask;
let tests = 0, passed = 0;

async function withAsk(impl, fn) {
  providers.ask = impl;
  try { return await fn(); } finally { providers.ask = realAsk; }
}
function check(name, cond) { tests++; if (cond) { passed++; console.log(`  PASS: ${name}`); } else { console.error(`  FAIL: ${name}`); } }

(async () => {
  console.log('\nplanning-route tests');

  // ── Explicit draft-intent phrasing → deterministic planning guard ────────
  // Regression: "let's plan a trip" failed the old regex (plan-as-verb has
  // no middle verb) and fell to the LLM.

  const planningPhrases = [
    "let's plan a trip to Denver",
    "lets plan my week",
    "let's brainstorm ideas",
    "help me think through this",
    "think it through",
    "I need to work out an idea",
    "work out an approach",
    "let's figure out an approach",
    "can we map out a strategy",
    "map out a roadmap",
    "I want to hash out the details",
    "pick your brain on this",
    "let's come up with a plan to reorganize",
    "help me make a plan",
  ];
  for (const p of planningPhrases) {
    await withAsk(async () => { throw new Error('LLM must not be called — phrase guard fires first'); }, async () => {
      const r = await classify(p);
      check(`"${p}" → planning (phrase guard)`, r.intent === 6 && r.source === 'planning_phrase_guard');
    });
  }

  // ── Execution phrasing must NOT hit the phrase guard ─────────────────────
  // "follow/execute/run/cancel the plan" is a task command about a plan,
  // not a request to draft one.

  const nonPlanningPhrases = [
    'follow this plan',
    'execute the plan',
    'run the plan now',
  ];
  for (const p of nonPlanningPhrases) {
    await withAsk(async () => ({ text: '0', provider: 'mock' }), async () => {
      const r = await classify(p);
      check(`"${p}" → not planning-phrase (${r.source})`,
        r.intent !== 6 && r.source !== 'planning_phrase_guard');
    });
  }

  // ── Complexity scorer — multi-service ONLY ────────────────────────────────
  // Prompt length and single-service sequencing are not planning signals.

  let cx = _complexityPlanningScore('create a google doc, then add a calendar event and a spreadsheet');
  check('doc + calendar + sheet → multi-deliverable', cx.score === 1 && cx.services >= 2);

  cx = _complexityPlanningScore('add to my amazon cart and send me an email when done');
  check('amazon + email → multi-deliverable', cx.score === 1 && cx.services >= 2);

  cx = _complexityPlanningScore('go to amazon, search for ESV bibles, click the first result, read the reviews and summarize them');
  check('single-service sequenced browse → NOT planning', cx.score === 0);

  cx = _complexityPlanningScore('open youtube, search for a video about the history of the roman empire, watch a bit of it, then tell me the three most interesting facts you learned from the description and the comments below it');
  check('long single-service prompt → NOT planning (length is not a signal)', cx.score === 0);

  // ── Answer-shape for open_plan_reply ─────────────────────────────────────

  const openPlan = { planId: 'p1', awaitingInput: true, boundToSession: true, routeOptions: [{ label: 'browser (app)' }, { label: 'nylas' }] };

  check('"goto john 1" → new command, not a plan answer', !isPlanAnswerShape('goto john 1', openPlan));
  check('"exodus 4 show on my screen" → new command', !isPlanAnswerShape('exodus 4 show on my screen', openPlan));
  check('"browser (app)" → route pick (label match)', isPlanAnswerShape('browser (app)', openPlan));
  check('"nylas" → route pick', isPlanAnswerShape('nylas', openPlan));
  check('"555-0134" → verb-free answer', isPlanAnswerShape('555-0134', openPlan));
  check('"Messages" → verb-free answer', isPlanAnswerShape('Messages', openPlan));
  check('"the first one" → ordinal pick', isPlanAnswerShape('the first one', openPlan));
  check('"option 2" → ordinal pick', isPlanAnswerShape('option 2', openPlan));
  check('"go to amazon and look up bibles" → command', !isPlanAnswerShape('go to amazon and look up bibles', openPlan));
  check('empty reply → not answer-shaped', !isPlanAnswerShape('', openPlan));

  // ── Capability gate pin mapping ───────────────────────────────────────────

  check('pin + no missing info → pin', shouldPinGate('pin', null) === true);
  check('pin + missing recipient → NOT pin (options ask for it)', shouldPinGate('pin', 'recipient') === false);
  check('needs_setup → not pin', shouldPinGate('needs_setup', null) === false);
  check('clarify → not pin', shouldPinGate('clarify', null) === false);
  check('fallback → not pin', shouldPinGate('fallback', null) === false);
  check('none → not pin', shouldPinGate('none', null) === false);

  // ── Verb table sanity ────────────────────────────────────────────────────

  check('"show" is a verb (was the awaitingInput bypass verb)', PLAN_REPLY_VERB_RE.test('show exodus 4 on my screen'));
  check('"search" is a verb', PLAN_REPLY_VERB_RE.test('search for esv bibles'));
  check('"metallic blue" is verb-free', !PLAN_REPLY_VERB_RE.test('metallic blue'));

  console.log(`\n${passed}/${tests} passed`);
  process.exit(passed === tests ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
