'use strict';
/**
 * taskJournal.test.cjs — lifecycle guards for the task journal
 *
 * Regressions covered:
 *   1. getActiveTasks() dropped 'awaiting-approval' / 'waiting-for-input'
 *      tasks entirely — pending-approval work vanished from /tasks and the UI.
 *   2. updateTask() let a late non-terminal update resurrect a terminal task
 *      (cancelled plan-gen finishing later overwrote 'cancelled' back to
 *      'awaiting-approval').
 *   3. updateProgress() never transitioned 'queued' → 'running' — tasks read
 *      as queued forever and startedAt stayed null.
 *
 * Run: node comms-graph/test/taskJournal.test.cjs
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate persistence before requiring the module (JOURNAL_PATH is read at load).
process.env.TASK_JOURNAL_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tj-test-')), 'journal.json');

const journal = require('../src/taskJournal.cjs');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { console.log('  PASS:', label); passed++; }
  else { console.error(`  FAIL: ${label}`); failed++; }
}

const ids = [];
function mk(status) {
  const id = journal.createTask({ prompt: 'test', intent: 'handoff', source: 'text' });
  ids.push(id);
  if (status && status !== 'queued') journal.updateTask(id, status);
  return id;
}

// ── 1. Non-terminal interactive states are active ────────────────────────────
for (const st of ['awaiting-approval', 'waiting-for-input', 'auth-required', 'running']) {
  const id = mk(st);
  const inActive = journal.getActiveTasks().some(t => t.id === id);
  const inAll = journal.getAllTasks().some(t => t.id === id);
  ok(inActive && inAll, `status '${st}' is visible via getActiveTasks + getAllTasks`);
}

// ── 2. Terminal tasks are one-way ────────────────────────────────────────────
{
  const id = mk('queued');
  journal.updateTask(id, 'cancelled', { error: 'cancelled by user' });
  journal.updateTask(id, 'awaiting-approval', { planFile: '/tmp/x.md' }); // late straggler
  const t = journal.getTask(id);
  ok(t.status === 'cancelled' && !t.planFile, 'terminal status survives a late awaiting-approval update');

  const id2 = mk('done');
  journal.updateTask(id2, 'running');
  ok(journal.getTask(id2).status === 'done', 'done task ignores a late running update');
}

// ── 3. Progress flips queued → running and stamps startedAt ──────────────────
{
  const id = mk('queued');
  journal.updateProgress(id, { step: 0, totalSteps: 3, currentStep: 'Init' });
  const t = journal.getTask(id);
  ok(t.status === 'running', 'first progress ping flips queued → running');
  ok(typeof t.startedAt === 'number' && t.startedAt > 0, 'startedAt stamped on first progress');
  ok(t.progress.step === 0 && t.progress.totalSteps === 3, 'progress payload recorded');

  // A second ping must not disturb terminal states
  journal.updateTask(id, 'done');
  journal.updateProgress(id, { step: 3 });
  ok(journal.getTask(id).status === 'done', 'progress on done task does not resurrect it');
}

// ── 4. Terminal tasks land in recent, not active ──────────────────────────────
{
  const id = mk('done');
  ok(!journal.getActiveTasks().some(t => t.id === id), 'done task not in active list');
  ok(journal.getRecentTasks().some(t => t.id === id), 'done task in recent list');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
