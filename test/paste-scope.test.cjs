'use strict';
/**
 * paste-scope.test.cjs — paste+question turns must scope intent judgments to
 * the ask, not the pasted material.
 *
 * Observed failure (2026-11-03 17:06Z): user pasted ~600 chars of a routing
 * audit (containing "AGENTS.md rule") and appended "What does envelope mean
 * in regards to this and in computer science". The rule-author weak marker
 * matched \brule\b, confirmJudgment judged the WHOLE pasted block, returned
 * YES → _authorRule couldn't parse a rule from prose → "I couldn't turn that
 * into a rule". The turn never reached classify.
 *
 * Fix: facts.requestText (trailing ask segment) + focused verdict state
 * (ask + matched-evidence sentence). Matchers still generate candidates on
 * full userText; judgments read the ask.
 *
 * Run: node comms-graph/test/paste-scope.test.cjs
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'td-paste-test-'));
process.env.COMMS_NO_LISTEN = '1';
process.env.COMMS_NO_HISTORY = '1'; // never write test turns into live session history
process.env.THINKDROP_RULES_PATH = path.join(TMP, 'rules.json');
process.env.THINKDROP_PLANS_DIR = path.join(TMP, 'plans');
fs.mkdirSync(process.env.THINKDROP_PLANS_DIR, { recursive: true });

const RULE_JSON = JSON.stringify({
  when: { hostMatch: 'youtube.com' },
  then: { action: 'show_card', kind: 'emoji', emoji: '😄' },
});
const llmStub = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/llm/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ text: RULE_JSON })}\n\n`);
    res.write(`data: ${JSON.stringify({ done: true, provider: 'stub' })}\n\n`);
    return res.end();
  }
  res.writeHead(404); res.end();
});

let tests = 0, passed = 0;
function check(name, cond, extra = '') {
  tests++;
  if (cond) { passed++; console.log(`  PASS: ${name}`); }
  else { console.error(`  FAIL: ${name}${extra ? ' — ' + extra : ''}`); }
}

async function listen(server) {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return server.address().port;
}

// The pasted block from the incident (paraphrased, keeps the trigger tokens).
const PASTE = 'I have written the full audit plus plan. The answer to your question: '
  + 'the root is regex pinning — closed-class regexes making open-world routing '
  + 'decisions at several sites in different vocabularies, and they fire before '
  + 'the context-aware classifiers. One RouteVerdict per turn, computed once from '
  + 'the envelope with history, with regexes demoted to anchored fast-paths and '
  + 'every lane override forced through confirmJudgment per your own AGENTS.md rule.';

(async () => {
  console.log('\npaste-scope tests');

  const port = await listen(llmStub);
  process.env.BACKEND_LLM_URL = `http://127.0.0.1:${port}/api/llm`;

  const { computeTurnFacts, deriveRequestText } = require('../../shared/turn-facts.cjs');
  const providers = require('../src/llm-providers.cjs');
  const decision = require('../src/decision.cjs');
  const { processMessage, _focusState, _evidenceSentence } = require('../src/server.cjs');
  const realAsk = providers.ask;
  const realConfirm = decision.confirmJudgment;

  // ── A. deriveRequestText unit cases ───────────────────────────────────────
  console.log('deriveRequestText');
  check('short text → whole', deriveRequestText('what does envelope mean') === 'what does envelope mean');
  check('200-char text → whole', deriveRequestText('x'.repeat(200)).length === 200);
  check('long single sentence → whole',
    deriveRequestText('whenever I go to youtube and a new video drops on any channel I follow put it on my screen and notify me right away every single time').includes('whenever'));
  check('paste + trailing question → question only',
    deriveRequestText(`${PASTE} - What does envelope mean in regards to this`) === 'What does envelope mean in regards to this');
  check('multiline → last line',
    deriveRequestText('line one is long enough to pass the two hundred character threshold easily with room to spare and keep going for quite a while, and then some more text here so it is definitely well over\nwhat about this one?') === 'what about this one?');
  check('trailing fragment pulls predecessor',
    deriveRequestText(`${PASTE} does this apply. right?`).includes('does this apply'));
  check('facts expose requestText + requestIsQuestion', (() => {
    const f = computeTurnFacts({ rawText: `${PASTE} - What does envelope mean?` });
    return f.requestText === 'What does envelope mean?' && f.requestIsQuestion === true;
  })());
  check('facts on plain question → requestText === userText', (() => {
    const f = computeTurnFacts({ rawText: 'show me the logs' });
    return f.requestText === f.userText;
  })());

  // ── B. _focusState / _evidenceSentence ────────────────────────────────────
  console.log('focus state');
  const scoped = computeTurnFacts({ rawText: `${PASTE} - What does envelope mean?` });
  const fs1 = _focusState(scoped, /\brules?\b/i);
  check('focus state = Ask + evidence', /^Ask: What does envelope mean\?\nCandidate evidence: "/.test(fs1),
    `got: ${JSON.stringify(fs1).slice(0, 140)}`);
  check('evidence sentence carries the match', fs1.includes('AGENTS.md rule.'));
  const unscoped = computeTurnFacts({ rawText: 'can you set a rule for me' });
  check('short text → bare ask (no Ask: prefix)', _focusState(unscoped, /\brules?\b/i) === 'can you set a rule for me');
  check('_evidenceSentence finds the sentence',
    _evidenceSentence('alpha beta. gamma has the word plan in it. delta.', /\bplan\b/i) === 'gamma has the word plan in it.');

  // ── C. The incident — paste+question must not enter rule authoring ────────
  console.log('incident replay');
  providers.ask = async () => ({ text: '1', provider: 'mock' }); // classify → general_quick
  let calls = [];
  // Simulate the OLD wrong verdict but observe the scoped state — a YES on a
  // scoped state means the model genuinely read the ask as a rule request.
  decision.confirmJudgment = async (o) => { calls.push(o); return 'NO'; };
  const r1 = await processMessage({ text: `${PASTE} - What does envelope mean in regards to this and in computer science` });
  check('paste+question does NOT enter guardian lane',
    r1.intentName !== 'guardian' && r1.metadata?.source !== 'guardian', `got ${r1.intentName}`);
  const ruleCall = calls.find(c => c.site === 'rule-author');
  // Interrogative-led asks short-circuit BEFORE the verdict now — question-
  // shaped requests are answered, never authored; the paste problem is handled
  // deterministically upstream of the model (stronger than a NO verdict).
  check('interrogative ask skips the rule-author verdict', !ruleCall);

  // The scoped-state contract still binds for imperative asks — an imperative
  // variant reaches the gate with focus narrowed to the real request. (Capital
  // T: deriveRequestText splits the " - " boundary on [A-Z0-9], same as the
  // original "What does" case.)
  calls = [];
  decision.confirmJudgment = async (o) => { calls.push(o); return 'NO'; };
  await processMessage({ text: `${PASTE} - Tell me what envelope means in this context` });
  const ruleCall2 = calls.find(c => c.site === 'rule-author');
  check('imperative ask reaches verdict with scoped state',
    ruleCall2 && /^Ask: Tell me what envelope means/.test(ruleCall2.state),
    `got: ${ruleCall2 && JSON.stringify(ruleCall2.state).slice(0, 160)}`);
  check('verdict question names the paste problem', ruleCall2 && /quoted or pasted material/i.test(ruleCall2.question));

  // A YES on the SCOPED state means the ask really was rule-shaped — the lane
  // still fires (regression guard for over-suppression).
  calls = [];
  decision.confirmJudgment = async (o) => { calls.push(o); return 'YES'; };
  const r2 = await processMessage({ text: 'can you set a rule for me' });
  check('short rule request + YES → guardian lane',
    r2.intentName === 'guardian' || r2.metadata?.source === 'guardian', `got ${r2.intentName}`);
  await processMessage({ text: 'rule cancel' });

  // ── D. Anchored phrase on a long paste → scoped verdict ───────────────────
  console.log('anchored-on-paste gate');
  calls = [];
  decision.confirmJudgment = async (o) => { calls.push(o); return 'NO'; };
  const quotedCond = 'Here is the rule idea the team discussed. If I go to youtube and a new video drops on a channel I watch you show me a happy emoji on my screen every single time it happens. '
    + 'Can you explain what this rule would do?';
  const r3 = await processMessage({ text: quotedCond });
  check('quoted conditional + question does NOT author (NO verdict)',
    r3.intentName !== 'guardian' && r3.metadata?.source !== 'guardian', `got ${r3.intentName}`);
  check('anchored-on-paste consulted the verdict', calls.some(c => c.site === 'rule-author'));

  calls = [];
  decision.confirmJudgment = async (o) => { calls.push(o); return 'YES'; };
  const r4 = await processMessage({ text: quotedCond });
  check('quoted conditional + YES → authors (evidence kept the phrasing)',
    r4.intentName === 'guardian' || r4.metadata?.source === 'guardian', `got ${r4.intentName}`);
  check('author lane echoed a draft', /rule i understood|rule confirm/i.test(r4.text));
  await processMessage({ text: 'rule cancel' });

  // Short anchored phrases still fire directly — no verdict call.
  calls = [];
  decision.confirmJudgment = async (o) => { calls.push(o); return 'NO'; }; // NO must be ignored here
  const r5 = await processMessage({ text: 'if I goto youtube show me a happy emoji' });
  check('short anchored phrase bypasses the verdict',
    !calls.some(c => c.site === 'rule-author')
      && (r5.intentName === 'guardian' || r5.metadata?.source === 'guardian'), `got ${r5.intentName}`);
  await processMessage({ text: 'rule cancel' });

  // ── E. logMention scoped to the ask ───────────────────────────────────────
  console.log('logMention scoping');
  const sc = require('../src/nodes/statusCheck.cjs');
  const realProbe = sc.probeLog;
  let probed = 0;
  sc.probeLog = async (t) => { probed++; return { name: 'comms-graph', out: 'fake log line' }; };
  decision.confirmJudgment = realConfirm;
  await processMessage({ text: `${PASTE} it also mentions comms-graph.log errors near the end. What does this error mean?` });
  check('paste-only log mention does NOT probe', probed === 0, `probed=${probed}`);
  await processMessage({ text: 'show me the comms-graph log' });
  check('ask-shaped log mention probes', probed === 1, `probed=${probed}`);
  sc.probeLog = realProbe;

  // ── F. plan-referent + missing-detail scoping ─────────────────────────────
  console.log('plan-referent focus');
  const pf = computeTurnFacts({ rawText: `${PASTE} it references the nylas plan rollout. What does this plan actually do?` });
  const pstate = _focusState(pf, /\bplans?\b/i);
  check('plan-referent state is ask-first', /^Ask: What does this plan actually do\?/.test(pstate));

  // missing-detail must skip when the ASK is a question even if the whole
  // turn is statement-shaped — classify() guards it internally.
  const { classify } = require('../src/classify.cjs');
  calls = [];
  decision.confirmJudgment = async (o) => { calls.push(o); return 'NO'; };
  providers.ask = async () => ({ text: '0', provider: 'mock' }); // remote → handoff (missing-detail candidate)
  await classify(`${PASTE} delete the quarterly report from shared drive. What does this instruction actually do?`, null);
  check('missing-detail skipped on question-shaped ask',
    !calls.some(c => c.site === 'missing-detail'), `calls: ${calls.map(c => c.site).join(',')}`);
  check('judgments that did run got scoped message', calls.every(c => !c.state || !String(c.state).includes('quarterly report') || String(c.state).includes('Ask:')));

  // ── G. Executor pins on pasted material (observed live: quoted "show me a
  // happy emoji on my screen" pinned the screen lane; quoted "build me an app"
  // could pin planning) ────────────────────────────────────────────────────
  console.log('executor pins on pasted content');
  providers.ask = async () => ({ text: '1', provider: 'mock' });
  const rq = await classify('Here is the rule idea the team wrote down. If I go to youtube and a new video drops on a channel I watch you show me a happy emoji on my screen every single time it happens. Can you explain what this rule would do?', null);
  check('quoted "on my screen" does NOT pin screen lane', rq.intent !== 7, `got ${rq.intentName}/${rq.source}`);
  const rd = await classify(`${PASTE} The design doc says to build me an app for tracking meals and groceries. What would that involve?`, null);
  check('quoted deliverable does NOT pin planning', rd.intent !== 6, `got ${rd.intentName}/${rd.source}`);
  const rp = await classify(`${PASTE} - What does this plan involve?`, null);
  check('quoted "plan" mention does NOT pin planning', rp.intent !== 6, `got ${rp.intentName}/${rp.source}`);
  const rs = await classify('show a happy emoji on my screen', null);
  check('direct screen request still pins screen lane', rs.intent === 7, `got ${rs.intentName}/${rs.source}`);
  const rp2 = await classify('make a plan to reorganize my downloads folder', null);
  check('direct planning request still pins planning', rp2.intent === 6, `got ${rp2.intentName}/${rp2.source}`);

  decision.confirmJudgment = realConfirm;
  providers.ask = realAsk;

  console.log(`\n${passed}/${tests} passed`);
  llmStub.close();
  process.exit(passed === tests ? 0 : 1);
})().catch(e => { console.error(e); llmStub.close(); process.exit(1); });
