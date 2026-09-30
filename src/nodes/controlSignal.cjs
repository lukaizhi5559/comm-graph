'use strict';

/**
 * controlSignal.cjs — Intent 4: task-cancel signals
 *
 * Handles control commands for running tasks:
 *   - cancel: stop the current running task (aborts its AbortController via
 *     main.js's /comms.signal handler → handoffRunner.cancel)
 *
 * pause/resume were removed: main.js only aborts on 'cancel', so those signals
 * journaled a status and spoke a confirmation while the task kept running —
 * a dishonest reply, and their vocabulary ("resume", "wait", "proceed")
 * false-positive'd on file names like resume.pdf. Re-add when pause/resume
 * are actually implemented.
 *
 * Writes signals to the task journal and notifies main.js.
 * FUTURE: will also handle delete-agent, remove-context-rule, settings changes.
 */

const http = require('http');
const logger = require('../logger.cjs');
const { getActiveTasks, updateTask } = require('../taskJournal.cjs');

const THINKDROP_MAIN_PORT = parseInt(process.env.THINKDROP_MAIN_PORT || '3010', 10);

// ── Signal detection ───────────────────────────────────────────────────────────
const CANCEL_RE = /\b(cancel|stop|abort|never\s*mind|nevermind|forget\s*it|forget\s+that|kill)\b/i;

// Context tags ([File: …], etc.) are metadata, not prose — strip them so a
// path word can't pick the signal type.
const _CONTEXT_TAG_RE = /\[(?:File|Folder|Highlighted|Context|Thought):[^\]]*\]/gi;

/**
 * Detect the control signal type from the English message.
 * @param {string} englishText
 * @returns {{ signalType: 'cancel'|null, taskId: string|null }}
 */
function detectSignal(englishText) {
  const text = String(englishText || '').replace(_CONTEXT_TAG_RE, ' ').trim();

  // Find the most relevant active task
  const active = getActiveTasks();
  const runningTask = active.find(t => t.status === 'running') || active[0] || null;

  if (CANCEL_RE.test(text)) {
    return { signalType: 'cancel', taskId: runningTask?.id || null };
  }

  return { signalType: null, taskId: null };
}

/**
 * Notify main.js of a control signal.
 * @param {string} signalType
 * @param {string} taskId
 * @returns {Promise<boolean>}
 */
function _notifyMain(signalType, taskId) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ signalType, taskId, source: 'comms-graph' });
    const req = http.request({
      hostname: '127.0.0.1',
      port: THINKDROP_MAIN_PORT,
      path: '/comms.signal',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 3000,
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
 * @param {string} englishText  - English user message
 * @param {string} systemPrompt - Full system prompt (persona + personality)
 * @returns {Promise<{ text: string, fullText: string, metadata: Object }>}
 */
async function execute(englishText, systemPrompt) {
  const { signalType, taskId } = detectSignal(englishText);

  if (!signalType) {
    return {
      text: "I didn't catch a clear command. Did you want to cancel something?",
      fullText: "I didn't catch a clear command. Did you want to cancel something?",
      metadata: { source: 'control_signal_unknown', intent: 4 },
    };
  }

  const active = getActiveTasks();
  if (active.length === 0) {
    const pool = [
      "Nothing is running at the moment — nothing to cancel.",
      "All quiet — there's no active task to cancel.",
      "Nothing to cancel, sir. The slate is clean.",
      "No task is in flight right now, so there's nothing to stop.",
    ];
    const response = pool[Math.floor(Math.random() * pool.length)];
    return {
      text: response,
      fullText: response,
      metadata: { source: 'control_signal_no_task', intent: 4, signalType },
    };
  }

  // Notify main.js to execute the signal
  const notified = await _notifyMain(signalType, taskId);

  // Update task journal
  if (taskId) updateTask(taskId, 'cancelled');

  const response = notified
    ? 'Right away — cancelling the current task.'
    : 'I tried to cancel, but something went amiss.';

  logger.info('[ControlSignal] Executed', { signalType, taskId, notified });

  return {
    text: response,
    fullText: response,
    metadata: { source: 'control_signal', intent: 4, signalType, taskId, notified },
  };
}

module.exports = { execute, detectSignal };
