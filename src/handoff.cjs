'use strict';

/**
 * handoff.cjs — Async stategraph handoff with per-agent locking
 *
 * When the intent classifier returns 0 (handoff), this module:
 *   1. Resolves the target agentId from the prompt (if determinable)
 *   2. Checks the agent lock — acquire or park
 *   3. If acquired: notifies main.js to spawn a concurrent stategraph run
 *   4. Returns a handoff phrase (generated through the personality layer)
 *
 * The actual stategraph execution happens in main.js/handoffRunner.js.
 * This module just coordinates the lock + task journal + notification.
 */

const http = require('http');
const logger = require('./logger.cjs');
const { createTask, updateTask, getTask } = require('./taskJournal.cjs');
const { RUN_LOCK_KEY, tryAcquire, release, isLocked, getWaitingCount } = require('./agentLock.cjs');

const THINKDROP_MAIN_PORT = parseInt(process.env.THINKDROP_MAIN_PORT || '3010', 10);

// ── Agent detection from prompt ────────────────────────────────────────────────
// Lightweight regex to guess the target agent from the English prompt.
// This is a hint — the main stategraph's resolveAgent node does the real resolution.
const AGENT_PATTERNS = [
  { agentId: 'chatgpt.agent',   pattern: /\b(chatgpt|chat\s*gpt|openai)\b/i },
  { agentId: 'claude.agent',     pattern: /\b(claude|anthropic)\b/i },
  { agentId: 'perplexity.agent', pattern: /\b(perplexity)\b/i },
  { agentId: 'grok.agent',       pattern: /\b(grok|x\.ai)\b/i },
  { agentId: 'gmail.agent',      pattern: /\b(gmail|google\s*mail)\b/i },
  { agentId: 'youtube.agent',    pattern: /\b(youtube|yt)\b/i },
  { agentId: 'amazon.agent',     pattern: /\b(amazon)\b/i },
  { agentId: 'twitter.agent',    pattern: /\b(twitter|x\.com|tweet)\b/i },
  { agentId: 'reddit.agent',     pattern: /\b(reddit)\b/i },
  { agentId: 'github.agent',     pattern: /\b(github|git\s*hub)\b/i },
  { agentId: 'notion.agent',     pattern: /\b(notion)\b/i },
  { agentId: 'slack.agent',      pattern: /\b(slack)\b/i },
  { agentId: 'spotify.agent',    pattern: /\b(spotify)\b/i },
  { agentId: 'netflix.agent',    pattern: /\b(netflix)\b/i },
];

/**
 * Try to detect the target agent from the prompt text.
 * Returns the first matching agentId, or null if no match.
 * @param {string} englishPrompt
 * @returns {string|null}
 */
function detectAgent(englishPrompt) {
  // Agent hints come from the USER'S words only — attachment blobs and bare
  // email addresses are content, not intent (observed: a highlighted
  // "…@gmail.com" inside a resume dispatched the analysis to gmail.agent).
  const { _stripTags } = require('../../shared/decision-state.cjs');
  const clean = _stripTags(englishPrompt).replace(/\S+@\S+/g, ' ');
  for (const { agentId, pattern } of AGENT_PATTERNS) {
    if (pattern.test(clean)) return agentId;
  }
  return null;
}

/**
 * Notify main.js to spawn a concurrent stategraph run for a task.
 * POSTs to main.js /comms.handoff endpoint.
 *
 * @param {string} taskId
 * @param {string} englishPrompt
 * @param {string} agentId
 * @param {string} source  - 'voice' or 'text'
 * @param {string|null} originalPrompt - non-English original (for display)
 * @param {string|null} [guessedIntent] - comms-graph regex guess (for early sound/UX)
 * @param {string|null} [sessionId] - Conversation session this task belongs to
 * @param {object|null} [thoughtContext] - Proactive card being replied to { id, text, tag }
 * @returns {Promise<boolean>} true if notification was sent
 */
