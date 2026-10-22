'use strict';
/**
 * agentLock.test.cjs — the serial interactive run lane.
 *
 * Regressions covered:
 *   1. Every unagented task ran fully concurrent — tryAcquire(null) always
 *      succeeded, so two rapid user prompts spawned parallel stategraph runs
 *      (observed: two concurrent "Gathering requirements" git runs).
 *   2. User-facing work (text/voice + plan tasks) shares one __run__ lane —
 *      second task parks FIFO and resumes on release.
 *   3. Background thought dispatches keep per-agent locking — a thought on
 *      slack.agent can run while a user task holds __run__.
 *
 * Run: node comms-graph/test/agentLock.test.cjs
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate journal persistence before requiring modules (path read at load).
process.env.TASK_JOURNAL_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'al-test-')), 'journal.json');

const journal = require('../src/taskJournal.cjs');
const { RUN_LOCK_KEY, tryAcquire, release, isLocked, getWaitingCount } = require('../src/agentLock.cjs');

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { console.log('  PASS:', label); passed++; }
  else { console.error(`  FAIL: ${label}`); failed++; }
}

const t1 = journal.createTask({ prompt: 'first', intent: 'handoff', source: 'text' });
const t2 = journal.createTask({ prompt: 'second', intent: 'handoff', source: 'text' });
const t3 = journal.createTask({ prompt: 'third', intent: 'handoff', source: 'voice' });
const thought = journal.createTask({ prompt: 'brain thought', intent: 'handoff', source: 'proactive', agentId: 'slack.agent' });

// ── 1. One interactive run at a time ────────────────────────────────────────
let r = tryAcquire(RUN_LOCK_KEY, t1);
ok(r.acquired === true, 'first user task acquires the run lane');
ok(isLocked(RUN_LOCK_KEY) === true, 'run lane reports locked');

r = tryAcquire(RUN_LOCK_KEY, t2);
ok(r.acquired === false && r.waitingBehind === t1, 'second user task parks behind the first');
ok(journal.getTask(t2).status === 'waiting-for-agent', 'parked task marked waiting-for-agent');
ok(getWaitingCount(RUN_LOCK_KEY) === 1, 'one task waiting on the run lane');

// ── 2. Thoughts keep their own per-agent lane ───────────────────────────────
r = tryAcquire('slack.agent', thought);
ok(r.acquired === true, 'thought on slack.agent runs while __run__ is held');
ok(isLocked('slack.agent') === true, 'agent lock held by the thought');

// ── 3. FIFO resume on release ───────────────────────────────────────────────
const resumed = release(RUN_LOCK_KEY, t1);
ok(resumed === t2, 'release resumes the parked task (FIFO)');
ok(journal.getTask(t2).status === 'queued', 'resumed task marked queued');
ok(isLocked(RUN_LOCK_KEY) === true, 'run lane still held (now by t2)');

// A third user task parks behind t2
r = tryAcquire(RUN_LOCK_KEY, t3);
ok(r.acquired === false && r.waitingBehind === t2, 'third user task parks behind t2');

// Thought completion does not touch the run lane
ok(release('slack.agent', thought) === null, 'thought release leaves run lane intact');
ok(isLocked(RUN_LOCK_KEY) === true, 'run lane unaffected by thought release');

ok(release(RUN_LOCK_KEY, t2) === t3, 'second release resumes t3');
ok(release(RUN_LOCK_KEY, t3) === null, 'lane empty after t3 releases');
ok(isLocked(RUN_LOCK_KEY) === false, 'run lane fully released');

// ── 4. Releasing a non-holder just dequeues ─────────────────────────────────
const t4 = journal.createTask({ prompt: 'fourth', intent: 'handoff', source: 'text' });
const t5 = journal.createTask({ prompt: 'fifth', intent: 'handoff', source: 'text' });
tryAcquire(RUN_LOCK_KEY, t4);
tryAcquire(RUN_LOCK_KEY, t5); // parked
// Cancel t5 while parked — release with a foreign taskId removes it from the queue
ok(release(RUN_LOCK_KEY, t5) === null, 'non-holder release dequeues t5 without resuming');
ok(release(RUN_LOCK_KEY, t4) === null, 'holder release resumes nothing (t5 dequeued)');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
