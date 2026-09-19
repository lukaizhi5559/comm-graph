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
const { createTask, updateTask } = require('./taskJournal.cjs');
const { tryAcquire, release, isLocked, getWaitingCount } = require('./agentLock.cjs');

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
  for (const { agentId, pattern } of AGENT_PATTERNS) {
    if (pattern.test(englishPrompt)) return agentId;
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
 * @returns {Promise<boolean>} true if notification was sent
 */
function _notifyMain(taskId, englishPrompt, agentId, source, originalPrompt, guessedIntent, sessionId = null, userApproved = false) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      taskId,
      prompt: englishPrompt,
      agentId,
      source,
      originalPrompt: originalPrompt || englishPrompt,
      guessedIntent: guessedIntent !== undefined ? guessedIntent : null,
      sessionId: sessionId || null,
      userApproved: userApproved === true,
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
 * Execute a handoff: create task, check lock, notify main.js.
 *
 * @param {Object} args
 * @param {string} args.englishPrompt  - English translation of user request
 * @param {string} args.source        - 'voice' or 'text'
 * @param {string|null} [args.originalPrompt] - Non-English original (for display)
 * @param {string|null} [args.guessedIntent] - comms-graph regex guess (forwarded to main.js)
 * @param {string|null} [args.sessionId] - Conversation session this prompt was routed into
 * @returns {Promise<{ taskId: string, agentId: string|null, parked: boolean, waitingBehind: string|null }>}
 */
async function execute({ englishPrompt, source, originalPrompt, guessedIntent, sessionId = null, userApproved = false }) {
  const agentId = detectAgent(englishPrompt);

  // Create task in journal
  const taskId = createTask({
    prompt: englishPrompt,
    agentId,
    intent: 'handoff',
    source,
    sessionId,
    userApproved,
  });

  // Try to acquire agent lock
  const { acquired, waitingBehind } = tryAcquire(agentId, taskId);

  if (acquired) {
    // Lock acquired — notify main.js to spawn stategraph run
    updateTask(taskId, 'queued');
    const notified = await _notifyMain(taskId, englishPrompt, agentId, source, originalPrompt, guessedIntent, sessionId, userApproved);
    if (!notified) {
      logger.warn('[Handoff] Failed to notify main.js — task will be picked up on retry', { taskId });
    }
    logger.info('[Handoff] Dispatched', { taskId, agentId, source });
  } else {
    // Parked — waiting for agent lock
    logger.info('[Handoff] Parked — waiting for agent lock', {
      taskId, agentId, waitingBehind,
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
 */
function complete(taskId, agentId, status, result, items, sessionId = null, planFile = null) {
  updateTask(taskId, status, { result: result || null, items: items || null, sessionId, ...(planFile ? { planFile } : {}) });
  if (agentId) {
    const nextTaskId = release(agentId, taskId);
    if (nextTaskId) {
      // A waiting task was resumed — notify main.js to start it.
      // Re-guess the intent so the resumed task:created carries it (the guess
      // is not stored in the journal — task.intent stays 'handoff').
      const task = require('./taskJournal.cjs').getTask(nextTaskId);
      if (task) {
        const guessedIntent = require('./intentGuesser.cjs').guess(task.prompt).guessedIntent;
        _notifyMain(nextTaskId, task.prompt, task.agentId, task.source, null, guessedIntent, task.sessionId, task.userApproved === true)
          .catch(() => {});
      }
    }
  }
  logger.info('[Handoff] Completed', { taskId, agentId, status });
}

/**
 * Remove a task from the journal and release any held agent lock.
 * @param {string} taskId
 * @returns {boolean}
 */
function remove(taskId) {
  const task = require('./taskJournal.cjs').getTask(taskId);
  if (!task) return false;
  // If the task is active or waiting on an agent, release that agent's lock
  const activeStatuses = ['queued', 'running', 'waiting-for-agent', 'awaiting-approval', 'waiting-for-input'];
  if (activeStatuses.includes(task.status) && task.agentId) {
    const nextTaskId = release(task.agentId, taskId);
    if (nextTaskId) {
      const nextTask = require('./taskJournal.cjs').getTask(nextTaskId);
      if (nextTask) {
        const guessedIntent = require('./intentGuesser.cjs').guess(nextTask.prompt).guessedIntent;
        _notifyMain(nextTaskId, nextTask.prompt, nextTask.agentId, nextTask.source, null, guessedIntent, nextTask.sessionId, nextTask.userApproved === true)
          .catch(() => {});
      }
    }
  }
  const deleted = require('./taskJournal.cjs').deleteTask(taskId);
  logger.info('[Handoff] Removed', { taskId, deleted });
  return deleted;
}

module.exports = { execute, complete, remove, detectAgent, isLocked, getWaitingCount };
