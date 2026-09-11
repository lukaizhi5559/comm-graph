'use strict';

/**
 * controlSignal.cjs — Intent 4: cancel/pause/resume signals
 *
 * Handles control commands for running tasks:
 *   - cancel: stop the current running task
 *   - pause: pause the current task
 *   - resume: resume a paused task
 *
 * Writes signals to the task journal and notifies main.js.
 * FUTURE: will also handle delete-agent, remove-context-rule, settings changes.
 */

const http = require('http');
const logger = require('../logger.cjs');
const { getActiveTasks, updateTask } = require('../taskJournal.cjs');

const THINKDROP_MAIN_PORT = parseInt(process.env.THINKDROP_MAIN_PORT || '3010', 10);

// ── Signal detection ───────────────────────────────────────────────────────────
const CANCEL_RE = /\b(cancel|stop|abort|never\s*mind|forget\s*it|kill)\b/i;
const PAUSE_RE  = /\b(pause|hold\s+on|wait)\b/i;
const RESUME_RE = /\b(resume|continue|go\s+ahead|keep\s+going)\b/i;

/**
 * Detect the control signal type from the English message.
 * @param {string} englishText
 * @returns {{ signalType: 'cancel'|'pause'|'resume'|null, taskId: string|null }}
 */
function detectSignal(englishText) {
  const text = englishText.trim();

  // Find the most relevant active task
  const active = getActiveTasks();
  const runningTask = active.find(t => t.status === 'running') || active[0] || null;

  if (CANCEL_RE.test(text)) {
    return { signalType: 'cancel', taskId: runningTask?.id || null };
  }
  if (PAUSE_RE.test(text)) {
    return { signalType: 'pause', taskId: runningTask?.id || null };
  }
  if (RESUME_RE.test(text)) {
    const pausedTask = active.find(t => t.status === 'paused') || runningTask;
    return { signalType: 'resume', taskId: pausedTask?.id || null };
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
      text: "I didn't catch a clear command. Did you want to cancel, pause, or resume something?",
      fullText: "I didn't catch a clear command. Did you want to cancel, pause, or resume something?",
      metadata: { source: 'control_signal_unknown', intent: 4 },
    };
  }

  const active = getActiveTasks();
  if (active.length === 0) {
    const response = signalType === 'cancel'
      ? "Nothing is running at the moment. The slate is clean."
      : signalType === 'pause'
      ? "There's nothing to pause right now."
      : "Nothing to resume — the slate is clean.";
    return {
      text: response,
      fullText: response,
      metadata: { source: 'control_signal_no_task', intent: 4, signalType },
    };
  }

  // Notify main.js to execute the signal
  const notified = await _notifyMain(signalType, taskId);

  // Update task journal
  if (taskId) {
    if (signalType === 'cancel') updateTask(taskId, 'cancelled');
    else if (signalType === 'pause') updateTask(taskId, 'paused');
    else if (signalType === 'resume') updateTask(taskId, 'running');
  }

  const responses = {
    cancel:  notified ? 'Right away — cancelling the current task.' : 'I tried to cancel, but something went amiss.',
    pause:   notified ? 'Holding position — task paused. Say resume when ready.' : 'I tried to pause, but something went amiss.',
    resume:  notified ? 'Back in motion. Resuming where we left off.' : 'I tried to resume, but something went amiss.',
  };

  const response = responses[signalType];

  logger.info('[ControlSignal] Executed', { signalType, taskId, notified });

  return {
    text: response,
    fullText: response,
    metadata: { source: 'control_signal', intent: 4, signalType, taskId, notified },
  };
}

module.exports = { execute, detectSignal };
