'use strict';
/**
 * planning-stepgen-parse.test.cjs — step generation must salvage real LLM
 * output, not only perfectly-fenced JSON.
 *
 * Regression (observed 2026-10-19, plan_mvffysxl_dgq7e): the backend's
 * non-streaming router dropped the caller's maxTokens and hardcoded
 * max_tokens:512 — stepgen replies truncated mid-array with no closing
 * fence, the strict-fence regex matched nothing → "Step generation produced
 * no steps" → both retries failed identically → the task sat 'generating
 * steps…' forever, holding the plan-check card pending so the run never
 * started.
 *
 * Invariants under test:
 *   1. A valid fenced json array parses to steps.
 *   2. A reply truncated MID-ARRAY (no closing fence) still yields the
 *      complete steps — the partial tail entry is dropped, not fatal.
 *   3. A bare (unfenced) JSON array parses.
 *   4. Prose-only output returns null — the bounded-retry path is preserved.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.THINKDROP_PLANS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'td-stepgen-test-'));

// Stub the LLM provider BEFORE planning.cjs loads it — it destructures
// ask/askEarly/askStream at require time.
const llmPath = require.resolve('../src/llm-providers.cjs');
require(llmPath);
let SCRIPT = [];
require.cache[llmPath].exports = {
  ...require.cache[llmPath].exports,
  ask: async () => ({ text: SCRIPT.length ? SCRIPT.shift() : '', provider: 'mock' }),
  askStream: async () => ({ text: SCRIPT.length ? SCRIPT.shift() : '', provider: 'mock' }),
  askEarly: async () => ({ firstSentence: '', fullText: SCRIPT.length ? SCRIPT.shift() : '', provider: 'mock' }),
};

const planning = require('../src/nodes/planning.cjs');
const genSteps = planning._generateTaskSteps;

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name} ${extra}`); }
}

const TASK = { num: 1, title: 't', prompt: 'compile a list', agents: ['shell'], auth: 'none-required' };

const FENCED = '```json\n[' +
  JSON.stringify({ skill: 'synthesize', args: { prompt: 'wrap up' }, description: 'final' }) +
  ']\n```';

// The observed failure shape: valid fenced array truncated mid-object —
// no closing fence, tail ends at `"skill":`.
const TRUNCATED = '```json\n[\n' +
  '  ' + JSON.stringify({ skill: 'shell.run', args: { command: 'ls' }, description: 'list files' }) + ',\n' +
  '  ' + JSON.stringify({ skill: 'synthesize', args: { prompt: 'summarize files' }, description: 'final' }) + ',\n' +
  '  {\n    "skill":';

const BARE = '[' +
  JSON.stringify({ skill: 'synthesize', args: {}, description: 'final' }) +
  ']';

(async () => {
  console.log('\nplanning stepgen parse tests');

  SCRIPT = [FENCED];
  let steps = await genSteps({ ...TASK });
  check('fenced json array parses', Array.isArray(steps) && steps.length === 1 && steps[0].skill === 'synthesize');

  SCRIPT = [TRUNCATED];
  steps = await genSteps({ ...TASK });
  check('truncated mid-array reply salvages complete steps',
    Array.isArray(steps) && steps.length >= 1 && steps.every(s => typeof s.skill === 'string' && s.skill),
    `got ${JSON.stringify(steps)}`);

  SCRIPT = [BARE];
  steps = await genSteps({ ...TASK });
  check('unfenced json array parses', Array.isArray(steps) && steps.length === 1);

  SCRIPT = ['Here are the steps I would take: first search, then write.'];
  steps = await genSteps({ ...TASK });
  check('prose-only reply returns null (retry path)', steps === null, `got ${JSON.stringify(steps)}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
