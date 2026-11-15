'use strict';
/**
 * guardian-passcode-gate.test.cjs — passcode hard-gate + unlock grace
 *
 * Motivation: a `block`/`ask` rule with no guardian passcode produces a
 * curtain anyone can click away — protection in name only. So guard actions
 * are refused at authoring until a passphrase exists, and a successful
 * passcode unlock stamps `unlockedUntil` (suppressRule) so the re-fire loop
 * can't instantly re-block the screen the parent just released.
 *
 * Covers: `guardian add` gating (block/ask refused, notify allowed),
 * passphrase set, suppressRule → evaluate/evaluateAsync gating incl. guard
 * actions, grace expiry, listRules surfacing unlockedUntil.
 *
 * Run: node comms-graph/test/guardian-passcode-gate.test.cjs
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ── Env BEFORE requires — paths/flags captured at module load ───────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'td-passgate-'));
process.env.COMMS_NO_LISTEN = '1';   // don't bind :3015 — the real service owns it
process.env.COMMS_NO_HISTORY = '1';  // never write test turns into live session history
process.env.THINKDROP_RULES_PATH = path.join(TMP, 'rules.json');
process.env.THINKDROP_PLANS_DIR = path.join(TMP, 'plans');
fs.mkdirSync(process.env.THINKDROP_PLANS_DIR, { recursive: true });

let tests = 0, passed = 0;
function check(name, cond) {
  tests++;
  if (cond) { passed++; console.log(`  PASS: ${name}`); }
  else { console.error(`  FAIL: ${name}`); }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('\nguardian passcode gate tests');

  const { processMessage } = require('../src/server.cjs');
  const rulesMod = require('../../mcp-services/command-service/src/skill-helpers/rules.cjs');

  // ── A. guardian add — guard actions refused without a passphrase ──────────
  console.log('authoring gate');
  const BLOCK_JSON = JSON.stringify({
    id: 'gate1', seam: 'observation',
    when: { hostMatch: 'explicit.example' },
    then: { action: 'block' },
  });
  const refused = await processMessage({ text: `guardian add ${BLOCK_JSON}` });
  check('block rule refused without passcode', /passcode is required/i.test(refused.text));
  check('rule not stored', !rulesMod.listRules().some(r => r.id === 'gate1'));

  const ASK_JSON = JSON.stringify({
    id: 'gate2', seam: 'entry',
    when: { hostMatch: 'ask.example' },
    then: { action: 'ask' },
  });
  const refusedAsk = await processMessage({ text: `guardian add ${ASK_JSON}` });
  check('ask rule refused without passcode', /passcode is required/i.test(refusedAsk.text));
  check('ask rule not stored', !rulesMod.listRules().some(r => r.id === 'gate2'));

  const NOTIFY_JSON = JSON.stringify({
    id: 'gate3', seam: 'observation',
    when: { hostMatch: 'news.example' },
    then: { action: 'notify', body: 'hi' },
  });
  const allowed = await processMessage({ text: `guardian add ${NOTIFY_JSON}` });
  check('non-guard rule allowed without passcode', /added/i.test(allowed.text));
  check('notify rule stored', rulesMod.listRules().some(r => r.id === 'gate3'));

  // ── B. passphrase set → gated add now commits ─────────────────────────────
  const set = await processMessage({ text: 'guardian passphrase opensesame' });
  check('passphrase set', /passphrase set/i.test(set.text));
  assert(rulesMod.hasPassphrase(), 'hasPassphrase after set');

  const added = await processMessage({ text: `guardian add opensesame ${BLOCK_JSON}` });
  check('block rule commits with passcode', /added/i.test(added.text));
  check('block rule stored', rulesMod.listRules().some(r => r.id === 'gate1'));

  const badPass = await processMessage({ text: `guardian add wrongpass ${ASK_JSON}` });
  check('wrong passcode still refused', /passphrase required/i.test(badPass.text)
    && !rulesMod.listRules().some(r => r.id === 'gate2'));

  // ── C. suppressRule — unlock grace gates evaluation ───────────────────────
  console.log('unlock grace');
  const ctx = { url: 'https://explicit.example/page' };
  let hits = rulesMod.evaluate(ctx, 'observation');
  check('block rule matches before unlock', hits.some(r => r.id === 'gate1'));

  const sup = rulesMod.suppressRule('gate1', 60_000);
  check('suppressRule ok', sup.ok === true && sup.unlockedUntil > Date.now());
  hits = rulesMod.evaluate(ctx, 'observation');
  check('suppressed → no hit (guard actions included)', !hits.some(r => r.id === 'gate1'));

  // evaluateAsync honors it too — semanticMatch rules skip the judge entirely
  rulesMod.addRule({ id: 'gate4', seam: 'observation', when: { semanticMatch: 'explicit content' }, then: { action: 'block' } });
  rulesMod.suppressRule('gate4', 60_000);
  let judged = 0;
  const ahits = await rulesMod.evaluateAsync(ctx, 'observation', async () => { judged++; return 'YES'; });
  check('evaluateAsync skips suppressed semantic rule (no judge call)', judged === 0 && !ahits.some(r => r.id === 'gate4'));

  // Short grace lapses → the rule re-arms on the next eval
  rulesMod.suppressRule('gate1', 1);
  await sleep(5);
  hits = rulesMod.evaluate(ctx, 'observation');
  check('grace expired → rule matches again', hits.some(r => r.id === 'gate1'));

  const listed = rulesMod.listRules().find(r => r.id === 'gate4');
  check('listRules surfaces unlockedUntil', typeof listed.unlockedUntil === 'number' && listed.unlockedUntil > 0);

  // suppressRule validates input
  check('suppressRule rejects unknown rule', rulesMod.suppressRule('nope', 1000).ok === false);
  check('suppressRule rejects bad duration', rulesMod.suppressRule('gate1', 0).ok === false);

  console.log(`\n${passed}/${tests} passed`);
  process.exit(passed === tests ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
