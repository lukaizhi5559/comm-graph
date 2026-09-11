'use strict';

/**
 * agentLock.cjs — Per-agent lock management with smart pause/resume
 *
 * Prevents two tasks from using the same browser agent simultaneously
 * (e.g. two ChatGPT automations would fight over the same browser session).
 *
 * Rules:
 *   - Same agent, same site → second task parks, resumes when first completes
 *   - Different agents → both run in parallel, no conflict
 *   - Lock TTL: if a lock holder hasn't updated progress in TTL, force-release
 *
 * Integration:
 *   - handoff.cjs calls tryAcquire() before spawning a stategraph run
 *   - handoffRunner.cjs calls release() when a task completes
 *   - taskJournal.cjs stores the 'waiting-for-agent' status
 */

const logger = require('./logger.cjs');
const { updateTask } = require('./taskJournal.cjs');

const LOCK_TTL_MS = parseInt(process.env.AGENT_LOCK_TTL_MS || '600000', 10); // 10 min default

// ── Lock state ─────────────────────────────────────────────────────────────────
/**
 * @type {Map<string, { taskId: string, acquiredAt: number, lastProgressAt: number }>}
 * Key: agentId, Value: lock info
 */
const _locks = new Map();

/**
 * @type {Map<string, string[]>}
 * Key: agentId, Value: array of waiting taskIds
 */
const _waiting = new Map();

// ── Broadcast for lock state changes (for UI) ──────────────────────────────────
let _lockBroadcastFn = null;

function setLockBroadcast(fn) {
  _lockBroadcastFn = fn;
}

function _broadcastLockState() {
  if (_lockBroadcastFn) {
    _lockBroadcastFn({
      locks: Array.from(_locks.entries()).map(([agentId, info]) => ({ agentId, ...info })),
      waiting: Array.from(_waiting.entries()).map(([agentId, ids]) => ({ agentId, count: ids.length })),
    });
  }
}

// ── Public API ──────────────────────────────────────────────────────────────────

/**
 * Try to acquire a lock for an agent.
 * If the agent is already locked, the task is parked as 'waiting-for-agent'.
 *
 * @param {string} agentId   - The agent to lock (e.g. 'chatgpt.agent')
 * @param {string} taskId    - The task requesting the lock
 * @returns {{ acquired: boolean, waitingBehind: string|null }}
 *   - acquired: true if lock was acquired, false if parked
 *   - waitingBehind: taskId of the task currently holding the lock (if parked)
 */
function tryAcquire(agentId, taskId) {
  if (!agentId) {
    // No agent = no lock needed (e.g. shell-only tasks)
    return { acquired: true, waitingBehind: null };
  }

  // Check for stale lock (TTL expired)
  const existing = _locks.get(agentId);
  if (existing) {
    const age = Date.now() - existing.lastProgressAt;
    if (age > LOCK_TTL_MS) {
      logger.warn('[AgentLock] Force-releasing stale lock', {
        agentId, taskId: existing.taskId, ageMs: age,
      });
      _locks.delete(agentId);
      // Notify the stale task it was force-released
      updateTask(existing.taskId, 'failed', { error: 'Lock expired (no progress updates)' });
      // Resume next waiting task
      _resumeNext(agentId);
    }
  }

  if (!_locks.has(agentId)) {
    // Lock is free — acquire it
    _locks.set(agentId, {
      taskId,
      acquiredAt: Date.now(),
      lastProgressAt: Date.now(),
    });
    logger.info('[AgentLock] Acquired', { agentId, taskId });
    _broadcastLockState();
    return { acquired: true, waitingBehind: null };
  }

  // Lock is held by another task — park this one
  const lockHolder = _locks.get(agentId);
  if (lockHolder.taskId === taskId) {
    // Same task already holds the lock (shouldn't happen, but handle gracefully)
    return { acquired: true, waitingBehind: null };
  }

  // Add to waiting queue
  if (!_waiting.has(agentId)) _waiting.set(agentId, []);
  _waiting.get(agentId).push(taskId);

  logger.info('[AgentLock] Parked — waiting for agent', {
    agentId, taskId, behind: lockHolder.taskId,
  });
  updateTask(taskId, 'waiting-for-agent', { agentId });
  _broadcastLockState();
  return { acquired: false, waitingBehind: lockHolder.taskId };
}

/**
 * Release a lock for an agent. Triggers resume of the next waiting task.
 *
 * @param {string} agentId
 * @param {string} taskId  - The task releasing the lock (must match holder)
 * @returns {string|null} taskId of the task that should resume, or null
 */
function release(agentId, taskId) {
  if (!agentId) return null;

  const lock = _locks.get(agentId);
  if (!lock || lock.taskId !== taskId) {
    // Not the lock holder — just remove from waiting queue if present
    const queue = _waiting.get(agentId);
    if (queue) {
      const idx = queue.indexOf(taskId);
      if (idx >= 0) {
        queue.splice(idx, 1);
        if (queue.length === 0) _waiting.delete(agentId);
      }
    }
    return null;
  }

  _locks.delete(agentId);
  logger.info('[AgentLock] Released', { agentId, taskId });

  // Resume next waiting task
  const nextTaskId = _resumeNext(agentId);
  _broadcastLockState();
  return nextTaskId;
}

/**
 * Resume the next waiting task for an agent.
 * @param {string} agentId
 * @returns {string|null} taskId that was resumed, or null
 * @internal
 */
function _resumeNext(agentId) {
  const queue = _waiting.get(agentId);
  if (!queue || queue.length === 0) {
    _waiting.delete(agentId);
    return null;
  }

  const nextTaskId = queue.shift();
  if (queue.length === 0) _waiting.delete(agentId);

  // Acquire the lock for the resumed task
  _locks.set(agentId, {
    taskId: nextTaskId,
    acquiredAt: Date.now(),
    lastProgressAt: Date.now(),
  });

  logger.info('[AgentLock] Resumed waiting task', { agentId, taskId: nextTaskId });
  updateTask(nextTaskId, 'queued', { agentId });
  return nextTaskId;
}

/**
 * Update the progress timestamp for a lock holder (prevents TTL expiry).
 * @param {string} agentId
 * @param {string} taskId
 */
function heartbeat(agentId, taskId) {
  const lock = _locks.get(agentId);
  if (lock && lock.taskId === taskId) {
    lock.lastProgressAt = Date.now();
  }
}

/**
 * Get the current lock state for all agents.
 * @returns {{ locks: Array, waiting: Array }}
 */
function getLockState() {
  return {
    locks: Array.from(_locks.entries()).map(([agentId, info]) => ({ agentId, ...info })),
    waiting: Array.from(_waiting.entries()).map(([agentId, ids]) => ({ agentId, count: ids.length, taskIds: [...ids] })),
  };
}

/**
 * Check if an agent is currently locked.
 * @param {string} agentId
 * @returns {boolean}
 */
function isLocked(agentId) {
  if (!agentId) return false;
  const lock = _locks.get(agentId);
  if (!lock) return false;
  // Check TTL
  if (Date.now() - lock.lastProgressAt > LOCK_TTL_MS) {
    _locks.delete(agentId);
    _resumeNext(agentId);
    return false;
  }
  return true;
}

/**
 * Get the number of tasks waiting for an agent.
 * @param {string} agentId
 * @returns {number}
 */
function getWaitingCount(agentId) {
  const queue = _waiting.get(agentId);
  return queue ? queue.length : 0;
}

module.exports = {
  tryAcquire,
  release,
  heartbeat,
  isLocked,
  getLockState,
  getWaitingCount,
  setLockBroadcast,
};
