'use strict';
/**
 * semantic-rule.test.cjs — semanticMatch/semanticExempt frame judging
 *
 * Motivation: deterministic `when` fields can't express concepts — "block any
 * site with sexual content" degrades to keyword regex that over-fires on news
 * and under-fires on unlabelled content. semanticMatch names the frame (what
 * counts); semanticExempt names the anti-frame (same vocabulary, wrong scene).
 * rules.cjs orchestrates: whenMatches defers any rule asserting semanticMatch,
 * evaluateAsync ANDs deterministic fields first as prefilters, then the
 * caller-injected judge decides (phi4 decision.answer — stubbed here).
 *
 * Covers: whenMatches defer, evaluateAsync judge matrix, prefilter
 * short-circuit, hasSemanticRules, authoring sanitization/describe, and the
 * entry-seam block path through processMessage.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// ── Env BEFORE requires — paths/flags captured at module load ───────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'td-semrule-'));
process.env.COMMS_NO_LISTEN = '1';   // don't bind :3015 — the real service owns it
process.env.COMMS_NO_HISTORY = '1';  // never write test turns into live session history
process.env.THINKDROP_RULES_PATH = path.join(TMP, 'rules.json');
process.env.THINKDROP_PLANS_DIR = path.join(TMP, 'plans');
fs.mkdirSync(process.env.THINKDROP_PLANS_DIR, { recursive: true });

// The rule draft the stubbed "LLM" returns for _parseRuleNl — a frame rule for
// the user's example shape ("block screen for any site with sexual content…").
const SEM_RULE_JSON = JSON.stringify({
  when: {
    semanticMatch: 'sexual material, explicit language, or graphic blood and violence',
    semanticExempt: 'news reporting, medical or educational text, scripture',
  },
  then: { action: 'block', reason: 'restricted content' },
  seam: 'observation',
});

const llmStub = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/llm/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ text: SEM_RULE_JSON })}\n\n`);
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
  console.log('\nsemanticMatch rule tests');

  const port = await listen(llmStub);
  process.env.BACKEND_LLM_URL = `http://127.0.0.1:${port}/api/llm`;

  const providers = require('../src/llm-providers.cjs');
  const decision = require('../src/decision.cjs');
  const { processMessage, _isRulePhrase, _RULE_WEAK_RE } = require('../src/server.cjs');
  const rulesMod = require('../../mcp-services/command-service/src/skill-helpers/rules.cjs');
  const realAsk = providers.ask;
  const realAskDecision = decision.askDecision;
  const realConfirm = decision.confirmJudgment;

  // ── A. whenMatches — semanticMatch defers (can never match the sync path) ──
  console.log('whenMatches defer');
  check('semantic-only when → false', !rulesMod.whenMatches({ semanticMatch: 'explicit' }, { ocrText: 'explicit stuff here' }));
  check('hostMatch+semanticMatch with matching host → still false (no bypass)',
    !rulesMod.whenMatches({ hostMatch: 'bad.com', semanticMatch: 'x' }, { url: 'https://bad.com/v' }));
  check('deterministic fields unaffected', rulesMod.whenMatches({ hostMatch: 'bad.com' }, { url: 'https://bad.com/v' }));

  // ── B. evaluateAsync — judge matrix + prefilter short-circuit ─────────────
  console.log('evaluateAsync');
  rulesMod.addRule({ id: 'sem1', seam: 'entry', when: { semanticMatch: 'gambling content' }, then: { action: 'block' } });
  check('hasSemanticRules → true', rulesMod.hasSemanticRules());

  const judgeCalls = [];
  const yesJudge = async (f, e) => { judgeCalls.push({ f, e }); return 'YES'; };
  let hits = await rulesMod.evaluateAsync({ prompt: 'open a casino site' }, 'entry', yesJudge);
  check('frame YES → semantic hit', hits.some(r => r.id === 'sem1'));
  check('judge received (frame, exempt=null)', judgeCalls.length === 1
    && judgeCalls[0].f === 'gambling content' && judgeCalls[0].e === null);

  hits = await rulesMod.evaluateAsync({ prompt: 'hi' }, 'entry', async () => 'NO');
  check('NO verdict → no hit', !hits.some(r => r.id === 'sem1'));
  hits = await rulesMod.evaluateAsync({ prompt: 'hi' }, 'entry', async () => null);
  check('null verdict (model down) → no hit (fail-open)', !hits.some(r => r.id === 'sem1'));
  hits = await rulesMod.evaluateAsync({ prompt: 'hi' }, 'entry');
  check('no judge fn → deterministic only', !hits.some(r => r.id === 'sem1'));

  // deterministic prefilter ANDs first — judge must not be called on a miss
  rulesMod.addRule({ id: 'sem2', seam: 'observation', when: { hostMatch: 'bad.com', semanticMatch: 'x' }, then: { action: 'block' } });
  judgeCalls.length = 0;
  await rulesMod.evaluateAsync({ url: 'https://good.com' }, 'observation', async () => { judgeCalls.push(1); return 'YES'; });
  check('prefilter fail → judge NOT called', judgeCalls.length === 0);
  hits = await rulesMod.evaluateAsync({ url: 'https://bad.com/x' }, 'observation', async () => 'YES');
  check('prefilter pass + YES → hit', hits.some(r => r.id === 'sem2'));
  rulesMod.removeRule('sem2');

  // seam filtering — sem1 is seam:'entry', must not fire at observation
  hits = await rulesMod.evaluateAsync({ prompt: 'x', ocrText: 'gambling' }, 'observation', async () => 'YES');
  check('seam mismatch → no hit', !hits.some(r => r.id === 'sem1'));

  // ── C. Authoring — stub backend emits a semanticMatch draft ───────────────
  console.log('authoring');
  check('block+site phrasing is a weak-marker candidate', _RULE_WEAK_RE.test('bring up block screen for any site with sexual content'));
  check('block-any-site is a weak-marker candidate', _RULE_WEAK_RE.test('block any site with sexual content'));
  check('ordinary "block a user" NOT a candidate', !_RULE_WEAK_RE.test('block john on slack'));

  providers.ask = async () => ({ text: '1', provider: 'mock' }); // classify fall-through → general_quick
  decision.confirmJudgment = async () => 'YES'; // weak-marker verdict → author lane

  const auth = await processMessage({ text: 'bring up block screen for any site with sexual content, explicit language, or blood and gore violence' });
  check('weak-marker + YES enters author lane', auth.intentName === 'guardian' || auth.metadata?.source === 'guardian');
  check('echo describes the frame + exempt', /content matches/i.test(auth.text) && /except/i.test(auth.text));
  decision.confirmJudgment = realConfirm;

  const conf = await processMessage({ text: 'rule confirm' });
  check('rule confirm commits', /Rule set:/.test(conf.text));
  const authored = rulesMod.listRules().find(r => r.when?.semanticMatch && !['sem1'].includes(r.id));
  check('semanticMatch persisted', !!authored && authored.when.semanticMatch === 'sexual material, explicit language, or graphic blood and violence');
  check('semanticExempt persisted', authored.when.semanticExempt === 'news reporting, medical or educational text, scripture');
  check('block action persisted', authored.then.action === 'block' && authored.seam === 'observation');
  rulesMod.removeRule(authored.id);

  // ── D. Entry seam — semantic block rule through processMessage ────────────
  console.log('entry seam');
  rulesMod.addRule({ id: 'entsem', seam: 'entry', when: { semanticMatch: 'gambling requests' }, then: { action: 'block', reason: 'no gambling' } });
  // Stub decision.answer — discriminate on the judge's question ids so
  // unrelated decision batches (classifyRoute etc.) get null, not this shape.
  decision.askDecision = async (qs) => (Array.isArray(qs) && qs.some(q => q.id === 'frame')
    ? { answers: { frame: { label: 'YES' }, exempt: { label: 'NO' } }, elapsedMs: 1 }
    : null);
  const blocked = await processMessage({ text: 'find me a casino to bet at' });
  check('semantic entry rule blocks the prompt', /blocked by guardian rule/.test(blocked.text));

  decision.askDecision = async (qs) => (Array.isArray(qs) && qs.some(q => q.id === 'frame')
    ? { answers: { frame: { label: 'YES' }, exempt: { label: 'YES' } }, elapsedMs: 1 }
    : null);
  const exempted = await processMessage({ text: 'explain card counting in blackjack for a school project' });
  check('exempt YES → falls through unblocked', !/blocked by guardian rule/.test(exempted.text));

  decision.askDecision = async () => null; // phi4 down
  const open = await processMessage({ text: 'find me a casino to bet at' });
  check('judge unreachable → fail-open unblocked', !/blocked by guardian rule/.test(open.text));

  decision.askDecision = realAskDecision;
  decision.confirmJudgment = realConfirm;
  providers.ask = realAsk;

  console.log(`\n${passed}/${tests} passed`);
  llmStub.close();
  process.exit(passed === tests ? 0 : 1);
})().catch(e => { console.error(e); llmStub.close(); process.exit(1); });
