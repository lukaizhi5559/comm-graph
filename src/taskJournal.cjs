'use strict';

/**
 * taskJournal.cjs — Per-task progress store for comms-graph
 *
 * Tracks every handoff task's lifecycle: enqueued → running → done/failed.
 * Used by:
 *   - status_check intent (intent 3) to answer "how is my task going?"
 *   - Frontend queue cards (via IPC from main.js)
 *   - Agent lock management (which agent is locked by which task)
 *
 * Persists to ~/.thinkdrop/task-journal.json so state survives restarts.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomBytes } = require('crypto');
const logger = require('./logger.cjs');

const JOURNAL_PATH = process.env.TASK_JOURNAL_PATH
  ? process.env.TASK_JOURNAL_PATH.replace('~', os.homedir())
  : path.join(os.homedir(), '.thinkdrop', 'task-journal.json');

// ── In-memory store ────────────────────────────────────────────────────────────
/** @type {Map<string, TaskEntry>} */
const _tasks = new Map();

// ── Types (JSDoc) ──────────────────────────────────────────────────────────────
/**
 * @typedef {'waiting-for-agent'|'queued'|'running'|'done'|'failed'|'cancelled'} TaskStatus
 * @typedef {{ id: string, prompt: string, agentId: string|null, status: TaskStatus, createdAt: number, startedAt: number|null, doneAt: number|null, error: string|null, progress: { step: number, totalSteps: number, currentStep: string|null, eta: { lo: number, hi: number }|null }, result: string|null, intent: string, source: string }} TaskEntry
 */

// ── Persistence ────────────────────────────────────────────────────────────────
function _save() {
  try {
    const dir = path.dirname(JOURNAL_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const arr = Array.from(_tasks.values()).filter(t =>
      t.status === 'running' || t.status === 'queued' || t.status === 'waiting-for-agent'
    );
    fs.writeFileSync(JOURNAL_PATH, JSON.stringify(arr, null, 2), 'utf8');
  } catch (err) {
    logger.warn('[TaskJournal] Persist failed', { error: err.message });
  }
}

function _load() {
  try {
    if (!fs.existsSync(JOURNAL_PATH)) return;
    const raw = fs.readFileSync(JOURNAL_PATH, 'utf8');
    const arr = JSON.parse(raw) || [];
    for (const item of arr) {
      // Reset running tasks to queued on restart (they didn't survive)
      if (item.status === 'running') item.status = 'queued';
      _tasks.set(item.id, item);
    }
    logger.info('[TaskJournal] Loaded', { count: _tasks.size });
  } catch (_) {}
}

// Load on module init
_load();

// ── Helpers ────────────────────────────────────────────────────────────────────
function _uid() {
  return `task_${randomBytes(4).toString('hex')}`;
}

// ── Broadcast (set by server.cjs to push updates to main.js) ────────────────────
let _broadcastFn = null;

function setBroadcast(fn) {
  _broadcastFn = fn;
}

function _broadcast() {
  if (_broadcastFn) _broadcastFn(getActiveTasks());
}

// ── Public API ──────────────────────────────────────────────────────────────────

/**
 * Create a new task entry. Returns the task id.
 * @param {Object} opts
 * @param {string} opts.prompt       - Original user prompt (English)
 * @param {string|null} [opts.agentId] - Target agent (if known)
 * @param {string} [opts.intent]     - Intent that triggered the handoff
 * @param {string} [opts.source]     - 'voice' or 'text'
 * @returns {string} task id
 */
function createTask({ prompt, agentId = null, intent = 'handoff', source = 'text' }) {
  const id = _uid();
  /** @type {TaskEntry} */
  const task = {
    id,
    prompt,
    agentId,
    status: 'queued',
    createdAt: Date.now(),
    startedAt: null,
    doneAt: null,
    error: null,
    progress: { step: 0, totalSteps: 0, currentStep: null, eta: null },
    result: null,
    intent,
    source,
  };
  _tasks.set(id, task);
  _save();
  _broadcast();
  logger.info('[TaskJournal] Created', { id, prompt: prompt.substring(0, 60), agentId });
  return id;
}

/**
 * Update task status.
 * @param {string} id
 * @param {TaskStatus} status
 * @param {Object} [extra] - Additional fields to update
 */
function updateTask(id, status, extra = {}) {
  const task = _tasks.get(id);
  if (!task) return;
  const updates = { status, ...extra };
  if (status === 'running' && !task.startedAt) updates.startedAt = Date.now();
  if (status === 'done' || status === 'failed' || status === 'cancelled') {
    updates.doneAt = Date.now();
  }
  _tasks.set(id, { ...task, ...updates });
  _save();
  _broadcast();
  logger.info('[TaskJournal] Updated', { id, status, ...extra });
}

/**
 * Update task progress (step-level).
 * @param {string} id
 * @param {Object} progress - { step, totalSteps, currentStep, eta }
 */
function updateProgress(id, progress) {
  const task = _tasks.get(id);
  if (!task) return;
  _tasks.set(id, { ...task, progress: { ...task.progress, ...progress } });
  _broadcast();
}

/**
 * Set task result (final answer).
 * @param {string} id
 * @param {string} result
 */
function setResult(id, result) {
  const task = _tasks.get(id);
  if (!task) return;
  _tasks.set(id, { ...task, result });
  _save();
}

/**
 * Get a single task by id.
 * @param {string} id
 * @returns {TaskEntry|undefined}
 */
function getTask(id) {
  return _tasks.get(id);
}

/**
 * Get all active tasks (queued, waiting, running).
 * @returns {TaskEntry[]}
 */
function getActiveTasks() {
  return Array.from(_tasks.values())
    .filter(t => t.status === 'queued' || t.status === 'waiting-for-agent' || t.status === 'running')
    .sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Get recently completed tasks (for status_check and UI).
 * @param {number} [limit=10]
 * @returns {TaskEntry[]}
 */
function getRecentTasks(limit = 10) {
  return Array.from(_tasks.values())
    .filter(t => t.status === 'done' || t.status === 'failed' || t.status === 'cancelled')
    .sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0))
    .slice(0, limit);
}

