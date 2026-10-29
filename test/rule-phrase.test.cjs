'use strict';
/**
 * rule-phrase.test.cjs — natural-language rule authoring lane entry
 *
 * Observed failure (2026-10-29): "I need to set a rule that if I goto youtube
 * and look at a mike winger video you show me a happy emoji on my screen"
 * missed _isRulePhrase on TWO counts — "goto" (one word) vs the "go\s+to"
 * alternation, and "look at"/"watch" absent from the visit-verb list — fell
 * to intent-6 planning → stub plan + backend hang. The rule checks also ran
 * on raw text BEFORE computeTurnFacts, so a [Highlighted:] blob carrying
 * conditional phrasing could false-author a rule (AGENTS.md violation).
 *
 * Fix: widened anchored visit-verbs + explicit "set a rule" opener on
 * facts.userText, plus a confirmJudgment semantic gate for weak markers
 * (regexes generate candidates; the model arbitrates lane overrides).
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// ── Env BEFORE requires — BACKEND_LLM_URL and rules/plans paths are captured
// at module load time. The stub SSE backend answers the backend contract:
// POST /api/llm/stream → data:{text}… data:{done:true}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'td-rule-test-'));
process.env.COMMS_NO_LISTEN = '1'; // don't bind :3015 — the real service owns it
process.env.THINKDROP_RULES_PATH = path.join(TMP, 'rules.json');
process.env.THINKDROP_PLANS_DIR = path.join(TMP, 'plans');
fs.mkdirSync(process.env.THINKDROP_PLANS_DIR, { recursive: true });

// The rule draft the stubbed "LLM" returns for _parseRuleNl.
const RULE_JSON = JSON.stringify({
  when: { hostMatch: 'youtube.com', titleMatch: 'mike winger' },
  then: { action: 'show_card', kind: 'emoji', emoji: '😄', mood: 'happy' },
});

const llmStub = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/llm/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ text: RULE_JSON })}\n\n`);
    res.write(`data: ${JSON.stringify({ done: true, provider: 'stub' })}\n\n`);
    return res.end();
  }
  res.writeHead(404); res.end();
});

let tests = 0, passed = 0;
function check(name, cond) { tests++; if (cond) { passed++; console.log(`  PASS: ${name}`); } else { console.error(`  FAIL: ${name}`); } }

async function listen(server) {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return server.address().port;
}

(async () => {
  console.log('\nrule-phrase lane tests');

  const port = await listen(llmStub);
  process.env.BACKEND_LLM_URL = `http://127.0.0.1:${port}/api/llm`;

  const providers = require('../src/llm-providers.cjs');
  const decision = require('../src/decision.cjs');
  const { processMessage, _isRulePhrase, _RULE_WEAK_RE } = require('../src/server.cjs');
  const rulesMod = require('../../mcp-services/command-service/src/skill-helpers/rules.cjs');
  const realAsk = providers.ask;
  const realConfirm = decision.confirmJudgment;

  // ── A. Anchored regex coverage ────────────────────────────────────────────
  console.log('anchored phrase coverage');
  check('"goto" (one word) hits', _isRulePhrase('if I goto youtube show me an emoji'));
  check('"look at" hits', _isRulePhrase('if I look at a mike winger video show a happy emoji'));
  check('"watch" hits', _isRulePhrase('whenever I watch a new video on youtube ping me'));
  check('"join" (calls) hits', _isRulePhrase('when I join a zoom meeting remind me to unmute'));
  check('explicit "set a rule" opener hits', _isRulePhrase('I need to set a rule that if I goto youtube and look at a mike winger video you show me a happy emoji on my screen'));
  check('action-first still hits', _isRulePhrase('show me a happy emoji when I visit youtube'));
  // negatives — no authoring signal
  check('no visit verb → miss', !_isRulePhrase('if it rains tomorrow tell me'));
  check('rule question → miss', !_isRulePhrase("what's the rule for expense reports?"));
  check('bare "set a rule" without conditional → miss', !_isRulePhrase('can you set a rule please'));

  // ── B. Weak-marker coverage (semantic-gate candidates) ────────────────────
  console.log('weak markers');
  check('"set a rule" weak', _RULE_WEAK_RE.test('I want to set a rule'));
  check('"every time" weak', _RULE_WEAK_RE.test('every time I open figma'));
  check('"remind me when" weak', _RULE_WEAK_RE.test('remind me when john posts'));
  check('"whenever" weak', _RULE_WEAK_RE.test('whenever it happens'));
  check('plain question not weak', !_RULE_WEAK_RE.test('how does this work'));

  // ── C. Lane entry via processMessage — stub SSE backend feeds _parseRuleNl ─
  console.log('lane entry (stub backend)');
  providers.ask = async () => ({ text: '1', provider: 'mock' }); // fall-through classify → general_quick

  const anchored = await processMessage({ text: 'I need to set a rule that if I goto youtube and look at a mike winger video you show me a happy emoji on my screen' });
  check('anchored prompt enters author lane (guardian source)',
    anchored.intentName === 'guardian' || anchored.metadata?.source === 'guardian');
  check('author lane echoes the understood rule',
    /rule i understood|rule confirm/i.test(anchored.text));

  const confirmed = await processMessage({ text: 'rule confirm' });
  check('"rule confirm" commits the rule', /Rule set:/.test(confirmed.text));
  const persisted = rulesMod.listRules();
  check('rules.json now has the rule', persisted.length === 1
    && persisted[0].when.hostMatch === 'youtube.com'
    && persisted[0].when.titleMatch === 'mike winger'
    && persisted[0].then.kind === 'emoji');
  // Clean up so later tests start empty
  rulesMod.removeRule(persisted[0].id);

  // ── D. confirmJudgment gate on weak markers ───────────────────────────────
  // These phrases must miss the anchored regexes (no visit-verb/action pairing)
  // but carry a weak marker — so they only reach the lane via the verdict.
  console.log('semantic gate');
  let called = 0;
  decision.confirmJudgment = async () => { called++; return 'YES'; };
  const weakYes = await processMessage({ text: 'can you set a rule for me' });
  check('weak marker + YES verdict enters author lane', called === 1
    && (weakYes.intentName === 'guardian' || weakYes.metadata?.source === 'guardian'));
  await processMessage({ text: 'rule cancel' }); // drop the pending draft

  called = 0;
  decision.confirmJudgment = async () => { called++; return 'NO'; };
  const weakNo = await processMessage({ text: 'can you set a rule for me' });
  check('weak marker + NO verdict falls through (not guardian)', called === 1
    && weakNo.intentName !== 'guardian' && weakNo.metadata?.source !== 'guardian');
  decision.confirmJudgment = realConfirm;

  // ── E. userText scoping — blobs must not author rules ────────────────────
  console.log('blob safety');
  called = 0;
  decision.confirmJudgment = async () => { called++; return 'YES'; }; // would fire if reached
  const blobbed = await processMessage({ text: 'read this out [Highlighted: if I goto youtube show me a happy emoji] for me' });
  check('[Highlighted:] blob does NOT reach the rule gate', called === 0
    && blobbed.intentName !== 'guardian' && blobbed.metadata?.source !== 'guardian');
  decision.confirmJudgment = realConfirm;
  providers.ask = realAsk;

  console.log(`\n${passed}/${tests} passed`);
  llmStub.close();
  process.exit(passed === tests ? 0 : 1);
})().catch(e => { console.error(e); llmStub.close(); process.exit(1); });
