'use strict';

/**
 * planPreflight.cjs — Planning-phase auth/config assessment
 *
 * Reads the same persistent auth ledger the stategraph's preflightAgents node
 * trusts (~/.thinkdrop/preflight-auth-cache.json — `authed:true` is permanent
 * until a runtime login-wall observation flips it to authed:false) and maps
 * each plan Task's declared agents to an auth state:
 *
 *   'authed'         — ledger trusts the agent
 *   'needs sign-in'  — ledger says auth failed / never verified + web service
 *   'bypassed'       — user explicitly chose "proceed without"
 *   'none-required'  — local/generic skill (shell, cli discovery, edit, app)
 *   'unknown'        — no evidence either way — Run gate asks the user
 *
 * No live probes, no automation — planning must never open a browser or run
 * a CLI merely to assess a draft. Real sign-in still happens through the
 * existing preflight:auth_required → Agents tab flow when the user runs
 * (or explicitly asks to) — this module only classifies + surfaces.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const logger = require('./logger.cjs');
const skillIndex = require('../../shared/skill-index.cjs');

// Non-file names that never need web sign-in. Skill-file coverage is
// automatic — every command-service skill (browser.agent, web.agent,
// tab.map.agent, just.type.agent, …) is a generic execution surface.
const LOCAL_AGENTS = new Set([
  'shell', 'none', 'general_knowledge', 'synthesize',
]);

function _authCacheFile() {
  return process.env.THINKDROP_PREFLIGHT_AUTH_CACHE
    || path.join(os.homedir(), '.thinkdrop', 'preflight-auth-cache.json');
}

let _ledger = null;
let _ledgerPath = null;
let _ledgerMtime = 0;

function _loadLedger() {
  const file = _authCacheFile();
  let mtime = 0;
  try { mtime = fs.statSync(file).mtimeMs; } catch (_) {}
  if (_ledger !== null && _ledgerPath === file && _ledgerMtime === mtime) return _ledger;
  try {
    _ledger = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  } catch (_) { _ledger = {}; }
  _ledgerPath = file;
  _ledgerMtime = mtime;
  return _ledger;
}

/** Canonicalize 'google_docs.agent'/'Google Agent' → 'google.agent' style key. */
function _canonAgent(agentId) {
  if (!agentId) return '';
  let a = String(agentId).trim().toLowerCase().replace(/\s+/g, '.');
  // Skill names that don't end in .agent (shell.run, fs.read, web.crawl, …)
  // are already canonical — don't suffix them into phantom ids.
  if (!a.endsWith('.agent') && !LOCAL_AGENTS.has(a) && !skillIndex.skillExists(a)) a += '.agent';
  return a;
}

// Registered-agent types that never authenticate to a web account.
const _NO_AUTH_AGENT_TYPES = new Set(['cli', 'app', 'mcp']);

// Descriptor consult — service-map knows type/secrets without any probing.
// Advisory only: a resolution failure must not change behavior.
function _describeAgentSafe(agentId) {
  try {
    return require('../../shared/service-map.cjs').describeAgent(agentId);
  } catch (_) {
    return null;
  }
}

// True when the registry says this agent can never need account sign-in —
// a local cli/app/mcp agent that declares no secrets.
function _descriptorNeedsNoAuth(agentId) {
  const desc = _describeAgentSafe(agentId);
  return !!(desc && _NO_AUTH_AGENT_TYPES.has(desc.type)
    && (!Array.isArray(desc.secrets) || desc.secrets.length === 0));
}

/**
 * Assess a single agent's auth state from the ledger.
 * @param {string} agentId
 * @param {Set<string>} [bypassed] - agentIds the user bypassed
 */
function assessAgent(agentId, bypassed = new Set()) {
  const a = _canonAgent(agentId);
  if (!a || a === 'none') return { agent: a, auth: 'none-required' };
  if (LOCAL_AGENTS.has(a)) return { agent: a, auth: 'none-required' };
  // Generic execution surface — a command-service skill file. These never
  // authenticate (browser_agent/web_agent are open-web profiles); per-site
  // auth belongs to the registry service agents, which have no skill files.
  if (skillIndex.skillExists(a)) return { agent: a, auth: 'none-required' };
  if (bypassed.has(a)) return { agent: a, auth: 'bypassed' };

  const entry = _loadLedger()[a] || _loadLedger()[a.replace(/\.agent$/, '')] || null;
  if (!entry) {
    // No ledger evidence — but a registered cli/app/mcp agent that declares
    // no secrets needs no account sign-in (e.g. catt controls Chromecast
    // over the LAN; app agents drive local apps). Without this, 'unknown'
    // dead-ends every first-run local tool on an auth wall that can never
    // be cleared — there is no login to perform.
    if (_descriptorNeedsNoAuth(a)) return { agent: a, auth: 'none-required' };
    return { agent: a, auth: 'unknown' };
  }
  if (entry.authed === true && !entry.lastAuthFailedAt) return { agent: a, auth: 'authed' };
  // needsAuth is recorded by the 0/1 LLM classifier as a NUMBER — `=== true`
  // alone never matched it, so recorded "needs sign-in" silently fell to
  // 'unknown' and recorded "no login needed" was ignored entirely.
  if (entry.authed === false || entry.needsAuth === true || entry.needsAuth === 1 || entry.lastAuthFailedAt) {
    return { agent: a, auth: 'needs sign-in', reason: entry.lastAuthFailedReason || null };
  }
  if (entry.needsAuth === 0) return { agent: a, auth: 'none-required' };
  // Same rule for stale/inconclusive ledger entries — a no-secrets local
  // agent must never sit at 'unknown' (the run gate would block it forever).
  if (_descriptorNeedsNoAuth(a)) return { agent: a, auth: 'none-required' };
  return { agent: a, auth: 'unknown' };
}