/**
 * Get all tasks (active + recent completed) for UI rendering.
 * @returns {TaskEntry[]}
 */
function getAllTasks() {
  const active = getActiveTasks();
  const recent = getRecentTasks(5);
  return [...active, ...recent];
}

/**
 * Format a status summary for the status_check intent.
 * @param {string} [filterAgentId] - Filter by agent
 * @returns {string} human-readable status summary
 */
function formatStatusSummary(filterAgentId) {
  const active = getActiveTasks();
  if (active.length === 0) {
    return 'Nothing is currently running. The slate is clean.';
  }

  const filtered = filterAgentId
    ? active.filter(t => t.agentId === filterAgentId)
    : active;

  if (filtered.length === 0) {
    return `No tasks running for ${filterAgentId}.`;
  }

  return filtered.map(t => {
    const elapsed = t.startedAt ? Math.round((Date.now() - t.startedAt) / 1000) : 0;
    const step = t.progress.step > 0 ? ` — step ${t.progress.step} of ${t.progress.totalSteps}` : '';
    const current = t.progress.currentStep ? ` (${t.progress.currentStep})` : '';
    const agent = t.agentId ? `[${t.agentId}] ` : '';
    return `${agent}"${t.prompt.substring(0, 60)}${t.prompt.length > 60 ? '...' : ''}" — ${t.status}${step}${current} (${elapsed}s)`;
  }).join('\n');
}

/**
 * Clean up old completed tasks (called periodically).
 */
function cleanup() {
  const now = Date.now();
  const MAX_AGE = 30 * 60 * 1000; // 30 minutes
  for (const [id, task] of _tasks) {
    if ((task.status === 'done' || task.status === 'failed' || task.status === 'cancelled') &&
        task.doneAt && (now - task.doneAt > MAX_AGE)) {
      _tasks.delete(id);
    }
  }
  _save();
}

// Periodic cleanup every 5 minutes
setInterval(cleanup, 5 * 60 * 1000);

module.exports = {
  setBroadcast,
  createTask,
  updateTask,
  updateProgress,
  setResult,
  getTask,
  getActiveTasks,
  getRecentTasks,
  getAllTasks,
  formatStatusSummary,
  cleanup,
};