function _notifyMain(taskId, englishPrompt, agentId, source, originalPrompt, guessedIntent, sessionId = null, userApproved = false, thoughtContext = null, planMeta = null, detectedLanguage = null, capabilityReason = null, routeDecision = null) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      taskId,
      prompt: englishPrompt,
      agentId,
      source,
      originalPrompt: originalPrompt || englishPrompt,
      detectedLanguage: detectedLanguage || null,
      guessedIntent: guessedIntent !== undefined ? guessedIntent : null,
      sessionId: sessionId || null,
      userApproved: userApproved === true,
      thoughtContext: thoughtContext || null,
      ...(capabilityReason ? { capabilityReason } : {}),
      // RouteDecision envelope — the single upstream classification;
      // resolveReferencesV2 consumes it instead of re-classifying.
      ...(routeDecision ? { routeDecision } : {}),
      ...(planMeta && planMeta.planId ? { planId: planMeta.planId } : {}),
      ...(planMeta && planMeta.planTaskNum ? { planTaskNum: planMeta.planTaskNum } : {}),
      ...(planMeta && planMeta.planTask ? { planTask: true } : {}),
      ...(planMeta && planMeta.preflightAuthBypass?.length ? { preflightAuthBypass: planMeta.preflightAuthBypass } : {}),
      ...(planMeta && Array.isArray(planMeta.deterministicPlan) && planMeta.deterministicPlan.length
        ? { deterministicPlan: planMeta.deterministicPlan } : {}),
      ...(planMeta && Array.isArray(planMeta.priorResults) && planMeta.priorResults.length
        ? { priorResults: planMeta.priorResults } : {}),
      ...(planMeta && planMeta.allowPlannerFallback ? { allowPlannerFallback: true } : {}),
      ...(planMeta && Array.isArray(planMeta.refs) && planMeta.refs.length
        ? { refs: planMeta.refs } : {}),
    });
    const req = http.request({
      hostname: '127.0.0.1',
      port: THINKDROP_MAIN_PORT,
      path: '/comms.handoff',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 5000,
    }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve(res.statusCode === 200));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write(body);
    req.end();
  });
}

/**
 * Lock key for a dispatch: user-facing work (text/voice prompts AND plan
 * tasks) shares the single __run__ lane — one interactive run at a time,
 * FIFO. Background thought dispatches keep per-agent locking so the Brain
 * can run while the user works.
 */
function _lockKeyFor(source, planTask, agentId) {
  const isThought = source === 'proactive' && !planTask;
  return isThought ? agentId : RUN_LOCK_KEY;
}

/**
 * Notify main.js for a task that just (re)gained its locks. Re-checks the
 * task's service agent for non-thought tasks — a thought may hold it, in
 * which case the task parks on the agent queue while KEEPING the run lane
 * (lock ordering __run__ → agent is consistent; no deadlock).
 */
function _resumeNotify(nextTaskId) {
  const task = getTask(nextTaskId);
  if (!task || task.status === 'cancelled') return;
  const isThought = task.source === 'proactive' && !(task.planMeta && task.planMeta.planTask);
  if (!isThought && task.agentId) {
    const r = tryAcquire(task.agentId, nextTaskId);
    if (!r.acquired) return; // parked on the agent queue — notified on agent release
  }
  const guessedIntent = require('./intentGuesser.cjs').guess(task.prompt).guessedIntent;
  _notifyMain(nextTaskId, task.prompt, task.agentId, task.source, task.originalPrompt || null, guessedIntent, task.sessionId, task.userApproved === true, task.thoughtContext || null, task.planMeta || null, task.detectedLanguage || null, null, task.routeDecision || null)
    .catch(() => {});
}

/**
 * Release every lock a task could hold (run lane + service agent) and resume
 * whatever was parked behind each.
 */
function _releaseTask(taskId, agentIdHint) {
  const task = getTask(taskId);
  const keys = new Set();
  // The interactive lane is always worth a release attempt — release()
  // no-ops for non-holders, and a journal-miss/null-agent task can ONLY be
  // holding __run__ anyway (unagented work takes no agent lock).
  keys.add(RUN_LOCK_KEY);
  if (task && task.lockKey) keys.add(task.lockKey);
  else if (task) keys.add(_lockKeyFor(task.source, task.planMeta && task.planMeta.planTask, task.agentId));
  else if (agentIdHint) keys.add(agentIdHint); // journal miss — caller's hint
  if (task && task.agentId) keys.add(task.agentId);
  for (const key of keys) {
    if (!key) continue;
    const nextTaskId = release(key, taskId);
    if (nextTaskId) _resumeNotify(nextTaskId);
  }
}

