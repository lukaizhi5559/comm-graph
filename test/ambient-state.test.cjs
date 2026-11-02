'use strict';

// statusCheck.cjs ambient-state probe tests — the observed failure was an
// ambient-state question ("is a video being recorded…") being dispatched as a
// TASK: it escalated needs_plan and left a dead "Replanning" card instead of
// an answer. The probe reads the audio journal's live /audio.status instead.
//
// Invariants under test:
//   1. isAmbientStateQuery fires on state questions about capture/recording/
//      journal — and not on requests ("can you record this") or tasks.
//   2. probeAmbient answers from /audio.status (Bearer-attached), never null
//      for a matching question, honestly when the service is unreachable.
//   3. A past-tense question can cite the newest journal file on disk.

const fs = require('fs');
const os = require('os');
const path = require('path');

// AUDIO_DIR + the memory-service Bearer are read at module load — set both
// before requiring statusCheck.cjs.
const AUDIO_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'td-audio-test-'));
process.env.AUDIO_JOURNAL_DIR = AUDIO_DIR;
process.env.MCP_USER_MEMORY_API_KEY = process.env.MCP_USER_MEMORY_API_KEY || 'test-mem-key';

// Stub fetch — _probeAmbient calls GET /audio.status.
let STATUS = null;
let lastHeaders = null;
const _fetch = global.fetch;
global.fetch = async (_url, opts) => {
  lastHeaders = (opts && opts.headers) || {};
  if (!STATUS) return { ok: false, status: 503, json: async () => null };
  return { ok: true, status: 200, json: async () => STATUS };
};

const { isAmbientStateQuery, probeAmbient } = require('../src/nodes/statusCheck.cjs');

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
}

(async () => {
  // ── isAmbientStateQuery — question shapes vs requests/tasks ──────────────
  const YES = [
    'is a video being recorded that i play on the web page for me it\'s a big record',
    'are you recording this',
    'did you record the meeting',
    'is it recording what i play',
    'was the call captured',
    'is the audio journal on',
    'can you hear the video playing',
    'what are you transcribing',
  ];
  const NO = [
    'can you record this for me',     // a request, not a state question
    'record this video',              // imperative
    'text my wife about dinner',
    'go to youtube and play lo-fi',   // a task
  ];
  for (const q of YES) check(`match: "${q.slice(0, 50)}"`, isAmbientStateQuery(q));
  for (const q of NO) check(`no match: "${q.slice(0, 50)}"`, !isAmbientStateQuery(q));

  // ── probeAmbient — live capture state ────────────────────────────────────
  STATUS = {
    mode: 'auto', capturing: true,
    verdict: { recordable: true, type: 'media', engine: 'groq', app: 'web', title: 'test vid', url: 'https://youtube.com/x' },
    session: { app: 'web', title: 'test vid', type: 'media', engine: 'groq', segs: 7 },
    lastSegment: 'and that is how it works',
    webMedia: [{ url: 'https://youtube.com/x', title: 'test vid', state: 'playing' }],
  };
  const r1 = await probeAmbient('is a video being recorded');
  check('capturing → affirmative answer', /^Yes — the audio journal is capturing/.test(r1), `got: ${r1}`);
  check('capturing → names the media', /test vid/.test(r1), `got: ${r1}`);
  check('capturing → cites latest transcript', /and that is how it works/.test(r1), `got: ${r1}`);
  check('probe sends Bearer', lastHeaders.Authorization === `Bearer ${process.env.MCP_USER_MEMORY_API_KEY}`, `got: ${lastHeaders.Authorization}`);

  STATUS = { mode: 'auto', capturing: false, verdict: { recordable: false }, session: null, webMedia: [] };
  fs.mkdirSync(path.join(AUDIO_DIR, '2026-10-30'), { recursive: true });
  fs.writeFileSync(path.join(AUDIO_DIR, '2026-10-30', '1430-my-video.md'), '# journal');
  const r2 = await probeAmbient('did you record the video');
  check('idle → honest negative', /^No — nothing is being captured/.test(r2), `got: ${r2}`);
  check('idle → cites last journal file', /1430-my-video\.md/.test(r2), `got: ${r2}`);

  STATUS = null;
  const r3 = await probeAmbient('is it recording');
  check('unreachable → honest unknown', /couldn't reach|unknown/i.test(r3), `got: ${r3}`);

  const r4 = await probeAmbient('go to youtube and play lo-fi');
  check('non-question → null (probe stays out of the lane)', r4 === null, `got: ${r4}`);

  global.fetch = _fetch;
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
