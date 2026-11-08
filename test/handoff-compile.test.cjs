'use strict';
/**
 * handoff-compile.test.cjs — compiler-hoist payload wiring.
 *
 * _notifyMain must carry `compiledPlan` + `allowPlannerFallback` in the
 * /comms.handoff body when comms-graph compiled typed steps at dispatch —
 * that's what turns the stategraph run runtime-only (_skillPlan fast-path).
 *
 * Run: node comms-graph/test/handoff-compile.test.cjs
 */

process.env.THINKDROP_MAIN_PORT = '3409'; // capture server

const http = require('http');
let _captured = null;
const server = http.createServer((req, res) => {
  if (req.url === '/comms.handoff' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { _captured = JSON.parse(body); res.writeHead(200).end('{}'); });
  } else { res.writeHead(200).end('{}'); }
});

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.error(`  FAIL ${name}`); }
}

(async () => {
  await new Promise(r => server.listen(3409, r));
  const handoff = require('../src/handoff.cjs');

  // Reach inside via a task dispatch whose lock is free — execute() notifies
  // _notifyMain → our capture server. Compile fires _generateTaskSteps which
  // hits the real backend; if it fails we still verify the body shape when
  // compiledPlan is injected directly into _notifyMain.
  // Direct _notifyMain isn't exported — exercise it through execute() with a
  // stubbed compile by monkeypatching the module cache is fragile; instead
  // verify the POST body shape by calling execute() and inspecting what
  // arrives (compile result or not — field presence is what we assert when
  // compile succeeds).

  // Force-acquire-free dispatch: planTask=false, source='text', unique prompt
  const r = await handoff.execute({
    englishPrompt: `test dispatch ${Date.now()} — reply with the word ok`,
    source: 'text',
    originalPrompt: 'test dispatch',
    sessionId: 'test-session',
  });
  check('execute returned taskId', typeof r.taskId === 'string' && r.taskId.length > 0);

  // Wait for the async notify to land
  await new Promise(r => setTimeout(r, 500));
  check('POST /comms.handoff captured', _captured && _captured.taskId === r.taskId);
  check('prompt rides through', _captured && _captured.prompt === `test dispatch — reply with the word ok`.replace('test dispatch —', `test dispatch ${''}`) || _captured.prompt.includes('reply with the word ok'));

  // compiledPlan presence depends on the live backend — assert SHAPE when present:
  // steps are typed {skill, args} objects and allowPlannerFallback accompanies them.
  if (_captured && Array.isArray(_captured.compiledPlan)) {
    check('compiledPlan is typed steps', _captured.compiledPlan.every(s => s && typeof s.skill === 'string'));
    check('allowPlannerFallback rides with compiledPlan', _captured.allowPlannerFallback === true);
    console.log(`  INFO compiled ${ _captured.compiledPlan.length } steps: ${_captured.compiledPlan.map(s => s.skill).join(' → ')}`);
  } else {
    console.log('  SKIP compiledPlan absent (backend unavailable or compile declined — degrade path OK)');
  }

  // Release the first dispatch's __run__ lock — every later execute() would
  // otherwise park behind it and the resume path would notify WITHOUT going
  // through the compile gate at all.
  handoff.complete(r.taskId, null, 'done', 'test');

  // ── Compile eligibility — the RouteDecision envelope is authoritative ─────
  // task_fb887853 regression: envelope {isActivityQuery, suggestedIntent:
  // memory_retrieve} still got a compiled shell.run plan → _skillPlan bypassed
  // decompose → "None found". Non-skill envelopes must NOT carry compiledPlan.
  // Each case must complete before the next execute() — the __run__ lane is
  // single-holder and a parked task never reaches the compile gate.
  const nonSkillCases = [
    ['suggestedIntent=memory_retrieve', { suggestedIntent: 'memory_retrieve', taskType: 'query' }],
    ['isActivityQuery flag (flake mode: suggestedIntent null)', { isActivityQuery: true, suggestedIntent: null, taskType: 'query' }],
    ['isConversationRecall', { isConversationRecall: true, taskType: 'query' }],
    ['resolution=needs_clarification', { resolution: 'needs_clarification', taskType: 'query' }],
    ['resolution=declined_ack', { resolution: 'declined_ack', taskType: 'browser' }],
    ['needsFreshScreen', { needsFreshScreen: true, taskType: 'local_system' }],
    // Abstaining envelopes — task_534944fc regression: query + null intent on
    // "list details about the videos" compiled to mdfind shell.run. No
    // affirmative task signal → pipeline, not a compiled plan.
    ['abstain: query + null suggestedIntent', { suggestedIntent: null, taskType: 'query' }],
    ['abstain: query + no suggestedIntent field', { taskType: 'query' }],
    ['abstain: null routeDecision', null],
    ['abstain: unknown taskType + null intent', { taskType: 'unknown_future_type', suggestedIntent: null }],
  ];
  for (const [label, rd] of nonSkillCases) {
    _captured = null;
    const rr = await handoff.execute({
      englishPrompt: `nonskill ${label} ${Date.now()}`,
      source: 'text',
      sessionId: 'test-session',
      routeDecision: rd,
    });
    check(`dispatch acquired lane for ${label}`, rr && rr.parked === false);
    await new Promise(r => setTimeout(r, 300));
    check(`no compiledPlan for ${label}`, _captured && !Array.isArray(_captured.compiledPlan));
    if (rd) check(`routeDecision still carried for ${label}`, _captured && _captured.routeDecision && _captured.routeDecision.taskType === rd.taskType);
    handoff.complete(rr.taskId, null, 'done', 'test');
  }

  // Skill-lane envelopes keep the hoist — the gate must not block them.
  // Compile may still return null (backend down) but the POST must land and
  // the skip must NOT have happened at the envelope gate.
  for (const [label, rd] of [
    ['suggestedIntent=command_automate', { suggestedIntent: 'command_automate', taskType: 'browser' }],
    ['taskType=local_file + null intent (task-shaped)', { taskType: 'local_file', suggestedIntent: null }],
    ['taskType=messaging + null intent (task-shaped)', { taskType: 'messaging', suggestedIntent: null }],
  ]) {
    _captured = null;
    const rr = await handoff.execute({
      englishPrompt: `skilllane ${label} ${Date.now()} — reply ok`,
      source: 'text',
      sessionId: 'test-session',
      routeDecision: rd || undefined,
    });
    // Compile runs an LLM stepgen before notify — poll up to 30s for the POST.
    const deadline = Date.now() + 30000;
    while (!_captured && Date.now() < deadline) await new Promise(r => setTimeout(r, 250));
    check(`dispatch reached main for ${label}`, _captured && _captured.taskId === rr.taskId);
    handoff.complete(rr.taskId, null, 'done', 'test');
  }

  server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
