'use strict';
/**
 * llm-providers-flatten.test.cjs — messages[] → {systemPrompt, prompt} flattening
 *
 * Regression: the planning lane passes a real alternating-role messages[]
 * array; the backend HTTP contract is two flat strings, so _extractFromMessages
 * flattened it WITHOUT role labels. The model couldn't tell its own questions
 * from the user's answers and re-asked "Which day next week?" in a loop.
 *
 * Contract: multi-turn arrays become a labeled "User:/Assistant:" transcript;
 * <tool_results> injections pass through raw; single-message callers are
 * byte-identical to before (classify/translate/stepgen/verifiers).
 */
const assert = require('assert');
const { _extractFromMessages } = require('../src/llm-providers.cjs');
const { replaceVocalizationTags, createVocalizationMapper } = require('../../shared/vocalization-tags.cjs');

let tests = 0, passed = 0;
function check(name, cond) { tests++; if (cond) { passed++; console.log(`  PASS: ${name}`); } else { console.error(`  FAIL: ${name}`); } }

console.log('\nllm-providers flatten tests');

// ── Single-message callers are untouched ────────────────────────────────────
{
  const { systemPrompt, prompt } = _extractFromMessages([
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'Message: hello world' },
  ]);
  check('single user message passes through raw', prompt === 'Message: hello world');
  check('system prompt extracted', systemPrompt === 'SYS');
}

{
  const { prompt } = _extractFromMessages([
    { role: 'user', content: 'only text' },
  ]);
  check('lone user message unlabeled', prompt === 'only text');
}

// ── Multi-turn arrays get role labels ───────────────────────────────────────
{
  const { systemPrompt, prompt } = _extractFromMessages([
    { role: 'system', content: 'PERSONA + DIRECTIVE' },
    { role: 'user', content: 'Create a calendar event for next week at 5:00 AM.' },
    { role: 'assistant', content: 'Which day next week?' },
    { role: 'user', content: 'friday' },
    { role: 'assistant', content: 'What should I call the event?' },
    { role: 'user', content: 'dentist appt' },
  ]);
  const lines = prompt.split('\n\n');
  check('user turns labeled', lines[0] === 'User: Create a calendar event for next week at 5:00 AM.' && lines[2] === 'User: friday' && lines[4] === 'User: dentist appt');
  check('assistant turns labeled', lines[1] === 'Assistant: Which day next week?' && lines[3] === 'Assistant: What should I call the event?');
  check('system prompt stays separate', systemPrompt === 'PERSONA + DIRECTIVE' && !prompt.includes('PERSONA'));
}

// ── <tool_results> injections stay raw (self-describing system turns) ───────
{
  const { prompt } = _extractFromMessages([
    { role: 'user', content: 'read my file' },
    { role: 'assistant', content: '<tool>fs.read("/tmp/x")</tool>' },
    { role: 'user', content: '<tool_results>\nfs.read → contents here\n</tool_results>' },
    { role: 'assistant', content: 'The file says contents here.' },
  ]);
  check('tool_results not labeled User:', prompt.includes('<tool_results>\nfs.read → contents here\n</tool_results>'));
  check('tool_results carries no User: prefix', !prompt.includes('User: <tool_results>'));
}

// ── Multiple system messages still join ─────────────────────────────────────
{
  const { systemPrompt, prompt } = _extractFromMessages([
    { role: 'system', content: 'A' },
    { role: 'user', content: 'u1' },
    { role: 'system', content: 'B' },
    { role: 'user', content: 'u2' },
  ]);
  check('system messages join', systemPrompt === 'A\n\nB');
  check('both user turns labeled', prompt === 'User: u1\n\nUser: u2');
}

console.log('\nvocalization-tags tests');

// ── replaceVocalizationTags ─────────────────────────────────────────────────
{
  check('known tag → emoji', replaceVocalizationTags('[sigh] Forgive me.') === '😮‍💨 Forgive me.');
  check('case-insensitive', replaceVocalizationTags('[UM] hold on') === '🤔 hold on');
  check('multiple tags', replaceVocalizationTags('[laugh] ok [gasp]') === '😄 ok 😮');
  check('non-tag brackets pass through', replaceVocalizationTags('[File: x.txt] and [4]') === '[File: x.txt] and [4]');
  check('plain text untouched', replaceVocalizationTags('no tags here') === 'no tags here');
}

// ── createVocalizationMapper — streaming with split tags ────────────────────
{
  const parts = [];
  const m = createVocalizationMapper(t => parts.push(t));
  m.push('For');
  m.push('give me — [si');
  m.push('gh] Friday works.');
  m.flush();
  const out = parts.join('');
  check('split tag maps to emoji', out === 'Forgive me — 😮‍💨 Friday works.');
}

{
  const parts = [];
  const m = createVocalizationMapper(t => parts.push(t));
  m.push('see [File: re');
  m.push('port.pdf] for details');
  m.flush();
  check('non-tag bracket split passes through', parts.join('') === 'see [File: report.pdf] for details');
}

{
  const parts = [];
  const m = createVocalizationMapper(t => parts.push(t));
  m.push('trailing [um');
  m.flush();
  check('unclosed tag flushes literally', parts.join('') === 'trailing [um');
}

console.log(`\n${passed}/${tests} passed`);
process.exit(passed === tests ? 0 : 1);
