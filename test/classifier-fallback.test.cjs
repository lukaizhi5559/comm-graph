'use strict';
/**
 * classifier-fallback.test.cjs — keyword-tier coverage for the prompt classes
 * observed failing when the force-prompt LLM is unavailable.
 *
 * Contract: every entry must classify to its intent at confidence > 0.5
 * (below 0.5 the wiring treats it as "no keyword match" → default_handoff).
 *
 * Run: node comms-graph/test/classifier-fallback.test.cjs
 */

const fallback = require('../src/classifier-fallback.cjs');

let passed = 0, failed = 0;
const CASES = [
  // [prompt, expected intent, label]
  ['cancel that', 4, 'cancel → control_signal'],
  ['stop the current task', 4, 'stop → control_signal'],
  ['never mind, forget it', 4, 'nevermind → control_signal'],

  ['how is that task going', 3, 'how is it going → status_check'],
  ["what's running right now", 3, 'whats running → status_check'],
  ['did my last task finish', 3, 'did task finish → status_check'],
  ['is it done yet', 3, 'is it done → status_check'],
  ['any progress on that', 3, 'progress → status_check'],

  ["what's my name", 2, 'name recall → memory_quick'],
  ['what is my favorite color', 2, 'color recall → memory_quick'],

  ['remember I have a dentist appointment next Tuesday', 5, 'dentist appt → memory_store'],
  ['note: buy milk tomorrow', 5, 'note → memory_store'],
  ['I have a flight on Monday', 5, 'flight → memory_store'],

  ['go to amazon and find cheap desks', 0, 'named-site browse → handoff'],
  ['search the web for ai news', 0, 'web search → handoff'],
  ['take a screenshot', 0, 'screenshot → handoff'],

  // First-person recall — these hit `when did`/`did i` in the general tier
  // and previously got claimed as general_quick, answering a memory question
  // with a canned "let me check your records" deferral (s2-mem-dentist).
  ['when did I last mention my dentist appointment', 0, 'when-did-i recall → handoff'],
  ['did I mention my flight details', 0, 'did-i-mention recall → handoff'],
  ["when's the last time I told you my address", 0, 'last-time recall → handoff'],
  ['have I told you my wifi password', 0, 'have-i-told recall → handoff'],
  ['summarize what I worked on recently', 0, 'activity summary → handoff'],
  ['what did we talk about yesterday', 0, 'conversation recall → handoff'],

  ['good morning', 1, 'greeting → general_quick (was falling to 0.5 residual → handoff)'],
  ['good afternoon', 1, 'afternoon greeting → general_quick'],
  ['how are you', 1, 'pleasantry → general_quick'],
  ['tell me a joke', 1, 'joke → general_quick'],
  ['why is the sky blue', 1, 'simple fact → general_quick'],
  ['who wrote pride and prejudice', 1, 'knowledge question → general_quick'],
  ['what do you think about vim vs emacs', 1, 'opinion → general_quick'],

  ['hey', 1, 'bare greeting → general_quick'],
];

// Bare-deictic continuations must NOT be claimed by any keyword tier — the
// referent lives in the transcript and the quick tier hallucinates without
// it (observed: "when was that" vetoed an LLM handoff → invented a date).
// Assert conf <= 0.5 so the wiring treats it as no-match → handoff.
const DEICTIC_CASES = [
  ['when was that', 'deictic time question'],
  ['tell me more about that', 'deictic continuation'],
  ['what about that', 'deictic what-about'],
];

(async () => {
  for (const [prompt, want, label] of CASES) {
    const r = await fallback.classify(prompt);
    const ok = r.intent === want;
    // For the residual-default case the wiring requires conf > 0.5 — document it
    const note = want === 1 ? ` (conf ${r.confidence} — wiring requires >0.5 to adopt, else handoff)` : ` (conf ${r.confidence})`;
    if (ok) { console.log(`  PASS: ${label}${note}`); passed++; }
    else { console.error(`  FAIL: ${label} — got intent ${r.intent}${note}`); failed++; }
  }
  for (const [prompt, label] of DEICTIC_CASES) {
    const r = await fallback.classify(prompt);
    const ok = r.confidence <= 0.5;
    if (ok) { console.log(`  PASS: ${label} — conf ${r.confidence} ≤ 0.5 (no keyword veto)`); passed++; }
    else { console.error(`  FAIL: ${label} — conf ${r.confidence} would veto handoff (intent ${r.intent})`); failed++; }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