/**
 * Execute a handoff: create task, check lock, notify main.js.
 *
 * @param {Object} args
 * @param {string} args.englishPrompt  - English translation of user request
 * @param {string} args.source        - 'voice' or 'text'
 * @param {string|null} [args.originalPrompt] - Non-English original (for display)
 * @param {string|null} [args.guessedIntent] - comms-graph regex guess (forwarded to main.js)
 * @param {string|null} [args.sessionId] - Conversation session this prompt was routed into
 * @param {object|null} [args.thoughtContext] - Proactive card being replied to { id, text, tag }
 * @returns {Promise<{ taskId: string, agentId: string|null, parked: boolean, waitingBehind: string|null }>}
 */
async function execute({ englishPrompt, source, originalPrompt, detectedLanguage = null, guessedIntent, sessionId = null, userApproved = false, thoughtContext = null, planId = null, planTaskNum = null, planTask = false, preflightAuthBypass = null, agentId: pinnedAgentId = null, deterministicPlan = null, priorResults = null, refs = null, capabilityReason = null, routeDecision = null, allowPlannerFallback = false }) {
  // Plan-dispatched tasks carry the task's canonical agentId so the lock key
  // is the shared session (google_*.agent → google.agent), not prompt text.
  const agentId = pinnedAgentId || detectAgent(englishPrompt);
  // allowPlannerFallback rides planMeta: a no_skill_coverage escalation the
  // user declines re-dispatches here with the flag so stategraph's coverage
  // gate lets the bounded planner run instead of looping back to planning.
  const planMeta = (planId || allowPlannerFallback) ? { planId, planTaskNum, planTask, preflightAuthBypass, deterministicPlan, priorResults, refs, allowPlannerFallback } : null;
  const isThought = source === 'proactive' && !planTask;
  const lockKey = _lockKeyFor(source, planTask, agentId);

  // Create task in journal
  const taskId = createTask({
    prompt: englishPrompt,
    agentId,
    intent: 'handoff',
    source,
    sessionId,
    userApproved,
    thoughtContext,
    planMeta,
    originalPrompt,
    detectedLanguage,
    routeDecision,
  });

  // Persist the lane so complete()/remove() release the right keys even if
  // the source/planMeta inference ever changes shape.
  updateTask(taskId, 'queued', { lockKey });

  // Try to acquire the lane lock (null for unagented thoughts → runs free)
  let acquired = true, waitingBehind = null;
  if (lockKey) {
    const r = tryAcquire(lockKey, taskId);
    acquired = r.acquired; waitingBehind = r.waitingBehind;
  }

  // An interactive task that owns the run lane still can't collide with a
  // thought holding its service agent — park on the agent queue while
  // HOLDING __run__ (everything behind simply waits its turn).
  if (acquired && !isThought && agentId) {
    const r = tryAcquire(agentId, taskId);
    if (!r.acquired) { acquired = false; waitingBehind = r.waitingBehind; }
  }

  if (acquired) {
    // Locks acquired — notify main.js to spawn stategraph run
    updateTask(taskId, 'queued');
    const notified = await _notifyMain(taskId, englishPrompt, agentId, source, originalPrompt, guessedIntent, sessionId, userApproved, thoughtContext, planMeta, detectedLanguage, capabilityReason, routeDecision);
    if (!notified) {
      logger.warn('[Handoff] Failed to notify main.js — task will be picked up on retry', { taskId });
    }
    logger.info('[Handoff] Dispatched', { taskId, agentId, source, lane: lockKey });
  } else {
    // Parked — waiting for the lane or its service agent
    logger.info('[Handoff] Parked — waiting for lock', {
      taskId, agentId, lane: lockKey, waitingBehind,
    });
  }

  return { taskId, agentId, parked: !acquired, waitingBehind };
}

/**
 * Release an agent lock when a task completes (called by main.js via /comms.release).
 *
 * @param {string} taskId
 * @param {string} agentId
 * @param {string} status  - 'done' | 'failed' | 'cancelled'
 * @param {string} [result]
 * @param {Array}  [items] - structured page cards extracted by web.crawl/browser.agent.
 *   Item shape: { title?, imageUrl?, url?, price?, snippet?, hostname?,
 *                mediaType?, videoUrl?, embedUrl?, posterUrl?, duration?,
 *                channel?, sourceUrl? }
 * @param {string|null} [sessionId] - Conversation session the run resolved into
 * @param {object|null} [artifacts] - Run artifacts { steps, savedFilePaths, drafts }
 *   persisted on the task so queue cards re-expand to real outputs after restart.
 */
