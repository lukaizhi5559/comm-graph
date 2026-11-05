'use strict';
/**
 * history-scope.test.cjs — Phase 4.7 history scoping + userwait lifecycle
 *
 * Regression coverage for the paste-in-history pollution class (observed: a
 * clarify turn asked about "the YouTube notification rule" because history
 * carried a pasted rule unscoped — judgments read the raw turn, not the ask).
 *
 *   - _addTurn/_formatContext: a history turn whose prompt was paste+question
 *     renders the ask (requestText), not the paste, into context
 *   - _listSessionMessages: metadata.requestText wins over raw text for user
 *     turns; assistant turns and legacy messages pass through verbatim
 *   - POST /comms.task.userwait: waiting-for-input → running round-trip;
 *     terminal tasks refuse resurrection; waitingSince stamps and clears
 */
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Isolate the journal + pick random ports BEFORE requiring the modules.
process.env.TASK_JOURNAL_PATH = path.join(os.tmpdir(), `journal-test-${process.pid}.json`);
process.env.PORT = '0';
process.env.THINKDROP_MAIN_PORT = '0'; // main.js stub not needed — fetch calls fire-and-forget
process.env.COMMS_NO_HISTORY = '1'; // never write test turns into live session history

// Conversation-service stub: returns one paste+question user turn (with
// persisted requestText) + one legacy user turn (no metadata) + assistant.
const CONV_MESSAGES = [
  {
    sender: 'user',
    text: 'Here is my rule: when a new video drops on a watched YouTube channel show a happy emoji on my screen. It has a few steps. Can you explain what this rule actually does?',
    metadata: { requestText: 'Can you explain what this rule actually does?' },
  },
  { sender: 'assistant', text: 'That rule watches a YouTube channel and shows an emoji on new videos.' },
  {
    sender: 'user',
    text: 'Short turns pass through unchanged',
    metadata: {},
  },
];
const convActions = []; // every action the comms service posts to the stub
const convStub = http.createServer((req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  req.on('end', () => {
    try { convActions.push(JSON.parse(raw).action); } catch (_) {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: { messages: CONV_MESSAGES } }));
  });
});

const taskJournal = require('../src/taskJournal.cjs');
const llmPath = require.resolve('../src/llm-providers.cjs');
require(llmPath);
require.cache[llmPath].exports = {
  ...require.cache[llmPath].exports,
  ask: async () => ({ text: 'NO', provider: 'mock' }),
};

let tests = 0, passed = 0;
async function check(name, p) { tests++; try { const cond = await p; if (cond) { passed++; console.log(`  PASS: ${name}`); } else { console.error(`  FAIL: ${name}`); } } catch (e) { console.error(`  FAIL: ${name} — ${e.message}`); } }

function post(port, pathName, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const r = http.request({
      hostname: '127.0.0.1', port, path: pathName, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 3000,
    }, (res) => {
      let b = '';
      res.on('data', c => { b += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(b) }); } catch (_) { resolve({ status: res.statusCode, body: b }); } });
    });
    r.on('error', reject);
    r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); });
    r.write(data);
    r.end();
  });
}

(async () => {
  console.log('\nhistory-scope + userwait tests');

  await new Promise(r => convStub.listen(0, '127.0.0.1', r));
  process.env.CONVERSATION_SERVICE_PORT = String(convStub.address().port);

  const srv = require('../src/server.cjs');
  // server.listen(PORT=0) fires at require time — wait for 'listening' before
  // reading the bound port.
  await new Promise(r => srv.server.listening ? r() : srv.server.once('listening', r));
  const port = srv.server.address().port;

  // ── _addTurn / _formatContext: paste in history renders as the ask ────
  srv._addTurn(
    'Here is my rule for ThinkDrop — I set it up last week and want to review it before adding more like it. The rule: when a new video drops on a watched YouTube channel, show a happy emoji on my screen. It watches a channel, polls periodically, and displays an overlay. Can you explain what this rule actually does?',
    'It watches a channel and shows an emoji.',
    'general_quick'
  );
  const ctx = srv._formatContext();
  await check('history context renders the ask, not the paste',
    ctx.includes('Can you explain what this rule actually does?'));
  await check('pasted rule text does not leak into history context',
    !ctx.includes('new video drops'));
  srv._addTurn('plain short turn', 'ok', 'general_quick');
  await check('short turns keep their full text (no split applied)',
    srv._formatContext().includes('plain short turn'));

  // ── _listSessionMessages: metadata.requestText wins ───────────────────
  const { history } = await srv._listSessionMessages('sess_test');
  await check('service history renders persisted requestText for user turns',
    history && history.includes('Can you explain what this rule actually does?'));
  await check('pasted rule body stays out of the history context',
    history && !history.includes('happy emoji'));
  await check('assistant turns pass through verbatim',
    history && history.includes('watches a YouTube channel'));
  await check('legacy turns (no requestText) fall back to derived ask',
    history && history.includes('Short turns pass through unchanged'));

  // ── /comms.task.userwait: status round-trip ───────────────────────────
  const taskId = taskJournal.createTask({ prompt: 'test waiting round trip', agentId: 'test' });
  taskJournal.updateTask(taskId, 'running');

  const w1 = await post(port, '/comms.task.userwait', { taskId, waiting: true });
  await check('userwait:true → 200', w1.status === 200 && w1.body.ok === true);
  await check('task flips to waiting-for-input',
    taskJournal.getTask(taskId).status === 'waiting-for-input');
  await check('waitingSince stamped on wait',
    typeof taskJournal.getTask(taskId).waitingSince === 'number');

  const w2 = await post(port, '/comms.task.userwait', { taskId, waiting: false });
  await check('userwait:false → 200', w2.status === 200 && w2.body.ok === true);
  await check('answered task returns to running',
    taskJournal.getTask(taskId).status === 'running');
  await check('waitingSince cleared on resume',
    taskJournal.getTask(taskId).waitingSince === null);

  // Terminal tasks refuse the flip — a late userwait can't resurrect a card.
  taskJournal.updateTask(taskId, 'done');
  await post(port, '/comms.task.userwait', { taskId, waiting: true });
  await check('terminal task ignores late userwait',
    taskJournal.getTask(taskId).status === 'done');

  const bad = await post(port, '/comms.task.userwait', { waiting: true });
  await check('missing taskId → 400', bad.status === 400);

  // ── COMMS_NO_HISTORY gate: test turns must not write live history ───────
  // Regression for the phantom-JSON incident — stub replies from processMessage
  // tests landed as real assistant turns in the user's session feed.
  {
    const before = convActions.filter(a => a === 'message.add').length;
    srv._logConversationTurn('a test turn', 'a stub reply', 'general_quick', 'sess_test', null, 'a test turn');
    await new Promise(r => setTimeout(r, 150));
    await check('COMMS_NO_HISTORY=1 → zero message.add posts',
      convActions.filter(a => a === 'message.add').length === before);

    delete process.env.COMMS_NO_HISTORY;
    srv._logConversationTurn('a test turn', 'a stub reply', 'general_quick', 'sess_test', null, 'a test turn');
    await new Promise(r => setTimeout(r, 150));
    await check('flag unset → user+assistant turns post',
      convActions.filter(a => a === 'message.add').length === before + 2);
    process.env.COMMS_NO_HISTORY = '1';
  }

  convStub.close();
  try { fs.unlinkSync(process.env.TASK_JOURNAL_PATH); } catch (_) {}
  console.log(`\n${passed}/${tests} passed`);
  process.exit(passed === tests ? 0 : 1);
})();