/**
 * Assess all tasks in a plan.
 * @param {Array} tasks - plan-format tasks ({num, agents, auth})
 * @param {Set<string>} [bypassed]
 * @returns {{byTask: Map<number,{auth:string,agents:Array}>, authRequired: Array}}
 */
function assessTasks(tasks, bypassed = new Set()) {
  const byTask = new Map();
  const authRequired = [];

  for (const task of (tasks || [])) {
    const assessments = (task.agents || []).map(a => assessAgent(a, bypassed));
    const states = assessments.map(x => x.auth);
    let auth;
    if (!assessments.length) auth = 'unknown';
    else if (states.every(s => s === 'none-required')) auth = 'none-required';
    else if (states.some(s => s === 'needs sign-in')) auth = 'needs sign-in';
    else if (states.every(s => s === 'authed' || s === 'none-required' || s === 'bypassed')) {
      auth = states.includes('bypassed') ? 'bypassed' : 'authed';
    }
    else auth = 'unknown';
    byTask.set(task.num, { auth, agents: assessments });

    for (const a of assessments) {
      if (a.auth === 'needs sign-in' || a.auth === 'unknown') {
        authRequired.push({
          taskNum: task.num,
          agentId: a.agent,
          state: a.auth,
          reason: a.reason || (a.auth === 'unknown' ? 'no auth evidence — may need sign-in' : null),
        });
      }
    }
  }

  logger.info('[PlanPreflight] Assessment', {
    tasks: [...byTask.entries()].map(([n, v]) => `${n}:${v.auth}`).join(', '),
    authRequired: authRequired.length,
  });
  return { byTask, authRequired };
}

/**
 * Run gate — is every task clear to execute?
 * @returns {{ok: boolean, blockers: Array}}
 */
function assessRunGate(tasks, bypassed = new Set()) {
  const { byTask } = assessTasks(tasks, bypassed);
  const blockers = [];
  for (const [num, info] of byTask.entries()) {
    if (info.auth === 'needs sign-in' || info.auth === 'unknown') {
      for (const a of info.agents) {
        if (a.auth === 'needs sign-in' || a.auth === 'unknown') {
          blockers.push({ taskNum: num, agentId: a.agent, state: a.auth });
        }
      }
    }
  }
  return { ok: blockers.length === 0, blockers };
}

/**
 * Async run gate — same sync gate, then resolves declared `secrets:` for any
 * remaining 'unknown' NON-BROWSER blockers. A credential-backed CLI agent is
 * authed when its env keys are actually stored; when they're missing the
 * blocker stays but gains a concrete reason. Browser 'unknown' is untouched
 * — there is no such signal to resolve. (Sync assessRunGate remains for
 * info-render call sites that can't await.)
 */
async function assessRunGateAsync(tasks, bypassed = new Set()) {
  const gate = assessRunGate(tasks, bypassed);
  if (gate.ok) return gate;
  let resolveAgentSecrets = null;
  try {
    ({ resolveAgentSecrets } = require('../../shared/secret-resolve.cjs'));
  } catch (_) {}
  const blockers = [];
  for (const b of gate.blockers) {
    if (b.state !== 'unknown' || !resolveAgentSecrets) { blockers.push(b); continue; }
    try {
      const desc = _describeAgentSafe(b.agentId);
      if (desc && desc.type !== 'browser'
          && Array.isArray(desc.secrets) && desc.secrets.length > 0) {
        const res = await resolveAgentSecrets(b.agentId, desc.secrets);
        if (res && res.missing && res.missing.length === 0) continue;
        blockers.push({
          ...b,
          reason: `missing env keys: ${(res?.missing || desc.secrets).join(', ')}`,
        });
      } else {
        blockers.push(b);
      }
    } catch (_) {
      blockers.push(b);
    }
  }
  return { ok: blockers.length === 0, blockers };
}

module.exports = { assessAgent, assessTasks, assessRunGate, assessRunGateAsync };
