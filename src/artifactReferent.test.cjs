'use strict';
/* Unit test for artifactReferent.resolve — run: node artifactReferent.test.cjs */
const assert = require('assert');
const { resolve } = require('./artifactReferent.cjs');

const NOW = Date.now();
const nylasCreate = {
  id: 'task_0a43b3ea',
  prompt: 'Create a Google Calendar event titled "Take out trash" for tomorrow at 5:00 PM.',
  agentId: 'nylas.agent',
  status: 'done',
  doneAt: NOW - 4 * 60 * 1000,
  createdAt: NOW - 5 * 60 * 1000,
  result: 'The automation succeeded: the output shows "✓ Event created successfully!" with the title "Take out trash" scheduled for Tue Oct 27 2026 at 5:00 PM America/New_York.',
  artifacts: { steps: [{ title: 'Create Google Calendar event via Nylas', status: 'done', skill: 'cli.agent', output: '✓ Event created successfully!\n\nTitle: Take out trash\nWhen: Tue, Oct 27, 2026, 5:00 PM - 5:30 PM\nID: jagqp5a612756f28rbq5cjduu4' }] },
};
const fileCreate = {
  id: 'task_ff',
  prompt: 'Create a file called notes.txt on the desktop',
  agentId: 'desktop.agent',
  status: 'done',
  doneAt: NOW - 3 * 60 * 1000,
  createdAt: NOW - 3 * 60 * 1000,
  result: 'File created.',
  artifacts: { steps: [] },
};
const olderEventCreate = {
  id: 'task_old',
  prompt: 'Schedule a meeting with Sam tomorrow at noon',
  agentId: 'nylas.agent',
  status: 'done',
  doneAt: NOW - 26 * 3600 * 1000,
  createdAt: NOW - 26 * 3600 * 1000,
  result: 'Meeting scheduled.',
  artifacts: { steps: [] },
};

let r;

// 1. Named artifact + recency → binds newest matching create task
r = resolve('I need you delete that event I just set', [nylasCreate]);
assert(r, 'expected a hit');
assert.strictEqual(r.agentId, 'nylas.agent');
assert(r.referentDesc.includes('Take out trash'), 'referent should carry the title');
assert(r.referentDesc.includes('jagqp5a612756f28rbq5cjduu4'), 'referent should carry the event id');

// 2. Bare deictic within window → binds most recent create
r = resolve('use nylas to delete it', [nylasCreate]);
assert(r && r.agentId === 'nylas.agent', 'bare "it" should bind newest create in window');

// 3. Typo'd verb still counts
r = resolve('use nylas to delte it', [nylasCreate]);
assert(r && r.agentId === 'nylas.agent', 'typo "delte" should still match');

// 4. Noun mismatch — "delete that event" must not bind a file-create task
r = resolve('delete that event', [fileCreate]);
assert.strictEqual(r, null, 'event noun must not match a file task');

// 5. Noun match picks the event task over a newer file task
r = resolve('delete that event I just set', [fileCreate, nylasCreate]);
assert(r && r.agentId === 'nylas.agent' && r.taskId === 'task_0a43b3ea', 'noun match wins over recency');

// 6. Bare deictic outside window → no bind
r = resolve('delete it', [{ ...nylasCreate, doneAt: NOW - 2 * 3600 * 1000 }]);
assert.strictEqual(r, null, 'stale bare-deictic must not bind');

// 7. Named noun still binds older task ("delete the meeting I scheduled")
r = resolve('delete the meeting I scheduled yesterday', [olderEventCreate]);
assert(r && r.agentId === 'nylas.agent', 'named noun should bind even when old');

// 8. No mutation verb → no bind
assert.strictEqual(resolve('what time is that event', [nylasCreate]), null);
assert.strictEqual(resolve('show me that event', [nylasCreate]), null);

// 9. No create-verb prompt → no bind
assert.strictEqual(resolve('delete that event', [{ ...nylasCreate, prompt: 'list my events' }]), null);

// 10. Failed/non-agent tasks skipped
assert.strictEqual(resolve('delete that event', [{ ...nylasCreate, status: 'failed' }]), null);
assert.strictEqual(resolve('delete that event', [{ ...nylasCreate, agentId: null }]), null);

// 11. Empty journal → null
assert.strictEqual(resolve('delete that event I just set', []), null);
assert.strictEqual(resolve('delete that event I just set', null), null);

// 12. "remove it now" with concrete artifact name in same message
r = resolve('the calendar event to take out the trash I want you to remove it now', [nylasCreate]);
assert(r && r.agentId === 'nylas.agent', 'explicit calendar-event noun should bind');

// ── resolveExplicitTool ──────────────────────────────────────────────────────
const { resolveExplicitTool } = require('./artifactReferent.cjs');
let e;
e = resolveExplicitTool('use nylas to delete it');
assert(e && e.agentId === 'nylas.agent', `expected nylas.agent, got ${e && e.agentId}`);
e = resolveExplicitTool('use nylas to delte it');
assert(e && e.agentId === 'nylas.agent', 'typo verb still resolves the tool name');
e = resolveExplicitTool('delete the event with nylas');
assert(e && e.agentId === 'nylas.agent');
e = resolveExplicitTool('what is the weather today');
assert.strictEqual(e, null, 'no tool name → null');
e = resolveExplicitTool('show me some cute puppies');
assert.strictEqual(e, null);
// cli-typed agent beats a browser surface when both could match
e = resolveExplicitTool('use nylas to delete that calendar event');
assert(e && e.agentId === 'nylas.agent', `cli tool should win over browser calendar, got ${e && e.agentId}`);
console.log('explicit-tool:', e.agentId, 'matched:', e.matched);

// Generic keywords must not bind from bare prose — the reported bug pinned
// messages.app.agent on the word "text" in a scripture-file edit task.
e = resolveExplicitTool('Using the file kids-weekly-memory-verse.rtf, update the content to include the actual ESV text for Exodus 7:1-2 for Chloe.');
assert.strictEqual(e, null, `ESV "text" must not pin messages.app.agent, got ${e && e.agentId}`);
e = resolveExplicitTool('save it in text format');
assert.strictEqual(e, null, `in/from phrases are not tool mentions, got ${e && e.agentId}`);
// But an explicit "use X" mention still binds the keyword.
e = resolveExplicitTool('use text to message mom');
assert(e && e.agentId === 'messages.app.agent', `strong keyword mention should pin, got ${e && e.agentId}`);

// Data-compound tails are not tool mentions — "commit messages" names git
// output, not Messages.app (observed: this exact planner text pinned
// messages.app.agent and blocked a git-sync plan at the readiness gate).
e = resolveExplicitTool('Stage and commit all uncommitted work across the repositories using commit messages based on the actual code diffs found in Task 2.');
assert.strictEqual(e, null, `"commit messages" must not pin messages.app.agent, got ${e && e.agentId}`);
e = resolveExplicitTool('check the error messages in the log');
assert.strictEqual(e, null, `"error messages" is data vocabulary, got ${e && e.agentId}`);
// Bare (non-compound) service-name mentions still resolve weak.
e = resolveExplicitTool('send messages to mom');
assert(e && e.agentId === 'messages.app.agent', `bare "send messages" should still hit, got ${e && e.agentId}`);
e = resolveExplicitTool('use messages to text mom');
assert(e && e.agentId === 'messages.app.agent', `strong "use messages" should still hit, got ${e && e.agentId}`);

console.log('artifactReferent.test.cjs: all assertions passed');
