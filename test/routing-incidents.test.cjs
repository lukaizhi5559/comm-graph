'use strict';
/**
 * routing-incidents.test.cjs — regression for the three misroutes found in
 * the 2026-11-03 routing audit:
 *
 *   1. "Do you still know the path to the thinkdrop project" — the model's
 *      handoff pick was vetoed to general_quick by a keyword hit (blind answer
 *      + an offer to "search your computer" it couldn't serve); then "search
 *      for it" hit the explicit-search guard → public SERP for the resolved
 *      subject instead of a local filesystem search.
 *   2. Highlight + "I need a response to the recent message for this" — the
 *      <comm-noun> <person> rule matched "message for" (a preposition) →
 *      command_automate → selection action veto → browser takeover of the
 *      user's LinkedIn tab.
 *   3. Zombie "Replanning" card settle — covered by loop-back-settle.test.cjs.
 *
 * Mocks: llm-providers.ask (remote classify leg) + decision.askDecision
 * (local leg — null → falls to remote). decision.confirmJudgment is patched
 * per-case to drive the semantic gates.
 *
 * Run: node comms-graph/test/routing-incidents.test.cjs
 */

const { guess } = require('../src/intentGuesser.cjs');
const decision = require('../src/decision.cjs');
const llmProviders = require('../src/llm-providers.cjs');
const { classify } = require('../src/classify.cjs');
const { deriveLane, derivePlanShape } = require('../src/route-decision.cjs');

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  PASS: ${name}`); }
  else { failed++; console.error(`  FAIL: ${name}${extra ? ' — ' + extra : ''}`); }
}

(async () => {
  const realAsk = llmProviders.ask;
  const realAskDecision = decision.askDecision;
  const realConfirm = decision.confirmJudgment;
  // Local decision leg always unavailable → remote leg (mocked ask) decides.
  decision.askDecision = async () => null;

  // ── 1. <comm-noun> <person>: prepositions/determiners are NOT recipients ──
  check('"message for this" is NOT command_automate',
    guess('I need a response to the recent message for this').guessedIntent !== 'command_automate');
  check('"email John the report" still command_automate',
    guess('email John the report').guessedIntent === 'command_automate');
  check('"text my mom" still command_automate',
    guess('text my mom').guessedIntent === 'command_automate');
  check('"message Sarah about lunch" still command_automate',
    guess('message Sarah about lunch').guessedIntent === 'command_automate');
  check('"call the office" still command_automate',
    guess('call the office').guessedIntent === 'command_automate');

  // ── 2. Explicit-search guard: context-dependent / offer-reply never pins 8 ──
  llmProviders.ask = async () => ({ text: null }); // remote leg dead → default_handoff
  const offerCtx = 'User: Do you still know the path to the thinkdrop project\n'
    + 'Assistant: I do not have that path in memory — want me to search your computer for it?';

  const r1 = await classify('search for it', null);
  check('"search for it" alone does NOT pin web_search', r1.intent !== 8, `got ${r1.intentName}/${r1.source}`);

  const r2 = await classify('search for it', offerCtx);
  check('"search for it" as offer reply does NOT pin web_search', r2.intent !== 8, `got ${r2.intentName}/${r2.source}`);

  const r3 = await classify('search for the best gluten-free pasta recipe', null);
  check('standalone self-contained lookup still pins web_search', r3.intent === 8, `got ${r3.intentName}/${r3.source}`);

  // ── 3. Offer-echo consent — short imperative echo of an offer → handoff ──
  decision.confirmJudgment = async () => 'YES';
  const r4 = await classify('search for it', offerCtx);
  check('offer-echo + YES verdict → handoff', r4.intent === 0 && r4.source === 'offer_echo_guard',
    `got ${r4.intentName}/${r4.source}`);

  decision.confirmJudgment = async () => 'NO';
  const r5 = await classify('search for it', offerCtx);
  check('offer-echo + NO verdict → falls through, still NOT web_search', r5.intent !== 8,
    `got ${r5.intentName}/${r5.source}`);

  // ── 4. Keyword veto of a model pick — semantic verdict required ──
  // Model leg returns 0 (handoff); keyword tier claims general_quick.
  llmProviders.ask = async () => ({ text: '0', provider: 'mock' });

  decision.confirmJudgment = async () => 'CHAT';
  const r6 = await classify('tell me a joke', null);
  check('model-0 + CHAT verdict → keyword adopted', r6.intent === 1, `got ${r6.intentName}/${r6.source}`);

  decision.confirmJudgment = async () => 'GRAPH';
  const r7 = await classify('tell me a joke', null);
  check('model-0 + GRAPH verdict → handoff kept', r7.intent === 0 && r7.source === 'keyword_veto_denied',
    `got ${r7.intentName}/${r7.source}`);

  decision.confirmJudgment = async () => null;
  const r8 = await classify('tell me a joke', null);
  check('model-0 + null verdict → handoff kept (fail-open to model)', r8.intent === 0,
    `got ${r8.intentName}/${r8.source}`);

  // ── 5. Envelope: planShape + lane derivation for the executor veto ──
  check('planShape single — local_file deliverable',
    derivePlanShape({ taskType: 'local_file', suggestedIntent: 'command_automate' }) === 'single');
  check('planShape single — local_system',
    derivePlanShape({ taskType: 'local_system', suggestedIntent: 'command_automate' }) === 'single');
  check('planShape complex — service task', derivePlanShape({ taskType: 'browser', targetService: 'linkedin' }) === 'complex');
  check('planShape complex — multi_step', derivePlanShape({ taskType: 'local_file', suggestedIntent: 'multi_step' }) === 'complex');
  check('planShape complex — recurring', derivePlanShape({ taskType: 'local_system', isRecurring: true }) === 'complex');
  check('planShape complex — needs clarification',
    derivePlanShape({ taskType: 'local_file', needsClarification: true }) === 'complex');
  check('planShape null — ambiguous', derivePlanShape({ taskType: 'ambiguous' }) === null);
  check('planShape null — no taskType', derivePlanShape({}) === null);

  check('deriveLane screen_display → screen lane',
    deriveLane({ taskType: 'query', suggestedIntent: 'screen_display' }) === 'screen_display');
  check('deriveLane screen-follow-up stays handoff',
    deriveLane({ taskType: 'query', suggestedIntent: 'screen_display', isScreenFollowUp: true }) === 'handoff');
  check('deriveLane service task stays handoff',
    deriveLane({ taskType: 'messaging', suggestedIntent: 'command_automate', targetService: 'slack' }) === 'handoff');

  decision.confirmJudgment = realConfirm;
  decision.askDecision = realAskDecision;
  llmProviders.ask = realAsk;
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
