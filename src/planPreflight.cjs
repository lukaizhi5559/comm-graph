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
  if (!entry) return { agent: a, auth: 'unknown' };
  if (entry.authed === true && !entry.lastAuthFailedAt) return { agent: a, auth: 'authed' };
  if (entry.authed === false || entry.needsAuth === true || entry.lastAuthFailedAt) {
    return { agent: a, auth: 'needs sign-in', reason: entry.lastAuthFailedReason || null };
  }
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

module.exports = { assessAgent, assessTasks, assessRunGate };