function complete(taskId, agentId, status, result, items, sessionId = null, planFile = null, trace = null, artifacts = null) {
  updateTask(taskId, status, { result: result || null, items: items || null, sessionId, ...(planFile ? { planFile } : {}), ...(trace ? { trace } : {}), ...(artifacts ? { artifacts } : {}) });
  _releaseTask(taskId, agentId);
  logger.info('[Handoff] Completed', { taskId, agentId, status });
}

/**
 * Remove a task from the journal and release any held agent lock.
 * @param {string} taskId
 * @returns {boolean}
 */
function remove(taskId) {
  const task = getTask(taskId);
  if (!task) {
    // Journal entry already gone — the run lane may still name it holder
    // (e.g. a delete that skipped release). Safe: no-ops for non-holders.
    const nextTaskId = release(RUN_LOCK_KEY, taskId);
    if (nextTaskId) _resumeNotify(nextTaskId);
    return false;
  }
  // Release unless the task is terminal-and-already-released (done/failed —
  // complete() runs _releaseTask). 'cancelled' MUST release: /comms.cancel
  // marks status before remove() runs, so gating on active-only leaked the
  // run lane — every later task parked forever behind the dead holder.
  // _resumeNotify still skips a cancelled next-task, so releasing here can't
  // spawn siblings during a plan cancel.
  if (task.status !== 'done' && task.status !== 'failed') {
    _releaseTask(taskId, task.agentId);
  }
  const deleted = require('./taskJournal.cjs').deleteTask(taskId);
  logger.info('[Handoff] Removed', { taskId, deleted });
  return deleted;
}

// ── Queued-task re-notify sweep ─────────────────────────────────────────────
// _notifyMain can fail (main process down, port stolen by a stale instance —
// observed: a 5h-old zombie Electron held :3010 and every approved plan
// "dispatched" into the void). Tasks then sat `queued` forever — the old log
// line claimed "picked up on retry" but no retry existed. This sweep re-notifies
// queued tasks that never got a `running` ping, up to 3 attempts, then fails
// them honestly so the UI shows the truth instead of a silent stuck queue.
const _notifyAttempts = new Map(); // taskId → attempt count
const SWEEP_INTERVAL_MS = 15 * 1000;
const STALE_QUEUED_MS   = 20 * 1000; // queued with no ack for this long = notify missed
const MAX_NOTIFY_ATTEMPTS = 3;

let _sweepTimer = null;
function startRetrySweep() {
  if (_sweepTimer) return;
  _sweepTimer = setInterval(async () => {
    const journal = require('./taskJournal.cjs');
    for (const task of journal.getActiveTasks()) {
      if (task.status !== 'queued') continue;
      if (Date.now() - (task.createdAt || 0) < STALE_QUEUED_MS) continue;
      const attempts = (_notifyAttempts.get(task.id) || 0) + 1;
      _notifyAttempts.set(task.id, attempts);
      if (attempts > MAX_NOTIFY_ATTEMPTS) {
        logger.warn('[Handoff] Notify retry exhausted — marking task failed', { taskId: task.id, attempts });
        journal.updateTask(task.id, 'failed', {
          error: 'dispatch unreachable — the app did not acknowledge the task (is a stale instance holding the port?)',
        });
        _notifyAttempts.delete(task.id);
        continue;
      }
      logger.info('[Handoff] Re-notifying queued task (attempt ' + attempts + ')', { taskId: task.id });
      try {
        const guessedIntent = require('./intentGuesser.cjs').guess(task.prompt).guessedIntent;
        const ok = await _notifyMain(task.id, task.prompt, task.agentId, task.source, task.originalPrompt || null,
          guessedIntent, task.sessionId, task.userApproved === true, task.thoughtContext || null, task.planMeta || null, task.detectedLanguage || null, null, task.routeDecision || null);
        if (ok) _notifyAttempts.delete(task.id);
      } catch (_) { /* next sweep */ }
    }
  }, SWEEP_INTERVAL_MS);
  _sweepTimer.unref?.();
}

module.exports = { execute, complete, remove, detectAgent, isLocked, getWaitingCount, startRetrySweep };
