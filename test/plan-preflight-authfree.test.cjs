'use strict';

// planPreflight no-auth classification tests — the observed failure was a
// plan whose only task used catt.agent (a local Chromecast CLI with no auth
// surface) being BLOCKED by the run gate because the ledger had no entry,
// which emitted preflight:open-agents-tab and dead-ended the user on the
// Agents tab. There was no login to perform — nothing could ever clear it.
//
// Invariants under test:
//   1. Registered cli/app/mcp agent + no secrets + no ledger → 'none-required'
//   2. Browser agent with no ledger → 'unknown' (still blocks)
//   3. Ledger needsAuth:1 (numeric) → 'needs sign-in'; needsAuth:0 → 'none-required'
//   4. cli agent WITH declared secrets → 'unknown' → assessRunGateAsync
//      resolves: all stored → pass; missing → blocked with concrete reason
//   5. Stale/inconclusive ledger entry on a no-secrets cli → 'none-required'

const fs = require('fs');
const os = require('os');
const path = require('path');

// ── Isolate ledger + agents dir BEFORE requiring planPreflight ──────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'td-preflight-'));
const LEDGER_FILE = path.join(TMP, 'preflight-auth-cache.json');
const AGENTS_DIR = path.join(TMP, 'agents');
fs.mkdirSync(AGENTS_DIR, { recursive: true });
process.env.THINKDROP_PREFLIGHT_AUTH_CACHE = LEDGER_FILE;
process.env.THINKDROP_AGENTS_DIR = AGENTS_DIR;

const _agent = (id, type, extra = '') =>
  `---\nid: ${id}\ntype: ${type}\nservice: ${id.replace('.agent', '')}\n${extra}---\n`;

// No-secrets local tools — must never be auth-gated.
fs.writeFileSync(path.join(AGENTS_DIR, 'castbox.agent.md'),
  _agent('castbox.agent', 'cli', 'cli_tool: castbox\n'));
fs.writeFileSync(path.join(AGENTS_DIR, 'desktop.tool.agent.md'),
  _agent('desktop.tool.agent', 'app', ''));
// Credential-backed CLI — declared secrets go through the async resolver.
fs.writeFileSync(path.join(AGENTS_DIR, 'keycli.agent.md'),
  _agent('keycli.agent', 'cli', 'cli_tool: keycli\nsecrets: [KEYCLI_API_KEY]\n'));
// Browser service — still an auth decision.
fs.writeFileSync(path.join(AGENTS_DIR, 'webapp.agent.md'),
  _agent('webapp.agent', 'browser', 'start_url: https://webapp.example\n'));

const pp = require('../src/planPreflight.cjs');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name); console.log(`  ✗ ${name} ${extra}`); }
}

const _setLedger = (obj) => fs.writeFileSync(LEDGER_FILE, JSON.stringify(obj));

(async () => {
  // ── 1. No ledger: descriptor decides ──────────────────────────────────────
  _setLedger({});
  check('cli agent no-secrets → none-required',
    pp.assessAgent('castbox.agent').auth === 'none-required');
  check('app agent → none-required',
    pp.assessAgent('desktop.tool.agent').auth === 'none-required');
  check('browser agent no-ledger → unknown',
    pp.assessAgent('webapp.agent').auth === 'unknown');
  check('cli agent WITH secrets → unknown',
    pp.assessAgent('keycli.agent').auth === 'unknown');
  check('unregistered agent → unknown',
    pp.assessAgent('ghost.agent').auth === 'unknown');

  // The original bug — a cast plan must clear the run gate now.
  const gate1 = pp.assessRunGate([{ num: 1, agents: ['castbox.agent'] }]);
  check('cast plan gate clears', gate1.ok === true && gate1.blockers.length === 0);

  const gate2 = pp.assessRunGate([{ num: 1, agents: ['webapp.agent'] }]);
  check('browser plan gate blocks', gate2.ok === false
    && gate2.blockers[0].agentId === 'webapp.agent');

  // ── 2. Ledger needsAuth numeric encoding ──────────────────────────────────
  _setLedger({
    'webapp.agent': { ts: 1, needsAuth: 1 },
    'castbox.agent': { ts: 1, needsAuth: 0 },
  });
  check('needsAuth:1 → needs sign-in',
    pp.assessAgent('webapp.agent').auth === 'needs sign-in');
  check('needsAuth:0 → none-required',
    pp.assessAgent('castbox.agent').auth === 'none-required');

  // ── 3. Inconclusive ledger entry on a no-secrets cli → still none-required ─
  _setLedger({ 'castbox.agent': { ts: 1 } }); // entry exists, says nothing
  check('inconclusive ledger + no-auth descriptor → none-required',
    pp.assessAgent('castbox.agent').auth === 'none-required');

  // ── 4. bypassed flag ──────────────────────────────────────────────────────
  _setLedger({});
  check('bypassed browser agent → bypassed',
    pp.assessAgent('webapp.agent', new Set(['webapp.agent'])).auth === 'bypassed');

  // ── 5. assessRunGateAsync — secrets resolution for 'unknown' blockers ──────
  const secretPath = require.resolve('../../shared/secret-resolve.cjs');
  const origSecret = require.cache[secretPath];

  // 5a. All secrets stored → gate clears.
  require.cache[secretPath] = {
    exports: { resolveAgentSecrets: async () => ({ found: { KEYCLI_API_KEY: 'x' }, missing: [] }) },
  };
  let gate = await pp.assessRunGateAsync([{ num: 1, agents: ['keycli.agent'] }]);
  check('async gate: stored secrets → clear', gate.ok === true);

  // 5b. Missing secrets → blocked with concrete reason.
  require.cache[secretPath] = {
    exports: { resolveAgentSecrets: async () => ({ found: {}, missing: ['KEYCLI_API_KEY'] }) },
  };
  gate = await pp.assessRunGateAsync([{ num: 1, agents: ['keycli.agent'] }]);
  check('async gate: missing secrets → blocked + reason',
    gate.ok === false && /KEYCLI_API_KEY/.test(gate.blockers[0].reason || ''));

  // 5c. Browser 'unknown' untouched by the resolver.
  require.cache[secretPath] = {
    exports: { resolveAgentSecrets: async () => ({ found: { X: 'y' }, missing: [] }) },
  };
  gate = await pp.assessRunGateAsync([{ num: 1, agents: ['webapp.agent'] }]);
  check('async gate: browser unknown still blocks', gate.ok === false);

  if (origSecret) require.cache[secretPath] = origSecret;

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('FAILURES:', failures.join(', ')); process.exit(1); }
})();
