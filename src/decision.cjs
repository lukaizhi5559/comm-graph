'use strict';

/**
 * decision.cjs — local typed-decision client for comms-graph
 *
 * POSTs to phi4's /decision.answer (Ollama-backed typed decision model).
 * Replaces remote force-classification LLM calls (~1.6–12.5s, worst-case
 * observed 900s+) with a single local forward pass (~50–300ms warm).
 *
 * Modes (env):
 *   DECISION_LOCAL=0          — disabled entirely; callers use remote path
 *   DECISION_SHADOW=1         — run local AND remote, log agreement, return
 *                               the REMOTE answer (data collection only)
 *   default                   — local first; on DECISION_UNAVAILABLE /
 *                               malformed / timeout, fall back to remote
 *
 * Shadow logging line (grep for '[DecisionShadow]'):
 *   [DecisionShadow] site=<site> agree=<bool> local=<v> remote=<v> localMs=<n>
 */

const logger = require('./logger.cjs');

const PHI4_URL = process.env.MCP_PHI4_URL || 'http://127.0.0.1:3009';
const PHI4_API_KEY = process.env.MCP_PHI4_API_KEY || process.env.MCP_API_KEY || '';
const DEFAULT_TIMEOUT_MS = parseInt(process.env.DECISION_TIMEOUT_MS || '2000', 10);

function decisionEnabled() {
  return process.env.DECISION_LOCAL !== '0';
}
function shadowMode() {
  return process.env.DECISION_SHADOW === '1';
}

/**
 * Ask the local decision model a batch of typed questions.
 *
 * @param {Array}  questions  [{id, type, question, options?, min?, max?}]
 * @param {object} [opts]     { state?, image?, timeoutMs? }
 * @returns {Promise<object|null>} answers map {id: value} or null on failure
 */
async function askDecision(questions, opts = {}) {
  const start = Date.now();
  try {
    const res = await fetch(`${PHI4_URL}/decision.answer`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(PHI4_API_KEY ? { Authorization: `Bearer ${PHI4_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        version: 'mcp.v1',
        service: 'phi4',
        action: 'decision.answer',
        requestId: `cg_dec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        payload: {
          state: opts.state || '',
          questions,
          ...(opts.image ? { image: opts.image } : {}),
        },
      }),
      signal: AbortSignal.timeout(opts.timeoutMs || DEFAULT_TIMEOUT_MS),
    });
    const body = await res.json().catch(() => null);
    if (!body || body.status !== 'ok' || !body.data?.answers) return null;
    return { answers: body.data.answers, elapsedMs: Date.now() - start, model: body.data.model };
  } catch (err) {
    logger.debug(`[Decision] local decision failed: ${err.message}`);
    return null;
  }
}

/**
 * Shadow helper: run local + remote side by side, log agreement, return remote.
 * `localFn` should return a normalized comparable value (or null).
 * `remoteFn` returns the production answer. Remote stays authoritative.
 */
async function shadowCompare(site, localFn, remoteFn) {
  const remotePromise = Promise.resolve().then(remoteFn);
  let localValue = null;
  let localMs = null;
  let localErr = null;
  try {
    const t0 = Date.now();
    localValue = await localFn();
    localMs = Date.now() - t0;
  } catch (e) {
    localErr = e.message;
  }
  const remoteValue = await remotePromise;
  const agree = localValue != null && remoteValue != null && String(localValue) === String(remoteValue);
  logger.info(`[DecisionShadow] site=${site} agree=${agree} local=${localValue} remote=${remoteValue} localMs=${localMs}${localErr ? ` err=${localErr}` : ''}`);
  return remoteValue;
}

module.exports = { askDecision, decisionEnabled, shadowMode, shadowCompare };
